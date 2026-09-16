'use strict'

/**
 * 公网服务器模式冒烟测试 —— 不启动 GUI，直接在进程内起 DanmakuServer：
 *   1. 游客连接、无口令发送、收到广播
 *   2. 开启房间口令后：无口令拒绝、错口令拒绝、对口令通过
 *   3. 管理员：认证成功 / 口令错误被拒 / 发固定公告 / 清屏 / 暂停恢复 / 改屏蔽词
 *   4. 静态白名单：/sender/ 放行、/admin/ 公网模式放行、/main/ 禁止
 */

const assert = require('assert')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const WebSocket = require('ws')
const { DanmakuServer } = require('../src/main/server')
const { MSG, LIMITS } = require('../src/shared/protocol')

const PORT = 17321
const ORIGIN = `http://127.0.0.1:${PORT}`
const WS_URL = `ws://127.0.0.1:${PORT}`
const ROOM_TOKEN = 'test-room-token'
const ADMIN_TOKEN = 'test-admin-token'

/** 简易等待 */
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 开一个客户端连接，返回 { ws, next } —— next(pred) 等第一条匹配的消息 */
function client () {
  const ws = new WebSocket(WS_URL)
  const queue = []
  const waiters = new Set()
  ws.on('message', raw => {
    const msg = JSON.parse(raw.toString())
    if (waiters.size) {
      const w = waiters.values().next().value
      w(msg)
    } else {
      queue.push(msg)
    }
  })
  const next = pred => new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiters.delete(w); reject(new Error('等消息超时')) }, 3000)
    const w = m => {
      if (!pred || pred(m)) {
        clearTimeout(t)
        waiters.delete(w)
        resolve(m)
      }
      // 不匹配就继续等，消息丢弃（这些都是服务端主动广播，丢一条不影响断言）
    }
    waiters.add(w)
    while (queue.length) {
      const m = queue.shift()
      if (waiters.size) w(m)
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { ws, next, opened, send: p => ws.send(JSON.stringify(p)) }
}

