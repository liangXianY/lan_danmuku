'use strict';
/* eslint-disable */

/**
 * 弹幕层渲染引擎
 * ---------------------------------------------------------------
 * 职责：接收主进程推来的弹幕 → 分配轨道 → 用 Web Animations API 从右往左滚出。
 *
 * 为什么用 Web Animations API 而不是 CSS @keyframes：
 *   1. transform 动画跑在合成线程上，主进程就算卡一下也不掉帧
 *   2. 可以随时 cancel / pause / 精确读取进度，节点池复用不会残留 fill 效果
 *   3. 不需要为每条弹幕写 style 标签或强制重排
 */
(function () {
  const FONT_STACK = '"Microsoft YaHei", "PingFang SC", system-ui, -apple-system, sans-serif'

  /** 同轨道前后两条弹幕的最小间距（px），实际用配置里的 laneGap */
  const POOL_MAX = 80
  /** 排队等待超过这个时长就直接上屏（宁可轻微重叠，也不让弹幕延迟出现） */
  const MAX_LEAD_MS = 1500

  const stage = document.getElementById('stage')

  /**
   * 固定弹幕的独立全屏层。
   * 不能挂在 #stage 里 —— stage 被限高成顶部弹幕带且 overflow:hidden，
   * "中间/下方"落点的节点会被裁掉直接看不见（这是 center 落点失效的根因）。
   */
  const fixedLayer = document.createElement('div')
  fixedLayer.id = 'fixedLayer'
  stage.parentNode.appendChild(fixedLayer)

  const cfg = {
    fontSize: 26,
    scrollDuration: 9,
    laneGap: 28,
    opacity: 0.96,
    showName: false,
    stageHeight: 300,
    paused: false
  }

  let stageWidth = window.innerWidth
  let laneHeight = 42
  /** 轨道占用时间表：lanes[i] = 该轨道下一条弹幕最早可用的时间戳(performance.now 基准) */
  let lanes = [{ availableAt: 0 }]

  const pool = []
  const active = new Set()
  let buffer = []

  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')

  // ---------------------------------------------------------------- 工具

  function pxPerMs () {
    const perSecond = stageWidth / Math.max(1, cfg.scrollDuration)
    return perSecond / 1000
  }

  /**
   * 预测量文字宽度。
   * 绝不能用 `text.length * fontSize` 估算 —— 中英文和 emoji 混排下必然错得离谱，
   * 误差会直接导致轨道判断失准、弹幕互相叠在一起。
   */
  function measureText (text, fontSize) {
    measureCtx.font = `600 ${fontSize}px ${FONT_STACK}`
    return Math.ceil(measureCtx.measureText(text).width)
  }

  function displayText (item) {
    return cfg.showName && item.name ? `${item.name}: ${item.text}` : item.text
  }

  // ---------------------------------------------------------------- 布局

  /** 按当前 laneHeight 把已上屏的弹幕挪回所属轨道的正确位置 */
  function reposition (rec) {
    const offset = Math.max(0, (laneHeight - rec.size * 1.3) / 2)
    rec.node.style.top = `${Math.round(rec.laneIndex * laneHeight + offset)}px`
  }

  function relayout (preserveActive) {
    stageWidth = stage.clientWidth || window.innerWidth
    const newLaneHeight = Math.max(20, Math.round(cfg.fontSize * 1.65))
    const laneHeightChanged = newLaneHeight !== laneHeight
    laneHeight = newLaneHeight

    // 弹幕层窗口盖满整屏，滚动只发生在顶部 stageHeight 高的带子里
    stage.style.height = `${cfg.stageHeight}px`
    stage.style.bottom = 'auto'

    const count = Math.max(1, Math.floor(cfg.stageHeight / laneHeight))
    if (count === lanes.length) {
      // 轨道数没变：字号变了也只需要把已有弹幕垂直居中微调一下
      if (laneHeightChanged && preserveActive) {
        for (const rec of active) reposition(rec)
      }
      return
    }

    // 轨道数变了：超出新轨道数的弹幕收掉，其余原地保留（不清屏！）
    lanes = Array.from({ length: count }, (_, i) => lanes[i] || { availableAt: 0 })
    if (!preserveActive) {
      clearAll()
      return
    }
    for (const rec of Array.from(active)) {
      if (rec.laneIndex >= count) {
        release(rec)
      } else if (laneHeightChanged) {
        reposition(rec)
      }
    }
  }

  // ---------------------------------------------------------------- 节点池

  function acquire () {
    const node = pool.pop()
    if (node) return node
    const el = document.createElement('div')
    el.className = 'dm'
    return el
  }

  function release (rec) {
    if (!active.has(rec)) return
    active.delete(rec)
    rec.anim.onfinish = null
    rec.anim.oncancel = null
    try { rec.anim.cancel() } catch { /* 已结束 */ }
    rec.node.remove()
    if (pool.length < POOL_MAX) pool.push(rec.node)
  }

  // ---------------------------------------------------------------- 轨道调度

  /**
   * 选轨道：挑"最早空出来"的那条。
   * 因为同轨道里所有弹幕速度一致，只要新弹幕的入场时刻满足
   *   上一条的右边缘 <= 屏幕右边缘
   * 就永远不会追尾。
   */
  function pickLane (now, width) {
    let best = 0
    let earliest = Infinity
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i].availableAt < earliest) {
        earliest = lanes[i].availableAt
        best = i
      }
    }

    let startAt = Math.max(now, earliest)
    const lead = startAt - now
    if (lead > MAX_LEAD_MS) {
      // 全都排到很久以后了：直接插队，牺牲一点点重叠换实时性
      startAt = now
    }

    lanes[best].availableAt = startAt + (width + cfg.laneGap) / pxPerMs()
    return { index: best, startAt }
  }

  // ---------------------------------------------------------------- 上屏

  function spawn (item) {
    if (!item || !item.text) return

    // 固定弹幕（控制台公告）：不滚动、不受暂停约束，直接落点显示
    if (item.mode === 'fixed') return drawFixed(item)

    if (cfg.paused) {
      buffer.push(item)
      if (buffer.length > 200) buffer.shift()
      return
    }

    // 弹幕内容自带基准字号（协议 SIZE_DEFAULT=26）；本地「字号」设置是本机的缩放系数，
    // 只影响这块屏幕，不会跟着弹幕广播到别的设备
    const size = Math.round((item.size || 26) * (cfg.fontSize / 26))
    const text = displayText(item)
    const width = measureText(text, size)

    const now = performance.now()
    const lane = pickLane(now, width)
    const delay = lane.startAt - now

    if (delay > 20) {
      setTimeout(() => draw(item, text, size, width, lane.index), delay)
    } else {
      draw(item, text, size, width, lane.index)
    }
  }

  function draw (item, text, size, width, laneIndex) {
    if (cfg.paused) {
      buffer.push(item)
      if (buffer.length > 200) buffer.shift()
      return
    }

    // 延迟入场期间轨道数可能变了（用户拖了高度/字号），夹回有效范围
    laneIndex = Math.min(laneIndex, lanes.length - 1)

    const node = acquire()
    node.textContent = ''
    if (cfg.showName && item.name) {
      const who = document.createElement('span')
      who.className = 'who'
      who.textContent = `${item.name}: `
      node.appendChild(who)
    }
    node.appendChild(document.createTextNode(item.text))

    node.style.fontSize = `${size}px`
    node.style.color = item.color || '#FFFFFF'
    node.style.opacity = String(cfg.opacity)
    // 字号不同时让它在轨道里垂直居中，避免上下参差
    const offset = Math.max(0, (laneHeight - size * 1.3) / 2)
    node.style.top = `${Math.round(laneIndex * laneHeight + offset)}px`

    stage.appendChild(node)

    const durationMs = cfg.scrollDuration * 1000 * (stageWidth + width) / Math.max(1, stageWidth)

    const anim = node.animate(
      [
        { transform: `translate3d(${stageWidth}px, 0, 0)` },
        { transform: `translate3d(${-width}px, 0, 0)` }
      ],
      { duration: durationMs, easing: 'linear', fill: 'forwards' }
    )

    const rec = { node, anim, laneIndex, size }
    active.add(rec)
    anim.onfinish = () => release(rec)
  }

  // ---------------------------------------------------------------- 固定弹幕

  /** 每个落点的存活列表，用于同位置多条时竖向堆叠 */
  const fixedActive = { top: [], center: [], bottom: [] }

  /** 固定弹幕：横向居中，落点上/中/下，支持三种样式，停留 stayMs 后淡出消失 */
  function drawFixed (item) {
    const position = fixedActive[item.position] ? item.position : 'center'
    const styleName = ['bubble', 'card', 'plain'].includes(item.style) ? item.style : 'card'
    const size = Math.round((item.size || 26) * (cfg.fontSize / 26))
    const op = cfg.opacity

    const node = document.createElement('div')
    node.className = 'dm-fixed style-' + styleName
    node.style.fontSize = `${size}px`
    node.style.color = item.color || '#FFFFFF'
    node.textContent = item.text
    fixedLayer.appendChild(node)

    const arr = fixedActive[position]
    arr.push(node)
    layoutFixed(position)

    const stayMs = Math.max(800, Number(item.stayMs) || 2000)
    const anim = node.animate(
      [
        { opacity: 0, transform: 'translateX(-50%) translateY(-8px)' },
        { opacity: op, transform: 'translateX(-50%) translateY(0)', offset: 0.1 },
        { opacity: op, transform: 'translateX(-50%) translateY(0)', offset: 0.88 },
        { opacity: 0, transform: 'translateX(-50%) translateY(8px)' }
      ],
      { duration: stayMs, easing: 'ease-in-out', fill: 'forwards' }
    )
    anim.onfinish = () => {
      const i = arr.indexOf(node)
      if (i >= 0) arr.splice(i, 1)
      node.remove()
      layoutFixed(position)
    }
  }

  /** 同一位置多条固定弹幕按出现顺序竖向排开；落点全部约束在「弹幕显示区域」内（从屏幕顶部往下） */
  function layoutFixed (position) {
    const arr = fixedActive[position]
    if (!arr.length) return
    const lineH = Math.max(36, arr[0].offsetHeight + 14)
    const bandH = cfg.stageHeight // 弹幕显示区域：从屏幕顶部往下的高度
    arr.forEach((node, i) => {
      if (position === 'top') {
        node.style.top = `${12 + i * lineH}px`
        node.style.bottom = ''
      } else if (position === 'bottom') {
        // 贴显示区域底边往上堆（最新在最下面）
        node.style.top = `${Math.max(0, Math.round(bandH - 12 - (arr.length - i) * lineH))}px`
        node.style.bottom = ''
      } else {
        // 以显示区域中线为基准居中
        node.style.bottom = ''
        const blockH = arr.length * lineH
        node.style.top = `${Math.round(bandH / 2 - blockH / 2 + i * lineH)}px`
      }
    })
  }

  // ---------------------------------------------------------------- 控制

  function clearAll () {
    for (const rec of Array.from(active)) {
      active.delete(rec)
      rec.anim.onfinish = null
      try { rec.anim.cancel() } catch { /* ignore */ }
      rec.node.remove()
      if (pool.length < POOL_MAX) pool.push(rec.node)
    }
    active.clear()
    pool.splice(0, pool.length) // 清屏时把池子也倒了，顺便释放内存
    lanes.forEach(l => { l.availableAt = 0 })
    buffer = []
    // 固定弹幕同样清掉
    for (const key of Object.keys(fixedActive)) {
      fixedActive[key].splice(0).forEach(n => n.remove())
    }
  }

  function flushBuffer () {
    if (!buffer.length) return
    const items = buffer
    buffer = []
    for (const item of items) spawn(item)
  }

  function setPaused (paused) {
    cfg.paused = !!paused
    if (!cfg.paused) flushBuffer()
  }

  function applyConfig (next) {
    if (!next) return
    const opacityChanged = next.opacity !== undefined && next.opacity !== cfg.opacity
    Object.assign(cfg, next)
    // 布局变化只做"保留 + 重新就位"，不清屏 —— 拖高度/字号滑块时当前弹幕不该消失
    relayout(true)
    if (opacityChanged) {
      for (const rec of active) rec.node.style.opacity = String(cfg.opacity)
    }
  }

  // ---------------------------------------------------------------- 对外接口

  window.overlayBridge.onInit(({ config }) => {
    applyConfig(config)
    relayout(true)
  })

  window.overlayBridge.onConfig(applyConfig)

  window.overlayBridge.onDanmaku(spawn)

  window.overlayBridge.onClear(clearAll)
  window.overlayBridge.onPause(() => setPaused(true))
  window.overlayBridge.onResume(() => setPaused(false))

  window.addEventListener('resize', () => relayout(true))

  // 定期上报渲染侧状态，控制台用来判断"弹幕层是否真的在跑"
  setInterval(() => {
    window.overlayBridge.report({
      active: active.size,
      lanes: lanes.length,
      buffered: buffer.length,
      width: stageWidth,
      height: cfg.stageHeight
    })
  }, 3000)

  relayout(true)
  window.overlayBridge.ready()
})()
