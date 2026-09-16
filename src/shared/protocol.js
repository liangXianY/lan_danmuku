/**
 * 前后端共用的消息协议定义。
 * 主进程用 require 加载，浏览器页面用 <script> 加载得到 window.DanmakuProtocol。
 * 三方共用同一份定义，避免协议漂移。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.DanmakuProtocol = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const MSG = {
    // client -> server
    HELLO: 'hello',
    SEND: 'send',
    PING: 'ping',
    /** 管理员认证：{ token }，通过后该连接获得管理权限（公网服务器模式） */
    AUTH: 'auth',
    /** 管理员修改服务端配置：目前只放行屏蔽词 */
    SET_CONFIG: 'set-config',

    // server -> client
    DANMAKU: 'danmaku',
    ACK: 'ack',
    REJECT: 'reject',
    STATS: 'stats',
    PONG: 'pong',
    HISTORY: 'history',

    // 主机下发控制指令（最终作用于弹幕层）
    CLEAR: 'clear',
    PAUSE: 'pause',
    RESUME: 'resume',
    CONFIG: 'config'
  }

  /** 服务端强校验用的边界值 —— 客户端传来的一切都不可信 */
  const LIMITS = {
    TEXT_MAX: 60,
    NAME_MAX: 12,
    SIZE_MIN: 16,
    SIZE_MAX: 48,
    /** 发送端没指定字号时弹幕内容的基准字号（与任何一端的本地显示设置无关） */
    SIZE_DEFAULT: 26,
    HISTORY_MAX: 200,
    /** 固定弹幕（控制台公告）停留时长边界（毫秒） */
    STAY_MS_MIN: 1000,
    STAY_MS_MAX: 30000,
    STAY_MS_DEFAULT: 8000,
    /** 固定弹幕允许的落点 */
    POSITIONS: ['top', 'center', 'bottom']
  }

  const REJECT = {
    RATE_LIMIT: 'RATE_LIMIT',
    EMPTY: 'EMPTY',
    TOO_LONG: 'TOO_LONG',
    BLOCKED: 'BLOCKED',
    PAUSED: 'PAUSED',
    BAD_PAYLOAD: 'BAD_PAYLOAD',
    /** 服务器开启了房间口令，发送前必须先在 HELLO 里带上正确口令 */
    NEED_TOKEN: 'NEED_TOKEN',
    /** 口令不对 */
    BAD_TOKEN: 'BAD_TOKEN',
    /** 服务器强制实名：没填昵称不允许发言 */
    NEED_NAME: 'NEED_NAME',
    /** 该操作需要管理员权限 */
    FORBIDDEN: 'FORBIDDEN',
    /** 管理员口令不对 */
    BAD_ADMIN_TOKEN: 'BAD_ADMIN_TOKEN'
  }

  const REJECT_TEXT = {
    RATE_LIMIT: '发得太快了，歇一下',
    EMPTY: '内容不能为空',
    TOO_LONG: '最多 ' + LIMITS.TEXT_MAX + ' 个字',
    BLOCKED: '这条被屏蔽词拦下了',
    PAUSED: '弹幕已暂停上屏',
    BAD_PAYLOAD: '数据格式不对',
    NEED_TOKEN: '这个房间需要口令才能发言',
    BAD_TOKEN: '口令不对，问主持人要一个',
    NEED_NAME: '服务器要求填昵称才能发言，匿名已关闭',
    FORBIDDEN: '没有权限执行这个操作',
    BAD_ADMIN_TOKEN: '管理口令不对'
  }

  /** 预设弹幕颜色 —— 兼顾深色与浅色桌面背景下的可读性；不够用可在发送处自定义取色 */
  const PRESET_COLORS = [
    '#FFFFFF', '#FFD400', '#FF9F1C', '#FF7A45',
    '#FF4D4F', '#FF5C8A', '#4FC3F7', '#00E5CC',
    '#7CFFB2', '#52C41A', '#C7B3FF', '#9254DE'
  ]

  /** 快捷弹幕 */
  const QUICK_TEXTS = ['666', '哈哈哈哈哈', '前排', '牛啊', '这也行？', '???', '前方高能', '泪目了']

  return { MSG, LIMITS, REJECT, REJECT_TEXT, PRESET_COLORS, QUICK_TEXTS }
})
