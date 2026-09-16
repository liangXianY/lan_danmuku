'use strict'

const http = require('http')
const net = require('net')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const { Room } = require('./room')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}

/**
 * 静态资源白名单：局域网主机模式只放行发送页和共享协议；
 * 公网独立部署时由入口传入更多目录（如 admin/ 管理台）。
 */
const DEFAULT_ALLOWED_PREFIX = ['sender/', 'shared/']

const WEB_ROOT = path.resolve(__dirname, '..')
const MAX_WS_MESSAGE = 4096
const PORT_PROBE_RANGE = 20
const HEARTBEAT_MS = 30000

/**
 * 试占一个端口：用一次性的 net 服务器探测，测完立刻关掉。
 *
 * 为什么不在监听失败后换端口重试同一个 http.Server —— 踩过的坑：
 * listen 失败（EADDRINUSE）后该实例仍持有 handle，直接再次 listen 会同步抛
 * ERR_SERVER_ALREADY_LISTEN；而同步抛错发生在 setTimeout 回调里，会绕过 Promise
 * 的 reject 一路冒到 uncaughtException，把整个应用搞死。
 * 先探测再监听，就完全绕开了这个状态机的坑。
 */
function probePort (port) {
  return new Promise(resolve => {
    const srv = net.createServer()
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      try { srv.close(() => resolve(ok)) } catch { resolve(ok) }
      // close 回调在"从未成功监听"的情况下不一定触发，兜底一次
      const t = setTimeout(() => resolve(ok), 80)
      if (t.unref) t.unref()
    }
    srv.once('error', () => done(false))
    srv.once('listening', () => done(true))
    srv.listen(port, '0.0.0.0')
  })
}

class DanmakuServer {
  constructor ({ getConfig, setConfig, onLog, onClear, allowedPrefixes, api }) {
    this.getConfig = getConfig
    this.onLog = onLog || (() => {})
    // 可选的 REST API 处理器：/api/* 的请求全部转交给它（返回 true 表示已处理）
    this.api = api || null
    this.allowedPrefixes = Array.isArray(allowedPrefixes) && allowedPrefixes.length
      ? allowedPrefixes
      : DEFAULT_ALLOWED_PREFIX
    this.room = new Room({ getConfig, setConfig, onLog: this.onLog, onClear })
    this.httpServer = null
    this.wss = null
    this.port = null
    this._heartbeat = null
    this.triedPorts = []
  }

  /** 启动 HTTP + WebSocket 服务，端口被占用时自动向上探测 */
  async start (preferredPort) {
    const port = await this.listenWithFallback(Number(preferredPort) || 7321)
    this.port = port
    this.startHeartbeat()
    return this.port
  }

  /** 依次尝试 startPort、startPort+1…，返回真正绑上的端口 */
  async listenWithFallback (startPort) {
    const tried = []

    for (let i = 0; i <= PORT_PROBE_RANGE; i++) {
      const port = startPort + i
      if (!(await probePort(port))) {
        tried.push(port)
        continue
      }

      const server = http.createServer((req, res) => this.handleHttp(req, res))
      server.on('clientError', (err, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      })
      const wss = new WebSocketServer({ server, maxPayload: MAX_WS_MESSAGE })
      wss.on('connection', (ws, req) => this.handleWs(ws, req))

      try {
        await new Promise((resolve, reject) => {
          const onError = err => {
            server.removeListener('listening', onListening)
            reject(err)
          }
          const onListening = () => {
            server.removeListener('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          // 绑定 0.0.0.0 才能被同网段的其它设备访问
          server.listen(port, '0.0.0.0')
        })
        this.httpServer = server
        this.wss = wss
        this.triedPorts = tried
        return port
      } catch (err) {
        // 探测和真正监听之间有竞态（端口刚被别人抢走），清理干净换下一个
        try { wss.close() } catch { /* ignore */ }
        try { server.close() } catch { /* ignore */ }
        if (err.code !== 'EADDRINUSE') throw err
        tried.push(port)
      }
    }

    throw new Error(`端口 ${startPort}~${startPort + PORT_PROBE_RANGE} 都不可用`)
  }

  startHeartbeat () {
    this._heartbeat = setInterval(() => {
      if (!this.wss) return
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          this.onLog({ level: 'warn', msg: '清理掉线连接' })
          ws.terminate()
          continue
        }
        ws.isAlive = false
        try { ws.ping() } catch { /* ignore */ }
      }
    }, HEARTBEAT_MS)
    if (this._heartbeat.unref) this._heartbeat.unref()
  }

