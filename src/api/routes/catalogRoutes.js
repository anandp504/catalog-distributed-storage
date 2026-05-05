'use strict'
const express = require('express')
const { createPublishHandler } = require('../handlers/publishHandler')
const { createReadHandler } = require('../handlers/readHandler')
const createRouter = (giteaRouter) => {
  const router = express.Router()
  router.post('/catalog/publish', createPublishHandler(giteaRouter))
  router.get('/catalog/:catalogId', createReadHandler(giteaRouter))
  return router
}
module.exports = { createRouter }
