'use strict';

/**
 * 加入模式窗口 —— 连接主机后本机屏幕顶部滚动弹幕。
 * 这里只负责界面，真正的连接和渲染都在主进程 / 弹幕层。
 */
;(function () {
  const api = window.joinApi
  const $ = id => document.getElementById(id)

  const els = {
    dot: $('dot'),
    statusTitle: $('statusTitle'),
    statusSub: $('statusSub'),
    online: $('online'),
    host: $('host'),
    tokenRow: $('tokenRow'),
    roomToken: $('roomToken'),
    tokenWarn: $('tokenWarn'),
    connectBtn: $('connectBtn'),
    disconnectBtn: $('disconnectBtn'),
    connectedHint: $('connectedHint'),
    ballBtn: $('ballBtn'),
    pauseBtn: $('pauseBtn'),
    senderName: $('senderName'),
    senderAnon: $('senderAnon'),
    identityHint: $('identityHint'),
    recent: $('recent'),
    switchModeBtn: $('switchModeBtn'),
    version: $('version'),
    showName: $('showName'),
    displayId: $('displayId'),
    discoverBox: $('discoverBox'),
    discoverHint: $('discoverHint'),
    discoverList: $('discoverList')
  }

  const STATUS_TEXT = {
    idle: ['未连接', '输入主机地址开始观看弹幕'],
    connecting: ['连接中…', '正在与主机建立连接'],
    open: ['已连接', '弹幕正在屏幕顶部滚动'],
    closed: ['已断开', '正在自动重连，检查主机是否开着']
  }

  let paused = false
  let applying = false
  /** 主机昵称政策：null=未知（未连接或旧版主机），'required'=强制实名，'free'=允许匿名 */
  let serverNamePolicy = null

  // ---------------------------------------------------------------- 外观设置

  const SLIDERS = [
    { id: 'heightRatio', key: 'heightRatio', toModel: v => Number(v) / 100, fromModel: v => Math.round(v * 100) },
    { id: 'fontSize', key: 'fontSize', toModel: Number, fromModel: v => v },
    { id: 'scrollDuration', key: 'scrollDuration', toModel: Number, fromModel: v => v },
    { id: 'laneGap', key: 'laneGap', toModel: Number, fromModel: v => v },
    { id: 'opacity', key: 'opacity', toModel: Number, fromModel: v => v }
  ]

  const FORMAT = {
    heightRatio: v => `${Math.round(v * 100)}%`,
    fontSize: v => `${v} px`,
    scrollDuration: v => `${Number(v).toFixed(1)} 秒`,
    laneGap: v => `${v} px`,
    opacity: v => `${Math.round(v * 100)}%`
  }

  function renderAppearance (state) {
    const cfg = state.config || {}
    applying = true
    for (const s of SLIDERS) {
      const input = $(s.id)
      // 用户正在拖这个滑块时不要回填，否则防抖保存返回后会被旧值打断手感
      if (document.activeElement === input) continue
      const model = cfg[s.key]
      if (model === undefined) continue
      input.value = String(s.fromModel(model))
      const label = $(s.id + 'Val')
      if (label) label.textContent = FORMAT[s.id](model)
    }
    els.showName.checked = !!cfg.showName

    const displays = state.displays || []
    const dKey = displays.map(d => d.id).join(',')
    if (els.displayId.dataset.key !== dKey) {
      els.displayId.dataset.key = dKey
      els.displayId.innerHTML = ''
      const auto = document.createElement('option')
      auto.value = ''
      auto.textContent = '跟随主屏'
      els.displayId.appendChild(auto)
      displays.forEach(d => {
        const opt = document.createElement('option')
        opt.value = String(d.id)
        opt.textContent = d.label + (d.primary ? ' （主屏）' : '')
        els.displayId.appendChild(opt)
      })
    }
    els.displayId.value = cfg.displayId === null || cfg.displayId === undefined ? '' : String(cfg.displayId)
    applying = false
  }

  function debounce (fn, ms) {
    let t = null
    return (...args) => {
      clearTimeout(t)
      t = setTimeout(() => fn(...args), ms)
    }
  }

  const pushSlider = debounce((key, value) => {
    api.setConfig({ [key]: value })
  }, 140)

  SLIDERS.forEach(s => {
    const input = $(s.id)
    input.addEventListener('input', () => {
      if (applying) return
      const label = $(s.id + 'Val')
      if (label) label.textContent = FORMAT[s.id](s.toModel(input.value))
      pushSlider(s.key, s.toModel(input.value))
    })
  })

  els.showName.addEventListener('change', () => {
    if (applying) return
    api.setConfig({ showName: els.showName.checked })
  })

  els.displayId.addEventListener('change', () => {
    if (applying) return
    const v = els.displayId.value
    api.setConfig({ displayId: v === '' ? null : Number(v) })
  })

  function hhmmss (ts) {
    const d = new Date(ts)
    const p = n => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  function renderStatus ({ status, detail }) {
    const [title, sub] = STATUS_TEXT[status] || STATUS_TEXT.idle
    els.statusTitle.textContent = title
    els.statusSub.textContent = detail ? `${sub}（${detail}）` : sub
    els.dot.className = 'dot ' + (status === 'open' ? 'on' : status === 'closed' ? 'off' : status === 'connecting' ? 'warn' : '')

    const connected = status === 'open'
    els.connectBtn.disabled = connected
    els.disconnectBtn.disabled = !connected
    els.connectedHint.hidden = !connected
    // 已连上时发现列表没什么用，藏掉
    els.discoverBox.hidden = connected
  }

  // -------------------------------------------------------------- 自动发现

  function renderDiscovered (hosts) {
    // 正在连接时列表已隐藏，不再重绘
    if (els.discoverBox.hidden) return
    els.discoverList.innerHTML = ''
    if (!hosts || !hosts.length) {
      els.discoverHint.hidden = false
      els.discoverHint.textContent = '正在搜索局域网内的主机…（主机的控制台开着才会广播）'
      return
    }
    els.discoverHint.hidden = true
    hosts.forEach(h => {
      const li = document.createElement('li')
      li.className = 'discover-item'
      const name = document.createElement('span')
      name.className = 'd-name'
      name.textContent = h.name ? `${h.name} 的弹幕主机` : '弹幕主机'
      const addr = document.createElement('span')
      addr.className = 'd-addr'
      addr.textContent = `${h.address}:${h.port}`
      li.appendChild(name)
      li.appendChild(addr)
      li.addEventListener('click', async () => {
        els.host.value = `${h.address}:${h.port}`
        els.connectBtn.disabled = true
        apply(await api.connect(els.host.value, els.roomToken.value.trim()))
      })
      els.discoverList.appendChild(li)
    })
  }

  /** 图片弹幕点开看原图：极简全屏遮罩，点击关闭（页面本无 lightbox，动态造一个）。
   *  用 style.display 切换显隐——inline 的 display:flex 会压过 hidden 属性，点关不掉 */
  function openImageLightbox (src) {
    let mask = document.getElementById('imgLightbox')
    if (!mask) {
      mask = document.createElement('div')
      mask.id = 'imgLightbox'
      mask.style.cssText = 'position:fixed;inset:0;background:rgba(20,20,22,.86);align-items:center;justify-content:center;z-index:9999;cursor:zoom-out;display:none'
      const img = document.createElement('img')
      img.alt = '查看大图'
      img.style.cssText = 'max-width:92vw;max-height:88vh;border-radius:8px'
      mask.appendChild(img)
      mask.addEventListener('click', () => { mask.style.display = 'none' })
      document.body.appendChild(mask)
    }
    mask.querySelector('img').src = src
    mask.style.display = 'flex'
  }

  function addRecent (item) {
    if (!item || (!item.text && !item.image)) return
    const empty = els.recent.querySelector('.empty')
    if (empty) empty.remove()

    const li = document.createElement('li')
    const t = document.createElement('span')
    t.className = 'who'
    t.textContent = hhmmss(item.ts || Date.now())
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = item.name || '匿名'
    li.appendChild(t)
    li.appendChild(who)

    if (item.image) {
      // 图片弹幕：缩略图挂列表里，点开看原图（纯图时没有文字段）
      const thumb = document.createElement('img')
      thumb.className = 'thumb'
      thumb.src = item.image
      thumb.alt = '图片弹幕'
      thumb.style.cssText = 'display:block;max-width:160px;max-height:72px;border-radius:6px;margin-top:4px;cursor:zoom-in'
      thumb.addEventListener('click', () => openImageLightbox(item.image))
      li.appendChild(thumb)
    }

    if (item.text) {
      const msg = document.createElement('span')
      msg.className = 'msg'
      msg.textContent = item.text
      msg.style.color = item.color || 'inherit'
      li.appendChild(msg)
    }
    els.recent.insertBefore(li, els.recent.firstChild)
    while (els.recent.children.length > 60) els.recent.removeChild(els.recent.lastChild)
  }

  // ---------------------------------------------------------------- 事件

  els.connectBtn.addEventListener('click', async () => {
    els.connectBtn.disabled = true
    const state = await api.connect(els.host.value.trim(), els.roomToken.value.trim())
    apply(state)
  })

  els.disconnectBtn.addEventListener('click', async () => {
    apply(await api.disconnect())
  })

  els.ballBtn.addEventListener('click', () => api.showBall())

  // ---------------------------------------------------------------- 发言身份

  let identityApplying = false

  /** 主机昵称政策对发言身份 UI 的影响：强制实名时锁定匿名勾选为关，并提示必填 */
  function syncAnonUi () {
    if (serverNamePolicy === 'required') {
      els.senderAnon.disabled = true
      els.senderAnon.checked = false
      els.senderName.disabled = false
    } else {
      els.senderAnon.disabled = false
      els.senderName.disabled = els.senderAnon.checked
    }
  }

  function anonHint () {
    if (serverNamePolicy === 'required') {
      const name = els.senderName.value.trim()
      return name
        ? `当前昵称：${name}。服务器已关闭匿名，弹幕会显示这个昵称。`
        : '服务器已关闭匿名：必须先填昵称才能发言。'
    }
    return els.senderAnon.checked
      ? '当前是匿名发言，弹幕上只会显示「匿名」。'
      : (els.senderName.value
          ? `当前昵称：${els.senderName.value}。发言时不用再填。`
          : '先定好身份，之后在桌宠里直接发，不用每次填名字。')
  }

  function renderIdentity (identity) {
    if (!identity) return
    identityApplying = true
    els.senderName.value = identity.name || ''
    els.senderAnon.checked = !!identity.anonymous
    syncAnonUi()
    els.identityHint.textContent = anonHint()
    identityApplying = false
  }

  function pushIdentity () {
    if (identityApplying) return
    api.setIdentity({
      name: els.senderName.value.trim(),
      anonymous: els.senderAnon.checked
    })
  }

  els.senderName.addEventListener('change', pushIdentity)
  els.senderAnon.addEventListener('change', () => {
    els.senderName.disabled = els.senderAnon.checked
    pushIdentity()
  })

  els.pauseBtn.addEventListener('click', () => {
    paused = !paused
    els.pauseBtn.textContent = paused ? '恢复滚动' : '暂停滚动'
    api.togglePause()
  })

  els.switchModeBtn.addEventListener('click', () => api.switchMode())

  els.host.addEventListener('keydown', e => {
    if (e.key === 'Enter') els.connectBtn.click()
  })

  // 口令改完（失焦/回车）立刻向主机重新校验，不用断开重连
  els.roomToken.addEventListener('change', () => {
    if (applying) return
    api.setRoomToken(els.roomToken.value.trim())
  })

  // ---------------------------------------------------------------- 数据流

  function apply (state) {
    if (!state) return
    renderStatus(state)
    if (state.url) els.host.value = state.url
    if (typeof state.token === 'string' && document.activeElement !== els.roomToken) {
      els.roomToken.value = state.token
    }
    // 服务器开了口令且当前没过：亮出警告条
    els.tokenWarn.hidden = state.canSend !== false
    if (typeof state.namePolicy === 'string') serverNamePolicy = state.namePolicy
    if (typeof state.online === 'number') els.online.textContent = String(state.online)
    if (state.identity) renderIdentity(state.identity)
    if (typeof state.paused === 'boolean') {
      paused = state.paused
      els.pauseBtn.textContent = paused ? '恢复滚动' : '暂停滚动'
    }
    ;(state.recent || []).forEach(addRecent)
    if (Array.isArray(state.discovered)) renderDiscovered(state.discovered)
    renderAppearance(state)
    els.version.textContent = `LAN Danmaku v${state.appVersion || '?'} · 加入模式`
    // 单模式安装包（加入版）没有别的模式可选，藏掉切换入口免得误导
    if (state.appMode) els.switchModeBtn.hidden = true
  }

  api.onStatus(renderStatus)
  api.onStats(({ online }) => { els.online.textContent = String(online || 0) })
  api.onCanSend(canSend => {
    els.tokenWarn.hidden = canSend !== false
    if (canSend === true) {
      els.tokenWarn.hidden = false
      els.tokenWarn.classList.add('ok')
      els.tokenWarn.textContent = '✓ 口令验证通过，现在可以发言了（桌宠和 Ctrl+回车 都能发）'
      setTimeout(() => {
        els.tokenWarn.hidden = true
        els.tokenWarn.classList.remove('ok')
        els.tokenWarn.textContent = '⚠ 这台服务器开启了发言口令：你现在只能观看，在上方填好口令即可发言（不用断开重连）。'
      }, 4000)
    }
  })
  api.onIdentity(identity => renderIdentity(identity))
  api.onNamePolicy(({ namePolicy }) => {
    if (namePolicy !== 'required' && namePolicy !== 'free') return
    const changed = serverNamePolicy !== namePolicy
    serverNamePolicy = namePolicy
    syncAnonUi()
    if (changed) els.identityHint.textContent = anonHint()
  })
  api.onDanmaku(addRecent)
  api.onDiscovered(renderDiscovered)

  api.onTokenResult(({ ok, msg }) => {
    els.tokenWarn.hidden = false
    els.tokenWarn.classList.toggle('ok', false)
    els.tokenWarn.textContent = '✘ ' + (msg || '口令不对，问主持人要一个') + '（填对后立即生效，不用断开重连）'
  })

  api.getState().then(apply)
})()
