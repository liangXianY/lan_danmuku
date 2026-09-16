'use strict'
/** 截取控制台「匿名模式」卡片，核对开关文案。前置：主机 CDP 9224 已启动。 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

const CDP_PORT = 9224

function getTargets () {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => resolve(JSON.parse(buf)))
    }).on('error', reject)
  })
}

function cdp (target, id, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })))
    ws.on('message', data => {
      const m = JSON.parse(data.toString())
      if (m.id === id) { resolve(m.result); ws.close() }
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('cdp timeout')), 8000)
  })
}

;(async () => {
  const targets = await getTargets()
  const control = targets.find(t => t.type === 'page' && t.title.includes('控制台'))
  if (!control) throw new Error('no control page')

  await cdp(control, 1, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const card = document.getElementById('anonMode').closest('.card')
      card.scrollIntoView({ block: 'center' })
      return true
    })()`
  })
  await new Promise(r => setTimeout(r, 300))

  const shot = await cdp(control, 2, 'Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(__dirname, '..', '.e2e-anon-card.png'), Buffer.from(shot.data, 'base64'))
  console.log('saved .e2e-anon-card.png')
  process.exit(0)
})().catch(e => { console.error(e.message); process.exit(1) })
