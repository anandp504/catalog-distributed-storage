'use strict'
jest.mock('pg')
jest.mock('ioredis')

const request = require('supertest')
const { createApp } = require('../../../src/api/app')

describe('GET /catalog/:catalogId', () => {
  it('existing catalog → 200 + manifest JSON', async () => {
    const manifest = { id: 'CAT-001', descriptor: { name: 'Test' } }
    const router = { publish: jest.fn(), read: jest.fn().mockResolvedValue(manifest) }
    const app = createApp(router)

    const res = await request(app).get('/catalog/CAT-001')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(manifest)
  })

  it('unknown catalogId → 404 NACK NOT_FOUND', async () => {
    const err = new Error('not found')
    err.code = 'NOT_FOUND'
    const router = { publish: jest.fn(), read: jest.fn().mockRejectedValue(err) }
    const app = createApp(router)

    const res = await request(app).get('/catalog/CAT-UNKNOWN')
    expect(res.status).toBe(404)
    expect(res.body.status).toBe('NACK')
    expect(res.body.error.errorCode).toBe('NOT_FOUND')
  })

  it('invalid catalogId (path traversal) → 400 NACK INVALID_CATALOG_ID', async () => {
    const err = new Error('Invalid catalogId')
    err.code = 'INVALID_CATALOG_ID'
    const router = { publish: jest.fn(), read: jest.fn().mockRejectedValue(err) }
    const app = createApp(router)

    const res = await request(app).get('/catalog/..%2Fetc%2Fpasswd')
    expect(res.status).toBe(400)
    expect(res.body.status).toBe('NACK')
    expect(res.body.error.errorCode).toBe('INVALID_CATALOG_ID')
  })
})
