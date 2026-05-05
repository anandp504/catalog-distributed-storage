'use strict'
jest.mock('pg')
jest.mock('ioredis')

const nock = require('nock')
const { HashRing } = require('../../../src/coordinator/hashRing')
const { RoutingTable } = require('../../../src/coordinator/routingTable')
const { GiteaRouter } = require('../../../src/gitea/giteaRouter')

const GITEA_URL = 'http://gitea-1:3000'
const ADMIN_USER = 'gitea_admin'
const ADMIN_PASS = 'gitea_admin_pass'
const ORG = 'beckn'
const CATALOG_ID = 'CAT-ROUTER-001'

const makeCatalog = (id = CATALOG_ID) => ({
  id,
  descriptor: { name: 'Test Catalog' },
  provider: { id: 'PROV-001', descriptor: { name: 'Provider' } },
  resources: [{ id: 'RES-001', descriptor: { name: 'Resource' } }],
})

const makeDirective = (id = CATALOG_ID) => ({
  catalogId: id,
  catalogType: 'regular',
  updateMode: 'MERGE',
})

const makeContext = () => ({
  action: 'catalog/publish',
  version: '2.0.0',
  networkId: 'beckn.one/test',
  messageId: 'msg-001',
  transactionId: 'txn-001',
  timestamp: '2026-05-05T10:00:00Z',
})

let pgPool, redisClient, hashRing, routingTable, router

beforeEach(() => {
  nock.cleanAll()

  pgPool = {
    query: jest.fn(),
    end: jest.fn().mockResolvedValue(),
  }
  redisClient = {
    hget: jest.fn().mockResolvedValue(null),
    hset: jest.fn().mockResolvedValue('OK'),
    quit: jest.fn().mockResolvedValue(),
  }

  // Always route CATALOG_ID → GITEA_URL via the routing table
  pgPool.query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT')) return { rows: [{ node_url: GITEA_URL }] }
    return { rows: [] }
  })

  hashRing = new HashRing([GITEA_URL])
  routingTable = new RoutingTable(pgPool, redisClient, hashRing)
  router = new GiteaRouter(routingTable, ADMIN_USER, ADMIN_PASS, ORG)
})

afterAll(() => nock.restore())

describe('GiteaRouter.publish', () => {
  it('resolves node via routing table, ensureRepo, commits manifest + metadata', async () => {
    // ensureRepo
    nock(GITEA_URL).post(`/api/v1/orgs/${ORG}/repos`).reply(201, { name: CATALOG_ID })
    // commitFile manifest.json: GET 404 → POST
    nock(GITEA_URL).get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`).reply(404)
    nock(GITEA_URL).post(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`).reply(201, { commit: { sha: 'sha-manifest' } })
    // commitFile .metadata.json: GET 404 → POST
    nock(GITEA_URL).get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/.metadata.json`).reply(404)
    nock(GITEA_URL).post(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/.metadata.json`).reply(201, { commit: { sha: 'sha-meta' } })

    await expect(router.publish(makeCatalog(), makeDirective(), makeContext())).resolves.not.toThrow()
    expect(nock.isDone()).toBe(true)
  })

  it('second publish for same catalogId uses PUT (blob sha forwarded for manifest)', async () => {
    const existingSha = 'existing-blob-sha'
    // ensureRepo — 409 (already exists)
    nock(GITEA_URL).post(`/api/v1/orgs/${ORG}/repos`).reply(409)
    // commitFile manifest.json: GET 200 → PUT
    nock(GITEA_URL)
      .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`)
      .reply(200, { sha: existingSha, content: Buffer.from('{}').toString('base64') })
    nock(GITEA_URL)
      .put(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`)
      .reply(200, { commit: { sha: 'new-sha' } })
    // .metadata.json: GET 200 → PUT
    nock(GITEA_URL)
      .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/.metadata.json`)
      .reply(200, { sha: 'meta-sha', content: Buffer.from('{}').toString('base64') })
    nock(GITEA_URL)
      .put(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/.metadata.json`)
      .reply(200, { commit: { sha: 'meta-new' } })

    await expect(router.publish(makeCatalog(), makeDirective(), makeContext())).resolves.not.toThrow()
    expect(nock.isDone()).toBe(true)
  })

  it('routing table INSERT called only once for same catalogId (no double-write)', async () => {
    // Route via hash ring (no Postgres hit for first call)
    let pgCallCount = 0
    pgPool.query.mockImplementation(async (sql) => {
      pgCallCount++
      if (sql.includes('INSERT')) return { rows: [] }  // INSERT
      if (pgCallCount === 1) return { rows: [] }  // first SELECT → cache miss
      return { rows: [{ node_url: GITEA_URL }] }  // re-read SELECT → authoritative row
    })

    // First publish
    nock(GITEA_URL).post(`/api/v1/orgs/${ORG}/repos`).reply(201, { name: CATALOG_ID })
    nock(GITEA_URL).get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`).reply(404)
    nock(GITEA_URL).post(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`).reply(201, { commit: { sha: 'sha1' } })
    nock(GITEA_URL).get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/.metadata.json`).reply(404)
    nock(GITEA_URL).post(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/.metadata.json`).reply(201, { commit: { sha: 'sha2' } })

    await router.publish(makeCatalog(), makeDirective(), makeContext())

    const insertCount = pgPool.query.mock.calls.filter(c => c[0].includes('INSERT')).length
    expect(insertCount).toBe(1)  // only one INSERT for this catalogId
  })

  it('sanitizeCatalogId is called — ../inject rejects with INVALID_CATALOG_ID', async () => {
    const badCatalog = makeCatalog('../inject')
    const badDirective = makeDirective('../inject')
    await expect(router.publish(badCatalog, badDirective, makeContext()))
      .rejects.toMatchObject({ code: 'INVALID_CATALOG_ID' })
  })
})

describe('GiteaRouter.read', () => {
  it('resolves node, readFile, returns manifest', async () => {
    const manifest = { id: CATALOG_ID, descriptor: { name: 'Test' } }
    const encoded = Buffer.from(JSON.stringify(manifest)).toString('base64')
    nock(GITEA_URL)
      .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`)
      .reply(200, { content: encoded, sha: 'abc' })

    const result = await router.read(CATALOG_ID)
    expect(result).toEqual(manifest)
  })

  it('unknown catalogId — 404 from Gitea → throws with NOT_FOUND code', async () => {
    nock(GITEA_URL)
      .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`)
      .reply(404)

    await expect(router.read(CATALOG_ID))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
