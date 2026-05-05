'use strict'
const { validatePublishRequest } = require('../validation/catalogSchema')
const { ack, nack } = require('../../common/becknShapes')

const createPublishHandler = (router) => async (req, res, next) => {
  try {
    const validationError = validatePublishRequest(req.body)
    if (validationError) {
      return res.status(400).json(nack(validationError.errorCode, validationError.errorMessage))
    }

    const { context, message } = req.body
    const { catalogs, publishDirectives = [] } = message

    // Build a directive map for quick lookup
    const directiveMap = {}
    for (const d of publishDirectives) directiveMap[d.catalogId] = d

    await Promise.all(catalogs.map(catalog => {
      const directive = directiveMap[catalog.id] || { catalogId: catalog.id, updateMode: 'MERGE' }
      return router.publish(catalog, directive, context)
    }))

    return res.status(200).json(ack())
  } catch (err) {
    next(err)
  }
}

module.exports = { createPublishHandler }
