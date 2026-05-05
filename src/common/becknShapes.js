'use strict'
const ack = () => ({ status: 'ACK' })
const nack = (errorCode, errorMessage) => ({ status: 'NACK', error: { errorCode, errorMessage } })
module.exports = { ack, nack }
