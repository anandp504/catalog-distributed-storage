'use strict'
const crypto = require('crypto')

const sha256 = (key) => crypto.createHash('sha256').update(key).digest('hex')

class HashRing {
  constructor(nodeUrls, virtualNodes = 150) {
    if (!nodeUrls || nodeUrls.length === 0) {
      throw new Error('HashRing requires at least one node')
    }
    this.ring = []
    for (const nodeUrl of nodeUrls) {
      for (let i = 0; i < virtualNodes; i++) {
        this.ring.push({ hash: sha256(`${nodeUrl}:vnode:${i}`), nodeUrl })
      }
    }
    this.ring.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  }

  getNode(catalogId) {
    const keyHash = sha256(catalogId)
    // binary search: find first entry with hash >= keyHash
    let lo = 0, hi = this.ring.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.ring[mid].hash < keyHash) lo = mid + 1
      else hi = mid
    }
    // wrap around if keyHash is beyond all vnodes
    return this.ring[lo % this.ring.length].nodeUrl
  }
}

module.exports = { HashRing }
