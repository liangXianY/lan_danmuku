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
    if (!item || (!item.text && !item.image)) return

    // 固定弹幕（控制台公告）：不滚动、不受暂停约束，直接落点显示
    if (item.mode === 'fixed') return drawFixed(item)

    if (cfg.paused) {
      buffer.push(item)
      if (buffer.length > 200) buffer.shift()
      return
    }

    // 图片弹幕：大图卡片独占多条轨道，走独立渲染路径
    if (item.image) return startImageCard(item)

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

  // ---------------------------------------------------------------- 图片弹幕

  /** 图片卡片占用的轨道数（css 里图高 128 + 信息条约 32 ≈ 160px，约 4 条标准轨道） */
  const IMG_LANES = 4

  /** 图片加载完成后再上屏：宽度取决于图片真实比例，提前猜必错 */
  function startImageCard (item) {
    const probe = new Image()
    probe.onload = () => drawImageCard(item, probe)
    probe.onerror = () => {} // 服务端已校验过，这里兜底静默丢弃
    probe.src = item.image
  }

  /**
   * 图片卡片的多轨调度：占连续 span 条轨道。
   * 在所有「连续 span 条」的窗口里挑窗口内最晚空闲时间最早的，
   * 然后把窗口内每条轨道的 availableAt 都推后 —— 后续文字弹幕
   * 落进这几条轨道时自然排在图片之后，不会穿过卡片。
   */
  function pickLanesForImage (now, width) {
    const span = Math.min(IMG_LANES, lanes.length)
    let best = 0
    let earliest = Infinity
    for (let i = 0; i + span <= lanes.length; i++) {
      let latest = 0
      for (let j = i; j < i + span; j++) {
        if (lanes[j].availableAt > latest) latest = lanes[j].availableAt
      }
      if (latest < earliest) { earliest = latest; best = i }
    }
    let startAt = Math.max(now, earliest)
    if (startAt - now > MAX_LEAD_MS) startAt = now // 排队太久宁可轻微重叠
    const passMs = (width + cfg.laneGap) / pxPerMs()
    for (let j = best; j < best + span; j++) lanes[j].availableAt = startAt + passMs
    return { index: best, startAt }
  }

  function drawImageCard (item, loaded) {
    if (cfg.paused) {
      buffer.push(item)
      if (buffer.length > 200) buffer.shift()
      return
    }

    const node = document.createElement('div')
    node.className = 'dm-img'
    node.appendChild(loaded) // dataURL 已缓存，插进卡片瞬间就绪
    if (item.name || item.text) {
      const bar = document.createElement('div')
      bar.className = 'dm-img-bar'
      if (item.name) {
        const who = document.createElement('span')
        who.className = 'who'
        who.textContent = item.name
        bar.appendChild(who)
      }
      if (item.text) {
        const cap = document.createElement('span')
        cap.textContent = item.text
        bar.appendChild(cap)
      }
      node.appendChild(bar)
    }

    stage.appendChild(node) // 初始 translate3d(100vw) 在屏幕外，先量宽
    const width = node.offsetWidth || 220
    const now = performance.now()
    const lane = pickLanesForImage(now, width)
    const delay = lane.startAt - now

    const run = () => {
      if (cfg.paused) {
        node.remove()
        buffer.push(item)
        if (buffer.length > 200) buffer.shift()
        return
      }
      node.style.top = `${lane.index * laneHeight}px`
      stage.appendChild(node)
      const durationMs = cfg.scrollDuration * 1000 * (stageWidth + width) / Math.max(1, stageWidth)
      const anim = node.animate(
        [
          { transform: `translate3d(${stageWidth}px, 0, 0)` },
          { transform: `translate3d(${-width}px, 0, 0)` }
        ],
        { duration: durationMs, easing: 'linear', fill: 'forwards' }
      )
      const rec = { node, anim, laneIndex: lane.index, size: 0, isImage: true }
      active.add(rec)
      // 图片卡片结构特殊，不进文本节点池：结束直接销毁（图片限流下频率很低，无性能压力）
      anim.onfinish = () => {
        active.delete(rec)
        anim.onfinish = null
        try { anim.cancel() } catch { /* 已结束 */ }
        node.remove()
      }
    }

    if (delay > 20) {
      node.remove()
      setTimeout(run, delay)
    } else {
      run()
    }
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
    hoverRec = null // 被悬停暂停的弹幕可能已被清掉，避免拿到失效引用
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

  // ------------------------------------------------ 悬停暂停 & 图片放大

  // 窗口默认鼠标穿透（forward:true 让页面仍能收到 mousemove）。
  // 这里用 elementFromPoint 检测鼠标是否落在弹幕上：命中 → 请求主进程
  // 关闭穿透并 pause 该弹幕；移开 → 恢复穿透并从暂停位置继续滚动。
  // 只有状态变化才发 IPC，避免高频切换。

  let mouseIgnore = true   // 当前穿透状态（true = 鼠标穿透给桌面）
  let hoverRec = null      // 被悬停暂停的弹幕
  let lightboxOpen = false // 图片放大查看期间保持可交互
  let lastX = -1
  let lastY = -1
  let hoverRaf = false
  /** 手抖过滤：鼠标位移小于该值不重新判定，避免路过的弹幕被轻微手抖误冻 */
  const HOVER_JITTER = 6

  function setIgnoreMouse (ignore) {
    if (ignore === mouseIgnore) return
    mouseIgnore = ignore
    window.overlayBridge.setIgnoreMouse(ignore)
  }

  function pauseRec (rec) {
    hoverRec = rec
    try { rec.anim.pause() } catch { /* 动画可能已结束 */ }
    rec.node.classList.add('hover-paused')
  }

  function resumeHover () {
    if (!hoverRec) return
    try { hoverRec.anim.play() } catch { /* 动画可能已结束 */ }
    hoverRec.node.classList.remove('hover-paused')
    hoverRec = null
  }

  function findRecByNode (node) {
    for (const rec of active) if (rec.node === node) return rec
    return null
  }

  function processHover (x, y) {
    if (lightboxOpen) return // 放大查看期间保持可交互
    const el = document.elementFromPoint(x, y)
    const hit = el ? el.closest('.dm, .dm-img') : null
    const rec = hit ? findRecByNode(hit) : null

    if (hit) {
      // 只有图片卡片需要真实点击（放大查看），才请求关闭鼠标穿透；
      // 文字弹幕的悬停暂停只靠转发的 mousemove，穿透保持开启不挡桌面
      setIgnoreMouse(hit.classList.contains('dm-img') ? false : true)
      if (rec === hoverRec) return // 还压在同一条上，不动
      resumeHover()                // 鼠标已离开原弹幕：恢复它
      if (rec) pauseRec(rec)       // 压到新的一条：停住它
    } else {
      setIgnoreMouse(true)
      resumeHover()
    }
  }

  document.addEventListener('mousemove', e => {
    if (Math.abs(e.clientX - lastX) < HOVER_JITTER &&
        Math.abs(e.clientY - lastY) < HOVER_JITTER) return
    lastX = e.clientX
    lastY = e.clientY
    if (hoverRaf) return
    hoverRaf = true
    requestAnimationFrame(() => {
      hoverRaf = false
      processHover(lastX, lastY)
    })
  })

  // 图片悬停期间穿透已关：Windows 对透明窗口逐像素命中，鼠标移出图片卡片
  // （不透明像素）后 mousemove 直接失联，仅靠事件流永远无法"移开恢复"。
  // 主进程此时轮询全局光标位置推过来，用同一套判定把状态兜住。
  if (window.overlayBridge.onCursor) {
    window.overlayBridge.onCursor(pt => {
      if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return
      lastX = pt.x
      lastY = pt.y
      processHover(lastX, lastY)
    })
  }

  // -------- 点击图片弹幕放大到原比例 --------

  const lightbox = document.getElementById('lightbox')
  const lightboxImg = document.getElementById('lightboxImg')

  stage.addEventListener('click', e => {
    const card = e.target && e.target.closest ? e.target.closest('.dm-img') : null
    if (!card) return
    const img = card.querySelector('img')
    if (!img) return
    lightboxImg.src = img.src
    lightbox.hidden = false
    lightboxOpen = true
  })

  function closeLightbox () {
    if (!lightboxOpen) return
    lightboxOpen = false
    lightbox.hidden = true
    lightboxImg.removeAttribute('src')
    // 关闭后立刻按当前鼠标位置重算穿透/暂停状态
    processHover(lastX, lastY)
  }

  lightbox.addEventListener('click', closeLightbox)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox() })

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
