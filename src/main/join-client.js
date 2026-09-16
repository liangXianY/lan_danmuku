'use strict';

/**
 * 加入模式客户端：连到局域网内某台主机的 WebSocket，
 * 把收到的弹幕转交给主进程渲染到本机弹幕层。
 * 只出不进 —— 不监听任何端口，加入端机器不需要动防火墙。
 */
const WebSocket = require('ws')
const { MSG } = require('../shared/protocol')

const HISTORY_MAX = 200
const PING_MS = 20000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 5000
const SEND_TIMEOUT_MS = 6000
/** ws.readyState 的 OPEN —— 直接用字面量，省得依赖 ws 包里的常量导出 */
const OPEN_STATE = 1

/**
 * 解析用户输入的主机地址。
 * 接受 "192.168.1.5:7321"、"http://192.168.1.5:7321"，返回 { origin, wsUrl }；
 * 格式非法返回 null。
 */
function parseHostInput (input) {
  if (typeof input !== 'string') return null
  let raw = input.trim()
  if (!raw) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw
  let u
  try { u = new URL(raw) } catch { return null }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) && !u.hostname.includes(':')) {
    // 允许 IP 与主机名（mDNS 之类），但拒绝明显乱写的（比如带空格已被 URL 吞掉的情况）
    if (/\s/.test(input.trim())) return null
  }
  return {
    origin: u.origin,
    wsUrl: (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host
  }
}

class JoinClient {
  constructor ({ onLog }) {
    this.onLog = onLog || (() => {})
    /** 状态变化：(status, detail, origin) —— status: idle | connecting | open | closed */
    this.onStatus = () => {}
    this.onDanmaku = () => {}
    this.onStats = () => {}
    this.onClear = () => {}
    this.onPause = () => {}
    /** 发言权限变化：(canSend) —— 连上口令服务器、口令填对/改对时触发 */
    this.onCanSend = () => {}
    /** 主机昵称政策变化：(policy) —— HELLO 回执或 CONFIG 广播告知时触发 */
    this.onNamePolicy = () => {}
    /** HELLO 口令被拒（填错时）：(提示文本) —— 不提示用户会以为软件坏了 */
    this.onTokenRejected = () => {}

    /** 本机发言用的昵称（连接时随 HELLO 一起报给主机） */
    this.identityName = ''
    /** 房间口令：公网服务器开启口令时必须带上才有发送权限 */
    this.roomToken = ''
    /** 发言权限（HELLO 回执的 canSend）：null=未知/服务器没开口令，false=需要口令且当前没过 */
    this.canSend = null
    /** 主机昵称政策（HELLO 回执/CONFIG 广播告知）：null=未知（旧版主机），'required'=强制实名，'free'=允许匿名 */
    this.namePolicy = null

    /** 最近收到的弹幕（含刚接入时的历史），给弹幕层初始化用 */
    this.history = []
    this.origin = null
    this.ws = null

    this._target = null
    this._manual = false
    this._status = 'idle'
    this._retry = 0
    this._reconnectTimer = null
    this._pingTimer = null
    /** 本机发出的、还没收到回执的消息：reqId -> 超时定时器 */
    this._pending = new Map()
    this._seq = 0
  }

  connect (input) {
    const parsed = parseHostInput(input)
    if (!parsed) return false
    this.disconnect()
    this._manual = false
    this.origin = parsed.origin
    this._target = parsed.wsUrl
    this._open()
    return true
  }

  disconnect () {
    this._manual = true
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    clearInterval(this._pingTimer)
    this._pingTimer = null
    this._failPending('已断开与主机的连接')
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this._setStatus('idle', null)
  }

