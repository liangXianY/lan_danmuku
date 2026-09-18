'use strict';
/* eslint-disable */

/**
 * 控制台页面逻辑。所有真实状态都来自主进程，这里只负责渲染和转发操作。
 */
(function () {
  const api = window.controlApi
  const $ = id => document.getElementById(id)

  const els = {
    dot: $('dot'),
    statusTitle: $('statusTitle'),
    statusSub: $('statusSub'),
    online: $('online'),
    alertBox: $('alertBox'),
    alertTitle: $('alertTitle'),
    alertText: $('alertText'),
    alertAction: $('alertAction'),
    alertAction2: $('alertAction2'),
    url: $('url'),
    urlMeta: $('urlMeta'),
    qr: $('qr'),
    qrHint: $('qrHint'),
    adapterRow: $('adapterRow'),
    adapter: $('adapter'),
    copyBtn: $('copyBtn'),
    togglePause: $('togglePause'),
    clearBtn: $('clearBtn'),
    recheckBtn: $('recheckBtn'),
    restartBtn: $('restartBtn'),
    port: $('port'),
    rateMax: $('rateMax'),
    rateWindow: $('rateWindow'),
    blockedWords: $('blockedWords'),
    saveBlocked: $('saveBlocked'),
    roomToken: $('roomToken'),
    saveRoomToken: $('saveRoomToken'),
    roomTokenTip: $('roomTokenTip'),
    anonMode: $('anonMode'),
    imageRate: $('imageRate'),
    saveImageRate: $('saveImageRate'),
    fixedText: $('fixedText'),
    fixedPosition: $('fixedPosition'),
    fixedStay: $('fixedStay'),
    fixedStyle: $('fixedStyle'),
    fixedColors: $('fixedColors'),
    sendFixedBtn: $('sendFixedBtn'),
    recent: $('recent'),
    logs: $('logs'),
    openConfig: $('openConfig'),
    tunnelBtn: $('tunnelBtn'),
    tunnelStopBtn: $('tunnelStopBtn'),
    tunnelCopyBtn: $('tunnelCopyBtn'),
    tunnelUrl: $('tunnelUrl'),
    tunnelWaiting: $('tunnelWaiting'),
    tunnelErr: $('tunnelErr'),
    version: $('version')
  }

  /** 渲染期间置位，避免"主进程回推状态 → 触发 input 事件 → 又写回主进程"的死循环 */
  let applying = false
  let latest = null
  let lastRenderKey = ''

  // ---------------------------------------------------------------- 工具

  function hhmmss (ts) {
    const d = new Date(ts)
    const p = n => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  function debounce (fn, ms) {
    let timer = null
    return function (...args) {
      clearTimeout(timer)
      timer = setTimeout(() => fn.apply(this, args), ms)
    }
  }

  // ---------------------------------------------------------------- 渲染

  function renderStatus (state) {
    const { serverError, port, selfCheck, addresses, config } = state

    if (serverError) {
      els.dot.className = 'dot off'
      els.statusTitle.textContent = '服务启动失败'
      els.statusSub.textContent = serverError
      return
    }

    if (!port) {
      els.dot.className = 'dot'
      els.statusTitle.textContent = '正在启动…'
      els.statusSub.textContent = '弹幕服务初始化中'
      return
    }

    if (!addresses.length) {
      els.dot.className = 'dot warn'
      els.statusTitle.textContent = '未找到局域网地址'
      els.statusSub.textContent = '检查一下网线是否插好、网卡是否启用了'
      return
    }

    if (config.paused) {
      els.dot.className = 'dot warn'
      els.statusTitle.textContent = '已暂停上屏'
      els.statusSub.textContent = `服务运行中 · 端口 ${port}`
      return
    }

    els.dot.className = 'dot on'
    els.statusTitle.textContent = '服务运行中'
    els.statusSub.textContent = `端口 ${port} · 弹幕服务就绪`
  }

  function renderAlert (state) {
    const box = els.alertBox

    if (state.serverError) {
      box.hidden = false
      box.className = 'alert err'
      els.alertTitle.textContent = '服务启动失败'
      els.alertText.textContent = state.serverError + '。请检查端口是否被其它程序占用，或在"内容与限流"里换一个端口。'
      els.alertAction.hidden = true
      els.alertAction2.hidden = true
      return
    }

    if (!state.addresses.length) {
      box.hidden = false
      box.className = 'alert err'
      els.alertTitle.textContent = '没有可用的局域网地址'
      els.alertText.textContent = '本机没有检测到任何私网 IPv4 地址。确认网线已插好、网卡已启用，然后点下面的按钮重新检测。'
      els.alertAction.hidden = false
      els.alertAction.textContent = '重新自检'
      els.alertAction2.hidden = true
      return
    }

    if (state.selfCheck && state.selfCheck.status === 'fail') {
      box.hidden = false
      box.className = 'alert'
      els.alertTitle.textContent = '自检未通过，很可能被防火墙拦了'
      els.alertText.textContent =
        '这是同类工具最常见的坑：服务在跑、二维码也出来了，但别的设备死活连不上。' +
        '去「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」，' +
        '把这个程序在两个网络类型下都勾上；或者直接临时关掉防火墙验证一下。'
      els.alertAction.hidden = false
      els.alertAction.textContent = '重新自检'
      els.alertAction2.hidden = false
      return
    }

    box.hidden = true
  }

  function renderUrl (state) {
    if (state.url) {
      els.url.textContent = state.url
      els.urlMeta.textContent = state.subnet
        ? `发送端必须和主机在同一网段（${state.subnet}）`
        : ''
    } else {
      els.url.textContent = '—'
      els.urlMeta.textContent = ''
    }

    if (state.qrDataUrl) {
      els.qr.src = state.qrDataUrl
      els.qr.hidden = false
      els.qrHint.textContent = '同一交换机 / 同一网段的设备，扫码或用浏览器打开上面的地址即可发送。'
    } else {
      els.qr.hidden = true
      els.qrHint.textContent = '暂无可用的访问地址。'
    }
  }

  function renderAdapters (state) {
    const list = state.addresses || []
    if (list.length <= 1) {
      els.adapterRow.hidden = true
      return
    }
    els.adapterRow.hidden = false
    const key = list.map(a => a.address).join(',')
    if (els.adapter.dataset.key !== key) {
      els.adapter.dataset.key = key
      els.adapter.innerHTML = ''
      list.forEach(a => {
        const opt = document.createElement('option')
        opt.value = a.address
        const tags = []
        if (a.wired) tags.push('有线')
        else tags.push('无线')
        if (a.virtual) tags.push('虚拟网卡')
        opt.textContent = `${a.name} · ${a.address}${tags.length ? ' （' + tags.join('·') + '）' : ''}`
        els.adapter.appendChild(opt)
      })
    }
    if (state.address) els.adapter.value = state.address
  }

  function renderControls (state) {
    const cfg = state.config || {}

    applying = true

    if (document.activeElement !== els.port) els.port.value = cfg.port
    if (document.activeElement !== els.rateMax) els.rateMax.value = cfg.rateMax
    if (document.activeElement !== els.rateWindow) els.rateWindow.value = Math.round(cfg.rateWindowMs / 1000)
    if (document.activeElement !== els.blockedWords) {
      els.blockedWords.value = (cfg.blockedWords || []).join('\n')
    }
    if (document.activeElement !== els.roomToken) {
      els.roomToken.value = cfg.roomToken || ''
    }
    els.roomTokenTip.textContent = (cfg.roomToken || '')
      ? '口令已开启：发送需要口令，观看不受限。改动即时生效，新口令会立刻替换旧的。'
      : '设置后，浏览器发送页和加入端都要填这个口令才能发弹幕（观看不受限），填错会被降级为只看。改动即时生效。'

    // 固定弹幕的上次设置（存的是配置，回推时恢复显示）
    if (cfg.fixedPosition) els.fixedPosition.value = cfg.fixedPosition
    if (document.activeElement !== els.fixedStay && cfg.fixedStaySec) {
      els.fixedStay.value = cfg.fixedStaySec
    }
    if (cfg.fixedStyle) els.fixedStyle.value = cfg.fixedStyle
    renderFixedColors(cfg.fixedColor)

    els.togglePause.textContent = cfg.paused ? '恢复上屏' : '暂停上屏'
    els.togglePause.classList.toggle('warn', !!cfg.paused)

    els.anonMode.checked = !!cfg.forceNickname

    // 图片间隔：0 表示不限流；用户正在输入时不回推
    if (document.activeElement !== els.imageRate) {
      els.imageRate.value = String(Math.max(0, Math.round(Number(cfg.imageRateSec ?? 5))))
    }

    applying = false
  }

  function render (state) {
    latest = state
    // 只有实质性变化才重绘控件，避免用户正在拖滑块时被回推打断
    const key = JSON.stringify({
      e: state.serverError,
      p: state.port,
      a: state.address,
      o: state.online,
      c: state.config,
      d: state.displays && state.displays.map(d => d.id),
      s: state.selfCheck,
      q: !!state.qrDataUrl,
      r: state.overlayReady,
      t: state.tunnel
    })
    if (key === lastRenderKey) return
    lastRenderKey = key

    renderStatus(state)
    renderAlert(state)
    renderUrl(state)
    renderAdapters(state)
    renderControls(state)
    renderTunnel(state)

    els.online.textContent = String(state.online || 0)
    els.version.textContent = `LAN Danmaku v${state.appVersion || '?'} · ${state.platform === 'win32' ? 'Windows' : state.platform}`
  }

  // ---------------------------------------------------------------- 事件绑定

  els.adapter.addEventListener('change', () => {
    api.action('select-adapter', { address: els.adapter.value })
  })

  els.port.addEventListener('change', () => {
    const v = Number(els.port.value)
    if (Number.isInteger(v) && v >= 1024 && v <= 65535) api.setConfig({ port: v })
  })

  function pushRate () {
    const max = Number(els.rateMax.value)
    const sec = Number(els.rateWindow.value)
    const patch = {}
    if (Number.isFinite(max) && max > 0) patch.rateMax = Math.round(max)
    if (Number.isFinite(sec) && sec > 0) patch.rateWindowMs = Math.round(sec * 1000)
    if (Object.keys(patch).length) api.setConfig(patch)
  }
  els.rateMax.addEventListener('change', pushRate)
  els.rateWindow.addEventListener('change', pushRate)

  els.saveBlocked.addEventListener('click', () => {
    const words = els.blockedWords.value
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
    api.setConfig({ blockedWords: words })
    appendLog({ level: 'info', msg: `已保存 ${words.length} 个屏蔽词`, ts: Date.now() })
  })

  els.saveRoomToken.addEventListener('click', () => {
    const token = els.roomToken.value.trim()
    api.setConfig({ roomToken: token })
    appendLog({
      level: 'info',
      msg: token ? `房间口令已设置/更新（${token.length} 个字符），改动即时生效` : '房间口令已清空，任何人可直接发言',
      ts: Date.now()
    })
  })

  els.roomToken.addEventListener('keydown', e => {
    if (e.key === 'Enter') els.saveRoomToken.click()
  })

  els.anonMode.addEventListener('change', () => {
    api.setConfig({ forceNickname: els.anonMode.checked })
    appendLog({
      level: 'info',
      msg: els.anonMode.checked
        ? '强制实名已开启：发送端不能匿名，必须填昵称才能发言'
        : '强制实名已关闭：允许匿名发言',
      ts: Date.now()
    })
  })

  function pushImageRate () {
    const v = Number(els.imageRate.value)
    if (!Number.isFinite(v) || v < 0 || v > 600) return
    const sec = Math.round(v)
    api.setConfig({ imageRateSec: sec })
    appendLog({
      level: 'info',
      msg: sec > 0 ? `图片发送间隔已设为 ${sec} 秒，改动即时生效` : '图片限流已关闭（间隔 0）',
      ts: Date.now()
    })
  }
  els.saveImageRate.addEventListener('click', pushImageRate)
  els.imageRate.addEventListener('keydown', e => {
    if (e.key === 'Enter') pushImageRate()
  })

  els.copyBtn.addEventListener('click', () => api.action('copy-url'))
  els.clearBtn.addEventListener('click', () => api.action('clear'))
  els.restartBtn.addEventListener('click', () => api.action('restart-server'))
  els.recheckBtn.addEventListener('click', () => api.action('recheck'))
  els.alertAction.addEventListener('click', () => api.action('recheck'))
  els.alertAction2.addEventListener('click', () => api.action('open-firewall'))
  els.openConfig.addEventListener('click', () => api.action('open-config-dir'))

  els.togglePause.addEventListener('click', () => {
    const paused = latest && latest.config && latest.config.paused
    api.action(paused ? 'resume' : 'pause')
  })

  // ---------------- 发送固定弹幕 ----------------

  async function sendFixed () {
    const text = els.fixedText.value.trim()
    if (!text) {
      els.fixedText.focus()
      return
    }
    els.sendFixedBtn.disabled = true
    try {
      const sec = Number(els.fixedStay.value)
      await api.sendFixed({
        text,
        position: els.fixedPosition.value,
        stayMs: Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : undefined,
        style: els.fixedStyle.value,
        color: window.DanmakuProtocol ? normalizeFixedColor() : els.fixedColor.value
      })
      els.fixedText.value = ''
      appendLog({ level: 'info', msg: `固定弹幕已发送（${els.fixedPosition.value}，${els.fixedStay.value || 2} 秒）`, ts: Date.now() })
    } catch (err) {
      appendLog({ level: 'warn', msg: `固定弹幕发送失败：${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, ts: Date.now() })
    } finally {
      els.sendFixedBtn.disabled = false
    }
  }

  els.sendFixedBtn.addEventListener('click', sendFixed)
  els.fixedText.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendFixed()
  })

  // ---------------- 固定弹幕样式与颜色 ----------------

  let fixedColor = '#FFD400'

  function renderFixedColors (current) {
    if (window.DanmakuProtocol && current) fixedColor = current
    els.fixedColors.innerHTML = ''
    const colors = (window.DanmakuProtocol ? window.DanmakuProtocol.PRESET_COLORS : ['#FFD400', '#FFFFFF', '#FF7A45', '#4FC3F7', '#7CFFB2']).slice(0, 8)
    colors.forEach(c => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'swatch' + (String(c).toLowerCase() === String(fixedColor).toLowerCase() ? ' sel' : '')
      b.style.background = c
      b.title = c
      b.addEventListener('click', () => {
        fixedColor = c
        renderFixedColors(fixedColor)
        api.setConfig({ fixedColor: c })
      })
      els.fixedColors.appendChild(b)
    })
    // 自定义取色器
    const custom = document.createElement('input')
    custom.type = 'color'
    custom.className = 'swatch custom'
    custom.title = '自定义颜色'
    if (/^#[0-9a-fA-F]{6}$/.test(fixedColor)) custom.value = fixedColor.toLowerCase()
    custom.addEventListener('input', () => {
      fixedColor = custom.value
      renderFixedColors(fixedColor)
      api.setConfig({ fixedColor: custom.value })
    })
    els.fixedColors.appendChild(custom)
  }

  function normalizeFixedColor () {
    return /^#[0-9a-fA-F]{6}$/.test(fixedColor) ? fixedColor : undefined
  }

  els.fixedStyle.addEventListener('change', () => {
    api.setConfig({ fixedStyle: els.fixedStyle.value })
  })

  // ---------------- 公网隧道 ----------------

  let tunnelPoll = null

  function renderTunnel (state) {
    const t = state.tunnel || {}
    els.tunnelBtn.hidden = !!t.running
    els.tunnelStopBtn.hidden = !t.running
    els.tunnelCopyBtn.hidden = !t.url
    els.tunnelWaiting.hidden = !(t.running && !t.url && !t.error)

    if (t.url) {
      els.tunnelUrl.hidden = false
      els.tunnelUrl.textContent = t.url
    } else {
      els.tunnelUrl.hidden = true
      els.tunnelUrl.textContent = ''
    }

    if (t.error) {
      els.tunnelErr.hidden = false
      els.tunnelErr.textContent = t.error
    } else {
      els.tunnelErr.hidden = true
      els.tunnelErr.textContent = ''
    }

    // 隧道正在建立：轮询主进程状态，拿到地址或报错就停
    if (t.running && !t.url && !t.error) {
      if (!tunnelPoll) {
        tunnelPoll = setInterval(() => api.getState().then(renderTunnel).catch(() => {}), 1500)
      }
    } else if (tunnelPoll) {
      clearInterval(tunnelPoll)
      tunnelPoll = null
    }
  }

  els.tunnelBtn.addEventListener('click', () => {
    els.tunnelBtn.disabled = true
    Promise.resolve(api.action('tunnel-start'))
      .then(renderTunnel)
      .catch(err => alert(err.message))
      .finally(() => { els.tunnelBtn.disabled = false })
  })

  els.tunnelStopBtn.addEventListener('click', () => {
    if (tunnelPoll) { clearInterval(tunnelPoll); tunnelPoll = null }
    api.action('tunnel-stop').then(renderTunnel).catch(err => alert(err.message))
  })

  els.tunnelCopyBtn.addEventListener('click', () => api.action('copy-tunnel-url'))

  // ---------------------------------------------------------------- 数据流

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
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = hhmmss(item.ts || Date.now())
    li.appendChild(who)
    if (item.mode === 'fixed') {
      const tag = document.createElement('span')
      tag.className = 'who'
      tag.textContent = '[固定]'
      li.appendChild(tag)
    }
    const name = document.createElement('span')
    name.className = 'who'
    name.textContent = item.name || '匿名'

    li.appendChild(name)

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

  function appendLog (entry) {
    if (!entry) return
    const empty = els.logs.querySelector('.empty')
    if (empty) empty.remove()

    const stick = els.logs.scrollTop + els.logs.clientHeight >= els.logs.scrollHeight - 24

    const li = document.createElement('li')
    const t = document.createElement('span')
    t.className = 't'
    t.textContent = hhmmss(entry.ts || Date.now())
    const m = document.createElement('span')
    m.className = entry.level || 'info'
    m.textContent = entry.msg
    li.appendChild(t)
    li.appendChild(m)
    els.logs.appendChild(li)

    while (els.logs.children.length > 200) els.logs.removeChild(els.logs.firstChild)
    if (stick) els.logs.scrollTop = els.logs.scrollHeight
  }

  api.onState(render)
  api.onDanmaku(addRecent)
  api.onLog(appendLog)
  api.onStats(stats => {
    els.online.textContent = String(stats.online || 0)
  })

  // ---------------------------------------------------------------- 启动

  api.getState().then(state => {
    render(state)
    ;(state.logs || []).forEach(appendLog)
    ;(state.recent || []).slice(-30).reverse().forEach(addRecent)
  })
})()
