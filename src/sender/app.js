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
    toast: $('toast'),
    imgInput: $('imgInput'),
    pickImg: $('pickImg'),
    imgPreview: $('imgPreview'),
    imgThumb: $('imgThumb'),
    imgRemove: $('imgRemove'),
    imgInfo: $('imgInfo'),
    lightbox: $('lightbox'),
    lightboxImg: $('lightboxImg')
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
  /** 待发送的图片（dataURL）。文字和图片至少有一样才能发 */
  let pendingImage = null
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
    const hasImage = !!pendingImage
    els.send.disabled = (!hasText && !hasImage) || !connected
    if (!connected) setHint('还没连上主机，正在重试…')
    else if (!hasText && !hasImage) setHint('输入点什么就能发了')
    else if (hasImage && !hasText) setHint('图片已就绪，直接发送', 'ok')
    else setHint('按发送，弹幕会从屏幕右侧滚出来', 'ok')
  }

  // ---------------------------------------------------------------- 图片选择

  function setPendingImage (dataUrl, note) {
    pendingImage = dataUrl || null
    els.imgPreview.hidden = !pendingImage
    if (pendingImage) {
      els.imgThumb.src = pendingImage
      els.imgInfo.textContent = note || '图片已就绪，可配一句文字一起发'
    } else {
      els.imgInfo.textContent = 'png / jpg / webp / gif，大于 1MB 自动压缩，15 秒限一张'
      els.imgInput.value = ''
    }
    refreshSendButton()
  }

  function handleImageFile (file) {
    if (!file) return
    setHint('正在处理图片…')
    window.DanmakuProtocol.compressImage(file)
      .then(dataUrl => {
        const kb = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4 / 1024)
        setPendingImage(dataUrl, `图片已就绪（约 ${kb} KB），可配一句文字一起发`)
        buzz(10)
      })
      .catch(err => {
        setHint(err.message || '图片处理失败', 'err')
        toast(err.message || '图片处理失败', 2200)
        buzz([20, 40, 20])
      })
  }

  els.pickImg.addEventListener('click', () => els.imgInput.click())
  els.imgInput.addEventListener('change', () => handleImageFile(els.imgInput.files[0]))
  els.imgRemove.addEventListener('click', () => setPendingImage(null))

  // 粘贴截图：qq/微信/截图工具复制后直接 Ctrl+V 就能发
  document.addEventListener('paste', e => {
    const items = (e.clipboardData && e.clipboardData.items) || []
    for (const it of items) {
      if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
        e.preventDefault()
        handleImageFile(it.getAsFile())
        return
      }
    }
  })

  // 拖拽图片进来
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => {
    e.preventDefault()
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
    if (file && file.type.indexOf('image/') === 0) handleImageFile(file)
  })

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
    setPendingImage(null)
    onTextChange()
    buzz(15)
    toast('发出去了', 1200)
  }

  // ---------------------------------------------------------------- 最近弹幕

  function renderEmpty () {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = '还没有人发言'
    els.recent.appendChild(li)
  }

  function addRecent (item) {
    if (!item || (!item.text && !item.image)) return
    const empty = els.recent.querySelector('.empty')
    if (empty) empty.remove()

    const li = document.createElement('li')
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = item.name || '匿名'
    li.appendChild(who)

    if (item.image) {
      // 图片弹幕：缩略图直接挂列表里，点开看大图
      const thumb = document.createElement('img')
      thumb.className = 'thumb'
      thumb.src = item.image
      thumb.alt = '图片弹幕'
      thumb.addEventListener('click', () => {
        els.lightboxImg.src = item.image
        els.lightbox.hidden = false
      })
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
    while (els.recent.children.length > RECENT_MAX) {
      els.recent.removeChild(els.recent.lastChild)
    }
  }

  // 点击遮罩任意处关闭大图
  els.lightbox.addEventListener('click', () => { els.lightbox.hidden = true })

  // ---------------------------------------------------------------- 发送

  function doSend () {
    const text = els.text.value.trim()
    if (!text && !pendingImage) return
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast('还没连上主机')
      return
    }

    const reqId = 'r' + (++reqSeq)
    const hadImage = !!pendingImage
    pending.set(reqId, Date.now())

    try {
      ws.send(JSON.stringify({
        type: MSG.SEND,
        reqId,
        text,
        image: pendingImage || undefined,
        name: els.name.value.trim(),
        color: prefs.color
      }))
    } catch (err) {
      pending.delete(reqId)
      toast('发送失败，正在重连')
      return
    }

    // 回执没回来前按钮先禁着，防连点重复发图
    els.send.disabled = true

    // 图片消息体是 base64 大 JSON，公网上行慢，6 秒极易误报——带图放宽到 20 秒
    const timeout = hadImage ? 20000 : ACK_TIMEOUT
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId)
        els.send.disabled = false
        refreshSendButton()
        toast(hadImage ? '图片传输超时，网络较慢或没连上主机' : '主机没响应，检查一下网络')
      }
    }, timeout)
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
