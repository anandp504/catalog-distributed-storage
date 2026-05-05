'use strict'
const { sanitizeCatalogId } = require('../../coordinator/routingTable')

const validatePublishRequest = (body) => {
  if (!body || !body.context) {
    return { errorCode: 'INVALID_REQUEST', errorMessage: 'Missing context' }
  }
  if (body.context.action !== 'catalog/publish') {
    return { errorCode: 'INVALID_REQUEST', errorMessage: "context.action must be 'catalog/publish'" }
  }
  if (body.context.version !== '2.0.0') {
    return { errorCode: 'INVALID_REQUEST', errorMessage: "context.version must be '2.0.0'" }
  }
  if (!body.message || !Array.isArray(body.message.catalogs) || body.message.catalogs.length === 0) {
    return { errorCode: 'INVALID_REQUEST', errorMessage: 'message.catalogs must be a non-empty array' }
  }
  for (const catalog of body.message.catalogs) {
    if (!catalog.id) return { errorCode: 'INVALID_REQUEST', errorMessage: 'Each catalog must have an id' }
    if (!catalog.descriptor) return { errorCode: 'INVALID_REQUEST', errorMessage: 'Each catalog must have a descriptor' }
    if (!catalog.provider) return { errorCode: 'INVALID_REQUEST', errorMessage: 'Each catalog must have a provider' }
    if (!catalog.resources && !catalog.offers) {
      return { errorCode: 'INVALID_REQUEST', errorMessage: 'Each catalog must have resources or offers' }
    }
    // Sanitize catalogId — throws if invalid
    try {
      sanitizeCatalogId(catalog.id)
    } catch (err) {
      return { errorCode: err.code || 'INVALID_CATALOG_ID', errorMessage: err.message }
    }
  }
  return null
}

module.exports = { validatePublishRequest }
