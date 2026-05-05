'use strict'
const nock = require('nock')
const { GiteaClient } = require('../../../src/gitea/giteaClient')

const BASE_URL = 'http://gitea-test:3000'
const ADMIN_USER = 'gitea_admin'
const ADMIN_PASS = 'gitea_admin_pass'
const EXPECTED_AUTH = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`
const ORG = 'beckn'
const CATALOG_ID = 'CAT-GROCERY-001'

beforeEach(() => nock.cleanAll())
afterAll(() => nock.restore())

describe('GiteaClient', () => {
  let client

  beforeEach(() => {
    client = new GiteaClient(BASE_URL, ADMIN_USER, ADMIN_PASS, ORG)
  })

  describe('ensureRepo', () => {
    it('creates repo successfully (201)', async () => {
      nock(BASE_URL)
        .post(`/api/v1/orgs/${ORG}/repos`)
        .reply(201, { name: CATALOG_ID })

      await expect(client.ensureRepo(CATALOG_ID)).resolves.not.toThrow()
    })

    it('is idempotent — 409 already exists does not throw', async () => {
      nock(BASE_URL)
        .post(`/api/v1/orgs/${ORG}/repos`)
        .reply(409, { message: 'The repository with the same name already exists.' })

      await expect(client.ensureRepo(CATALOG_ID)).resolves.not.toThrow()
    })

    it('sends Authorization header on every call', async () => {
      nock(BASE_URL, { reqheaders: { authorization: EXPECTED_AUTH } })
        .post(`/api/v1/orgs/${ORG}/repos`)
        .reply(201, { name: CATALOG_ID })

      await client.ensureRepo(CATALOG_ID)
      expect(nock.isDone()).toBe(true)
    })
  })

  describe('commitFile', () => {
    const filePath = 'manifest.json'
    const contentObj = { id: CATALOG_ID, descriptor: { name: 'Test' } }
    const message = 'catalog publish'

    it('first commit: GET returns 404 → uses POST', async () => {
      nock(BASE_URL)
        .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/${filePath}`)
        .reply(404, { message: 'Not Found' })
      nock(BASE_URL)
        .post(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/${filePath}`)
        .reply(201, { commit: { sha: 'abc123' } })

      const result = await client.commitFile(CATALOG_ID, filePath, contentObj, message)
      expect(result).toHaveProperty('commitSha')
      expect(nock.isDone()).toBe(true)
    })

    it('subsequent commit: GET returns 200 with sha → uses PUT with sha', async () => {
      const existingSha = 'deadbeef1234'
      nock(BASE_URL)
        .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/${filePath}`)
        .reply(200, { sha: existingSha, content: Buffer.from('{}').toString('base64') })
      nock(BASE_URL)
        .put(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/${filePath}`)
        .reply(200, { commit: { sha: 'newsha456' } })

      const result = await client.commitFile(CATALOG_ID, filePath, contentObj, message)
      expect(result).toHaveProperty('commitSha')
      expect(nock.isDone()).toBe(true)
    })

    it('throws on non-2xx, non-404/409 HTTP error from Gitea', async () => {
      nock(BASE_URL)
        .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/${filePath}`)
        .reply(500, { message: 'Internal Server Error' })

      await expect(client.commitFile(CATALOG_ID, filePath, contentObj, message))
        .rejects.toThrow(/500/)
    })
  })

  describe('readFile', () => {
    it('returns parsed JSON content on success', async () => {
      const expected = { id: CATALOG_ID, descriptor: { name: 'Test' } }
      const encoded = Buffer.from(JSON.stringify(expected)).toString('base64')
      nock(BASE_URL)
        .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`)
        .reply(200, { content: encoded, sha: 'abc' })

      const result = await client.readFile(CATALOG_ID, 'manifest.json')
      expect(result).toEqual(expected)
    })

    it('returns null on 404', async () => {
      nock(BASE_URL)
        .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/contents/manifest.json`)
        .reply(404, { message: 'Not Found' })

      const result = await client.readFile(CATALOG_ID, 'manifest.json')
      expect(result).toBeNull()
    })
  })

  describe('getHistory', () => {
    it('returns array of { sha, message, timestamp }', async () => {
      nock(BASE_URL)
        .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/commits`)
        .query(true)
        .reply(200, [
          { sha: 'abc123', commit: { message: 'catalog publish', author: { date: '2026-05-05T10:00:00Z' } } },
          { sha: 'def456', commit: { message: 'catalog update', author: { date: '2026-05-05T09:00:00Z' } } },
        ])

      const result = await client.getHistory(CATALOG_ID)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ sha: 'abc123', message: 'catalog publish', timestamp: '2026-05-05T10:00:00Z' })
    })

    it('returns empty array when no commits', async () => {
      nock(BASE_URL)
        .get(`/api/v1/repos/${ORG}/${CATALOG_ID}/commits`)
        .query(true)
        .reply(200, [])

      const result = await client.getHistory(CATALOG_ID)
      expect(result).toEqual([])
    })
  })
})
