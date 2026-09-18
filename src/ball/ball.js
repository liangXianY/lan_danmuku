'use strict';

/**
 * 桌宠 —— 本机发弹幕的入口。
 *
 * 三种形态：
 *   收起   一颗球，停在桌面角落
 *   发送   一条紧凑输入条（颜色点 + 身份 + 输入框），回车即发，发完自动收回
 *   身份   第一次用时先设昵称或选匿名，之后不再打扰
 *
 * 真正的发送在主进程（加入模式走与主机的 ws，主机模式走本地房间），
 * 这里只负责界面和交互反馈。
 */
;(function () {
  const api = window.ballApi
  const $ = id => document.getElementById(id)

  const els = {
    shell: $('shell'),
    petWrap: $('petWrap'),
    pet: $('pet'),
    ballDot: $('ballDot'),
    panel: $('panel'),
    composeView: $('composeView'),
    identityView: $('identityView'),
    text: $('text'),
    send: $('send'),
    imgBtn: $('imgBtn'),
    imgInput: $('imgInput'),
    colors: $('colors'),
    who: $('who'),
    tips: $('tips'),
    tokenRow: $('tokenRow'),
    tokenInput: $('tokenInput'),
    nameInput: $('nameInput'),
    nameSave: $('nameSave'),
    anonCheck: $('anonCheck'),
    identityTips: $('identityTips')
  }

  // ------------------------------------------------------------- 桌宠动画
  // 帧图在 assets/pet/row-<name>.png（帧 96x104，横向排列），帧数与 pet.json 一致

  const PET_FPS = 8
  const PET_FRAME_W = 96
  const PET_ROWS = {
    idle: 6,
    'run-right': 8,
    'run-left': 8,
    waving: 4,
    jumping: 5,
    failed: 8,
    waiting: 6
  }

  let petBase = null       // 基础状态：idle（收起待机）/ waiting（展开）/ failed（没连上）
  let petTransient = null  // 正在播的一次性动画（waving / jumping / 跑动）
  let petTimer = null

  function petBaseState () {
    if (!state.connected) return 'failed'
    return expanded ? 'waiting' : 'idle'
  }

  function petSet (row, loops) {
    const frames = PET_ROWS[row] || 1
    els.pet.style.backgroundImage = `url('../../assets/pet/row-${row}.png')`
    els.pet.style.setProperty('--pet-end', `-${frames * PET_FRAME_W}px`)
    els.pet.style.animation = 'none'
    void els.pet.offsetWidth // 重置动画
    els.pet.style.animation =
      `petWalk ${(frames / PET_FPS).toFixed(3)}s steps(${frames}) ${loops === undefined ? 'infinite' : loops} both`
    clearTimeout(petTimer)
    if (loops !== undefined) {
      petTimer = setTimeout(() => {
        petTransient = null
        petBase = petBaseState()
        petSet(petBase)
      }, Math.round((frames / PET_FPS) * 1000 * loops))
    }
  }

  /** 播一段一次性动画，播完回到基础状态 */
  function petPulse (row, loops = 1) {
    petTransient = row
    petSet(row, loops)
  }

  /** 状态变化后刷新基础动画；正在播临时动画时先不打断 */
  function petUpdateBase () {
    if (petTransient) return
    const base = petBaseState()
    if (petBase !== base) {
      petBase = base
      petSet(petBase)
    } else if (petBase && !els.pet.style.animation) {
      petSet(petBase)
    }
  }

  let state = {
    identity: { name: '', anonymous: false },
    color: '#FFD400',
    colors: [],
    connected: false,
    mode: null,
    /** 服务器昵称政策：'required' 强制实名 | 'free' 允许匿名 | null 未知 */
    namePolicy: null,
    textMax: 60,
    nameMax: 12
  }

  let expanded = false
  let view = 'compose' // compose | identity
  let tipsTimer = null

  /** 实际生效的匿名：自己勾了匿名、且服务器没关匿名 */
  function anonEffective () {
    return state.namePolicy !== 'required' && !!state.identity.anonymous
  }

  /** 身份是不是还没设过（必须填名字，或既没名字也没勾匿名） */
  function needsIdentity () {
    if (state.identity.name) return false
    if (state.namePolicy === 'required') return true
    return !state.identity.anonymous
  }

  // ------------------------------------------------------------------ 渲染

  function setTips (message, kind) {
    els.tips.textContent = message || ''
    els.tips.className = 'tips' + (kind ? ' ' + kind : '')
    clearTimeout(tipsTimer)
    if (message && kind) {
      // 错误停留 6 秒（2.6 秒太短，用户会以为软件坏了）；成功提示保持短驻留
      tipsTimer = setTimeout(refreshIdleTips, kind === 'err' ? 6000 : 2600)
    }
  }

  /**
   * 只刷新"中性提示"。
   * 状态推送（在线人数、连接状态）很频繁，不能把刚弹出来的
   * 「已发出 ✓」或错误提示冲掉。
   */
  function refreshIdleTips () {
    if (els.tips.classList.contains('ok') || els.tips.classList.contains('err')) return
    if (view !== 'compose') return
    setTips(expanded ? idleTip() : '', expanded && !state.connected ? 'err' : '')
  }

  function idleTip () {
    if (!state.connected) return state.mode === 'join' ? '未连接主机' : '服务未就绪'
    if (state.needToken) return '需要房间口令才能发言'
    return '回车发送 · Esc 收起'
  }

  function renderBall () {
    const cls = state.connected ? 'on' : (state.mode === 'join' ? 'off' : 'warn')
    els.ballDot.className = 'pet-dot ' + cls
    els.petWrap.title = state.connected
      ? '发弹幕（可拖动）'
      : (state.mode === 'join' ? '未连接主机' : '服务未就绪')
  }

  function renderSwatches () {
    const colors = state.colors && state.colors.length ? state.colors : [state.color]
    els.colors.innerHTML = ''
    colors.forEach(color => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'swatch' + (String(color).toLowerCase() === String(state.color).toLowerCase() ? ' sel' : '')
      b.style.background = color
      b.title = color
      b.addEventListener('click', () => {
        state.color = color
        renderSwatches()
        api.setColor(color)
      })
      els.colors.appendChild(b)
    })

    // 当前颜色不在预设里 → 高亮彩虹取色器，并把它的值同步成当前颜色
    const isPreset = colors.some(c => String(c).toLowerCase() === String(state.color).toLowerCase())
    customColor.classList.toggle('sel', !isPreset)
    if (/^#[0-9a-fA-F]{6}$/.test(state.color)) customColor.value = state.color.toLowerCase()
    els.colors.appendChild(customColor)
  }

  /** 自定义取色器（彩虹圆点）：常驻在预设色点后面，点开弹系统取色板 */
  const customColor = document.createElement('input')
  customColor.type = 'color'
  customColor.className = 'swatch custom'
  customColor.title = '自定义颜色'
  customColor.value = '#FFD400'
  customColor.addEventListener('input', () => {
    state.color = customColor.value
    renderSwatches()
    api.setColor(customColor.value)
  })

  function renderIdentityChip () {
    const anon = anonEffective()
    const name = state.identity.name || ''
    els.who.textContent = anon ? '匿名' : (name || '设置昵称')
    // 长名字在 chip 里会被省略号截断，悬停能看到全名
    els.who.title = (anon ? '匿名发言中' : (name ? `昵称：${name}` : '还没起名字'))
      + ' · 点这里修改'
  }

  function renderView () {
    const showIdentity = view === 'identity'
    els.composeView.hidden = showIdentity
    els.identityView.hidden = !showIdentity
    if (showIdentity) {
      els.nameInput.value = state.identity.name || ''
      els.anonCheck.checked = !!state.identity.anonymous
      syncIdentityInputs()
      els.nameInput.focus()
      els.nameInput.select()
    } else {
      renderIdentityChip()
      if (expanded) els.text.focus()
    }
  }

  function syncIdentityInputs () {
    if (state.namePolicy === 'required') {
      // 服务器关了匿名：必须用昵称，匿名选项锁死为关
      els.anonCheck.disabled = true
      els.anonCheck.checked = false
      els.nameInput.disabled = false
      els.identityTips.textContent = '服务器已关闭匿名，必须填昵称才能发言'
      return
    }
    els.anonCheck.disabled = false
    // 勾了匿名就不用再填名字，但名字留着（取消匿名时还能用回来）
    els.nameInput.disabled = els.anonCheck.checked
    els.identityTips.textContent = els.anonCheck.checked
      ? '弹幕只会显示「匿名」'
      : '之后每次发言都用这个身份'
  }

  function render () {
    renderBall()
    renderSwatches()
    renderIdentityChip()
    els.send.disabled = !state.connected
    // 服务器要求口令且当前没过：亮出口令输入行
    els.tokenRow.hidden = !state.needToken
    petUpdateBase()
    refreshIdleTips()
  }

  // ------------------------------------------------------------ 展开 / 收起

  function openPanel () {
    view = needsIdentity() ? 'identity' : 'compose'
    expanded = true
    els.panel.hidden = false
    renderView()
    refreshIdleTips()
    petPulse('waving', 1) // 点它一下，先挥个手
    api.expand()
  }

  function closePanel () {
    expanded = false
    els.panel.hidden = true
    petUpdateBase()
    api.collapse()
  }

  function togglePanel () {
    if (expanded) closePanel()
    else openPanel()
  }

  // ---------------------------------------------------------------- 图片

  /** 待发送图片（dataURL）：选好即就绪，再点图按钮取消；发送成功自动清 */
  let pendingImage = null

  function setPendingImage (dataUrl) {
    pendingImage = dataUrl || null
    els.imgBtn.classList.toggle('active', !!pendingImage)
    els.text.placeholder = pendingImage ? '图已选好，可配一句话（回车发送）' : '说点什么，回车发送'
  }

  // 文件选择对话框是系统窗口，会让本窗口失焦；这期间绝不能把面板收起来
  let pickingImage = false

  els.imgBtn.addEventListener('click', () => {
    if (pendingImage) {
      setPendingImage(null)
      setTips('已取消图片', 'ok')
      return
    }
    pickingImage = true
    els.imgInput.click()
  })

  function handleImageFile (file) {
    if (!file) return
    setTips('正在处理图片…')
    // 存下压缩 promise：发送时若还没压完就等它（粘贴/选图后立刻发也能一次成功）
    imgReady = window.DanmakuProtocol.compressImage(file)
      .then(dataUrl => {
        const kb = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4 / 1024)
        setPendingImage(dataUrl)
        setTips(`图片就绪（约 ${kb} KB），直接发送`, 'ok')
      })
      .catch(err => setTips(err.message || '图片处理失败', 'err'))
      .finally(() => { imgReady = null })
  }

  els.imgInput.addEventListener('change', () => {
    pickingImage = false
    const file = els.imgInput.files && els.imgInput.files[0]
    els.imgInput.value = '' // 读走引用就清，允许下次重选同一文件
    handleImageFile(file)
  })

  // 粘贴截图：截图工具/聊天软件里复制的图，在输入框 Ctrl+V 直接挂上
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

  // ---------------------------------------------------------------- 发送

  /** 压缩进行中的 promise（handleImageFile 里挂上，完成即清）；发送时先等它 */
  let imgReady = null

  async function doSend () {
    // 图片还在压缩：等一下再走正常流程，粘贴/选图后立刻点发送不再落空
    if (imgReady) {
      setTips('图片处理中，马上就好…')
      try { await imgReady } catch { /* 失败提示已给过，走下面的空内容检查 */ }
    }
    const text = els.text.value.trim()
    if (!text && !pendingImage) {
      setTips('写点什么或选张图再发', 'err')
      return
    }
    if (!state.connected) {
      setTips(state.mode === 'join' ? '还没连上主机' : '服务还没起来', 'err')
      return
    }

    els.send.disabled = true
    try {
      const res = await api.send({ text, image: pendingImage || undefined })
      if (!res || !res.ok) throw new Error((res && res.error) || '发送失败')
      els.text.value = ''
      setPendingImage(null)
      setTips('已发出 ✓', 'ok')
      petPulse('jumping', 2) // 发出去，开心两连跳
      // 发完不自动收起：面板一直留着方便连发，点别处（窗口失焦）才隐藏
    } catch (err) {
      const msg = (err && err.message) || '发送失败'
      // 失败绝不能无声：面板若收着先弹回来，错误提示（含屏蔽词命中词）停留更久
      if (!expanded) openPanel()
      setTips(msg, 'err')
      petPulse('failed', 2) // 没发出去，蔫一下
      // 口令问题：聚焦口令输入行，让用户当场填，不用断开重连
      if (state.needToken) els.tokenInput.focus()
      // 服务器要求实名：直接切到身份面板让用户填名字
      if (/昵称/.test(msg)) {
        view = 'identity'
        renderView()
      }
    } finally {
      els.send.disabled = !state.connected
    }
  }

  // ---------------------------------------------------------------- 身份

  async function saveIdentity () {
    const anonymous = els.anonCheck.checked && state.namePolicy !== 'required'
    const name = els.nameInput.value.trim()
    if (!anonymous && !name) {
      els.identityTips.textContent = state.namePolicy === 'required'
        ? '服务器已关闭匿名，起个名字吧'
        : '起个名字，或者勾选匿名'
      return
    }
    state = await api.setIdentity({ name, anonymous })
    render()
    view = 'compose'
    renderView()
    setTips(anonymous ? '好的，匿名发言' : `好的，${name}`, 'ok')
  }

  // ---------------------------------------------------------------- 交互

  els.petWrap.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    e.preventDefault()

    const startX = e.screenX
    const startY = e.screenY
    let moved = false
    let lastDir = null
    api.dragStart()

    const onMove = ev => {
      const dx = ev.screenX - startX
      const dy = ev.screenY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
      if (!moved) {
        moved = true
        els.petWrap.classList.add('dragging')
      }
      // 拖动时小鸡朝移动方向跑
      const dir = dx >= 0 ? 'run-right' : 'run-left'
      if (dir !== lastDir) {
        lastDir = dir
        petTransient = dir
        petSet(dir)
      }
      api.drag(dx, dy)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      els.petWrap.classList.remove('dragging')
      api.dragEnd()
      if (moved) {
        // 松手：跑回基础状态（待机 / 失落）
        petTransient = null
        petBase = petBaseState()
        petSet(petBase)
      } else {
        togglePanel() // 没挪动就算点击
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  // 右键小鸡：直接收起面板 / 隐藏桌宠
  els.petWrap.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (expanded) closePanel()
    else api.hide()
  })

  els.send.addEventListener('click', doSend)

  els.text.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doSend()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePanel()
    }
  })

  els.text.addEventListener('input', () => {
    if (els.tips.classList.contains('err') && !state.needToken) setTips('')
  })

  // ---------------- 房间口令（面板内直接填，不用断开重连） ----------------

  async function saveToken () {
    const token = els.tokenInput.value.trim()
    await api.setToken(token)
    els.tokenInput.value = ''
    // 口令是否生效由主进程收到 HELLO 回执后推送（needToken 消失 = 过了）
    setTips('口令已保存，正在验证…', 'ok')
  }

  els.tokenInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveToken()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePanel()
    }
  })

  // 口令填错：服务器 HELLO 拒绝后主动推过来，明确告诉用户而不是石沉大海
  api.onTokenResult(({ ok, msg }) => {
    if (!ok) setTips(msg || '口令不对，问主持人要一个', 'err')
  })

  els.nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveIdentity()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (needsIdentity()) closePanel()
      else {
        view = 'compose'
        renderView()
      }
    }
  })
  els.nameInput.addEventListener('input', () => { els.identityTips.textContent = '之后每次发言都用这个身份' })

  els.nameSave.addEventListener('click', saveIdentity)
  els.anonCheck.addEventListener('change', syncIdentityInputs)

  els.who.addEventListener('click', () => {
    view = 'identity'
    renderView()
  })

  // 点到别处就收起来 —— 桌宠不该赖在屏幕上
  // 文件选择对话框打开期间例外：那是系统窗口，失焦不代表用户点了别处
  window.addEventListener('blur', () => {
    if (pickingImage) return
    if (expanded && !els.petWrap.classList.contains('dragging')) closePanel()
  })
  // 对话框取消时不会触发 change，窗口焦点回来后把标志复位
  window.addEventListener('focus', () => { pickingImage = false })

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && expanded) closePanel()
  })

  // ---------------------------------------------------------------- 数据流

  api.onMode(payload => {
    expanded = !!(payload && payload.expanded)
    els.panel.hidden = !expanded
    if (expanded) {
      view = needsIdentity() ? 'identity' : 'compose'
      renderView()
    }
    petUpdateBase()
  })

  api.onState(next => {
    const wasNeedToken = state.needToken
    state = Object.assign({}, state, next || {})
    // 口令验证通过：面板行收起 + 明确告诉用户能发了
    if (wasNeedToken && !state.needToken) {
      render()
      setTips('口令验证通过，现在可以发言了 ✓', 'ok')
      return
    }
    render()
  })

  // 有弹幕上屏：小鸡挥个手（正在播别的动画就不打断）
  api.onDanmaku(() => {
    if (!petTransient) petPulse('waving', 1)
  })

  api.getState().then(next => {
    state = Object.assign({}, state, next || {})
    els.text.maxLength = state.textMax || 60
    els.nameInput.maxLength = state.nameMax || 12
    render()
  })
})()
