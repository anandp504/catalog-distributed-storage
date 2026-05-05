'use strict'
const express = require('express')
const { createRouter } = require('./routes/catalogRoutes')
const { nack } = require('../common/becknShapes')

const createApp = (giteaRouter) => {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.get('/health', (req, res) => res.json({ status: 'ok' }))
  app.use('/', createRouter(giteaRouter))

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[api] unhandled error', err.message)
    res.status(500).json(nack('INTERNAL_ERROR', err.message))
  })

  return app
}

module.exports = { createApp }
