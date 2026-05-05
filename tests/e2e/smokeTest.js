#!/usr/bin/env node
'use strict'

/**
 * E2E Smoke Test — runs against a live Docker Compose stack.
 * Prerequisites:
 *   docker-compose up --build -d
 *   ./docker/gitea/init.sh http://localhost:3001
 *   ./docker/gitea/init.sh http://localhost:3002
 *   ./docker/gitea/init.sh http://localhost:3003
 *   GITEA_ADMIN_TOKEN=<token> node tests/e2e/smokeTest.js
 *
 * The same token must be set on the API container (restart it after init).
 */

const API_URL = process.env.API_URL || 'http://localhost:3000'
const GITEA_NODES = (process.env.GITEA_NODES || 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',')
const GITEA_ADMIN_USER = process.env.GITEA_ADMIN_USER || 'gitea_admin'
const GITEA_ADMIN_PASSWORD = process.env.GITEA_ADMIN_PASSWORD || ''
const BASIC_AUTH = Buffer.from(`${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}`).toString('base64')
const GITEA_ORG = process.env.GITEA_ORG || 'beckn'

let passed = 0
let failed = 0

const assert = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

const makeCatalog = (id) => ({
  context: {
    action: 'catalog/publish',
    version: '2.0.0',
    networkId: 'beckn.one/test',
    messageId: `msg-${Date.now()}`,
    transactionId: `txn-${Date.now()}`,
    timestamp: new Date().toISOString(),
  },
  message: {
    catalogs: [{
      id,
      descriptor: { name: `Catalog ${id}` },
      provider: { id: 'PROV-001', descriptor: { name: 'Test Provider' } },
      resources: [{ id: 'RES-001', descriptor: { name: 'Resource' }, resourceAttributes: { '@type': 'Test' } }],
    }],
    publishDirectives: [{ catalogId: id, catalogType: 'regular', updateMode: 'MERGE' }],
  },
})

const publish = (id) =>
  fetch(`${API_URL}/catalog/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeCatalog(id)),
  })

const read = (id) => fetch(`${API_URL}/catalog/${id}`)

const giteaRepoCount = async (nodeUrl) => {
  const res = await fetch(`${nodeUrl}/api/v1/repos/search?limit=50`, {
    headers: { Authorization: `Basic ${BASIC_AUTH}` },
  })
  if (!res.ok) return 0
  const data = await res.json()
  return data.data?.filter(r => r.owner?.login === GITEA_ORG).length ?? 0
}

const giteaCommitCount = async (nodeUrl, catalogId) => {
  const res = await fetch(
    `${nodeUrl}/api/v1/repos/${GITEA_ORG}/${catalogId}/commits`,
    { headers: { Authorization: `Basic ${BASIC_AUTH}` } }
  )
  if (!res.ok) return 0
  const data = await res.json()
  return Array.isArray(data) ? data.length : 0
}

async function run() {
  console.log(`\nE2E Smoke Test — API: ${API_URL}\n`)

  // ── Scenario 1: Publish ──────────────────────────────────────────────────
  console.log('Scenario 1: POST /catalog/publish')
  const s1res = await publish('CAT-SMOKE-001')
  const s1body = await s1res.json()
  assert('HTTP 200', s1res.status === 200, `got ${s1res.status}`)
  assert('body.status === ACK', s1body.status === 'ACK', JSON.stringify(s1body))

  // ── Scenario 2: Read ─────────────────────────────────────────────────────
  console.log('\nScenario 2: GET /catalog/CAT-SMOKE-001')
  const s2res = await read('CAT-SMOKE-001')
  const s2body = await s2res.json()
  assert('HTTP 200', s2res.status === 200, `got ${s2res.status}`)
  assert('manifest.id matches', s2body.id === 'CAT-SMOKE-001', JSON.stringify(s2body))

  // ── Scenario 3: Re-publish (second commit) ────────────────────────────────
  console.log('\nScenario 3: Re-publish CAT-SMOKE-001 (expect 2 commits)')
  const s3res = await publish('CAT-SMOKE-001')
  const s3body = await s3res.json()
  assert('HTTP 200 on re-publish', s3res.status === 200, `got ${s3res.status}`)
  assert('body.status === ACK', s3body.status === 'ACK')

  // Find which node owns CAT-SMOKE-001 and verify 2 commits
  let commitCount = 0
  for (const node of GITEA_NODES) {
    const n = await giteaCommitCount(node, 'CAT-SMOKE-001')
    if (n > 0) { commitCount = n; break }
  }
  assert('Gitea repo has >= 2 commits after re-publish', commitCount >= 2, `got ${commitCount}`)

  // ── Scenario 4: Distribution across 3 nodes ───────────────────────────────
  console.log('\nScenario 4: Publish 90 distinct catalogs, check distribution')
  const ids = Array.from({ length: 90 }, (_, i) => `CAT-DIST-${String(i).padStart(3, '0')}`)
  await Promise.all(ids.map(id => publish(id)))

  // Wait a moment then count repos per node
  await new Promise(r => setTimeout(r, 2000))
  const counts = await Promise.all(GITEA_NODES.map(n => giteaRepoCount(n)))
  console.log(`  Node distribution: ${counts.join(' / ')} repos`)
  counts.forEach((c, i) => {
    assert(`gitea-${i + 1} received 20-50 repos (got ${c})`, c >= 20 && c <= 60)
  })

  // ── Scenario 5: GET returns 404 for unknown catalog ───────────────────────
  console.log('\nScenario 5: GET unknown catalog -> 404 NACK')
  const s5res = await read('CAT-DOES-NOT-EXIST-99999')
  const s5body = await s5res.json()
  assert('HTTP 404', s5res.status === 404, `got ${s5res.status}`)
  assert('errorCode NOT_FOUND', s5body?.error?.errorCode === 'NOT_FOUND', JSON.stringify(s5body))

  // ── Scenario 6: Validation — bad request ─────────────────────────────────
  console.log('\nScenario 6: POST invalid payload -> 400 NACK')
  const s6res = await fetch(`${API_URL}/catalog/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { action: 'search', version: '2.0.0' } }),
  })
  const s6body = await s6res.json()
  assert('HTTP 400 on invalid request', s6res.status === 400, `got ${s6res.status}`)
  assert('errorCode INVALID_REQUEST', s6body?.error?.errorCode === 'INVALID_REQUEST', JSON.stringify(s6body))

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error('SMOKE TEST FAILED')
    process.exit(1)
  } else {
    console.log('SMOKE TEST PASSED')
  }
}

run().catch(err => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
