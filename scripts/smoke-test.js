'use strict'

/**
 * 冒烟测试：脱离 Electron，直接验证服务端 + 协议 + 静态资源这一整条链路。
 *
 *   node scripts/smoke-test.js
 *
 * 之所以能这么测，是因为 server/room/net/protocol 全是不依赖 electron 的纯 Node 模块，
 * 只有 main.js 才碰 GUI。这样改协议的时候不用开窗口就能验证。
 */

const path = require('path')
const http = require('http')
const WebSocket = require('ws')
const { DanmakuServer } = require('../src/main/server')
const { JoinClient, parseHostInput } = require('../src/main/join-client')
const { MSG, LIMITS } = require('../src/shared/protocol')

const PORT = 17321

const config = {
  port: PORT,
  fontSize: 26,
  scrollDuration: 9,
  laneGap: 28,
  opacity: 0.96,
  showName: false,
  paused: false,
  blockedWords: ['广告', 'deFault'],
  rateMax: 100,
  rateWindowMs: 1000
}

const getConfig = () => config

const results = []
function check (name, ok, detail) {
  results.push({ name, ok })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${name}${detail ? '  → ' + detail : ''}`)
}

function waitFor (ws, predicate, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('等待消息超时'))
    }, timeout)
    function onMessage (data) {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (!predicate(msg)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(msg)
    }
    ws.on('message', onMessage)
  })
}

/**
 * 客户端封装。
 * 关键点：message 监听必须在 await open 之前就挂上——服务端在连接建立的同一拍就推 stats，
 * 如果等 open 的 Promise resolve 之后再挂监听，那条消息会被静默丢掉（真实发送页没这个问题，
 * 它的监听在 new WebSocket 之后立即挂载）。
 */
function openClient (port, query) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${query ? '?' + query : ''}`)
  const inbox = []
  const waiters = []

  ws.on('message', data => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    // 必须按谓词匹配交付：不匹配的消息进 inbox，否则等待 REJECT 的 waiter
    // 会被先到的 ACK 抢走，测试结果就会错乱
    const waiterIdx = waiters.findIndex(w => w.predicate(msg))
    if (waiterIdx >= 0) {
      const waiter = waiters.splice(waiterIdx, 1)[0]
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    } else {
      inbox.push(msg)
    }
  })

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    setTimeout(() => reject(new Error('连接超时')), 4000)
  })

  return {
    ws,
    inbox,
    opened,
    send (obj) { ws.send(JSON.stringify(obj)) },
    waitFor (predicate, timeout = 4000) {
      const idx = inbox.findIndex(predicate)
      if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject }
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error('等待消息超时，最近收到：' + JSON.stringify(inbox.slice(-5))))
        }, timeout)
        waiters.push(waiter)
      })
    }
  }
}

function httpGet (port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 4000 }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('http 超时')) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ------------------------------------------------------------------ 主流程

