'use strict'

// Mock pg and ioredis before requiring the module under test
jest.mock('pg')
jest.mock('ioredis')

const { Pool } = require('pg')
const Redis = require('ioredis')
const { HashRing } = require('../../../src/coordinator/hashRing')
const { RoutingTable, sanitizeCatalogId } = require('../../../src/coordinator/routingTable')

describe('sanitizeCatalogId', () => {
  it('accepts valid catalog IDs', () => {
    expect(sanitizeCatalogId('CAT-GROCERY-001')).toBe('CAT-GROCERY-001')
    expect(sanitizeCatalogId('CAT_RETAIL_FRESHMART_005')).toBe('CAT_RETAIL_FRESHMART_005')
  })

  it('rejects path traversal: ../', () => {
    expect(() => sanitizeCatalogId('../etc/passwd')).toThrow()
  })

  it('rejects forward slash: /', () => {
    expect(() => sanitizeCatalogId('foo/bar')).toThrow()
  })

  it('rejects backslash: \\', () => {
    expect(() => sanitizeCatalogId('foo\\bar')).toThrow()
  })

  it('rejects null byte', () => {
    expect(() => sanitizeCatalogId('foo\x00bar')).toThrow()
  })
})

describe('RoutingTable.resolve', () => {
  let pgPool, redisClient, hashRing, table

  beforeEach(() => {
    // Set up pg Pool mock
    pgPool = {
      query: jest.fn(),
      end: jest.fn().mockResolvedValue(),
    }

    // Set up ioredis mock
    redisClient = {
      hget: jest.fn(),
      hset: jest.fn().mockResolvedValue('OK'),
      quit: jest.fn().mockResolvedValue(),
    }

    hashRing = new HashRing(['http://gitea-1:3000', 'http://gitea-2:3000', 'http://gitea-3:3000'])
    table = new RoutingTable(pgPool, redisClient, hashRing)
  })

  it('Redis cache hit → returns node, zero Postgres queries', async () => {
    redisClient.hget.mockResolvedValue('http://gitea-2:3000')

    const node = await table.resolve('CAT-001')

    expect(node).toBe('http://gitea-2:3000')
    expect(pgPool.query).not.toHaveBeenCalled()
  })

  it('Redis miss + Postgres hit → returns node, populates Redis', async () => {
    redisClient.hget.mockResolvedValue(null)
    pgPool.query.mockResolvedValue({ rows: [{ node_url: 'http://gitea-1:3000' }] })

    const node = await table.resolve('CAT-002')

    expect(node).toBe('http://gitea-1:3000')
    expect(redisClient.hset).toHaveBeenCalledWith('catalog-routing', 'CAT-002', 'http://gitea-1:3000')
  })

  it('Redis miss + Postgres miss → calls hash ring, INSERTs Postgres, HGETs Redis', async () => {
    redisClient.hget.mockResolvedValue(null)
    pgPool.query
      .mockResolvedValueOnce({ rows: [] })           // SELECT → no row (cache miss)
      .mockResolvedValueOnce({ rows: [] })           // INSERT
      .mockResolvedValueOnce({ rows: [{ node_url: 'http://gitea-1:3000' }] })  // re-read SELECT

    const node = await table.resolve('CAT-003')

    expect(node).toBe('http://gitea-1:3000')
    // Postgres INSERT called with ON CONFLICT DO NOTHING
    const insertCall = pgPool.query.mock.calls[1]
    expect(insertCall[0]).toMatch(/INSERT INTO catalog_routing/)
    expect(insertCall[0]).toMatch(/ON CONFLICT DO NOTHING/)
    // Redis populated with the authoritative re-read value
    expect(redisClient.hset).toHaveBeenCalledWith('catalog-routing', 'CAT-003', 'http://gitea-1:3000')
  })

  it('Postgres INSERT before Redis HSET (write order invariant)', async () => {
    redisClient.hget.mockResolvedValue(null)

    const callOrder = []
    let pgCallCount = 0
    pgPool.query.mockImplementation(async (sql) => {
      callOrder.push('pg')
      pgCallCount++
      if (pgCallCount === 1) return { rows: [] }        // first SELECT → miss
      if (sql.includes('INSERT')) return { rows: [] }    // INSERT
      return { rows: [{ node_url: 'http://gitea-1:3000' }] }  // re-read SELECT
    })
    redisClient.hset.mockImplementation(async () => {
      callOrder.push('redis')
      return 'OK'
    })

    await table.resolve('CAT-004')

    const pgIdx = callOrder.lastIndexOf('pg')
    const redisIdx = callOrder.indexOf('redis')
    expect(pgIdx).toBeLessThan(redisIdx)
  })

  it('adding a new node to ring does not change existing Postgres entries', async () => {
    // CAT-001 has a Postgres record pointing to gitea-1
    redisClient.hget.mockResolvedValue(null)
    pgPool.query.mockResolvedValue({ rows: [{ node_url: 'http://gitea-1:3000' }] })

    // Even with a 4-node ring, existing record wins
    const ring4 = new HashRing([
      'http://gitea-1:3000', 'http://gitea-2:3000',
      'http://gitea-3:3000', 'http://gitea-4:3000'
    ])
    const table4 = new RoutingTable(pgPool, redisClient, ring4)

    const node = await table4.resolve('CAT-001')
    expect(node).toBe('http://gitea-1:3000')
    // No INSERT — existing record was found
    expect(pgPool.query.mock.calls.every(c => !c[0].includes('INSERT'))).toBe(true)
  })

  it('close() calls pg.end() and redis.quit()', async () => {
    await table.close()
    expect(pgPool.end).toHaveBeenCalled()
    expect(redisClient.quit).toHaveBeenCalled()
  })
})
