'use strict'
jest.mock('pg')
jest.mock('ioredis')

const request = require('supertest')
const { createApp } = require('../../../src/api/app')

// Build a mock GiteaRouter for controlled test behavior
const makeRouter = (overrides = {}) => ({
  publish: jest.fn().mockResolvedValue(undefined),
  read: jest.fn().mockResolvedValue({}),
  ...overrides,
})

const validBody = () => ({
  context: {
    action: 'catalog/publish',
    version: '2.0.0',
    networkId: 'beckn.one/test',
    messageId: 'msg-001',
    transactionId: 'txn-001',
    timestamp: '2026-05-05T10:00:00Z',
  },
  message: {
    catalogs: [{
      id: 'CAT-001',
      descriptor: { name: 'Test Catalog' },
      provider: { id: 'PROV-001', descriptor: { name: 'Provider' } },
      resources: [{ id: 'RES-001', descriptor: { name: 'Resource' } }],
    }],
    publishDirectives: [{ catalogId: 'CAT-001', catalogType: 'regular', updateMode: 'MERGE' }],
  },
})

describe('POST /catalog/publish — validation', () => {
  let app

  beforeAll(() => {
    app = createApp(makeRouter())
  })

  it('missing context → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    delete body.context
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.status).toBe('NACK')
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('wrong context.action → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    body.context.action = 'search'
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('wrong context.version → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    body.context.version = '1.0.0'
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('empty message.catalogs array → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    body.message.catalogs = []
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('catalog missing id → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    delete body.message.catalogs[0].id
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('catalog missing descriptor → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    delete body.message.catalogs[0].descriptor
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('catalog missing provider → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    delete body.message.catalogs[0].provider
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('catalog missing both resources and offers → 400 NACK INVALID_REQUEST', async () => {
    const body = validBody()
    delete body.message.catalogs[0].resources
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_REQUEST')
  })

  it('catalogId with ../ → 400 NACK INVALID_CATALOG_ID', async () => {
    const body = validBody()
    body.message.catalogs[0].id = '../etc/passwd'
    body.message.publishDirectives = [{ catalogId: '../etc/passwd', catalogType: 'regular', updateMode: 'MERGE' }]
    const res = await request(app).post('/catalog/publish').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.errorCode).toBe('INVALID_CATALOG_ID')
  })

  it('valid request → 200 ACK', async () => {
    const res = await request(app).post('/catalog/publish').send(validBody())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ACK' })
  })

  it('router.publish throws → 500 NACK INTERNAL_ERROR', async () => {
    const errRouter = makeRouter({ publish: jest.fn().mockRejectedValue(new Error('Gitea down')) })
    const errApp = createApp(errRouter)
    const res = await request(errApp).post('/catalog/publish').send(validBody())
    expect(res.status).toBe(500)
    expect(res.body.error.errorCode).toBe('INTERNAL_ERROR')
  })
})
