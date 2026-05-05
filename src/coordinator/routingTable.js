'use strict'
const { ROUTING_HASH_KEY } = require('../common/constants')

const VALID_ID_RE = /^[A-Za-z0-9_-]+$/

const sanitizeCatalogId = (id) => {
  if (!id || typeof id !== 'string') {
    const err = new Error('catalogId must be a non-empty string')
    err.code = 'INVALID_CATALOG_ID'
    throw err
  }
  if (!VALID_ID_RE.test(id)) {
    const err = new Error(`Invalid catalogId: "${id}" contains forbidden characters`)
    err.code = 'INVALID_CATALOG_ID'
    throw err
  }
  return id
}

class RoutingTable {
  constructor(pgPool, redisClient, hashRing) {
    this.pg = pgPool
    this.redis = redisClient
    this.hashRing = hashRing
  }

  async resolve(catalogId) {
    // Layer 1: Redis cache
    const cached = await this.redis.hget(ROUTING_HASH_KEY, catalogId)
    if (cached) return cached

    // Layer 2: Postgres authoritative record
    const { rows } = await this.pg.query(
      'SELECT node_url FROM catalog_routing WHERE catalog_id = $1',
      [catalogId]
    )
    if (rows.length > 0) {
      try {
        await this.redis.hset(ROUTING_HASH_KEY, catalogId, rows[0].node_url)
      } catch (redisErr) {
        console.warn('[routing] Redis hset failed (cache miss tolerated):', redisErr.message)
      }
      return rows[0].node_url
    }

    // Layer 3: New catalogId — assign via hash ring, write Postgres first
    const nodeUrl = this.hashRing.getNode(catalogId)
    await this.pg.query(
      'INSERT INTO catalog_routing (catalog_id, node_url) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [catalogId, nodeUrl]
    )
    // Re-read to get the authoritative winner (handles concurrent first-publishes)
    const { rows: confirmed } = await this.pg.query(
      'SELECT node_url FROM catalog_routing WHERE catalog_id = $1',
      [catalogId]
    )
    const authoritative = confirmed[0].node_url
    try {
      await this.redis.hset(ROUTING_HASH_KEY, catalogId, authoritative)
    } catch (redisErr) {
      console.warn('[routing] Redis hset failed (cache miss tolerated):', redisErr.message)
    }
    return authoritative
  }

  async close() {
    await this.pg.end()
    await this.redis.quit()
  }
}

module.exports = { RoutingTable, sanitizeCatalogId }
