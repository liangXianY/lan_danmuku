'use strict';
/* eslint-disable */

/**
 * 管理台 —— 跑在公网服务器上，浏览器打开 /admin/。
 * 登录后可发固定公告、清屏、暂停/恢复、改屏蔽词。
 * 连接逻辑与发送页同构：原生 WebSocket + 服务端校验，这里不重复任何规则。
 */
;(function () {
  const { MSG, LIMITS } = window.DanmakuProtocol

  const $ = id => document.getElementById(id)
  const els = {
    loginCard: $('loginCard'),
    panelCard: $('panelCard'),
    token: $('token'),
    loginBtn: $('loginBtn'),
    loginErr: $('loginErr'),
    online: $('online'),
    pauseBtn: $('pauseBtn'),
    clearBtn: $('clearBtn'),
    logoutBtn: $('logoutBtn'),
    noticeText: $('noticeText'),
    noticeBtn: $('noticeBtn'),
    noticePos: $('noticePos'),
    noticeStay: $('noticeStay'),
    blockedWords: $('blockedWords'),
    saveWordsBtn: $('saveWordsBtn'),
    savedTip: $('savedTip'),
    tunnelBtn: $('tunnelBtn'),
    tunnelStopBtn: $('tunnelStopBtn'),
    tunnelUrl: $('tunnelUrl'),
    tunnelWaiting: $('tunnelWaiting'),
    tunnelErr: $('tunnelErr')
  }

  const LS_KEY = 'lan-danmaku-admin-token'
  const ACK_TIMEOUT = 6000

  let ws = null
  let authed = false
  let reqSeq = 0
  let reconnectDelay = 800
  let pingTimer = null
  const pending = new Map()

  function connect () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try {
      ws = new WebSocket(`${proto}//${location.host}`)
    } catch {
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      reconnectDelay = 800
      startPing()
      // 断线重连后自动重新认证（token 存在 localStorage）
      const token = localStorage.getItem(LS_KEY) || els.token.value.trim()
      if (token) doAuth(token)
    })

    ws.addEventListener('message', event => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      handleMessage(msg)
    })

    ws.addEventListener('close', () => {
      stopPing()
      scheduleReconnect()
    })

    ws.addEventListener('error', () => { /* close 会跟着来 */ })
  }

  function scheduleReconnect () {
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

  function send (payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try { ws.send(JSON.stringify(payload)) } catch { /* ignore */ }
  }

  /** 带回执的请求：ACK resolve / REJECT reject */
  function request (payload) {
    return new Promise((resolve, reject) => {
      const reqId = 'a' + (++reqSeq)
      const timer = setTimeout(() => {
        pending.delete(reqId)
        reject(new Error('服务器没响应'))
      }, ACK_TIMEOUT)
      pending.set(reqId, { resolve, reject, timer })
      send({ ...payload, reqId })
    })
  }

  function doAuth (token) {
    request({ type: MSG.AUTH, role: 'admin', token })
      .then(res => {
        authed = true
        localStorage.setItem(LS_KEY, token)
        els.loginErr.hidden = true
        els.loginCard.hidden = true
        els.panelCard.hidden = false
        if (typeof res.online === 'number') els.online.textContent = String(res.online)
        if (typeof res.paused === 'boolean') renderPaused(res.paused)
        if (Array.isArray(res.blockedWords)) {
          els.blockedWords.value = res.blockedWords.join('\n')
        }
      })
      .catch(err => {
        localStorage.removeItem(LS_KEY)
        els.loginErr.textContent = err.message
        els.loginErr.hidden = false
      })
  }

  function renderPaused (paused) {
    els.pauseBtn.textContent = paused ? '恢复上屏' : '暂停上屏'
  }

  function handleMessage (msg) {
    switch (msg.type) {
      case MSG.STATS:
        els.online.textContent = String(msg.online || 0)
        break

      case MSG.PAUSE:
        renderPaused(true)
        break

      case MSG.RESUME:
        renderPaused(false)
        break

      case MSG.ACK: {
        const p = pending.get(msg.reqId)
        if (p) {
          pending.delete(msg.reqId)
          clearTimeout(p.timer)
          p.resolve(msg)
        }
        break
      }

      case MSG.REJECT: {
        const p = pending.get(msg.reqId)
        if (p) {
          pending.delete(msg.reqId)
          clearTimeout(p.timer)
          p.reject(new Error(msg.msg || '操作失败'))
        }
        break
      }

      default:
        break
    }
  }

  // ---------------------------------------------------------------- 事件

  els.loginBtn.addEventListener('click', () => {
    const token = els.token.value.trim()
    if (!token) {
      els.loginErr.textContent = '先填管理口令'
      els.loginErr.hidden = false
      return
    }
    doAuth(token)
  })

  els.token.addEventListener('keydown', e => {
    if (e.key === 'Enter') els.loginBtn.click()
  })

  els.logoutBtn.addEventListener('click', () => {
    localStorage.removeItem(LS_KEY)
    authed = false
    els.panelCard.hidden = true
    els.loginCard.hidden = false
    els.token.value = ''
  })

  els.pauseBtn.addEventListener('click', () => {
    // 按钮文字反映的是当前状态，点它就是切到相反状态
    const next = els.pauseBtn.textContent.indexOf('恢复') === 0
    request({ type: next ? MSG.RESUME : MSG.PAUSE })
      .catch(err => alert(err.message))
  })

  els.clearBtn.addEventListener('click', () => {
    if (!confirm('确定清空所有客户端屏幕上的弹幕？')) return
    request({ type: MSG.CLEAR })
      .catch(err => alert(err.message))
  })

  els.noticeBtn.addEventListener('click', async () => {
    const text = els.noticeText.value.trim()
    if (!text) return
    const stayMs = Math.round(Number(els.noticeStay.value) * 1000)
    try {
      await request({
        type: MSG.SEND,
        text,
        mode: 'fixed',
        position: els.noticePos.value,
        stayMs: Math.min(Math.max(stayMs, LIMITS.STAY_MS_MIN), LIMITS.STAY_MS_MAX),
        name: '主机'
      })
      els.noticeText.value = ''
    } catch (err) {
      alert(err.message)
    }
  })

  els.noticeText.addEventListener('keydown', e => {
    if (e.key === 'Enter') els.noticeBtn.click()
  })

  let savedTipTimer = null
  els.saveWordsBtn.addEventListener('click', () => {
    const words = els.blockedWords.value
      .split('\n')
      .map(w => w.trim())
      .filter(Boolean)
    request({ type: MSG.SET_CONFIG, config: { blockedWords: words } })
      .then(() => {
        els.savedTip.hidden = false
        clearTimeout(savedTipTimer)
        savedTipTimer = setTimeout(() => { els.savedTip.hidden = true }, 1800)
      })
      .catch(err => alert(err.message))
  })

  // ---------------------------------------------------------------- 公网穿透

  /** 隧道接口：GET/POST /api/tunnel*，远程调用必须带管理口令 */
  function tunnelFetch (action) {
    return fetch(`/api/tunnel${action ? '/' + action : ''}`, {
      method: action ? 'POST' : 'GET',
      headers: { 'x-admin-token': localStorage.getItem(LS_KEY) || '' }
    })
      .then(r => r.json())
      .then(data => {
        if (!data.ok) throw new Error(data.error || '请求失败')
        return data
      })
  }

  function renderTunnel (st) {
    const { running, url, error } = st
    els.tunnelBtn.hidden = running
    els.tunnelStopBtn.hidden = !running
    els.tunnelWaiting.hidden = !(running && !url && !error)
    if (url) {
      els.tunnelUrl.hidden = false
      els.tunnelUrl.innerHTML = ''
      const a = document.createElement('a')
      a.href = url
      a.textContent = url
      a.target = '_blank'
      a.rel = 'noopener'
      els.tunnelUrl.appendChild(a)
      els.tunnelUrl.appendChild(document.createTextNode('（点开就是发送页，地址发给任何人都能用）'))
    } else {
      els.tunnelUrl.hidden = true
      els.tunnelUrl.textContent = ''
    }
    if (error) {
      els.tunnelErr.hidden = false
      els.tunnelErr.textContent = error
    } else {
      els.tunnelErr.hidden = true
      els.tunnelErr.textContent = ''
    }
  }

  let tunnelPoll = null

  function pollTunnel () {
    clearInterval(tunnelPoll)
    tunnelPoll = setInterval(async () => {
      try {
        const st = await tunnelFetch('')
        renderTunnel(st)
        if (st.url || st.error || !st.running) clearInterval(tunnelPoll)
      } catch { /* 下次再试 */ }
    }, 1500)
  }

  els.tunnelBtn.addEventListener('click', () => {
    els.tunnelBtn.disabled = true
    tunnelFetch('start')
      .then(st => {
        renderTunnel(st)
        if (st.running && !st.url) pollTunnel()
      })
      .catch(err => alert(err.message))
      .finally(() => { els.tunnelBtn.disabled = false })
  })

  els.tunnelStopBtn.addEventListener('click', () => {
    clearInterval(tunnelPoll)
    tunnelFetch('stop')
      .then(renderTunnel)
      .catch(err => alert(err.message))
  })

  // ---------------------------------------------------------------- 启动

  const saved = localStorage.getItem(LS_KEY)
  els.loginCard.hidden = !!saved
  els.panelCard.hidden = !saved
  connect()
  // 登录状态下顺手查一次隧道状态（页面刷新后状态不丢）
  if (saved) {
    tunnelFetch('')
      .then(renderTunnel)
      .catch(() => { /* 未登录或接口不可用就先不显示 */ })
  }
})()
