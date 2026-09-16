'use strict'
/** CDP 点击工具：在指定标题的页面里执行一段表达式。 */
const http = require('http')
const WebSocket = require('ws')

function getTargets () {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/list', res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

;(async () => {
  const port = process.argv[2] || '9222'
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => resolve(JSON.parse(buf)))
    }).on('error', reject)
  })
  const pages = targets.filter(t => t.type === 'page')
  console.log('pages:', pages.map(t => t.title).join(' | '))

  const expr = process.argv[3]
  if (!expr) { process.exit(0) }

  const target = pages.find(t => t.title.includes(process.argv[4] || '')) || pages[0]
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  ws.on('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { returnByValue: true, expression: expr }
    }))
  })
  ws.on('message', data => {
    const m = JSON.parse(data.toString())
    if (m.id === 1) {
      console.log(JSON.stringify(m.result && m.result.result && m.result.result.value))
      ws.close(); process.exit(0)
    }
  })
  setTimeout(() => { console.log('timeout'); process.exit(1) }, 6000)
})().catch(e => { console.error(e.message); process.exit(1) })
