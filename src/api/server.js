'use strict'
require('dotenv').config()

const { Pool } = require('pg')
const Redis = require('ioredis')
const { createApp } = require('./app')
const { HashRing } = require('../coordinator/hashRing')
const { RoutingTable } = require('../coordinator/routingTable')
const { GiteaRouter } = require('../gitea/giteaRouter')

const PORT = process.env.PORT || 3000
const GITEA_NODES = (process.env.GITEA_NODES || '').split(',').filter(Boolean)
const GITEA_ORG = process.env.GITEA_ORG || 'beckn'
const GITEA_ADMIN_USER = process.env.GITEA_ADMIN_USER || ''
const GITEA_ADMIN_PASSWORD = process.env.GITEA_ADMIN_PASSWORD || ''
const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

if (GITEA_NODES.length === 0) {
  console.error('[api] GITEA_NODES env var is required')
  process.exit(1)
}
if (!GITEA_ADMIN_USER) {
  console.error('[api] GITEA_ADMIN_USER env var is required')
  process.exit(1)
}
if (!GITEA_ADMIN_PASSWORD) {
  console.error('[api] GITEA_ADMIN_PASSWORD env var is required')
  process.exit(1)
}
if (!DATABASE_URL) {
  console.error('[api] DATABASE_URL env var is required')
  process.exit(1)
}

const pgPool = new Pool({ connectionString: DATABASE_URL })
const redisClient = new Redis(REDIS_URL, { lazyConnect: true })
redisClient.on('error', (err) => console.warn('[redis] connection error:', err.message))
const hashRing = new HashRing(GITEA_NODES)
const routingTable = new RoutingTable(pgPool, redisClient, hashRing)
const giteaRouter = new GiteaRouter(routingTable, GITEA_ADMIN_USER, GITEA_ADMIN_PASSWORD, GITEA_ORG)

const app = createApp(giteaRouter)

const server = app.listen(PORT, () => {
  console.info(`[api] listening on :${PORT}`)
  console.info(`[api] Gitea nodes: ${GITEA_NODES.join(', ')}`)
})

const shutdown = async () => {
  await new Promise(resolve => server.close(resolve))
  await routingTable.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
