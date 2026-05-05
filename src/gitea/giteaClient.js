'use strict'

// node-fetch v3 ships both ESM and a CommonJS-compatible build.
// Node v22 resolves require('node-fetch') via the CJS exports map entry,
// so .default is the fetch function — no dynamic import needed.
const fetch = require('node-fetch').default

const withTimeout = (ms) => {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, clear: () => clearTimeout(id) }
}

class GiteaClient {
  constructor(baseUrl, adminUser, adminPassword, org) {
    this.baseUrl = baseUrl
    this.adminUser = adminUser
    this.adminPassword = adminPassword
    this.org = org
  }

  _headers() {
    const credentials = Buffer.from(`${this.adminUser}:${this.adminPassword}`).toString('base64')
    return {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
    }
  }

  async ensureRepo(catalogId) {
    const url = `${this.baseUrl}/api/v1/orgs/${this.org}/repos`
    const { signal, clear } = withTimeout(10000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ name: catalogId, auto_init: true, private: false, default_branch: 'main' }),
        signal,
      })
      if (res.status === 201 || res.status === 409) return
      throw new Error(`POST ${url} → HTTP ${res.status}`)
    } finally {
      clear()
    }
  }

  async commitFile(catalogId, filePath, contentObj, message) {
    const contentsUrl = `${this.baseUrl}/api/v1/repos/${this.org}/${catalogId}/contents/${filePath}`

    const { signal: getSignal, clear: clearGet } = withTimeout(10000)
    let getRes
    try {
      getRes = await fetch(contentsUrl, { headers: this._headers(), signal: getSignal })
    } finally {
      clearGet()
    }

    const contentB64 = Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64')
    let method, body

    if (getRes.status === 404) {
      method = 'POST'
      body = { message, content: contentB64, branch: 'main' }
    } else if (getRes.ok) {
      const existing = await getRes.json()
      method = 'PUT'
      body = { message, content: contentB64, sha: existing.sha, branch: 'main' }
    } else {
      throw new Error(`GET ${contentsUrl} → HTTP ${getRes.status}`)
    }

    const { signal: writeSignal, clear: clearWrite } = withTimeout(10000)
    try {
      const writeRes = await fetch(contentsUrl, {
        method,
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: writeSignal,
      })
      if (!writeRes.ok) {
        const errBody = await writeRes.text().catch(() => '')
        throw new Error(`${method} ${contentsUrl} → HTTP ${writeRes.status}${errBody ? ': ' + errBody : ''}`)
      }
      const data = await writeRes.json()
      return { commitSha: data.commit?.sha ?? null }
    } finally {
      clearWrite()
    }
  }

  async readFile(catalogId, filePath) {
    const url = `${this.baseUrl}/api/v1/repos/${this.org}/${catalogId}/contents/${filePath}`
    const { signal, clear } = withTimeout(10000)
    try {
      const res = await fetch(url, { headers: this._headers(), signal })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
      const data = await res.json()
      return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'))
    } finally {
      clear()
    }
  }

  async getHistory(catalogId) {
    const url = `${this.baseUrl}/api/v1/repos/${this.org}/${catalogId}/commits?limit=50`
    const { signal, clear } = withTimeout(10000)
    try {
      const res = await fetch(url, { headers: this._headers(), signal })
      if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
      const commits = await res.json()
      return commits.map(c => ({
        sha: c.sha,
        message: c.commit.message,
        timestamp: c.commit.author.date,
      }))
    } finally {
      clear()
    }
  }
}

module.exports = { GiteaClient }