function httpGet (p) {
  return new Promise(resolve => {
    http.get(ORIGIN + p, res => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', () => resolve(0))
  })
}

async function main () {
  const config = {
    port: PORT,
    roomToken: '',
    adminToken: ADMIN_TOKEN,
    paused: false,
    blockedWords: ['坏词'],
    rateMax: 10,
    rateWindowMs: 3000
  }
  const setCalls = []
  const server = new DanmakuServer({
    getConfig: () => config,
    setConfig: patch => { Object.assign(config, patch); setCalls.push(patch) },
    onLog: () => {},
    allowedPrefixes: ['sender/', 'shared/', 'admin/']
  })
  const gotDanmaku = []
  server.room.onDanmaku = item => gotDanmaku.push(item)

  await server.start(PORT)
  console.log('  ✓ 服务启动，端口', PORT)

  // ---- 1. 无口令模式：游客直接能发，广播全员可见 ----
  const a = client(); await a.opened
  await a.next(m => m.type === MSG.STATS)
  const b = client(); await b.opened
  await b.next(m => m.type === MSG.STATS)
  await a.send({ type: MSG.HELLO, name: '小梁', reqId: 'h1' })
  const ackHello = await a.next(m => m.type === MSG.ACK && m.reqId === 'h1')
  assert.strictEqual(ackHello.ok, true)
  assert.strictEqual(ackHello.canSend, true)

  a.send({ type: MSG.SEND, text: '你好公网', name: '小梁', reqId: 's1' })
  const ackSend = await a.next(m => m.type === MSG.ACK && m.reqId === 's1')
  assert.strictEqual(ackSend.ok, true)
  const gotB = await b.next(m => m.type === MSG.DANMAKU)
  assert.strictEqual(gotB.item.text, '你好公网')
  assert.strictEqual(gotB.item.name, '小梁')
  console.log('  ✓ 无口令模式：游客可发送，广播正常')

  // 屏蔽词
  a.send({ type: MSG.SEND, text: '这里有坏词出现', reqId: 's2' })
  const rejBlocked = await a.next(m => m.type === MSG.REJECT && m.reqId === 's2')
  assert.strictEqual(rejBlocked.code, 'BLOCKED')
  console.log('  ✓ 屏蔽词拦截正常')

  // ---- 2. 开启房间口令 ----
  config.roomToken = ROOM_TOKEN

  const c = client(); await c.opened
  await c.next(m => m.type === MSG.STATS)
  c.send({ type: MSG.HELLO, name: '无口令', reqId: 'h1' })
  await c.next(m => m.type === MSG.ACK && m.reqId === 'h1')
  c.send({ type: MSG.SEND, text: '想发言', reqId: 's1' })
  const rejNeed = await c.next(m => m.type === MSG.REJECT && m.reqId === 's1')
  assert.strictEqual(rejNeed.code, 'NEED_TOKEN')

  const d = client(); await d.opened
  await d.next(m => m.type === MSG.STATS)
  d.send({ type: MSG.HELLO, name: '错口令', token: 'wrong', reqId: 'h1' })
  const rejBad = await d.next(m => m.type === MSG.REJECT && m.reqId === 'h1')
  assert.strictEqual(rejBad.code, 'BAD_TOKEN')

  const e = client(); await e.opened
  await e.next(m => m.type === MSG.STATS)
  e.send({ type: MSG.HELLO, name: '有口令', token: ROOM_TOKEN, reqId: 'h1' })
  await e.next(m => m.type === MSG.ACK && m.reqId === 'h1')
  e.send({ type: MSG.SEND, text: '过了口令', reqId: 's1' })
  const ackE = await e.next(m => m.type === MSG.ACK && m.reqId === 's1')
  assert.strictEqual(ackE.ok, true)
  console.log('  ✓ 房间口令：无/错/对三种情况全部正确')

  // ---- 3. 管理员 ----
  const admin = client(); await admin.opened
  await admin.next(m => m.type === MSG.STATS)
  admin.send({ type: MSG.AUTH, role: 'admin', token: 'nope', reqId: 'a0' })
  const rejAdmin = await admin.next(m => m.type === MSG.REJECT && m.reqId === 'a0')
  assert.strictEqual(rejAdmin.code, 'BAD_ADMIN_TOKEN')
  admin.send({ type: MSG.AUTH, role: 'admin', token: ADMIN_TOKEN, reqId: 'a1' })
  const ackAdmin = await admin.next(m => m.type === MSG.ACK && m.reqId === 'a1')
  assert.strictEqual(ackAdmin.ok, true)
  assert.deepStrictEqual(ackAdmin.blockedWords, ['坏词'])
  console.log('  ✓ 管理员认证：错口令拒绝、对口令通过')

  // 管理员发固定公告
  admin.send({
    type: MSG.SEND, mode: 'fixed', text: '活动开始', position: 'top', stayMs: 5000, reqId: 'a2'
  })
  const ackFixed = await admin.next(m => m.type === MSG.ACK && m.reqId === 'a2')
  assert.strictEqual(ackFixed.ok, true)
  const fixedMsg = await e.next(m => m.type === MSG.DANMAKU && m.item.mode === 'fixed')
  assert.strictEqual(fixedMsg.item.text, '活动开始')
  assert.strictEqual(fixedMsg.item.position, 'top')
  assert.strictEqual(fixedMsg.item.style, 'card') // 默认样式：卡片

  // 固定公告带样式与颜色
  admin.send({
    type: MSG.SEND, mode: 'fixed', text: '样式测试', position: 'center', style: 'plain', color: '#FF4D4F', stayMs: 3000, reqId: 'a4'
  })
  await admin.next(m => m.type === MSG.ACK && m.reqId === 'a4')
  const styledMsg = await e.next(m => m.type === MSG.DANMAKU && m.item.mode === 'fixed' && m.item.text === '样式测试')
  assert.strictEqual(styledMsg.item.style, 'plain')
  assert.strictEqual(styledMsg.item.color, '#FF4D4F')
  // 非法样式回落默认卡片
  admin.send({
    type: MSG.SEND, mode: 'fixed', text: '回落测试', position: 'bottom', style: 'nope', reqId: 'a5'
  })
  await admin.next(m => m.type === MSG.ACK && m.reqId === 'a5')
  const fallbackMsg = await e.next(m => m.type === MSG.DANMAKU && m.item.mode === 'fixed' && m.item.text === '回落测试')
  assert.strictEqual(fallbackMsg.item.style, 'card')
  console.log('  ✓ 固定公告：样式/颜色透传与回落正常')

  // 普通用户伪装固定弹幕 → 拒绝
  e.send({ type: MSG.SEND, mode: 'fixed', text: '伪装公告', reqId: 's2' })
  const rejFixed = await e.next(m => m.type === MSG.REJECT && m.reqId === 's2')
  assert.strictEqual(rejFixed.code, 'FORBIDDEN')
  console.log('  ✓ 固定公告：管理员可发，普通用户被拒')

  // 管理员暂停 / 恢复，全员收到广播
  admin.send({ type: MSG.PAUSE })
  await e.next(m => m.type === MSG.PAUSE)
  assert.strictEqual(config.paused, true)
  admin.send({ type: MSG.RESUME })
  await e.next(m => m.type === MSG.RESUME)
  assert.strictEqual(config.paused, false)
  console.log('  ✓ 管理员暂停/恢复广播正常')

  // 非管理员发控制指令 → 拒绝
  e.send({ type: MSG.CLEAR })
  const rejCtl = await e.next(m => m.type === MSG.REJECT)
  assert.strictEqual(rejCtl.code, 'FORBIDDEN')
  console.log('  ✓ 控制指令仅管理员可用')

  // 管理员改屏蔽词
  // 先验证：中途开口令后，无口令时期过校验的老连接必须重新过口令
  a.send({ type: MSG.SEND, text: '老连接还想发', reqId: 's0' })
  const rejStale = await a.next(m => m.type === MSG.REJECT && m.reqId === 's0')
  assert.strictEqual(rejStale.code, 'NEED_TOKEN')
  a.send({ type: MSG.HELLO, name: '小梁', token: ROOM_TOKEN, reqId: 'h2' })
  await a.next(m => m.type === MSG.ACK && m.reqId === 'h2')

  admin.send({ type: MSG.SET_CONFIG, config: { blockedWords: ['坏词', '新词'] }, reqId: 'a3' })
  const ackCfg = await admin.next(m => m.type === MSG.ACK && m.reqId === 'a3')
  assert.deepStrictEqual(ackCfg.config.blockedWords, ['坏词', '新词'])
  a.send({ type: MSG.SEND, text: '测试新词拦截', reqId: 's3' })
  const rejNew = await a.next(m => m.type === MSG.REJECT && m.reqId === 's3')
  assert.strictEqual(rejNew.code, 'BLOCKED')
  console.log('  ✓ 管理员在线更新屏蔽词立即生效')

  // ---- 4. 静态资源白名单 ----
  assert.strictEqual(await httpGet('/sender/'), 200)
  assert.strictEqual(await httpGet('/shared/protocol.js'), 200)
  assert.strictEqual(await httpGet('/admin/'), 200)
  assert.strictEqual(await httpGet('/admin/admin.js'), 200)
  assert.strictEqual(await httpGet('/main/main.js'), 403)
  assert.strictEqual(await httpGet('/server/main.js'), 403)
  assert.strictEqual(await httpGet('/package.json'), 403)
  assert.strictEqual(await httpGet('/health'), 200)
  console.log('  ✓ 静态白名单：sender/admin 放行，源码与配置全部 403')

  // ---- 清理 ----
  for (const cl of [a, b, c, d, e, admin]) { try { cl.ws.close() } catch { /* ignore */ } }
  await server.stop()

  console.log('\n全部通过 ✔  （公网服务器模式冒烟测试）')
}

main().catch(err => {
  console.error('\n测试失败 ✘', err)
  process.exit(1)
})
