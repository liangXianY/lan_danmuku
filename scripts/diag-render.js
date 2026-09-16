'use strict'
/**
 * 渲染层诊断脚本：通过 CDP 连进每个页面，抓 console 输出、未捕获异常，
 * 并在控制台页面里直接探测 controlApi 是否存在、getState 能否返回。
 * 用完即删，不进打包产物。
 */
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

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

async function inspect (target) {
  return new Promise(async (resolve) => {
    const lines = []
    let ws
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
    } catch (e) { resolve([`[${target.title}] ws 连接失败: ${e.message}`]); return }
    let id = 0
    const send = (method, params) => new Promise(r => {
      const mid = ++id
      const onMsg = data => {
        const m = JSON.parse(data.toString())
        if (m.id === mid) { ws.off('message', onMsg); r(m) }
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
    })
    ws.on('message', data => {
      const m = JSON.parse(data.toString())
      if (m.method === 'Runtime.consoleAPICalled') {
        const args = (m.params.args || []).map(a => a.value !== undefined ? JSON.stringify(a.value) : (a.description || a.type)).join(' ')
        lines.push(`[console.${m.params.type}] ${args}`)
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        lines.push(`[EXCEPTION] ${d.text} ${d.exception && d.exception.description ? d.exception.description : ''}`)
      }
    })
    ws.on('open', async () => {
      await send('Runtime.enable')
      await sleep(1200)
      const probe = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          hasApi: typeof window.controlApi !== 'undefined' || typeof window.overlayBridge !== 'undefined',
          readyState: document.readyState,
          scripts: Array.from(document.scripts).map(s => s.src),
          statusTitle: (document.getElementById('statusTitle')||{}).textContent || null
        })`,
        returnByValue: true
      })
      lines.push(`[probe] ${JSON.stringify(probe.result && probe.result.result && probe.result.result.value)}`)
      if (typeof window === 'undefined') { /* noop */ }
      // 再试一次 getState
      const gs = await send('Runtime.evaluate', {
        expression: `window.controlApi ? window.controlApi.getState().then(s => 'port=' + s.port + ' url=' + s.url + ' errs=' + JSON.stringify(s.logs ? s.logs.slice(-5) : [])).catch(e => 'REJECT ' + e.message) : 'no controlApi'`,
        returnByValue: true,
        awaitPromise: true
      })
      lines.push(`[getState] ${JSON.stringify(gs.result && gs.result.result && gs.result.result.value)}`)
      ws.close()
      resolve(lines)
    })
    ws.on('error', e => resolve([`[${target.title}] ws error: ${e.message}`]))
    setTimeout(() => resolve(lines), 8000)
  })
}

;(async () => {
  const targets = await getTargets()
  console.log('targets:', targets.map(t => `${t.type}:${t.title}`).join(' | '))
  const pages = targets.filter(t => t.type === 'page')
  for (const t of pages) {
    console.log(`\n===== ${t.title} (${t.url}) =====`)
    const out = await inspect(t)
    out.forEach(l => console.log(l))
  }
  process.exit(0)
})().catch(e => { console.error('diag failed:', e); process.exit(1) })
