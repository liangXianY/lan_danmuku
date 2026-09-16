'use strict'

const fs = require('fs')
const path = require('path')

/** 默认配置 —— 同时作为"恢复默认"的基准 */
const DEFAULTS = {
  /** 运行模式：'host' 主机 | 'join' 加入；null 表示未选择（显示模式选择窗口） */
  mode: null,
  /** 加入模式记住的主机地址（origin，如 http://192.168.1.5:7321） */
  joinUrl: null,
  /** 加入模式的房间口令：公网服务器开启口令时自动随连接上报 */
  joinToken: '',
  /** 监听端口，被占用时自动向上探测 */
  port: 7321,
  /** 用户在控制台手动选定的网卡地址；null 表示自动挑第一个 */
  adapterAddress: null,
  /** 目标显示器 id；null 表示主屏 */
  displayId: null,
  /** 弹幕带占屏幕高度的比例 */
  heightRatio: 0.3,
  /** 字号（px） */
  fontSize: 26,
  /** 一条弹幕从右侧进入到完全离开左侧所需秒数，与屏幕宽度无关 */
  scrollDuration: 9,
  /** 弹幕之间（同轨道前后两条）的最小水平间距 px */
  laneGap: 28,
  /** 弹幕不透明度 */
  opacity: 0.96,
  /** 是否在弹幕前显示发送者昵称 */
  showName: false,
  /** 发送身份：昵称（空表示还没设置过） */
  senderName: '',
  /** 发送身份：是否匿名（勾上则忽略 senderName，统一显示"匿名"） */
  senderAnonymous: false,
  /** 发送身份：上次选的弹幕颜色 */
  senderColor: '#FFD400',
  /** 桌宠在屏幕上的位置 { x, y }；null 表示默认贴右下角 */
  ballPos: null,
  /** 是否暂停上屏 */
  paused: false,
  /** 屏蔽词列表 */
  blockedWords: [],
  /** 房间口令：非空时，客户端发言需要携带该口令（观看不受限）；空 = 任何人可发 */
  roomToken: '',
  /** 强制实名（服务器级开关）：开启后发送端不能匿名，没填昵称的发言会被拒绝并提示去填名字；
   *  关闭时允许匿名（不填昵称显示「匿名」） */
  forceNickname: false,
  /** 限流：窗口内最多几条 */
  rateMax: 5,
  /** 限流窗口（毫秒） */
  rateWindowMs: 3000,
  /** 控制台固定弹幕：上次选的落点 'top' | 'center' | 'bottom' */
  fixedPosition: 'center',
  /** 控制台固定弹幕：停留秒数（默认 8 秒） */
  fixedStaySec: 8,
  /** 控制台固定弹幕：样式 'card' 卡片 | 'bubble' 气泡 | 'plain' 纯文字 */
  fixedStyle: 'card',
  /** 控制台固定弹幕：文字颜色 */
  fixedColor: '#FFD400'
}

class Store {
  constructor (file) {
    this.file = file
    this.data = { ...DEFAULTS }
    this.load()
  }

  load () {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = { ...DEFAULTS, ...parsed }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[store] 配置读取失败，回退默认值：', err.message)
      }
    }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch (err) {
      console.error('[store] 配置保存失败：', err.message)
    }
  }

  get (key) {
    return key === undefined ? { ...this.data } : this.data[key]
  }

  set (patch) {
    const clean = {}
    for (const k of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k]
    }
    Object.assign(this.data, clean)
    this.save()
    return { ...this.data }
  }

  reset () {
    this.data = { ...DEFAULTS }
    this.save()
    return { ...this.data }
  }
}

module.exports = { Store, DEFAULTS }
