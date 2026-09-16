'use strict'

/**
 * 公网隧道管理 —— 把本机服务一键穿透到公网。
 *
 * 用的是 Cloudflare 的快速隧道（quick tunnel）：
 *   cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate
 * 免注册免配置，启动后在输出里会打印一个随机分配的 trycloudflare.com 地址。
 *
 * 特性：
 *   - 自动寻找 cloudflared 可执行文件（配置 > 环境变量 > 常见位置 > PATH）
 *   - 地址只在进程输出里出现，靠正则从 stdout/stderr 里抓
 *   - 30 秒抓不到地址视为失败；进程退出自动清理状态
 */

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const URL_TIMEOUT_MS = 30000

class TunnelManager {
  constructor ({ getConfig, onLog, extraDirs }) {
    this.getConfig = getConfig
    this.onLog = onLog || (() => {})
    // 打包版会传入额外查找目录（exe 所在目录、resources 目录等）
    this.extraDirs = Array.isArray(extraDirs) ? extraDirs.filter(Boolean) : []
    this.child = null
    this.running = false
    this.url = null
    this.error = null
    this.binary = null
    this._urlTimer = null
  }

  status () {
    return {
      running: this.running,
      url: this.url,
      error: this.error,
      binary: this.binary
    }
  }

  /** 按优先级找一个可用的 cloudflared 可执行文件 */
  findBinary () {
    const cfg = this.getConfig()
    const candidates = []
    if (cfg.cloudflaredPath) candidates.push(cfg.cloudflaredPath)
    if (process.env.LAN_DANMAKU_CLOUDFLARED) candidates.push(process.env.LAN_DANMAKU_CLOUDFLARED)
    // 服务器工作目录（跟 main.js 同级最好找）
    candidates.push(
      path.join(process.cwd(), 'cloudflared.exe'),
      path.join(process.cwd(), 'cloudflared'),
      path.join(__dirname, '..', '..', 'cloudflared.exe')
    )
    // Windows 下载缓存目录（手动下载过一次就能被找到）
    candidates.push(path.join(os.tmpdir(), 'cloudflared.exe'))
    // 打包版传入的目录：exe 旁边、resources 目录
    for (const dir of this.extraDirs) {
      candidates.push(path.join(dir, 'cloudflared.exe'), path.join(dir, 'cloudflared'))
    }

    for (const c of candidates) {
      try {
        if (c && fs.existsSync(c)) return c
      } catch { /* ignore */ }
    }

    // 最后从 PATH 里找
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const out = execFileSync(cmd, ['cloudflared'], { encoding: 'utf8' })
      const first = out.split(/\r?\n/).find(Boolean)
      if (first) return first.trim()
    } catch { /* ignore */ }

    return null
  }

  start () {
    if (this.running) return this.status()
    this.url = null
    this.error = null

    if (!this.binary) this.binary = this.findBinary()
    if (!this.binary) {
      this.error = '没找到 cloudflared：把它（cloudflared.exe）放到服务器程序目录，或在配置文件里设 cloudflaredPath'
      this.onLog({ level: 'warn', msg: `隧道启动失败：${this.error}` })
      return this.status()
    }

    const port = Number(this.getConfig().port) || 7321
    try {
      this.child = spawn(
        this.binary,
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        { windowsHide: true }
      )
    } catch (err) {
      this.error = `cloudflared 启动失败：${err.message}`
      return this.status()
    }

    this.running = true
    this.onLog({ level: 'info', msg: `正在建立公网隧道（${this.binary}）…` })

    const grab = buf => {
      const m = String(buf).match(URL_RE)
      if (m && !this.url) {
        this.url = m[0]
        clearTimeout(this._urlTimer)
        this.onLog({ level: 'info', msg: `公网隧道已建立：${this.url}` })
      }
    }
    this.child.stdout.on('data', grab)
    this.child.stderr.on('data', grab)

    // cloudflared 的进度日志走 stderr，长时间无输出是常态，靠定时器兜底判失败
    this._urlTimer = setTimeout(() => {
      if (this.running && !this.url) {
        this.error = '30 秒内没拿到公网地址（网络不通或被墙），先确认服务器能访问外网'
      }
    }, URL_TIMEOUT_MS)

    this.child.on('exit', code => {
      clearTimeout(this._urlTimer)
      this.running = false
      this.child = null
      if (!this.url) {
        this.error = `cloudflared 退出了（code ${code}），没拿到公网地址`
      } else {
        this.onLog({ level: 'warn', msg: `cloudflared 退出（code ${code}），隧道已断` })
      }
    })

    this.child.on('error', err => {
      clearTimeout(this._urlTimer)
      this.running = false
      this.child = null
      this.error = `cloudflared 运行异常：${err.message}`
    })

    return this.status()
  }

  stop () {
    clearTimeout(this._urlTimer)
    if (this.child) {
      try { this.child.kill() } catch { /* ignore */ }
      this.child = null
    }
    this.running = false
    this.url = null
    return this.status()
  }

  destroy () {
    this.stop()
  }
}

module.exports = { TunnelManager, URL_RE }