async function main () {
  let server = new DanmakuServer({ getConfig, onLog: () => {} })
  const port = await server.start(PORT)

  console.log('\n— 服务与静态资源 —')
  check('服务成功监听', port === PORT, `port=${port}`)

  const health = await httpGet(port, '/health')
  check('GET /health 返回 200', health.status === 200)
  check('health 是合法 JSON', (() => {
    try { return JSON.parse(health.body).ok === true } catch { return false }
  })())

  // （旧断言"GET / 直接返回发送页"已废弃：根路径现在 301 到 /sender/，
  //   目的是让页面相对资源引用落在白名单前缀下，见下方回归用例）

  // 回归用例：根路径必须 301 到 /sender/，页面相对资源（sender.css / app.js）
  // 才会落在白名单前缀下。之前内容直接挂在 / 上，相对引用全 403，
  // 浏览器端表现为"裸 HTML + 永远连接中"。
  const root = await httpGet(port, '/')
  check('GET / 301 跳转到 /sender/', root.status === 301 && root.headers.location === '/sender/',
    `status=${root.status} loc=${root.headers.location}`)
  const shared = await httpGet(port, '/shared/protocol.js')
  check('GET /shared/protocol.js 可访问', shared.status === 200)

  const senderDir = await httpGet(port, '/sender/')
  check('GET /sender/ 返回发送页', senderDir.status === 200 && senderDir.body.includes('发弹幕'))

  // 模拟浏览器解析相对路径后的真实请求
  const relCss = await httpGet(port, '/sender/sender.css')
  check('GET /sender/sender.css 可访问（相对引用回归）', relCss.status === 200 &&
    /text\/css/.test(relCss.headers['content-type'] || ''), `status=${relCss.status}`)

  const relJs = await httpGet(port, '/sender/app.js')
  check('GET /sender/app.js 可访问（相对引用回归）', relJs.status === 200 &&
    /javascript/.test(relJs.headers['content-type'] || ''), `status=${relJs.status}`)

  const bareSender = await httpGet(port, '/sender')
  check('GET /sender 301 到 /sender/', bareSender.status === 301 && bareSender.headers.location === '/sender/')

  const appJs = await httpGet(port, '/sender/app.js')
  check('GET /sender/app.js 可访问', appJs.status === 200)

  const forbidden1 = await httpGet(port, '/main/main.js')
  check('拒绝访问 /main/（目录白名单生效）', forbidden1.status === 403, `status=${forbidden1.status}`)

  const forbidden2 = await httpGet(port, '/sender/../main/main.js')
  check('拒绝路径穿越', forbidden2.status === 403, `status=${forbidden2.status}`)

  const missing = await httpGet(port, '/sender/nope.js')
  check('不存在的文件返回 404', missing.status === 404)

  console.log('\n— WebSocket 连接与握手 —')

  const a = openClient(port)
  await a.opened
  const stats = await a.waitFor(m => m.type === MSG.STATS)
  check('连接后收到 stats', stats.online === 1, `online=${stats.online}`)

  a.send({ type: MSG.PING })
  const pong = await a.waitFor(m => m.type === MSG.PONG)
  check('ping 得到 pong', !!pong)

  a.send({ type: MSG.HELLO, name: '小梁', reqId: 'h1' })
  const helloAck = await a.waitFor(m => m.type === MSG.ACK && m.reqId === 'h1')
  check('hello 得到 ack', helloAck.ok === true && helloAck.you.name === '小梁')

  console.log('\n— 弹幕发送与广播 —')

  const b = openClient(port)
  await b.opened
  await b.waitFor(m => m.type === MSG.STATS && m.online === 2)
  check('第二个客户端接入，在线数变 2', server.room.online() === 2)

  const danmakuOnB = b.waitFor(m => m.type === MSG.DANMAKU)
  a.send({
    type: MSG.SEND, reqId: 's1', text: '这波操作太秀了', name: '小梁', color: '#FFD400'
  })

  const ack = await a.waitFor(m => m.type === MSG.ACK && m.reqId === 's1')
  check('发送后收到 ack', ack.ok === true && typeof ack.id === 'string')

  const received = await danmakuOnB
  check('另一个客户端收到广播', received.item.text === '这波操作太秀了')
  check('颜色被正确保留', received.item.color === '#FFD400')
  check('昵称被正确保留', received.item.name === '小梁')
  check('弹幕写入历史', server.room.history.length === 1)

  console.log('\n— 服务端校验（不信任客户端）—')

  a.send({ type: MSG.SEND, reqId: 'x1', text: '   ' })
  const empty = await a.waitFor(m => m.type === MSG.REJECT && m.reqId === 'x1')
  check('空内容被拒', empty.code === 'EMPTY')

  a.send({ type: MSG.SEND, reqId: 'x2', text: 'a'.repeat(LIMITS.TEXT_MAX + 5) })
  const tooLong = await a.waitFor(m => m.type === MSG.REJECT && m.reqId === 'x2')
  check('超长内容被拒', tooLong.code === 'TOO_LONG')

  a.send({ type: MSG.SEND, reqId: 'x3', text: '来点广告吧' })
  const blocked = await a.waitFor(m => m.type === MSG.REJECT && m.reqId === 'x3')
  check('屏蔽词被拦截', blocked.code === 'BLOCKED')

  a.send({ type: MSG.SEND, reqId: 'x4', text: '这是DEFAULT内容' })
  const blocked2 = await a.waitFor(m => m.type === MSG.REJECT && m.reqId === 'x4')
  check('屏蔽词大小写不敏感', blocked2.code === 'BLOCKED')

  a.send({ type: MSG.SEND, reqId: 'x5', text: '颜色攻击', color: 'javascript:alert(1)' })
  const colorAttack = await a.waitFor(m => m.type === MSG.DANMAKU && m.item.text === '颜色攻击')
  check('非法颜色被回退为白色', colorAttack.item.color === '#FFFFFF', colorAttack.item.color)

  a.send({ type: MSG.SEND, reqId: 'x6', text: '超大字号', size: 9999 })
  const hugeSize = await a.waitFor(m => m.type === MSG.DANMAKU && m.item.text === '超大字号')
  check('字号被 clamp 到上限', hugeSize.item.size === LIMITS.SIZE_MAX, `size=${hugeSize.item.size}`)

  a.send({ type: MSG.SEND, reqId: 'x7', text: '换行\n注入\t测试' })
  const crlf = await a.waitFor(m => m.type === MSG.DANMAKU && m.item.text.includes('换行'))
  check('换行/控制字符被清洗', !/[\n\t]/.test(crlf.item.text), JSON.stringify(crlf.item.text))

  a.ws.send('这不是 JSON')
  const badJson = await a.waitFor(m => m.type === MSG.REJECT)
  check('非法 JSON 被拒且连接存活', badJson.code === 'BAD_PAYLOAD')
  check('非法消息后连接仍可用', a.ws.readyState === WebSocket.OPEN)

  // 悬浮球在主机模式下走的是这条路径：没有 ws，直接进本地房间。
  // 必须和 ws 来的消息共享同一套校验，否则"本机发的不限流、不过屏蔽词"就成了后门。
  console.log('\n— 主机本机发送（悬浮球 publishLocal）—')

  const localDanmaku = b.waitFor(m => m.type === MSG.DANMAKU && m.item.text === '主机自己发的')
  const localOk = server.room.publishLocal({ text: '主机自己发的', name: '匿名', color: '#7CFFB2' })
  check('本机发送成功', localOk.ok === true && localOk.item.text === '主机自己发的')
  const localSeen = await localDanmaku
  check('本机发送同样广播给其他设备', localSeen.item.color === '#7CFFB2')
  check('本机发送写入历史', server.room.history.some(i => i.text === '主机自己发的'))
  check('本机发送空内容被拒', server.room.publishLocal({ text: '   ' }).code === 'EMPTY')
  check('本机发送超长被拒',
    server.room.publishLocal({ text: 'a'.repeat(LIMITS.TEXT_MAX + 1) }).code === 'TOO_LONG')
  check('本机发送同样过屏蔽词', server.room.publishLocal({ text: '来点广告' }).code === 'BLOCKED')
  // 拒绝明细带上具体命中词 —— 发送端提示条能说清"为什么发不出去"
  check('屏蔽词拒绝带具体命中词', (server.room.publish({ text: '来点广告', rateKey: 'detail-test' }).detail || '').includes('屏蔽词'))

  console.log('\n— 控制台固定弹幕（publishFixed）—')

  config.rateMax = 60 // 固定弹幕有自己的限流桶，这里临时放开避免和上面的用例互相挤占
  const fixedDanmaku = b.waitFor(m => m.type === MSG.DANMAKU && m.item.mode === 'fixed')
  const fixedOk = server.room.publishFixed({ text: '中场休息', position: 'bottom', stayMs: 5000 })
  check('固定弹幕发送成功', fixedOk.ok === true && fixedOk.item.mode === 'fixed')
  const fixedSeen = await fixedDanmaku
  check('固定弹幕广播携带位置与时长', fixedSeen.item.position === 'bottom' && fixedSeen.item.stayMs === 5000)
  check('非法位置回退 center', server.room.publishFixed({ text: '位置测试', position: 'left' }).item.position === 'center')
  check('停留时长被 clamp 到边界',
    server.room.publishFixed({ text: '超长停留', stayMs: 999999 }).item.stayMs === LIMITS.STAY_MS_MAX &&
    server.room.publishFixed({ text: '超短停留', stayMs: 1 }).item.stayMs === LIMITS.STAY_MS_MIN)
  check('固定弹幕同样过屏蔽词', server.room.publishFixed({ text: '来点广告' }).code === 'BLOCKED')
  check('固定弹幕空内容被拒', server.room.publishFixed({ text: '   ' }).code === 'EMPTY')
  config.paused = true
  const fixedInPause = server.room.publishFixed({ text: '暂停期间的公告' })
  check('固定弹幕不受暂停约束（公告语义）', fixedInPause.ok === true && fixedInPause.item.mode === 'fixed')
  config.paused = false
  config.rateMax = 5

  config.paused = true
  check('本机发送同样受暂停约束', server.room.publishLocal({ text: '暂停中' }).code === 'PAUSED')
  config.paused = false

  console.log('\n— 暂停上屏 —')

  config.paused = true
  a.send({ type: MSG.SEND, reqId: 'p1', text: '暂停期间发的' })
  const paused = await a.waitFor(m => m.type === MSG.REJECT && m.reqId === 'p1')
  check('暂停时发送被拒', paused.code === 'PAUSED')
  config.paused = false

  console.log('\n— 图片弹幕 —')

  // 1x1 透明 png（标准 base64），服务端魔数校验认它
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

  const imgOk = server.room.publish({ text: '看看这个', image: PNG_1PX, name: '小梁', rateKey: 'img-test', logIp: 'test' })
  check('图片弹幕发布成功（图+文）', imgOk.ok === true && !!imgOk.item.image && imgOk.item.text === '看看这个')
  check('纯图片（无文字）也能发', server.room.publish({ text: '', image: PNG_1PX, rateKey: 'img-test2' }).ok === true)
  check('空文字空图被拒', server.room.publish({ text: '   ', rateKey: 'img-test3' }).code === 'EMPTY')

  const bigImg = 'data:image/png;base64,' + Buffer.alloc(1024 * 1024 + 100, 1).toString('base64')
  check('超过 1MB 的图片被拒', server.room.publish({ text: '大图', image: bigImg, rateKey: 'img-test4' }).code === 'IMAGE_TOO_LARGE')

  const fakeImg = 'data:image/png;base64,' + Buffer.from('hello world, definitely not a png image!!').toString('base64')
  check('伪图片（魔数不对）被拒', server.room.publish({ text: '假的', image: fakeImg, rateKey: 'img-test5' }).code === 'IMAGE_BAD_FORMAT')
  check('非法 dataURL 头被拒', server.room.publish({ text: 'x', image: 'data:text/html;base64,PGgxPjwvaDE+', rateKey: 'img-test6' }).code === 'IMAGE_BAD_FORMAT')

  // 图片限流独立于文字：img-test 桶在第一条用例已消耗，15s 内同源第二张应被拒
  check('图片限流（15s 一张，独立于文字配额）',
    server.room.publish({ text: '连发', image: PNG_1PX, rateKey: 'img-test' }).code === 'IMAGE_RATE_LIMIT')

  // 图片限流间隔控制台可调：0 = 不限流，同桶第二张立即放行
  config.imageRateSec = 0
  check('图片限流可配置（0=不限流，第二张立即放行）',
    server.room.publish({ text: '不限', image: PNG_1PX, rateKey: 'img-test' }).ok === true)
  config.imageRateSec = 2
  check('图片限流可配置（自定义窗口内仍拦截）',
    server.room.publish({ text: '自定', image: PNG_1PX, rateKey: 'img-test2' }).code === 'IMAGE_RATE_LIMIT')
  config.imageRateSec = undefined

  for (let i = 0; i < 4; i++) {
    server.room.publish({ text: '图' + i, image: PNG_1PX, name: 'h' + i, rateKey: 'hist-' + i })
  }
  const withImg = server.room.history.filter(it => it.image)
  check('历史最多保留 3 张图', withImg.length === 3, `当前 ${withImg.length} 张`)
  const oldest = server.room.history.find(it => it.text === '图0')
  check('超出的老图降级为文字占位', !!oldest && !oldest.image)

  // ws 全链路：前面固定弹幕区块把 rateMax 压到 5，a 的文字桶早已耗尽，先恢复
  config.rateMax = 100
  a.send({ type: MSG.SEND, reqId: 'im1', text: 'ws发图', image: PNG_1PX, name: '小梁' })
  const imAck = await a.waitFor(m => (m.type === MSG.ACK || m.type === MSG.REJECT) && m.reqId === 'im1')
  check('ws 通道图片弹幕拿到回执', imAck.type === MSG.ACK, `收到 ${imAck.type}:${imAck.code || 'ok'}`)
  const imgBroadcast = await b.waitFor(m => m.type === MSG.DANMAKU && m.item.image && m.item.text === 'ws发图')
  check('图片弹幕广播到其他客户端', imgBroadcast.item.text === 'ws发图')

  // ws 纯图：桌宠纯图发送走的就是这条路径（b 的图片桶还没用过，a 已被 im1 占掉）
  b.send({ type: MSG.SEND, reqId: 'im2', text: '', image: PNG_1PX, name: '小梁' })
  const im2Ack = await b.waitFor(m => (m.type === MSG.ACK || m.type === MSG.REJECT) && m.reqId === 'im2')
  check('ws 通道纯图（无文字）拿到回执', im2Ack.type === MSG.ACK, `收到 ${im2Ack.type}:${im2Ack.code || 'ok'}`)
  const im2Bc = await a.waitFor(m => m.type === MSG.DANMAKU && m.item.image && m.item.text === '')
  check('ws 纯图广播带图且文字为空', im2Bc.item.image === PNG_1PX)

  // JoinClient 类级回归：0.5.5 前 DANMAKU 入口只认 text，加入端收纯图广播被整条丢弃
  // （控制台有记录、加入端弹幕层和页面全没有）。冒烟的裸 ws 客户端测不到这层，必须用真实类。
  const jcGot = []
  const jc = new JoinClient({ onLog: () => {} })
  jc.onDanmaku = item => jcGot.push(item)
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('JoinClient 连接超时')), 4000)
      jc.onStatus = status => { if (status === 'open') { clearTimeout(t); resolve() } }
      jc.connect('127.0.0.1:' + port)
    })
    const jcAck = await jc.send({ text: '', image: PNG_1PX, name: 'jc纯图' }).then(() => 'ok').catch(e => e.message)
    check('JoinClient 发纯图拿到回执', jcAck === 'ok', jcAck)
    await sleep(200)
    check('JoinClient 收到纯图广播（加入端链路不再过滤纯图）',
      !!jcGot.find(it => it.image && it.text === ''), `收到 ${jcGot.length} 条`)
  } catch (e) {
    check('JoinClient 纯图链路', false, e.message)
  }
  jc.disconnect()

  console.log('\n— 限流 —')

  // 等上一个限流窗口过期，避免和前面的测试互相干扰
  await sleep(1100)
  config.rateMax = 2
  a.send({ type: MSG.SEND, reqId: 'l1', text: '限流1' })
  a.send({ type: MSG.SEND, reqId: 'l2', text: '限流2' })
  a.send({ type: MSG.SEND, reqId: 'l3', text: '限流3' })
  const limited = await a.waitFor(m => m.type === MSG.REJECT && m.reqId === 'l3')
  check('超出速率被拒', limited.code === 'RATE_LIMIT')

  // 同机两个连接（同 IP）各自有配额 —— 网页发送端 + 加入端桌宠是两个独立使用者，
  // 不能因为共享一个 IP 就互相吃掉限流配额（回归：曾按 IP 共桶导致桌宠被网页挤掉）
  const d = openClient(port)
  await d.opened
  d.send({ type: MSG.SEND, reqId: 'd1', text: '另一个连接不受别人限流影响' })
  const dAck = await d.waitFor(m => (m.type === MSG.ACK || m.type === MSG.REJECT) && m.reqId === 'd1')
  check('限流按连接隔离（同 IP 不共享配额）', dAck.type === MSG.ACK, `收到 ${dAck.type}:${dAck.code || 'ok'}`)
  d.ws.close()

  config.rateMax = 100

  console.log('\n— 断线清理 —')

  b.ws.close()
  await sleep(200)
  check('断开后在线数回落', server.room.online() === 1, `online=${server.room.online()}`)

  const c = openClient(port)
  await c.opened
  const history = await c.waitFor(m => m.type === MSG.HISTORY)
  check('新客户端能拿到历史弹幕', Array.isArray(history.items) && history.items.length > 0,
    `${history.items.length} 条`)

  c.ws.close()
  a.ws.close()

  console.log('\n— 加入模式客户端（JoinClient）—')

  // 重启一个干净的服务器给加入端连
  await server.stop()
  server = new DanmakuServer({ getConfig, onLog: () => {} })
  const port2 = await server.start(PORT)
  server.room.onDanmaku = () => {}
  server.room.onStats = () => {}

  // 主机内部发送通道：进程自连的 ws 客户端，不计入在线设备数
  const hidden = openClient(port2)
  await hidden.opened
  hidden.send({ type: MSG.HELLO, reqId: 'hi1', internal: true })
  await hidden.waitFor(m => m.type === MSG.ACK && m.reqId === 'hi1')
  check('内部通道不占在线数', server.room.online() === 0, `online=${server.room.online()}`)
  hidden.ws.close()
  await sleep(100)

  // 连接 URL 带 ?internal=1：addClient 阶段就识别，不等 HELLO。
  // （回归：曾只在 HELLO 才标记，主机自连时先打出误导性的「127.0.0.1 已连接（在线 1）」，
  //   刚启动无人连接却显示在线 1 就是这么来的）
  const viaUrl = openClient(port2, 'internal=1')
  await viaUrl.opened
  check('URL 标记的内部通道连接即识别（不等 HELLO）', server.room.online() === 0, `online=${server.room.online()}`)
  viaUrl.ws.close()
  await sleep(100)

  // 隧道场景 IP 解析：cloudflared 跑在本机，外部用户经它进来 TCP 对端是回环，
  // 必须取转发头里的真实 IP；非回环直连不信任头（防局域网伪造他人 IP）。
  check('回环 + CF 头解析出真实 IP',
    server.room.clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '203.0.113.7' } }) === '203.0.113.7')
  check('回环 + XFF 取第一个 IP',
    server.room.clientIp({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' } }) === '198.51.100.9')
  check('非回环直连不信任代理头（防伪造）',
    server.room.clientIp({ socket: { remoteAddress: '192.168.1.8' }, headers: { 'cf-connecting-ip': '203.0.113.99' } }) === '192.168.1.8')

  const parsedAddr = parseHostInput(`127.0.0.1:${port2}`)
  check('主机地址解析', !!parsedAddr && parsedAddr.origin === `http://127.0.0.1:${port2}` &&
    parsedAddr.wsUrl === `ws://127.0.0.1:${port2}`)
  check('非法地址被拒', parseHostInput('ht tp://x y') === null && parseHostInput('') === null)

  const joiner = new JoinClient({ onLog: () => {} })
  const seen = { statuses: [], danmaku: [], stats: [], clears: 0, pauses: [] }
  joiner.onStatus = s => seen.statuses.push(s)
  joiner.onDanmaku = item => seen.danmaku.push(item)
  joiner.onStats = s => seen.stats.push(s)
  joiner.onClear = () => { seen.clears += 1 }
  joiner.onPause = p => seen.pauses.push(p)

  check('connect 接受合法地址', joiner.connect(`127.0.0.1:${port2}`) === true)
  check('connect 拒绝非法地址', joiner.connect('not a host') === false)

  // 注入一条弹幕 → 加入端应收到
  const inj = openClient(port2)
  await inj.opened
  inj.send({ type: MSG.SEND, reqId: 'j1', text: '加入端可见', name: '主持人', color: '#FF5566' })
  await sleep(500)
  check('加入端收到实时弹幕', seen.danmaku.length === 1 && seen.danmaku[0].text === '加入端可见')
  check('弹幕颜色正确透传', seen.danmaku[0].color === '#FF5566')
  check('加入端收到在线数', seen.stats.some(s => s.online === 2), `stats=${JSON.stringify(seen.stats)}`)
  check('连接状态流转正确', seen.statuses[0] === 'connecting' && seen.statuses.includes('open'),
    seen.statuses.join(','))

  // 重连后应拿到历史
  joiner.disconnect()
  seen.danmaku.length = 0
  joiner.connect(`127.0.0.1:${port2}`)
  await sleep(500)
  check('重新连接后拿到历史弹幕', joiner.history.length === 1, `history=${joiner.history.length}`)

  // ---------------------------------------------------------------- 加入端发言
  // 悬浮球在加入模式下走的就是 JoinClient.send：同一根 ws 上行，
  // 回执/拒绝都要能正确反馈到 Promise。
  console.log('\n— 加入端发言（悬浮球）—')

  const offline = new JoinClient({ onLog: () => {} })
  let offlineErr = null
  await offline.send({ text: '离线发的' }).catch(err => { offlineErr = err })
  check('未连接时发送立即失败', !!offlineErr && /没连上/.test(offlineErr.message),
    offlineErr && offlineErr.message)

  const sentAck = await joiner.send({ text: '加入端发言', name: '小梁', color: '#4FC3F7' })
  check('加入端发言拿到回执', !!sentAck && typeof sentAck.id === 'string')
  await sleep(300)
  const echoed = seen.danmaku.find(i => i.text === '加入端发言')
  check('加入端发言被主机广播回来（本机也能看到）', !!echoed)
  check('加入端发言保留颜色与昵称', !!echoed && echoed.color === '#4FC3F7' && echoed.name === '小梁')

  let rejectErr = null
  await joiner.send({ text: '来点广告' }).catch(err => { rejectErr = err })
  check('加入端发言被主机拦下并回传原因', !!rejectErr && /屏蔽/.test(rejectErr.message),
    rejectErr && rejectErr.message)

  let emptyErr = null
  await joiner.send({ text: '   ' }).catch(err => { emptyErr = err })
  check('加入端空内容被主机拒掉', !!emptyErr && /不能为空/.test(emptyErr.message),
    emptyErr && emptyErr.message)

  // 清屏/暂停是主机侧广播（主进程 server.broadcast），客户端发上来会被忽略
  server.broadcast({ type: MSG.CLEAR })
  server.broadcast({ type: MSG.PAUSE })
  await sleep(400)
  check('加入端响应清屏广播', seen.clears === 1)
  check('加入端响应暂停广播', seen.pauses[seen.pauses.length - 1] === true)

  joiner.disconnect()
  check('disconnect 后状态回到 idle', joiner._status === 'idle')
  inj.ws.close()
  await server.stop()

  // ------------------------------------------------------------------ 端口兜底
  // 这条用例是补的：端口被占用时的重试路径曾经会同步抛错冒到 uncaughtException，
  // 把整个应用干掉。端口空闲时永远测不出来，必须主动制造占用。
  console.log('\n— 端口占用兜底 —')

  const holder = new DanmakuServer({ getConfig, onLog: () => {} })
  const busyPort = PORT + 100
  const got1 = await holder.start(busyPort)
  check('第一个实例占用端口', got1 === busyPort, `port=${got1}`)

  const second = new DanmakuServer({ getConfig, onLog: () => {} })
  const got2 = await second.start(busyPort)
  check('端口被占用时自动换到下一个', got2 === busyPort + 1, `${busyPort} → ${got2}`)
  const health2 = await httpGet(got2, '/health')
  check('换端口后服务正常可用', health2.status === 200)
  check('记录下被占用的端口', second.triedPorts.includes(busyPort))

  await second.stop()
  await holder.stop()

  // ------------------------------------------------------------------ 汇总

  const failed = results.filter(r => !r.ok)
  console.log(`\n${'='.repeat(52)}`)
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('失败项：')
    failed.forEach(r => console.log(`  - ${r.name}`))
  }
  console.log('='.repeat(52))

  process.exit(failed.length ? 1 : 0)
}

main().catch(err => {
  console.error('\n测试过程中抛异常：', err)
  process.exit(1)
})
