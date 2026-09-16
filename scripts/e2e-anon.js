'use strict'
/**
 * 强制实名 E2E：真实 Electron 主机 + 真实 ws 客户端。
 * 前置：主机已以 --remote-debugging-port=9224 启动（LAN_DANMAKU_USERDATA=e2e7，mode=host）。
 * 验证链路：
 *   控制台勾选「关闭所有人的匿名」→ config.forceNickname 落盘 + ws 广播 CONFIG{namePolicy:required}
 *   开：不填昵称发送 → 收到 REJECT need_name；填昵称 → 正常上屏
 *   关：不填昵称发送 → 正常上屏「匿名」
 */
const http = require('http')
const path = require('path')
const fs = require('fs')
const WebSocket = require('ws')

const CDP_PORT = 9224
const USERDATA = path.join(process.env.APPDATA, 'lan-danmaku-e2e7', 'config.json')

let pass = 0
let fail = 0
function check (name, cond, extra) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) } else { fail++; console.log(`  [FAIL] ${name}${extra ? ' -> ' + extra : ''}`) }
}

function getTargets () {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => resolve(JSON.parse(buf)))
    }).on('error', reject)
  })
}

function cdpEval (target, expr) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: true, expression: expr } }))
    })
    ws.on('message', data => {
      const m = JSON.parse(data.toString())
      if (m.id === 1) {
        const r = m.result && m.result.result
        resolve(r ? r.value : undefined)
        ws.close()
      }
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('cdp eval timeout')), 8000)
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function readConfig () {
  return JSON.parse(fs.readFileSync(USERDATA, 'utf8'))
}

async function main () {
  const targets = await getTargets()
  const control = targets.find(t => t.type === 'page' && t.title.includes('控制台'))
  if (!control) throw new Error('找不到控制台页面: ' + targets.map(t => t.title).join('|'))

  const bootState = await cdpEval(control, `controlApi.getState()`)
  const serverPort = bootState && bootState.port
  if (!serverPort) throw new Error('拿不到服务端口')

  // 先确保强制实名是关的（上轮测试可能残留 true）
  const checked0 = await cdpEval(control, `document.getElementById('anonMode').checked`)
  if (checked0 === true) {
    await cdpEval(control, `document.getElementById('anonMode').click(); true`)
    await sleep(500)
  }

  const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`)
  const inbox = []
  ws.on('message', d => inbox.push(JSON.parse(d.toString())))
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  ws.send(JSON.stringify({ type: 'hello', name: '', reqId: 'join' }))
  await sleep(400)
  const helloAck = inbox.find(m => m.type === 'ack')
  check('HELLO 回执带 namePolicy=free（初始）', helloAck && helloAck.namePolicy === 'free', JSON.stringify(helloAck))

  // ---------------- 勾选：强制实名开 ----------------
  inbox.length = 0
  await cdpEval(control, `document.getElementById('anonMode').click(); true`)
  await sleep(600)
  const cfg1 = readConfig()
  check('点击后 config.forceNickname=true 已落盘', cfg1.forceNickname === true, JSON.stringify(cfg1.forceNickname))
  const cfgMsg = inbox.find(m => m.type === 'config')
  check('ws 客户端收到 CONFIG 广播 namePolicy=required', cfgMsg && cfgMsg.config && cfgMsg.config.namePolicy === 'required', JSON.stringify(inbox.map(m => m.type)))

  // 不填昵称发送 → REJECT need_name
  inbox.length = 0
  ws.send(JSON.stringify({ type: 'send', reqId: 's1', text: '强制实名没名字', name: '' }))
  await sleep(500)
  let rej = inbox.find(m => m.type === 'reject')
  check('强制实名开：不填昵称被拒（NEED_NAME）', rej && rej.code === 'NEED_NAME', rej && JSON.stringify(rej))

  // 硬传「匿名」→ 仍被拒
  inbox.length = 0
  ws.send(JSON.stringify({ type: 'send', reqId: 's2', text: '强制实名硬传匿名', name: '匿名' }))
  await sleep(500)
  rej = inbox.find(m => m.type === 'reject')
  check('强制实名开：硬传「匿名」也被拒', rej && rej.code === 'NEED_NAME')

  // 填昵称 → 正常上屏
  inbox.length = 0
  ws.send(JSON.stringify({ type: 'send', reqId: 's3', text: '强制实名填了名字', name: 'E2E张' }))
  await sleep(500)
  let dm = inbox.find(m => m.type === 'danmaku' && m.item && m.item.text === '强制实名填了名字')
  check('强制实名开：填昵称正常上屏', dm && dm.item.name === 'E2E张', dm && JSON.stringify(dm.item && dm.item.name))

  // ---------------- 取消勾选：恢复允许匿名 ----------------
  inbox.length = 0
  await cdpEval(control, `document.getElementById('anonMode').click(); true`)
  await sleep(600)
  const cfg2 = readConfig()
  check('再次点击后 config.forceNickname=false', cfg2.forceNickname === false)
  const cfgMsg2 = inbox.find(m => m.type === 'config')
  check('ws 客户端收到 CONFIG 广播 namePolicy=free', cfgMsg2 && cfgMsg2.config && cfgMsg2.config.namePolicy === 'free')

  // 不填昵称 → 连接记住了上次的昵称（E2E张），继续用它；验证匿名需新连接
  inbox.length = 0
  ws.send(JSON.stringify({ type: 'send', reqId: 's4', text: '关掉实名沿用昵称', name: '' }))
  await sleep(500)
  dm = inbox.find(m => m.type === 'danmaku' && m.item && m.item.text === '关掉实名沿用昵称')
  check('强制实名关：沿用记住的昵称', dm && dm.item.name === 'E2E张', dm && JSON.stringify(dm.item && dm.item.name))

  // 全新连接、什么都不填 → 「匿名」上屏（原始行为恢复）
  const ws2 = new WebSocket(`ws://127.0.0.1:${serverPort}`)
  const inbox2 = []
  ws2.on('message', d => inbox2.push(JSON.parse(d.toString())))
  await new Promise((resolve, reject) => { ws2.on('open', resolve); ws2.on('error', reject) })
  ws2.send(JSON.stringify({ type: 'hello', name: '', reqId: 'join' }))
  await sleep(400)
  ws2.send(JSON.stringify({ type: 'send', reqId: 's5', text: '关掉实名匿名一条', name: '' }))
  await sleep(500)
  dm = inbox2.find(m => m.type === 'danmaku' && m.item && m.item.text === '关掉实名匿名一条')
  check('强制实名关：全新连接不填昵称显示「匿名」', dm && dm.item.name === '匿名', dm && JSON.stringify(dm.item && dm.item.name))
  ws2.close()

  ws.close()
  console.log('====================================================')
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
  console.log('====================================================')
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error('E2E 失败：', err.message); process.exit(1) })
