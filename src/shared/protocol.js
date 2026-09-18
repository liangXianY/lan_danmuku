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
    POSITIONS: ['top', 'center', 'bottom'],

    // ---- 图片弹幕 ----
    /** 图片解码后大小上限（字节）：dataURL 是 base64，服务端按解码后算 */
    IMAGE_MAX_BYTES: 1024 * 1024,
    /** 客户端压缩的最长边（px） */
    IMAGE_DIM_MAX: 1280,
    /** 历史里最多保留几张带图弹幕（防爆内存，更老的降级为文字占位） */
    IMAGE_HISTORY_KEEP: 3,
    /** 图片限流窗口（毫秒）：比文字严得多，防刷屏 */
    IMAGE_RATE_WINDOW_MS: 15000,
    /** 图片限流窗口内最多几张 */
    IMAGE_RATE_MAX: 1
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
    BAD_ADMIN_TOKEN: 'BAD_ADMIN_TOKEN',
    /** 图片超过大小上限 */
    IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
    /** 图片格式不对（不在白名单或魔数校验失败） */
    IMAGE_BAD_FORMAT: 'IMAGE_BAD_FORMAT',
    /** 图片发得太快（独立于文字限流，更严） */
    IMAGE_RATE_LIMIT: 'IMAGE_RATE_LIMIT'
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
    BAD_ADMIN_TOKEN: '管理口令不对',
    IMAGE_TOO_LARGE: '图片太大，压一压再发（上限 1MB）',
    IMAGE_BAD_FORMAT: '只支持 png / jpg / webp / gif 图片',
    IMAGE_RATE_LIMIT: '图片发得太快了，歇一会再发'
  }

  /** 预设弹幕颜色 —— 兼顾深色与浅色桌面背景下的可读性；不够用可在发送处自定义取色 */
  const PRESET_COLORS = [
    '#FFFFFF', '#FFD400', '#FF9F1C', '#FF7A45',
    '#FF4D4F', '#FF5C8A', '#4FC3F7', '#00E5CC',
    '#7CFFB2', '#52C41A', '#C7B3FF', '#9254DE'
  ]

  /** 快捷弹幕 */
  const QUICK_TEXTS = ['666', '哈哈哈哈哈', '前排', '牛啊', '这也行？', '???', '前方高能', '泪目了']

  /** 图片弹幕 dataURL 的合法头（服务端魔数校验前的快速通道，两端口径一致） */
  const IMAGE_MIME_RE = /^data:image\/(png|jpeg|webp|gif);base64,/

  /**
   * 把用户选的图片文件压成可发送的 dataURL（发送端网页与桌宠共用）。
   * 策略：
   *   - gif ≤1MB   原样保留（压缩会丢动画）
   *   - png ≤1MB   原样保留（压缩会丢透明通道）
   *   - 其余       canvas 等比缩到最长边 IMAGE_DIM_MAX，转 JPEG 质量 0.8
   * 失败（解码不了/类型不支持）走 reject，调用方提示用户。
   */
  function compressImage (file) {
    return new Promise((resolve, reject) => {
      if (!file || typeof file.type !== 'string' || file.type.indexOf('image/') !== 0) {
        reject(new Error('这不是图片文件'))
        return
      }
      const keep = (dataUrl) => {
        // base64 会使体积膨胀约 1/3，按解码后口径换算校验
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        if (Math.round(b64.length * 3 / 4) > LIMITS.IMAGE_MAX_BYTES) {
          reject(new Error('图片太大，压一压再发（上限 1MB）'))
        } else {
          resolve(dataUrl)
        }
      }
      if ((file.type === 'image/gif' || file.type === 'image/png') && file.size <= LIMITS.IMAGE_MAX_BYTES) {
        const fr = new FileReader()
        fr.onload = () => keep(String(fr.result))
        fr.onerror = () => reject(new Error('图片读取失败'))
        fr.readAsDataURL(file)
        return
      }
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        try {
          const scale = Math.min(1, LIMITS.IMAGE_DIM_MAX / Math.max(img.width, img.height))
          const w = Math.max(1, Math.round(img.width * scale))
          const h = Math.max(1, Math.round(img.height * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          // JPEG 没有透明通道，透明区垫白底避免发黑
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(0, 0, w, h)
          ctx.drawImage(img, 0, 0, w, h)
          keep(canvas.toDataURL('image/jpeg', 0.8))
        } catch (err) {
          reject(new Error('图片处理失败'))
        } finally {
          URL.revokeObjectURL(url)
        }
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        // 解不开的原因五花八门（HEIC/损坏/超大长图），文案带上类型和大小才好定位
        console.error('[danmaku] 图片解码失败：', file.name, file.type, file.size, 'bytes')
        if (/^image\/hei[cf]$/i.test(file.type)) {
          reject(new Error('iPhone 的 HEIC 照片发不了：先用画图打开，另存为 JPG 再发'))
        } else {
          const kb = Math.max(1, Math.round(file.size / 1024))
          reject(new Error(`图片解码失败（${file.type || '未知类型'} / ${kb} KB），文件可能损坏或格式不支持`))
        }
      }
      img.src = url
    })
  }

  return { MSG, LIMITS, REJECT, REJECT_TEXT, PRESET_COLORS, QUICK_TEXTS, IMAGE_MIME_RE, compressImage }
})
