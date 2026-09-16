'use strict'
/**
 * 强制实名（服务器级开关）专项测试：
 *   开（forceNickname=true）→ 发送端不能匿名：没填昵称的发言被拒（NEED_NAME），
 *      显式传「匿名」也算没填；填了昵称正常上屏；固定公告不受影响。
 *   关（默认）→ 允许匿名：不填昵称显示「匿名」（原始行为）。
 *   HELLO 回执带 namePolicy：'required' | 'free'。
 */
const { Room } = require('../src/main/room')
const { REJECT } = require('../src/shared/protocol')

function makeRoom (cfg) {
  return new Room({
    getConfig: () => cfg,
    onDanmaku: () => {},
    onStats: () => {},
    onLog: () => {},
    onClear: () => {}
  })
}

let pass = 0
let fail = 0
function check (name, cond, extra) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) } else { fail++; console.log(`  [FAIL] ${name}${extra ? ' → ' + extra : ''}`) }
}

function fakeWs () {
  return { readyState: 1, send: () => {}, on: () => {} }
}

async function main () {
  // ---------------- 强制实名：开 ----------------
  {
    const room = makeRoom({ forceNickname: true, rateMax: 100, rateWindowMs: 1000 })
    const ws = fakeWs()
    room.addClient(ws, { socket: { remoteAddress: '192.168.1.42' } })
    const client = room.clients.get(ws)

    let got = null
    ws.send = payload => { got = JSON.parse(payload) }
    room.handleHello(ws, client, { type: 'hello', name: '', reqId: 'h1' })
    check('HELLO 回执带 namePolicy=required', got && got.namePolicy === 'required')

    // 不填昵称发送 → 拒绝 NEED_NAME
    const r1 = room.publish({ text: '没名字想发言', name: '', fallbackName: '', rateKey: 'a' })
    check('强制实名：没昵称被拒 NEED_NAME', !r1.ok && r1.code === REJECT.NEED_NAME, JSON.stringify(r1))

    // 硬传「匿名」→ 也按没填处理
    const r2 = room.publish({ text: '硬传匿名', name: '匿名', fallbackName: '', rateKey: 'a' })
    check('强制实名：硬传「匿名」也被拒', !r2.ok && r2.code === REJECT.NEED_NAME)

    // 连接注册过昵称（HELLO 带过）→ 用注册名，不拒
    client.name = '小张'
    const r3 = room.publish({ text: '注册过名字', name: '', fallbackName: client.name, rateKey: 'a' })
    check('强制实名：HELLO 注册过昵称可发言', r3.ok && r3.item.name === '小张')

    // 填了昵称 → 正常
    const r4 = room.publish({ text: '填了名字', name: 'E2E李', fallbackName: '', rateKey: 'a' })
    check('强制实名：填昵称正常显示', r4.ok && r4.item.name === 'E2E李')

    // 固定公告是主机身份，不受强制实名影响
    const r5 = room.publishFixed({ text: '中场休息', position: 'top', stayMs: 8000 })
    check('强制实名：固定公告正常（主机）', r5.ok && r5.item.name === '主机')

    room.destroy()
  }

  // ---------------- 强制实名：关（默认，允许匿名） ----------------
  {
    const room = makeRoom({ forceNickname: false, rateMax: 100, rateWindowMs: 1000 })
    const ws = fakeWs()
    room.addClient(ws, { socket: { remoteAddress: '192.168.1.42' } })

    let got = null
    ws.send = payload => { got = JSON.parse(payload) }
    room.handleHello(ws, room.clients.get(ws), { type: 'hello', name: '', reqId: 'h1' })
    check('HELLO 回执带 namePolicy=free', got && got.namePolicy === 'free')

    // 不填昵称 → 显示「匿名」（原始行为）
    const r1 = room.publish({ text: '匿名一条', name: '', fallbackName: '', rateKey: 'b' })
    check('关闭强制实名：不填昵称显示「匿名」', r1.ok && r1.item.name === '匿名')

    // 填昵称 → 昵称
    const r2 = room.publish({ text: '实名一条', name: 'E2E王', fallbackName: '', rateKey: 'b' })
    check('关闭强制实名：昵称正常显示', r2.ok && r2.item.name === 'E2E王')

    room.destroy()
  }

  console.log('====================================================')
  console.log(`共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
  console.log('====================================================')
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
