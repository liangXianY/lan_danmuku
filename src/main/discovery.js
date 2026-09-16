'use strict'

/**
 * 局域网主机自动发现：
 * - 主机端 DiscoveryBroadcaster：每 2 秒往 UDP 7323 广播一次「我在这」（端口 + 主机名），
 *   同时发往各网段的定向广播地址和全局广播，多网卡也尽量覆盖。
 * - 加入端 DiscoveryListener：监听 UDP 7323，收集最近 6 秒内有心跳的主机，
 *   变化时通过 onChange 推给加入窗口，点一下即可连接。
 *
 * 只用 node 内置 dgram，不引 mDNS 库——要的就是"列表里出现"这一步。
 */
const dgram = require('dgram')
const os = require('os')

const APP_ID = 'lan-danmaku-discovery-v1'
const DISCOVERY_PORT = 7323
const BROADCAST_INTERVAL = 2000
const STALE_MS = 6000

/** 从网卡配置里算出各网段的定向广播地址（如 192.168.11.255） */
function broadcastAddresses () {
  // 127.0.0.1：Windows 广播不回环，同机自发现（同机测试/单机演示）靠它
  const out = new Set(['255.255.255.255', '127.0.0.1'])
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      const [ip, mask] = net.address.split('.')
      const m = mask ? Number(mask) : 24
      if (!Number.isFinite(m) || m < 8 || m > 32) continue
      // 简化处理：只算常见的整字节掩码（8/16/24/32）
      const full = Math.floor(m / 8)
      const rest = ip.split('.').map(Number)
      if (m % 8 === 0) {
        for (let i = full; i < 4; i++) rest[i] = 255
        out.add(rest.join('.'))
      } else {
        out.add('255.255.255.255')
      }
    }
  }
  return [...out]
}

/** 主机端：周期广播 */
class DiscoveryBroadcaster {
  constructor ({ port, name, onLog }) {
    this.port = port
    this.name = name || os.hostname()
    this.onLog = onLog || (() => {})
    this.socket = null
    this.timer = null
    this.bound = false
    this.targets = broadcastAddresses()
  }

  start () {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('error', err => {
      this.onLog({ level: 'warn', msg: `发现广播出错：${err.message}` })
      this.stop()
    })
    this.socket.bind(() => {
      this.bound = true
      this._announce()
    })
    this.timer = setInterval(() => this._announce(), BROADCAST_INTERVAL)
  }

  _announce () {
    if (!this.bound || !this.socket) return
    const payload = Buffer.from(JSON.stringify({ app: APP_ID, name: this.name, port: this.port }))
    for (const target of this.targets) {
      this.socket.send(payload, DISCOVERY_PORT, target, () => {})
    }
  }

  stop () {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.bound = false
    if (this.socket) {
      try { this.socket.close() } catch { /* already closed */ }
      this.socket = null
    }
  }
}

/** 加入端：监听广播，维护"最近 6 秒内活着的主机"列表 */
class DiscoveryListener {
  constructor ({ onLog }) {
    this.onLog = onLog || (() => {})
    this.onChange = null
    this.socket = null
    this.pruneTimer = null
    /** id -> { id, address, port, name, lastSeen } */
    this.hosts = new Map()
  }

  start () {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('error', err => {
      // 端口被占（比如同机另一个加入实例）只降级：发现列表为空，手动输入仍可用
      this.onLog({ level: 'warn', msg: `主机发现不可用：${err.message}` })
      this.stop()
    })
    this.socket.on('message', (data, rinfo) => {
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (!msg || msg.app !== APP_ID || !Number.isFinite(msg.port)) return
      const address = rinfo.address
      const id = `${address}:${msg.port}`
      this.hosts.set(id, {
        id,
        address,
        port: msg.port,
        name: typeof msg.name === 'string' ? msg.name.slice(0, 32) : '',
        lastSeen: Date.now()
      })
      this._emit()
    })
    this.socket.bind(DISCOVERY_PORT, () => {
      this.onLog({ level: 'info', msg: `正在监听局域网主机广播（UDP ${DISCOVERY_PORT}）` })
    })
    this.pruneTimer = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [id, h] of this.hosts) {
        if (now - h.lastSeen > STALE_MS) { this.hosts.delete(id); changed = true }
      }
      if (changed) this._emit()
    }, 2000)
  }

  _emit () {
    if (this.onChange) this.onChange(this.list())
  }

  list () {
    return [...this.hosts.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, address, port, name }) => ({ id, address, port, name }))
  }

  stop () {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null }
    if (this.socket) {
      try { this.socket.close() } catch { /* already closed */ }
      this.socket = null
    }
  }
}

module.exports = { DiscoveryBroadcaster, DiscoveryListener, DISCOVERY_PORT }
