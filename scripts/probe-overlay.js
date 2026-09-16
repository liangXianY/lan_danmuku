'use strict'
/** 探测弹幕层 DOM：确认 .dm 节点真实存在、颜色正确。用完即删。 */
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
  const targets = await getTargets()
  const overlay = targets.find(t => t.type === 'page' && t.title === 'Danmaku Overlay')
  if (!overlay) { console.log('overlay target not found'); process.exit(1) }
  const ws = new WebSocket(overlay.webSocketDebuggerUrl, { perMessageDeflate: false })
  ws.on('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
          const nodes = Array.from(document.querySelectorAll('.dm'))
          return JSON.stringify({
            total: nodes.length,
            samples: nodes.slice(-6).map(n => ({ text: n.textContent, color: n.style.color }))
          })
        })()`
      }
    }))
  })
  ws.on('message', data => {
    const m = JSON.parse(data.toString())
    if (m.id === 1) {
      console.log(m.result && m.result.result && m.result.result.value)
      ws.close(); process.exit(0)
    }
  })
  setTimeout(() => { console.log('timeout'); process.exit(1) }, 6000)
})()
