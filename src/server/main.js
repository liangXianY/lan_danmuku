'use strict'

/**
 * 公网服务器模式入口 —— 纯 Node，不依赖 Electron。
 *
 * 把整个项目（或至少 src/ + node_modules + package.json）丢到一台有公网 IP 的
 * 机器上，`node src/server/main.js` 跑起来，任何人在任何网络下都能：
 *   - 浏览器打开 http://<服务器IP>:7321/ 发弹幕
 *   - 桌面客户端（加入模式）填服务器地址，本机弹幕层同步滚动 + 桌宠发言
 *   - 管理员打开 /admin/ 用管理口令登录：发公告、清屏、暂停、改屏蔽词
 *
 * 安全边界（公网和局域网不是一回事，这些是底线）：
 *   - 发送口令 roomToken：不设就是任何人可发；要办活动建议设一个
 *   - 管理口令 adminToken：首次启动自动生成并打印，管理员登录全靠它
 *   - 文本长度、控制字符、颜色白名单、按 IP 限流，全部沿用 room.js 的服务端实现
 *   - 反代到 HTTPS 时（推荐），客户端会自动用 wss，无需改代码
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DanmakuServer } = require('../main/server')
const { TunnelManager } = require('./tunnel')

// ---------------------------------------------------------------- 配置

const CONFIG_DIR = process.env.LAN_DANMAKU_SERVER_CONFIG
  ? path.dirname(process.env.LAN_DANMAKU_SERVER_CONFIG)
  : path.join(process.env.APPDATA || process.env.HOME || __dirname, '.lan-danmaku-server')
const CONFIG_FILE = process.env.LAN_DANMAKU_SERVER_CONFIG || path.join(CONFIG_DIR, 'config.json')

const SERVER_DEFAULTS = {
  port: 7321,
  /** 房间口令：空 = 任何人可发；设了 = 必须带对口令才能发弹幕（观看不受限） */
  roomToken: '',
  /** 管理口令：首次启动自动生成，用于 /admin/ 登录 */
  adminToken: '',
  paused: false,
  blockedWords: [],
  rateMax: 5,
  rateWindowMs: 3000,
  /** cloudflared 可执行文件路径：留空则自动查找（程序目录 / PATH / 下载缓存） */
  cloudflaredPath: ''
}

function loadConfig () {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return { ...SERVER_DEFAULTS, ...parsed }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[server] 配置读取失败，使用默认值：', err.message)
    }
    return { ...SERVER_DEFAULTS }
  }
}

const config = loadConfig()
let firstBoot = !config.adminToken

if (firstBoot) {
  // 随机管理口令，8 组 4 位好读好抄（去掉易混淆的 0O1lI）
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz'
  const bytes = crypto.randomBytes(12)
  config.adminToken = Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

function saveConfig () {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
  } catch (err) {
    console.error('[server] 配置保存失败：', err.message)
  }
}

saveConfig()

// ---------------------------------------------------------------- 服务

const log = (entry, msg) => {
  msg = (entry && typeof entry === 'object') ? entry.msg : msg
  const level = (entry && typeof entry === 'object') ? entry.level : 'info'
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`)
}

const server = new DanmakuServer({
  getConfig: () => config,
  /** 管理员在线改配置（目前只有屏蔽词、暂停状态会走到这） */
  setConfig: patch => {
    Object.assign(config, patch)
    saveConfig()
  },
  onLog: log,
  // 房间没有本地弹幕层，清空指令只需要广播给所有客户端
  onClear: null,
  // 公网模式额外放行管理台页面
  allowedPrefixes: ['sender/', 'shared/', 'admin/'],
  api: tunnelApi
})

// ---------------------------------------------------------------- 隧道 API

const tunnel = new TunnelManager({ getConfig: () => config, onLog: log })

/** 请求是否来自本机（本机操作免鉴权，远程必须带管理口令） */
function isLocalReq (req) {
  const addr = req.socket.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function tunnelApi (req, res, pathname) {
  const headerToken = req.headers['x-admin-token']
  const authed = isLocalReq(req) || (headerToken && headerToken === config.adminToken)
  if (!authed) {
    return server.sendJson(res, 403, { ok: false, error: 'forbidden（本机调用或携带管理口令）' })
  }

  if (req.method === 'GET' && pathname === '/api/tunnel') {
    return server.sendJson(res, 200, { ok: true, ...tunnel.status() })
  }
  if (req.method === 'POST' && pathname === '/api/tunnel/start') {
    return server.sendJson(res, 200, { ok: true, ...tunnel.start() })
  }
  if (req.method === 'POST' && pathname === '/api/tunnel/stop') {
    return server.sendJson(res, 200, { ok: true, ...tunnel.stop() })
  }
  return server.sendJson(res, 404, { ok: false, error: 'not found' })
}

server.start(config.port).then(port => {
  console.log('')
  console.log('  LAN Danmaku 公网服务器已启动')
  console.log(`  发送页     http://<你的域名或IP>:${port}/`)
  console.log(`  管理台     http://<你的域名或IP>:${port}/admin/`)
  if (firstBoot) {
    console.log(`  管理口令   ${config.adminToken}   （已写入配置文件，下次启动沿用）`)
  }
  console.log(`  配置文件   ${CONFIG_FILE}`)
  console.log(`  房间口令   ${config.roomToken ? '已开启（发言需要口令）' : '未设置（任何人可发言，公网部署建议设置）'}`)
  console.log('')
  log(`监听 0.0.0.0:${port}`)
}).catch(err => {
  console.error('[server] 启动失败：', err.message)
  process.exit(1)
})

// ---------------------------------------------------------------- 退出

async function shutdown (signal) {
  console.log(`\n[server] 收到 ${signal}，正在关闭…`)
  try { tunnel.destroy() } catch { /* ignore */ }
  try { await server.stop() } catch { /* ignore */ }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', err => {
  log('error', `未捕获异常：${err.message}`)
})
