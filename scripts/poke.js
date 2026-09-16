'use strict'

/**
 * 向正在运行的主机发几条测试弹幕。
 * 用途：快速验证"浏览器 → 服务 → 弹幕层"这条实时链路真的通。
 *
 *   node scripts/poke.js [host] [port]
 */

const WebSocket = require('ws')
const { MSG } = require('../src/shared/protocol')

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3]) || 7321

const texts = [
  { text: '局域网弹幕跑通了 🎉', color: '#FFD400' },
  { text: '这条是从另一台设备发过来的', color: '#7CFFB2' },
  { text: '从右往左，滚过屏幕最上方', color: '#4FC3F7' },
  { text: '鼠标可以直接点到下面的桌面', color: '#FFFFFF' },
  { text: '666', color: '#FF7A45' }
]

const url = `ws://${host}:${port}`
const ws = new WebSocket(url)

ws.on('open', () => {
  console.log(`已连接 ${url}`)
  ws.send(JSON.stringify({ type: MSG.HELLO, name: '测试机', reqId: 'poke' }))
  texts.forEach((item, i) => {
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: MSG.SEND,
        reqId: 'p' + i,
        text: item.text,
        name: '测试机',
        color: item.color
      }))
      console.log(`  已发送：${item.text}`)
    }, i * 900)
  })
  setTimeout(() => { ws.close(); process.exit(0) }, texts.length * 900 + 1500)
})

ws.on('message', raw => {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }
  if (msg.type === MSG.STATS) console.log(`  在线：${msg.online}`)
  if (msg.type === MSG.REJECT) console.log(`  被拒：${msg.msg}`)
  if (msg.type === MSG.ACK && msg.reqId !== 'poke') console.log('  已上屏 ✓')
})

ws.on('error', err => {
  console.error(`连接失败：${err.message}`)
  console.error('主机没在运行，或者 IP/端口不对。')
  process.exit(1)
})