  // ------------------------------------------------------------------ HTTP

  handleHttp (req, res) {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    } catch {
      return this.sendJson(res, 400, { ok: false, error: 'bad request' })
    }

    if (pathname === '/health') {
      return this.sendJson(res, 200, {
        ok: true,
        app: 'lan-danmaku',
        port: this.port,
        online: this.room.online()
      })
    }

    // REST API（公网模式的管理接口，由入口注入处理器并自行做鉴权）
    if (pathname.startsWith('/api/') && this.api) {
      return this.api(req, res, pathname)
    }

    // 浏览器总会自动要 favicon，白名单拦下会在控制台留一条 403 报错，直接 204 安抚
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      return res.end()
    }

    // 访问根路径时 301 到 /sender/ 而不是原地吐 HTML：
    // 页面里的相对引用（sender.css、app.js）是按 URL 基准解析的，
    // 如果内容挂在 / 下，请求会变成 /sender.css，被白名单 403 —— 页面就废了
    if (pathname === '/' || pathname === '') {
      res.writeHead(301, { Location: '/sender/' })
      return res.end()
    }

    // 目录形式访问补 index.html；URL 保持 /sender/ 前缀，相对路径才能正确解析
    if (pathname === '/sender') {
      res.writeHead(301, { Location: '/sender/' })
      return res.end()
    }
    if (pathname.endsWith('/')) pathname += 'index.html'

    // 关键：Windows 上 path.normalize 会把 / 转成 \，
    // 白名单前缀必须统一成正斜杠再比对，否则整条静态链路在 Windows 上直接全 403
    const rel = path
      .normalize(pathname)
      .replace(/^[/\\]+/, '')
      .split(path.sep)
      .join('/')

    const allowed = this.allowedPrefixes.some(prefix => rel.startsWith(prefix))
    const file = path.join(WEB_ROOT, rel)

    // 目录穿越 + 白名单双重防护
    // startsWith 必须带上分隔符，否则 "srcEvil" 也能蒙混过关
    if (!allowed || !file.startsWith(WEB_ROOT + path.sep)) {
      return this.sendJson(res, 403, { ok: false, error: 'forbidden' })
    }

    fs.readFile(file, (err, buf) => {
      if (err) return this.sendJson(res, 404, { ok: false, error: 'not found' })
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      })
      res.end(buf)
    })
  }

  sendJson (res, code, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    })
    res.end(body)
  }

  // ------------------------------------------------------------- WebSocket

  handleWs (ws, req) {
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    this.room.addClient(ws, req)

    ws.on('message', data => {
      if (data.length > MAX_WS_MESSAGE) {
        ws.close(1009, 'message too large')
        return
      }
      this.room.handle(ws, data)
    })

    const cleanup = () => this.room.removeClient(ws)
    ws.on('close', cleanup)
    ws.on('error', () => {
      cleanup()
      try { ws.terminate() } catch { /* ignore */ }
    })
  }

  // ------------------------------------------------------------------ 控制

  /** 主机侧下发控制指令给所有发送端（用于同步暂停状态等） */
  broadcast (payload) {
    this.room.broadcast(payload)
  }

  async stop () {
    clearInterval(this._heartbeat)
    this.room.destroy()
    if (this.wss) {
      for (const ws of this.wss.clients) {
        try { ws.terminate() } catch { /* ignore */ }
      }
      await new Promise(resolve => this.wss.close(resolve))
    }
    if (this.httpServer) {
      await new Promise(resolve => this.httpServer.close(resolve))
    }
  }
}

module.exports = { DanmakuServer }
