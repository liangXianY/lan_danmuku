'use strict'
/** 模拟浏览器行为验证发送页链路：HTTP 资源 + 带 Origin 的 WS 握手。用完即删。 */
const http = require('http')
const WebSocket = require('ws')

const HOST = process.argv[2] || '192.168.11.26'
const PORT = Number(process.argv[3]) || 7321

function fetchPath (p) {
  return new Promise(resolve => {
    http.get({ host: HOST, port: PORT, path: p }, res => {
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'],
        nosniff: res.headers['x-content-type-options'],
        len: Buffer.concat(chunks).length,
        head: Buffer.concat(chunks).toString('utf8', 0, 80).replace(/\n/g, ' ')
      }))
    }).on('error', e => resolve({ error: e.message }))
  })
}

function wsHandshake (withOrigin) {
  return new Promise(resolve => {
    const headers = {}
    if (withOrigin) headers.Origin = `http://${HOST}:${PORT}`
    const ws = new WebSocket(`ws://${HOST}:${PORT}`, { headers, handshakeTimeout: 4000 })
    const done = r => { try { ws.terminate() } catch {} resolve(r) }
    ws.on('open', () => done('OPEN'))
    ws.on('error', e => done('ERROR: ' + e.message))
    ws.on('unexpected-response', (_req, res) => done('HTTP ' + res.statusCode))
    setTimeout(() => done('TIMEOUT'), 5000)
  })
}

;(async () => {
  for (const p of ['/', '/sender/index.html', '/sender/sender.css', '/sender/app.js', '/shared/protocol.js']) {
    const r = await fetchPath(p)
    console.log(p, '=>', JSON.stringify(r))
  }
  console.log('WS no-origin =>', await wsHandshake(false))
  console.log('WS with-origin =>', await wsHandshake(true))
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
