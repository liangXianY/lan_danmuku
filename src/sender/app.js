'use strict';
/* eslint-disable */

/**
 * 发送端页面 —— 跑在别人的浏览器里（手机 / 另一台电脑）。
 * 只依赖原生 WebSocket，不引入任何框架：整个页面逻辑就这么多，上框架纯属负担。
 */
(function () {
  const { MSG, PRESET_COLORS, QUICK_TEXTS, LIMITS } = window.DanmakuProtocol

  const $ = id => document.getElementById(id)
  const els = {
    dot: $('dot'),
    statusText: $('statusText'),
    online: $('online'),
    name: $('name'),
    roomToken: $('roomToken'),
    tokenField: $('tokenField'),
    text: $('text'),
    count: $('count'),
    colors: $('colors'),
    customColor: $('customColor'),
    quick: $('quick'),
    send: $('send'),
    hint: $('hint'),
    recent: $('recent'),
    toast: $('toast')
  }

  const LS_KEY = 'lan-danmaku-sender'
  const RECENT_MAX = 20
  const ACK_TIMEOUT = 6000

  const prefs = { name: '', color: PRESET_COLORS[1], roomToken: '' }
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(LS_KEY) || '{}'))
  } catch { /* 存的东西坏了就用默认 */ }

  let ws = null
  let connected = false
  let reqSeq = 0
  let reconnectDelay = 800
  let pingTimer = null
  const pending = new Map()
  /** 服务器昵称政策：'required'=强制实名（必须填昵称），'free'=允许匿名，null=未知（旧版服务器） */
  let serverNamePolicy = null

  // ---------------------------------------------------------------- 基础 UI

  let toastTimer = null
  function toast (message, ms) {
    els.toast.textContent = message
    els.toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms || 2000)
  }

  function setStatus (state, text) {
    els.dot.className = 'dot ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : '')
    els.statusText.textContent = text
  }

  function setHint (message, kind) {
    els.hint.textContent = message
    els.hint.className = 'hint' + (kind ? ' ' + kind : '')
  }

  function savePrefs () {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)) } catch { /* 隐私模式 */ }
  }

  function buzz (ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms) } catch { /* ignore */ } }
  }

  function refreshSendButton () {
    const hasText = els.text.value.trim().length > 0
    els.send.disabled = !hasText || !connected
    if (!connected) setHint('还没连上主机，正在重试…')
    else if (!hasText) setHint('输入点什么就能发了')
    else setHint('按发送，弹幕会从屏幕右侧滚出来', 'ok')
  }

  // ---------------------------------------------------------------- 颜色 & 快捷语

  PRESET_COLORS.forEach(color => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'swatch' + (color.toLowerCase() === String(prefs.color).toLowerCase() ? ' sel' : '')
    b.style.background = color
    b.title = color
    b.addEventListener('click', () => {
      prefs.color = color
      savePrefs()
      syncColorSelection()
    })
    els.colors.appendChild(b)
  })

  function syncColorSelection () {
    const current = String(prefs.color).toLowerCase()
    const isPreset = PRESET_COLORS.some(c => c.toLowerCase() === current)
    Array.from(els.colors.children).forEach(el => {
      el.classList.toggle('sel', el.title.toLowerCase() === current)
    })
    if (!isPreset && /^#[0-9a-f]{6}$/i.test(prefs.color)) els.customColor.value = prefs.color
  }

  els.customColor.value = /^#[0-9a-f]{6}$/i.test(prefs.color) ? prefs.color : '#FFD400'
  els.customColor.addEventListener('input', () => {
    prefs.color = els.customColor.value
    savePrefs()
    syncColorSelection()
  })
  syncColorSelection()

  QUICK_TEXTS.forEach(text => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = text
    b.addEventListener('click', () => {
      els.text.value = text
      onTextChange()
      els.text.focus()
    })
    els.quick.appendChild(b)
  })

  // ---------------------------------------------------------------- 输入

  els.name.value = prefs.name || ''
  els.name.addEventListener('input', () => {
    prefs.name = els.name.value.trim()
    savePrefs()
  })

  /**
   * 服务器昵称政策同步：强制实名时把昵称框标成必填；允许匿名时恢复原来的提示。
   */
  function applyNamePolicy (policy) {
    if (serverNamePolicy === policy) return
    serverNamePolicy = policy
    if (policy === 'required') {
      els.name.placeholder = '必填：服务器已关闭匿名'
      els.name.style.borderColor = ''
      els.name.setAttribute('required', '')
    } else {
      els.name.placeholder = '留空就是匿名'
      els.name.removeAttribute('required')
    }
  }

  // 房间口令：公网服务器开了口令时才需要填；本地记住，重连自动带上
  els.roomToken.value = prefs.roomToken || ''
  els.roomToken.addEventListener('input', () => {
    prefs.roomToken = els.roomToken.value.trim()
    savePrefs()
  })
  // 口令改完（失焦/回车）立刻补一次 HELLO，不用等重连
  els.roomToken.addEventListener('change', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: MSG.HELLO,
        name: prefs.name || '',
        token: prefs.roomToken || '',
        reqId: 'hello'
      }))
    }
  })

  function onTextChange () {
    const len = els.text.value.length
    els.count.textContent = String(len)
    els.count.parentElement.classList.toggle('warn', len > LIMITS.TEXT_MAX - 10)
    refreshSendButton()
  }

  els.text.addEventListener('input', onTextChange)
  els.text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !('ontouchstart' in window))) {
      e.preventDefault()
      doSend()
    }
  })

  // ---------------------------------------------------------------- WebSocket

  function connect () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try {
      ws = new WebSocket(`${proto}//${location.host}`)
    } catch (err) {
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      connected = true
      reconnectDelay = 800
      setStatus('on', '已连接')
      refreshSendButton()
      startPing()
      ws.send(JSON.stringify({
        type: MSG.HELLO,
        name: prefs.name || '',
        token: prefs.roomToken || '',
        reqId: 'hello'
      }))
    })

    ws.addEventListener('message', event => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      handleMessage(msg)
    })

    ws.addEventListener('close', () => {
      connected = false
      stopPing()
      setStatus('off', '已断开')
      refreshSendButton()
      scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // close 事件一定会跟着来，这里不重复处理
    })
  }

  function scheduleReconnect () {
    setStatus('', '重连中…')
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 1.6, 5000)
  }

  function startPing () {
    stopPing()
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: MSG.PING }))
      }
    }, 20000)
  }

  function stopPing () {
    clearInterval(pingTimer)
    pingTimer = null
  }

  function handleMessage (msg) {
    switch (msg.type) {
      case MSG.STATS:
        els.online.textContent = `${msg.online} 人在线`
        break

      case MSG.ACK:
        if (msg.namePolicy !== undefined) applyNamePolicy(msg.namePolicy)
        if (msg.reqId && pending.has(msg.reqId)) {
          pending.delete(msg.reqId)
          onSendSuccess()
        }
        break

      case MSG.CONFIG:
        if (msg.config && msg.config.namePolicy !== undefined) applyNamePolicy(msg.config.namePolicy)
        break

      case MSG.REJECT: {
        if (msg.reqId) pending.delete(msg.reqId)
        toast(msg.msg || '发送失败', 2200)
        setHint(msg.msg || '发送失败', 'err')
        buzz([20, 40, 20])
        // 房间开了口令：把口令输入框亮出来，引导补填
        if (msg.code === 'NEED_TOKEN' || msg.code === 'BAD_TOKEN') {
          els.tokenField.hidden = false
          els.roomToken.focus()
        }
        // 服务器要求实名：聚焦昵称框，当场填不用找
        if (msg.code === 'NEED_NAME') {
          els.name.focus()
          els.name.setAttribute('required', '')
        }
        break
      }

      case MSG.HISTORY: {
        const items = msg.items || []
        items.slice(-RECENT_MAX).forEach(addRecent)
        break
      }

      case MSG.DANMAKU:
        addRecent(msg.item)
        break

      case MSG.CLEAR:
        els.recent.innerHTML = ''
        renderEmpty()
        break

      case MSG.PAUSE:
        setHint('主机已暂停上屏，等一会儿再发', 'err')
        break

      case MSG.RESUME:
        refreshSendButton()
        break

      default:
        break
    }
  }

  function onSendSuccess () {
    els.text.value = ''
    onTextChange()
    buzz(15)
    toast('发出去了', 1200)
    if (ws && ws.readyState === WebSocket.OPEN && navigator.vibrate) { /* 已在 buzz 里 */ }
  }

  // ---------------------------------------------------------------- 最近弹幕

  function renderEmpty () {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = '还没有人发言'
    els.recent.appendChild(li)
  }

  function addRecent (item) {
    if (!item || !item.text) return
    const empty = els.recent.querySelector('.empty')
    if (empty) empty.remove()

    const li = document.createElement('li')
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = item.name || '匿名'
    const msg = document.createElement('span')
    msg.className = 'msg'
    msg.textContent = item.text
    msg.style.color = item.color || 'inherit'
    li.appendChild(who)
    li.appendChild(msg)

    els.recent.insertBefore(li, els.recent.firstChild)
    while (els.recent.children.length > RECENT_MAX) {
      els.recent.removeChild(els.recent.lastChild)
    }
  }

  // ---------------------------------------------------------------- 发送

  function doSend () {
    const text = els.text.value.trim()
    if (!text) return
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast('还没连上主机')
      return
    }

    const reqId = 'r' + (++reqSeq)
    pending.set(reqId, Date.now())

    try {
      ws.send(JSON.stringify({
        type: MSG.SEND,
        reqId,
        text,
        name: els.name.value.trim(),
        color: prefs.color
      }))
    } catch (err) {
      pending.delete(reqId)
      toast('发送失败，正在重连')
      return
    }

    // 服务端没回执就提示一下，避免用户以为发出去了
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId)
        toast('主机没响应，检查一下网络')
      }
    }, ACK_TIMEOUT)
  }

  els.send.addEventListener('click', doSend)

  // ---------------------------------------------------------------- 启动

  setStatus('', '连接中…')
  onTextChange()
  syncColorSelection()
  renderEmpty()
  connect()

  // 从后台切回来时如果连接断了，立刻重连而不是等退避
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!ws || ws.readyState > WebSocket.OPEN)) {
      reconnectDelay = 400
      connect()
    }
  })
})()
