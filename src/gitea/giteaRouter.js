'use strict'
const { GiteaClient } = require('./giteaClient')
const { sanitizeCatalogId } = require('../coordinator/routingTable')

class GiteaRouter {
  constructor(routingTable, adminUser, adminPassword, org) {
    this.routingTable = routingTable
    this.adminUser = adminUser
    this.adminPassword = adminPassword
    this.org = org
    this._clients = new Map()
  }

  _clientFor(nodeUrl) {
    if (!this._clients.has(nodeUrl)) {
      this._clients.set(nodeUrl, new GiteaClient(nodeUrl, this.adminUser, this.adminPassword, this.org))
    }
    return this._clients.get(nodeUrl)
  }

  async publish(catalog, directive, context) {
    sanitizeCatalogId(catalog.id)
    const nodeUrl = await this.routingTable.resolve(catalog.id)
    const client = this._clientFor(nodeUrl)

    await client.ensureRepo(catalog.id)

    const metadata = {
      publishedAt: new Date().toISOString(),
      networkId: context.networkId,
      action: context.action,
      messageId: context.messageId,
      transactionId: context.transactionId,
      updateMode: directive.updateMode || 'MERGE',
    }

    const commitMessage = `catalog ${directive.updateMode || 'MERGE'}: ${catalog.id}`
    await client.commitFile(catalog.id, 'manifest.json', catalog, commitMessage)
    await client.commitFile(catalog.id, '.metadata.json', metadata, commitMessage)
  }

  async read(catalogId) {
    sanitizeCatalogId(catalogId)
    const nodeUrl = await this.routingTable.resolve(catalogId)
    const client = this._clientFor(nodeUrl)
    const manifest = await client.readFile(catalogId, 'manifest.json')
    if (manifest === null) {
      const err = new Error(`Catalog not found: ${catalogId}`)
      err.code = 'NOT_FOUND'
      throw err
    }
    return manifest
  }
}

module.exports = { GiteaRouter }
