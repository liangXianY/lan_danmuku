'use strict'

const { MSG, LIMITS, REJECT, REJECT_TEXT, IMAGE_MIME_RE } = require('../shared/protocol')

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const DEFAULT_COLOR = '#FFFFFF'
const DEFAULT_NAME = '匿名'

function clamp (value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeColor (value) {
  if (typeof value !== 'string') return DEFAULT_COLOR
  const v = value.trim()
  return HEX_COLOR.test(v) ? v : DEFAULT_COLOR
}

/** 去掉控制字符（含换行）—— 防止撑破单行布局，也顺手抹掉一部分注入面 */
function normalizeText (value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 房间：维护在线连接、弹幕历史、限流与校验。
 * 所有对外发出的内容都经过这里，服务端不信任任何客户端字段。
 */
class Room {
  constructor ({ getConfig, setConfig, onDanmaku, onStats, onLog, onClear }) {
    this.getConfig = getConfig
    /** 公网服务器模式下允许管理员在线改配置（屏蔽词等）；Electron 主机模式不提供 */
    this.setConfig = setConfig || null
    this.onDanmaku = onDanmaku || (() => {})
    this.onStats = onStats || (() => {})
    this.onLog = onLog || (() => {})
    /** 管理员远程清空弹幕时回调（独立服务器模式下没有本地弹幕层，也不需要） */
    this.onClear = onClear || (() => {})

    /** ws -> { id, name, ip, key, role, roomAuthed, connectedAt, lastSeen } */
    this.clients = new Map()
    /** 最近弹幕 */
    this.history = []
    /** 限流桶：key -> { start, count } */
    this.buckets = new Map()
    this.seq = 0

    // 定期清理过期限流桶，避免长期运行内存缓慢增长
    this._sweeper = setInterval(() => this.sweepBuckets(), 60 * 1000)
    if (this._sweeper.unref) this._sweeper.unref()
  }

  destroy () {
    clearInterval(this._sweeper)
    this.clients.clear()
    this.buckets.clear()
  }

  sweepBuckets () {
    const { rateWindowMs } = this.getConfig()
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= rateWindowMs * 2) this.buckets.delete(key)
    }
  }

  // ---------------------------------------------------------------- 连接管理

  addClient (ws, req) {
    const ip = this.clientIp(req)
    const cfg = this.getConfig()
    // 连接 URL 亮明的内部通道身份（?internal=1）只有本机回环连接才认：
    // 内部通道解析出的 IP 若是隧道真实地址就不再是回环，伪造不进来；
    // 局域网用户改个 URL 把在线数藏掉更不行。
    const isLoopback = ip === '127.0.0.1' || ip === '::1'
    let urlInternal = false
    if (isLoopback && req && typeof req.url === 'string') {
      try { urlInternal = new URL(req.url, 'http://localhost').searchParams.get('internal') === '1' } catch { /* ignore */ }
    }
    const client = {
      id: `c${(++this.seq).toString(36)}`,
      /** 昵称：HELLO 时上报的原始值（可能为空）；显示名在 publish 里统一决定 */
      name: '',
      ip,
      key: ip,
      /** 主机内部发送通道（主机进程自连的 ws）：不占在线设备数 */
      internal: urlInternal,
      /** 'guest' 或 'admin'（通过 AUTH 认证后升级） */
      role: 'guest',
      /** 服务器设了房间口令时，发送权限以 HELLO 里带的口令为准；观看不受限 */
      roomAuthed: !cfg.roomToken,
      /** 通过校验时记下的口令；发送时与当前配置比对，口令改了老连接就得重新过 */
      roomAuthedToken: cfg.roomToken || null,
      connectedAt: Date.now(),
      lastSeen: Date.now()
    }
    this.clients.set(ws, client)
    if (urlInternal) {
      // 内部通道不打印 IP 和在线数：那是主机自己连自己，打出来只会误导（「127.0.0.1 已连接（在线 1）」）
      this.onLog({ level: 'info', msg: '主机内部发送通道已接入（不计入在线数）' })
    } else {
      this.onLog({ level: 'info', msg: `${ip} 已连接（在线 ${this.online()}）` })
    }
    this.sendTo(ws, { type: MSG.STATS, online: this.online() })
    if (this.history.length) {
      this.sendTo(ws, { type: MSG.HISTORY, items: this.history.slice(-30) })
    }
    this.broadcastStats()
    return client
  }

  removeClient (ws) {
    const client = this.clients.get(ws)
    if (!client) return
    this.clients.delete(ws)
    const tag = client.internal ? '内部通道' : (client.name || '未报名')
    this.onLog({ level: 'info', msg: `${client.ip}（${tag}）已断开（在线 ${this.online()}）` })
    this.broadcastStats()
  }

  clientIp (req) {
    let ip = (req.socket && req.socket.remoteAddress) || 'unknown'
    // IPv6 映射写法 ::ffff:192.168.1.5
    if (ip.startsWith('::ffff:')) ip = ip.slice(7)
    // 本机回环可能不是"真人"：cloudflared 等反代跑在本机，外部用户经它进来时
    // TCP 对端是回环。只有回环才信任转发头（直连时 remoteAddress 改不了，
    // 局域网用户伪造不了头冒充别人），取隧道透传的真实来源 IP。
    if (ip === '127.0.0.1' || ip === '::1') {
      const fwd = req.headers || {}
      const real = String(fwd['cf-connecting-ip'] || '').trim() ||
        String(fwd['x-forwarded-for'] || '').split(',')[0].trim()
      if (real) ip = real
    }
    return ip
  }

  online () {
    // 主机内部发送通道（internal）不算真实设备
    let n = 0
    for (const c of this.clients.values()) {
      if (!c.internal) n++
    }
    return n
  }

  // ---------------------------------------------------------------- 消息处理

  handle (ws, raw) {
    const client = this.clients.get(ws)
    if (!client) return

    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return this.reject(ws, REJECT.BAD_PAYLOAD)
    }
    if (!msg || typeof msg !== 'object') return this.reject(ws, REJECT.BAD_PAYLOAD)

    client.lastSeen = Date.now()

    switch (msg.type) {
      case MSG.PING:
        return this.sendTo(ws, { type: MSG.PONG, ts: Date.now() })
      case MSG.HELLO:
        return this.handleHello(ws, client, msg)
      case MSG.SEND:
        return this.handleSend(ws, client, msg)
      case MSG.AUTH:
        return this.handleAuth(ws, client, msg)
      // 以下控制指令仅管理员可用（公网服务器模式）；局域网主机模式下
      // 这些指令只由主进程本地发起，不会出现在客户端消息里
      case MSG.CLEAR:
        return this.handleAdminControl(ws, client, () => {
          this.onLog({ level: 'info', msg: '管理员清空弹幕' })
          this.onClear()
        })
      case MSG.PAUSE:
        return this.handleAdminControl(ws, client, () => this.setPaused(true, client))
      case MSG.RESUME:
        return this.handleAdminControl(ws, client, () => this.setPaused(false, client))
      case MSG.SET_CONFIG:
        return this.handleSetConfig(ws, client, msg)
      default:
        return this.reject(ws, REJECT.BAD_PAYLOAD, msg.reqId)
    }
  }

  handleAuth (ws, client, msg) {
    const cfg = this.getConfig()
    if (msg.role !== 'admin') return this.reject(ws, REJECT.BAD_PAYLOAD, msg.reqId)
    if (!cfg.adminToken) {
      // 没配置管理口令 = 不开放远程管理，直接拒绝
      return this.reject(ws, REJECT.FORBIDDEN, msg.reqId)
    }
    if (String(msg.token || '') !== cfg.adminToken) {
      this.onLog({ level: 'warn', msg: `管理员认证失败，来自 ${client.ip}` })
      return this.reject(ws, REJECT.BAD_ADMIN_TOKEN, msg.reqId)
    }
    client.role = 'admin'
    // 管理员天然拥有发送权限（否则开了房间口令后连公告都发不了）
    client.roomAuthed = true
    this.onLog({ level: 'info', msg: `管理员已接入（${client.ip}）` })
    this.sendTo(ws, {
      type: MSG.ACK,
      reqId: msg.reqId,
      ok: true,
      role: 'admin',
      online: this.clients.size,
      paused: !!cfg.paused,
      blockedWords: Array.isArray(cfg.blockedWords) ? cfg.blockedWords : []
    })
  }

  /** 管理员专属指令的统一入口：权限不够就拒绝，够就执行 */
  handleAdminControl (ws, client, fn) {
    if (client.role !== 'admin') {
      return this.reject(ws, REJECT.FORBIDDEN)
    }
    fn()
  }

  handleSetConfig (ws, client, msg) {
    if (client.role !== 'admin') return this.reject(ws, REJECT.FORBIDDEN)
    if (!this.setConfig) return this.reject(ws, REJECT.FORBIDDEN)
    const patch = msg.config || {}
    const clean = {}

    // 目前只放行屏蔽词，其他字段一律忽略 —— 公网入口宁可少给权限
    if (Array.isArray(patch.blockedWords)) {
      clean.blockedWords = patch.blockedWords
        .map(w => normalizeText(String(w)))
        .filter(Boolean)
        .slice(0, 200)
    }
    if (!Object.keys(clean).length) return this.reject(ws, REJECT.BAD_PAYLOAD, msg.reqId)

    this.setConfig(clean)
    const cfg = this.getConfig()
    this.sendTo(ws, {
      type: MSG.ACK,
      reqId: msg.reqId,
      ok: true,
      config: { blockedWords: cfg.blockedWords }
    })
    this.onLog({ level: 'info', msg: `管理员更新了屏蔽词（当前 ${cfg.blockedWords.length} 条）` })
  }

  /** 管理员远程切换暂停状态：改配置 + 广播全端 */
  setPaused (next, client) {
    if (this.setConfig) this.setConfig({ paused: !!next })
    this.broadcast({ type: next ? MSG.PAUSE : MSG.RESUME })
    this.onLog({ level: 'info', msg: `${client && client.ip === 'local' ? '本机' : '管理员'}${next ? '暂停' : '恢复'}上屏` })
  }

  handleHello (ws, client, msg) {
    const cfg = this.getConfig()
    // 原样存昵称（可能为空）：显示名在 publish 里统一决定，这里不预设"匿名"
    const name = normalizeText(msg.name).slice(0, LIMITS.NAME_MAX)

    // 主机内部发送通道：主机进程自连的 ws 客户端，不占在线设备数
    if (!client.internal && msg.internal === true) {
      client.internal = true
      this.onLog({ level: 'info', msg: '主机内部发送通道已接入（不计入在线数）' })
      this.broadcastStats()
    }

    // 服务器设了房间口令：HELLO 里的口令决定发送权限，不对就降级为"只看"
    if (cfg.roomToken) {
      const token = String(msg.token || '')
      if (!token) {
        client.roomAuthed = false
        client.roomAuthedToken = null
      } else if (token === cfg.roomToken) {
        client.roomAuthed = true
        client.roomAuthedToken = cfg.roomToken
      } else {
        client.roomAuthed = false
        client.roomAuthedToken = null
        return this.reject(ws, REJECT.BAD_TOKEN, msg.reqId)
      }
    } else {
      client.roomAuthed = true
      client.roomAuthedToken = null
    }

    client.name = name
    this.sendTo(ws, {
      type: MSG.ACK,
      reqId: msg.reqId,
      ok: true,
      you: { name: name || DEFAULT_NAME, ip: client.ip },
      canSend: client.roomAuthed,
      /** 告知昵称政策：'required'=强制实名（匿名已关），发送端据此锁定匿名选项 */
      namePolicy: cfg.forceNickname ? 'required' : 'free'
    })
  }

  handleSend (ws, client, msg) {
    // 公网模式下没过口令的连接只允许观看
    if (!client.roomAuthed) return this.reject(ws, REJECT.NEED_TOKEN, msg.reqId)

    // 口令以当前配置为准：主机中途开口令或改口令后，老连接必须重新过口令才能发
    const liveCfg = this.getConfig()
    if (client.role !== 'admin' && liveCfg.roomToken && client.roomAuthedToken !== liveCfg.roomToken) {
      return this.reject(ws, REJECT.NEED_TOKEN, msg.reqId)
    }

    // 固定弹幕（公告）是管理特权，普通连接即使过了房间口令也不行
    if (msg.mode === 'fixed' && client.role !== 'admin') {
      return this.reject(ws, REJECT.FORBIDDEN, msg.reqId)
    }

    const result = this.publish({
      text: msg.text,
      name: msg.name,
      color: msg.color,
      size: msg.size,
      mode: msg.mode,
      position: msg.position,
      stayMs: msg.stayMs,
      style: msg.style,
      image: msg.image,
      fallbackName: client.name,
      // 限流按"连接"而不是按 IP：同一台机器上网页发送端 + 加入端桌宠
      // 是两个独立的使用者，共享一个 IP 桶会互相吃掉配额（网页发几条，
      // 桌宠立刻"发得太快了"）。防刷场景里恶意方本来就能随意重连，
      // 按连接限额已经足够。
      rateKey: client.role === 'admin' ? 'console' : client.id,
      logIp: client.ip
    })
    if (!result.ok) {
      const who = `${client.ip}${client.name ? `（${client.name}）` : ''}`
      this.onLog({ level: 'warn', msg: `发送被拒（${REJECT_TEXT[result.code] || result.code}）：${who}${result.detail ? '，' + result.detail : ''}` })
      return this.reject(ws, result.code, msg.reqId, result.detail)
    }
    client.name = result.item.name // 记住这次用的昵称，下次不填就用它
    const preview = result.item.text.length > 24 ? result.item.text.slice(0, 24) + '…' : result.item.text
    const imgTag = result.item.image ? '【图片】' : ''
    this.onLog({ level: 'info', msg: `弹幕发出：${result.item.name}（${client.ip}）${imgTag}${preview}` })
    this.sendTo(ws, { type: MSG.ACK, reqId: msg.reqId, ok: true, id: result.item.id })
  }

  /**
   * 发布一条弹幕，返回 { ok, item } 或 { ok:false, code }。
   * ws 收到的和小球本地发的都走这里 —— 校验、屏蔽词、限流只有一份实现，
   * 避免"本机发的不受限流"这种双标。
   * mode='fixed' 为控制台固定弹幕：不滚动，落点上/中/下，停留 stayMs 后消失。
   */
  publish ({ text, name, color, size, fallbackName, rateKey, logIp, mode = 'scroll', position, stayMs, style, image }) {
    const cfg = this.getConfig()
    const isFixed = mode === 'fixed'

    // 固定弹幕是主机公告，不受"暂停上屏"约束；其他照旧
    if (cfg.paused && !isFixed) return { ok: false, code: REJECT.PAUSED }
    if (!this.take(rateKey)) return { ok: false, code: REJECT.RATE_LIMIT }

    const clean = normalizeText(text)
    const hasImage = image !== undefined && image !== null && image !== ''
    if (!clean && !hasImage) return { ok: false, code: REJECT.EMPTY }
    if (clean.length > LIMITS.TEXT_MAX) return { ok: false, code: REJECT.TOO_LONG }

    const hit = this.matchBlocked(clean, cfg.blockedWords)
    if (hit) {
      this.onLog({ level: 'warn', msg: `拦截屏蔽词「${hit}」来自 ${logIp || rateKey}` })
      return { ok: false, code: REJECT.BLOCKED, detail: `包含屏蔽词「${hit}」` }
    }

    // 图片弹幕：先校验（快速失败给明确原因），再过独立限流（防刷图）。
    // 间隔秒数控制台可调（cfg.imageRateSec，0 = 不限流），拒绝提示带实际秒数。
    if (hasImage) {
      const bad = this.validateImageData(image)
      if (bad === 'large') return { ok: false, code: REJECT.IMAGE_TOO_LARGE }
      if (bad) return { ok: false, code: REJECT.IMAGE_BAD_FORMAT }
      const imgSec = Math.max(0, Math.min(600, Math.round(Number(cfg.imageRateSec ?? 15)) || 0))
      if (imgSec > 0 && !this.takeWith(`${rateKey}|img`, LIMITS.IMAGE_RATE_MAX, imgSec * 1000)) {
        return { ok: false, code: REJECT.IMAGE_RATE_LIMIT, detail: `图片限流：${imgSec} 秒一张（控制台可调）` }
      }
    }

    // 显示名统一在这里定，客户端传什么都不算数：
    //   强制实名开（固定公告除外，公告是主机身份）→ 没有昵称直接拒绝，逼发送端去填名字；
    //   显式传「匿名」也算没填，堵住"换个字段绕过开关"的口子；
    //   关闭时允许匿名，昵称 > 连接注册名 > 「匿名」。
    let who = normalizeText(name).slice(0, LIMITS.NAME_MAX)
    if (!who || who === DEFAULT_NAME) who = normalizeText(fallbackName).slice(0, LIMITS.NAME_MAX)
    if ((!who || who === DEFAULT_NAME) && !isFixed && cfg.forceNickname) {
      return { ok: false, code: REJECT.NEED_NAME }
    }
    if (!who || who === DEFAULT_NAME) who = DEFAULT_NAME

    const item = {
      id: `${Date.now().toString(36)}-${(++this.seq).toString(36)}`,
      text: clean,
      name: who,
      color: normalizeColor(color),
      // 字号是"弹幕内容"的一部分：没指定就用协议基准值。
      // 绝不能用主机配置的 fontSize 当默认值 —— 那会让主机控制台的字号设置
      // 悄悄串到所有加入端的每一条新弹幕上（本地设置只该管本地显示）。
      size: Math.round(clamp(size, LIMITS.SIZE_MIN, LIMITS.SIZE_MAX, LIMITS.SIZE_DEFAULT)),
      mode: isFixed ? 'fixed' : 'scroll',
      ts: Date.now()
    }
    if (isFixed) {
      item.position = LIMITS.POSITIONS.includes(position) ? position : 'center'
      item.stayMs = Math.round(clamp(stayMs, LIMITS.STAY_MS_MIN, LIMITS.STAY_MS_MAX, LIMITS.STAY_MS_DEFAULT))
      item.style = ['bubble', 'card', 'plain'].includes(style) ? style : 'card'
    }
    if (hasImage) item.image = image

    this.pushHistory(item)
    this.broadcast({ type: MSG.DANMAKU, item })
    this.onDanmaku(item)
    return { ok: true, item }
  }

  /**
   * 主机本机（桌宠）发送：没有 ws 连接，走独立的限流桶 'local'。
   * 主机自己发的东西同样要被屏蔽词和上限管住。
   */
  publishLocal ({ text, name, color, size }) {
    const result = this.publish({
      text,
      name,
      color,
      size,
      fallbackName: DEFAULT_NAME,
      rateKey: 'local',
      logIp: '本机桌宠'
    })
    if (result.ok && result.item) this.onLog({ level: 'info', msg: `本机发出弹幕：${result.item.text}` })
    return result
  }

  /**
   * 主机控制台发送固定弹幕（公告）：不滚动，固定在屏幕上/中/下，停留 N 秒后消失。
   * 同样过屏蔽词和限流（独立限流桶 'console'），但不受"暂停上屏"约束。
   */
  publishFixed ({ text, position, stayMs, color, style, logIp }) {
    const result = this.publish({
      text,
      name: '主机',
      fallbackName: '主机',
      color,
      rateKey: 'console',
      logIp: logIp || '控制台',
      mode: 'fixed',
      position,
      stayMs,
      style
    })
    if (result.ok && result.item) {
      this.onLog({ level: 'info', msg: `控制台发出固定弹幕：${result.item.text}` })
    }
    return result
  }

  reject (ws, code, reqId, customMsg) {
    this.sendTo(ws, { type: MSG.REJECT, code, msg: customMsg || REJECT_TEXT[code] || '发送失败', reqId })
  }

  matchBlocked (text, words) {
    if (!Array.isArray(words) || !words.length) return null
    const lower = text.toLowerCase()
    for (const w of words) {
      const word = normalizeText(w)
      if (word && lower.includes(word.toLowerCase())) return word
    }
    return null
  }

  // ---------------------------------------------------------------- 限流

  take (key) {
    const { rateMax, rateWindowMs } = this.getConfig()
    return this.takeWith(key, rateMax, rateWindowMs)
  }

  /** 通用限流：文字用配置的桶，图片用独立更严的桶（15s 一张），互不挤占 */
  takeWith (key, max, windowMs) {
    const now = Date.now()
    let bucket = this.buckets.get(key)
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 }
      this.buckets.set(key, bucket)
    }
    if (bucket.count >= max) return false
    bucket.count += 1
    return true
  }

  /** 图片魔数校验：dataURL 头 + 解码后文件签名双重确认，大小按解码后口径算 */
  validateImageData (dataUrl) {
    if (typeof dataUrl !== 'string' || !IMAGE_MIME_RE.test(dataUrl)) return 'format'
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    let buf
    try {
      buf = Buffer.from(b64, 'base64')
    } catch {
      return 'format'
    }
    if (!buf || buf.length < 16) return 'format'
    if (buf.length > LIMITS.IMAGE_MAX_BYTES) return 'large'
    // 文件签名：png 89504E47 / jpeg FFD8FF / gif "GIF8" / webp "RIFF....WEBP"
    const head = buf.subarray(0, 12)
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47
    const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF
    const isGif = head.toString('ascii', 0, 4) === 'GIF8'
    const isWebp = head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
    if (!isPng && !isJpeg && !isGif && !isWebp) return 'format'
    return null
  }

  // ---------------------------------------------------------------- 广播

  sendTo (ws, payload) {
    if (ws.readyState !== 1 /* OPEN */) return
    try {
      ws.send(JSON.stringify(payload))
    } catch (err) {
      console.error('[room] 发送失败：', err.message)
    }
  }

  broadcast (payload) {
    const raw = JSON.stringify(payload)
    for (const ws of this.clients.keys()) {
      if (ws.readyState !== 1) continue
      try {
        ws.send(raw)
      } catch { /* 单条失败不影响其他连接 */ }
    }
  }

  broadcastStats () {
    const online = this.online()
    this.broadcast({ type: MSG.STATS, online })
    this.onStats({ online })
  }

  // ---------------------------------------------------------------- 历史

  pushHistory (item) {
    this.history.push(item)
    if (this.history.length > LIMITS.HISTORY_MAX) {
      this.history.splice(0, this.history.length - LIMITS.HISTORY_MAX)
    }
    // 图片是内存大户（一张可到 1MB）：历史只保留最近 N 张，
    // 更老的把 dataURL 摘掉，留文字占位 —— 新连接拿历史不会拖爆内存
    let keep = 0
    for (let i = this.history.length - 1; i >= 0; i--) {
      const it = this.history[i]
      if (!it.image) continue
      keep++
      if (keep > LIMITS.IMAGE_HISTORY_KEEP) {
        delete it.image
        if (!it.text) it.text = '[图片]'
      }
    }
  }

  clearHistory () {
    this.history = []
  }
}

module.exports = { Room, normalizeText, normalizeColor }
