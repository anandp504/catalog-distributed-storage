'use strict'
describe('smoke', () => {
  it('loads app module without error', () => {
    expect(() => require('../../src/api/app')).not.toThrow()
  })
  it('loads becknShapes without error', () => {
    const { ack, nack } = require('../../src/common/becknShapes')
    expect(ack()).toEqual({ status: 'ACK' })
    expect(nack('E', 'm')).toEqual({ status: 'NACK', error: { errorCode: 'E', errorMessage: 'm' } })
  })
})
