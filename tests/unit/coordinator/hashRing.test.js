'use strict'
const { HashRing } = require('../../../src/coordinator/hashRing')

describe('HashRing', () => {
  const nodes = ['http://gitea-1:3000', 'http://gitea-2:3000', 'http://gitea-3:3000']

  it('throws when constructed with empty node list', () => {
    expect(() => new HashRing([])).toThrow('HashRing requires at least one node')
  })

  it('single node always returns that node', () => {
    const ring = new HashRing(['http://gitea-1:3000'])
    for (let i = 0; i < 100; i++) {
      expect(ring.getNode(`catalog-${i}`)).toBe('http://gitea-1:3000')
    }
  })

  it('same catalogId always maps to same node (deterministic)', () => {
    const ring = new HashRing(nodes)
    const first = ring.getNode('CAT-GROCERY-FRESHMART-001')
    for (let i = 0; i < 50; i++) {
      expect(ring.getNode('CAT-GROCERY-FRESHMART-001')).toBe(first)
    }
  })

  it('two rings with same nodes produce identical routing', () => {
    const ring1 = new HashRing(nodes)
    const ring2 = new HashRing(nodes)
    for (let i = 0; i < 200; i++) {
      const id = `CAT-${Math.random().toString(36).slice(2)}`
      expect(ring1.getNode(id)).toBe(ring2.getNode(id))
    }
  })

  it('ring has exactly nodeCount * virtualNodes entries', () => {
    const ring = new HashRing(nodes, 150)
    expect(ring.ring.length).toBe(nodes.length * 150)
  })

  it('distributes 1000 IDs roughly evenly across 3 nodes (20–80% each)', () => {
    const ring = new HashRing(nodes)
    const counts = {}
    nodes.forEach(n => { counts[n] = 0 })
    for (let i = 0; i < 1000; i++) {
      counts[ring.getNode(`catalog-id-${i}`)]++
    }
    nodes.forEach(n => {
      expect(counts[n]).toBeGreaterThan(200)
      expect(counts[n]).toBeLessThan(800)
    })
  })

  it('adding a node changes at most 1/(N+1) + 10% of assignments (consistent hash property)', () => {
    const ring3 = new HashRing(nodes)
    const ring4 = new HashRing([...nodes, 'http://gitea-4:3000'])
    let changed = 0
    const total = 1000
    for (let i = 0; i < total; i++) {
      const id = `catalog-id-${i}`
      if (ring3.getNode(id) !== ring4.getNode(id)) changed++
    }
    // Expect at most ~35% to change (ideal is 25% for 3→4 nodes)
    expect(changed / total).toBeLessThan(0.35)
  })

  it('handles wrap-around (ID that hashes beyond last vnode)', () => {
    const ring = new HashRing(nodes)
    // Force a very high hash value by testing many IDs — wrap-around must not return undefined
    for (let i = 0; i < 500; i++) {
      const node = ring.getNode(`wrap-test-${i}`)
      expect(nodes).toContain(node)
    }
  })
})