  /**
   * 本机发言。返回 Promise：主机回 ACK 就 resolve(null)，回 REJECT 或超时就 reject(Error)。
   * 走的是同一根 ws —— 主机的限流、屏蔽词、长度校验全都自动复用，
   * 不用在客户端重写一遍规则（重写必漂移）。
   */
  send ({ text, name, color, size }) {
    const ws = this.ws
    if (!ws || ws.readyState !== OPEN_STATE) {
      return Promise.reject(new Error('还没连上主机'))
    }

    const reqId = 's' + (++this._seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId)
        reject(new Error('主机没响应'))
      }, SEND_TIMEOUT_MS)
      if (timer.unref) timer.unref()

      this._pending.set(reqId, { resolve, reject, timer })

      try {
        ws.send(JSON.stringify({ type: MSG.SEND, reqId, text, name, color, size }))
      } catch (err) {
        clearTimeout(timer)
        this._pending.delete(reqId)
        reject(new Error('发送失败'))
      }
    })
  }

  /** 更新本机发言昵称；连着的话补一次 HELLO，免得主机还记着旧名字 */
  setIdentity (name) {
    this.identityName = name || ''
    this._hello()
  }

  /** 更新房间口令；连着的话同样补一次 HELLO 让主机重新校验发送权限 */
  setRoomToken (token) {
    this.roomToken = String(token || '')
    this._hello()
  }

  /** 向主机报一遍身份 + 口令（连接刚建立和身份变化时都会调） */
  _hello (reqId) {
    const ws = this.ws
    if (ws && ws.readyState === OPEN_STATE) {
      try {
        ws.send(JSON.stringify({
          type: MSG.HELLO,
          name: this.identityName || '',
          token: this.roomToken,
          reqId: reqId || 'hello'
        }))
      } catch { /* ignore */ }
    }
  }

  /** 连接断开时把没收到回执的发送全部失败掉，避免调用方一直等 */
  _failPending (message) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
    }
    this._pending.clear()
  }

  _setStatus (status, detail) {
    if (this._status === status && !detail) return
    this._status = status
    this.onStatus(status, detail, this.origin)
  }

  _open () {
    this._setStatus('connecting', null)
    let ws
    try {
      ws = new WebSocket(this._target)
    } catch (err) {
      this._retryLater(String(err.message || err))
      return
    }
    this.ws = ws

    ws.on('open', () => {
      this._retry = 0
      this._setStatus('open', null)
      this._hello('join')
      clearInterval(this._pingTimer)
      this._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: MSG.PING })) } catch { /* ignore */ }
        }
      }, PING_MS)
    })

    ws.on('message', data => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      this._handle(msg)
    })

    ws.on('close', () => {
      if (!this._manual) this._retryLater('连接已断开')
    })
    ws.on('error', err => {
      if (!this._manual) this._retryLater(err.code || String(err.message || err))
    })
  }

  _retryLater (detail) {
    clearInterval(this._pingTimer)
    this._setStatus('closed', detail)
    if (this._reconnectTimer) return // close 和 error 可能都来，只排一次
    const delay = Math.min(RETRY_BASE_MS * Math.pow(1.6, this._retry++), RETRY_MAX_MS)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._open()
    }, delay)
  }

  _handle (msg) {
    switch (msg.type) {
      case MSG.DANMAKU:
        if (msg.item && msg.item.text) {
          this.history.push(msg.item)
          if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX)
          this.onDanmaku(msg.item)
        }
        break
      case MSG.HISTORY:
        this.history = (msg.items || []).slice(-HISTORY_MAX)
        break
      case MSG.STATS:
        this.onStats(msg)
        break
      case MSG.CLEAR:
        this.history = []
        this.onClear()
        break
      case MSG.PAUSE:
        this.onPause(true)
        break
      case MSG.RESUME:
        this.onPause(false)
        break
      case MSG.CONFIG:
        // 目前只广播昵称政策；旧版主机不会发这条
        if (msg.config && msg.config.namePolicy !== undefined && msg.config.namePolicy !== this.namePolicy) {
          this.namePolicy = msg.config.namePolicy === 'required' ? 'required' : 'free'
          this.onNamePolicy(this.namePolicy)
        }
        break
      case MSG.ACK: {
        // HELLO 的回执带 canSend：告诉我们当前有没有发言权限（口令过没过）
        if (msg.canSend !== undefined && (msg.reqId === 'hello' || msg.reqId === 'join')) {
          const next = !!msg.canSend
          const changed = this.canSend !== next
          this.canSend = next
          if (changed) this.onCanSend(next)
        }
        // 同一回执带主机昵称政策；旧版主机没这个字段，保持 null 不动
        if (msg.namePolicy !== undefined && (msg.reqId === 'hello' || msg.reqId === 'join')) {
          const policy = msg.namePolicy === 'required' ? 'required' : 'free'
          if (policy !== this.namePolicy) {
            this.namePolicy = policy
            this.onNamePolicy(policy)
          }
        }
        const p = this._pending.get(msg.reqId)
        if (p) {
          this._pending.delete(msg.reqId)
          clearTimeout(p.timer)
          p.resolve({ id: msg.id })
        }
        break
      }
      case MSG.REJECT: {
        // HELLO 时的口令拒绝不在 _pending 里，必须单独上报，否则用户填错了毫无反馈
        if ((msg.reqId === 'hello' || msg.reqId === 'join') && msg.code === 'BAD_TOKEN') {
          this.onTokenRejected(msg.msg || '口令不对，问主持人要一个')
          break
        }
        const p = this._pending.get(msg.reqId)
        if (p) {
          this._pending.delete(msg.reqId)
          clearTimeout(p.timer)
          p.reject(new Error(msg.msg || '发送失败'))
        }
        break
      }
      default:
        break
    }
  }
}

module.exports = { JoinClient, parseHostInput }
