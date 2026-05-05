'use strict'
const { nack } = require('../../common/becknShapes')

const createReadHandler = (router) => async (req, res, next) => {
  try {
    const { catalogId } = req.params
    const manifest = await router.read(catalogId)
    return res.status(200).json(manifest)
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json(nack('NOT_FOUND', err.message))
    }
    if (err.code === 'INVALID_CATALOG_ID') {
      return res.status(400).json(nack('INVALID_CATALOG_ID', err.message))
    }
    next(err)
  }
}

module.exports = { createReadHandler }
