'use strict'
/**
 * CJS-compatible fetch shim used in place of node-fetch v3 (ESM-only).
 * Routes requests through Node's http/https modules so nock can intercept them.
 * Implements the subset of the fetch API used by GiteaClient.
 */

const http = require('http')
const https = require('https')

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }

    const req = lib.request(options, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: () => Promise.resolve(JSON.parse(raw)),
          text: () => Promise.resolve(raw),
        })
      })
      res.on('error', reject)
    })

    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

module.exports = { default: fetch }
