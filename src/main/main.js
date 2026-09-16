'use strict'

const path = require('path')
const http = require('http')
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen,
  shell, clipboard, nativeImage
} = require('electron')

const { Store } = require('./store')
const { DanmakuServer } = require('./server')
const { TunnelManager } = require('../server/tunnel')
const { JoinClient, parseHostInput } = require('./join-client')
const { DiscoveryBroadcaster, DiscoveryListener } = require('./discovery')
const { listLocalIPv4, subnetOf } = require('./net')
const { MSG, PRESET_COLORS, LIMITS, REJECT_TEXT } = require('../shared/protocol')

const isDev = process.argv.includes('--dev')
const ASSETS = path.join(__dirname, '..', '..', 'assets')

/** 桌宠：收起是一只会做动画的像素小鸡（帧图 96x104，四周留 6px 给阴影/拖动容差），
 *  展开时右侧仍是小鸡、左侧长出输入条（窗口右/下边界外撑，小鸡视觉不动） */
const PET_WIN = { width: 108, height: 116 }
const BALL_PANEL = { width: 500, height: 168 }
const BALL_MARGIN = 24

// 测试开关：同一台机器同时跑"主机 + 加入"两个实例时，用不同 userData 避免单实例锁冲突
if (process.env.LAN_DANMAKU_USERDATA) {
  app.setPath('userData', path.join(
    app.getPath('appData'), `lan-danmaku-${process.env.LAN_DANMAKU_USERDATA}`
  ))
}

// 兼容性兜底（实测在远程桌面 / 无 GPU 服务会话 / 部分虚拟机上，默认配置会直接闪退）：
//   1. GPU 进程起不来 → FATAL: "GPU process isn't usable. Goodbye."
//   2. 沙箱化的渲染子进程被系统杀掉 → 渲染层反复崩溃
// 本应用的两个渲染器只加载本地文件（contextIsolation 开、nodeIntegration 关、
// 对外网页跑在用户自己的浏览器里），关掉 GPU 加速和沙箱的实际安全代价很小，
// 弹幕只是几行文字的 transform 动画，软件渲染绰绰有余。
// 想改回默认行为：LAN_DANMAKU_GPU=1 恢复 GPU 加速，LAN_DANMAKU_SANDBOX=1 恢复沙箱
if (!process.env.LAN_DANMAKU_GPU) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  // in-process-gpu 避免单独拉起 GPU 子进程
  app.commandLine.appendSwitch('in-process-gpu')
}
if (!process.env.LAN_DANMAKU_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox')
}

/** webContents 可能正在销毁，直接 send 会抛 "Render frame was disposed" */
function safeSend (win, channel, payload) {
  if (!win || win.isDestroyed()) return false
  try {
    win.webContents.send(channel, payload)
    return true
  } catch {
    return false
  }
}

let store = null
let server = null
let tunnel = null
let joinClient = null
// 局域网自动发现：主机广播自己、加入端监听列表
let discoveryBroadcaster = null
let discoveryListener = null
/** 桌宠面板当前是否展开（决定口令状态变化时要不要重算窗口高度） */
let ballExpanded = false
let overlayWindow = null
let controlWindow = null
let joinWindow = null
let launcherWindow = null
let ballWindow = null
let tray = null
let quitting = false
let overlayReloads = 0
/** 拖动桌宠时的起始窗口位置（松手才落盘） */
let ballDragOrigin = null
/** 模式切换拆卸中：destroy 窗口触发的 render-process-gone 不算崩溃 */
let tearingDown = false

/** 控制台需要展示的全部运行时状态 */
const state = {
  port: null,
  addresses: [],
  address: null,
  url: null,
  subnet: '',
  online: 0,
  paused: false,
  overlayReady: false,
  overlayHealth: null,
  selfCheck: { status: 'unknown', message: '' },
  serverError: null,
  joinStatus: 'idle',
  joinError: null,
  qrDataUrl: null,
  recent: [],
  logs: []
}

// ---------------------------------------------------------------- 状态辅助

/**
 * 打包时锁定模式，供"主机版 / 加入版"两个安装包使用。
 * electron-builder 的 extraMetadata 会把 appMode 写进打包后的 package.json，
 * 于是主机版装完就变不成加入端、加入版也开不出服务器；开发态读不到该字段，
 * 走正常的"启动时选模式"逻辑。
 */
const FORCED_MODE = (() => {
  try {
    const meta = require(path.join(app.getAppPath(), 'package.json'))
    return meta.appMode === 'host' || meta.appMode === 'join' ? meta.appMode : null
  } catch {
    return null
  }
})()

/** 打包变体：'all' = 一体化版（每次启动都让用户选模式，不自动恢复上次模式）；
 *  null = 开发态 / 单模式包（沿用"记住上次模式"的行为） */
const APP_VARIANT = (() => {
  try {
    const meta = require(path.join(app.getAppPath(), 'package.json'))
    return meta.appVariant || null
  } catch {
    return null
  }
})()

function currentMode () {
  if (FORCED_MODE) return FORCED_MODE
  return store ? (store.get('mode') || null) : null
}

function log (level, msg) {
  // Room 的 onLog 回调传的是单个对象，这里统一适配两种调用形式
  if (level && typeof level === 'object') {
    msg = level.msg
    level = level.level
  }
  const entry = { level: level || 'info', msg: String(msg), ts: Date.now() }
  state.logs.push(entry)
  if (state.logs.length > 120) state.logs.splice(0, state.logs.length - 120)
  console.log(`[${entry.level}] ${entry.msg}`)
  safeSend(controlWindow, 'control:log', entry)
}

function publicState () {
  return {
    ...state,
    config: store ? store.get() : {},
    tunnel: tunnel ? tunnel.status() : { running: false, url: null, error: null, binary: null },
    displays: screen.getAllDisplays().map(d => ({
      id: d.id,
      label: `显示器 ${d.id} · ${d.bounds.width}×${d.bounds.height}`,
      primary: d.id === screen.getPrimaryDisplay().id,
      scaleFactor: d.scaleFactor
    })),
    appVersion: app.getVersion(),
    platform: process.platform,
    appMode: FORCED_MODE,
    configPath: store ? store.file : ''
  }
}

function pushState () {
  safeSend(controlWindow, 'control:state', publicState())
  safeSend(ballWindow, 'ball:state', ballPublicState())
  updateTrayMenu()
}

// ------------------------------------------------------------------ 网卡地址

function refreshAddresses () {
  const raw = listLocalIPv4()
  state.addresses = raw.map(a => ({
    ...a,
    url: state.port ? `http://${a.address}:${state.port}` : ''
  }))

  const cfg = store.get()
  let picked = state.addresses.find(a => a.address === cfg.adapterAddress)
  if (!picked) picked = state.addresses[0] || null

  state.address = picked ? picked.address : null
  state.subnet = picked ? subnetOf(picked.address) : ''
  state.url = state.port && picked ? `http://${picked.address}:${state.port}` : null
}

async function refreshQr () {
  if (!state.url) {
    state.qrDataUrl = null
    return
  }
  try {
    const QRCode = require('qrcode')
    state.qrDataUrl = await QRCode.toDataURL(state.url, {
      margin: 1,
      width: 260,
      errorCorrectionLevel: 'M',
      color: { dark: '#0C447C', light: '#FFFFFF' }
    })
  } catch (err) {
    log('error', `二维码生成失败：${err.message}`)
    state.qrDataUrl = null
  }
}

/**
 * 自检：从本机发起一次到局域网地址的 HTTP 请求。
 * 通过不代表万无一失，但失败基本就能确定是被防火墙拦了 —— 这个提示很值钱。
 */
function selfCheck () {
  return new Promise(resolve => {
    if (!state.address || !state.port) {
      resolve({ status: 'unknown', message: '没有可用的局域网地址' })
      return
    }
    const req = http.get(
      { host: state.address, port: state.port, path: '/health', timeout: 2500 },
      res => {
        res.resume()
        resolve({ status: 'ok', message: `本机可访问 ${state.address}:${state.port}` })
      }
    )
    req.on('timeout', () => { req.destroy(); resolve({ status: 'fail', message: '自检超时' }) })
    req.on('error', err => {
      resolve({ status: 'fail', message: `自检失败：${err.code || err.message}` })
    })
  })
}

async function runSelfCheck () {
  state.selfCheck = { status: 'checking', message: '正在自检…' }
  pushState()
  const result = await selfCheck()
  state.selfCheck = result
  log(result.status === 'ok' ? 'info' : 'warn', result.message)
  pushState()
}

// ------------------------------------------------------------------ 弹幕层窗口

function pickDisplay () {
  const displays = screen.getAllDisplays()
  const wanted = store.get('displayId')
  return displays.find(d => d.id === wanted) || screen.getPrimaryDisplay()
}

/** 滚动弹幕带的高度（屏幕高度 × heightRatio，最小 100） */
function overlayBandHeight () {
  const { bounds } = pickDisplay()
  return Math.max(100, Math.round(bounds.height * store.get('heightRatio')))
}

function overlayBounds () {
  const { bounds } = pickDisplay()
  // 窗口盖满整块屏幕：顶部 stageHeight 高的带子滚动弹幕，
  // 其余区域留给控制台固定弹幕（上/中/下落点）。窗口透明且不接收鼠标，不挡操作。
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}

function createOverlayWindow () {
  const b = overlayBounds()

  overlayWindow = new BrowserWindow({
    ...b,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 弹幕层永远拿不到焦点，必须关掉后台节流，否则动画会掉到 1fps
      backgroundThrottling: false
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  if (typeof overlayWindow.setVisibleOnAllWorkspaces === 'function') {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  overlayWindow.loadFile(path.join(__dirname, '..', 'overlay', 'index.html'))

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.showInactive()
  })

  overlayWindow.webContents.on('render-process-gone', (_e, details) => {
    if (tearingDown) return // 模式切换时主动 destroy，不算崩溃
    log('error', `弹幕层渲染进程异常退出：${details.reason}`)
    state.overlayReady = false
    pushState()
    // 限制重载次数，避免渲染进程持续崩溃时陷入无限重启循环
    if (overlayReloads < 3) {
      overlayReloads += 1
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.reload()
      }, 1500)
    } else {
      log('error', '弹幕层连续崩溃，已停止自动重载。请重启应用。')
    }
  })
}

function relayoutOverlay () {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.setBounds(overlayBounds())
}

function sendOverlay (channel, payload) {
  safeSend(overlayWindow, channel, payload)
}

function overlayConfig () {
  const cfg = store.get()
  return {
    fontSize: cfg.fontSize,
    scrollDuration: cfg.scrollDuration,
    laneGap: cfg.laneGap,
    opacity: cfg.opacity,
    showName: cfg.showName,
    // 滚动带高度：弹幕层窗口现在是整屏高，滚动只发生在顶部这一条带里
    stageHeight: overlayBandHeight(),
    paused: cfg.paused
  }
}

function applyConfigToOverlay () {
  relayoutOverlay()
  if (state.overlayReady) sendOverlay('overlay:config', overlayConfig())
  state.paused = store.get('paused')
  pushState()
}

// ------------------------------------------------------------------ 控制台窗口

function createControlWindow () {
  // 双保险：加入模式永远不应该出现主机控制台
  if (currentMode() === 'join') return
  controlWindow = new BrowserWindow({
    width: 580,
    height: 880,
    minWidth: 480,
    minHeight: 620,
    title: 'LAN Danmaku 控制台',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#F7F6F3',
    icon: loadIcon('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  controlWindow.loadFile(path.join(__dirname, '..', 'control', 'index.html'))

  controlWindow.once('ready-to-show', () => {
    controlWindow.show()
    pushState()
    if (isDev) controlWindow.webContents.openDevTools({ mode: 'detach' })
  })

  controlWindow.on('close', e => {
    // 关窗口不退出，缩到托盘继续跑
    if (!quitting) {
      e.preventDefault()
      controlWindow.hide()
      if (tray) tray.displayBalloon?.({
        title: 'LAN Danmaku 仍在运行',
        content: '弹幕服务还在后台工作，双击托盘图标可重新打开控制台。'
      })
    }
  })

  controlWindow.on('closed', () => { controlWindow = null })
}

function showControlWindow () {
  // 加入模式没有控制台：托盘点击 / 重复启动会走到这里，转去开加入设置窗口，
  // 否则会凭空弹出一个主机控制台（没有服务、显示"没有可用的局域网地址"）
  if (currentMode() === 'join') {
    showJoinWindow()
    return
  }
  if (!controlWindow || controlWindow.isDestroyed()) {
    createControlWindow()
    return
  }
  controlWindow.show()
  controlWindow.focus()
}

/** 按当前模式打开对应的交互窗口：二次启动、托盘点击都走这里 */
function showModeWindow () {
  const mode = currentMode()
  if (mode === 'join') showJoinWindow()
  else if (mode === 'host') showControlWindow()
  else showLauncherWindow()
}

// ------------------------------------------------------- 加入模式 / 模式选择

function createJoinWindow () {
  joinWindow = new BrowserWindow({
    width: 470,
    height: 860,
    minWidth: 400,
    minHeight: 560,
    title: 'LAN Danmaku · 加入弹幕',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#F7F6F3',
    icon: loadIcon('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-join.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  joinWindow.loadFile(path.join(__dirname, '..', 'join', 'index.html'))

  joinWindow.once('ready-to-show', () => joinWindow.show())
  joinWindow.on('closed', () => { joinWindow = null })
}

function showJoinWindow () {
  if (!joinWindow || joinWindow.isDestroyed()) {
    createJoinWindow()
    return
  }
  joinWindow.show()
  joinWindow.focus()
}

function createLauncherWindow () {
  launcherWindow = new BrowserWindow({
    width: 480,
    height: 540,
    resizable: false,
    title: 'LAN Danmaku',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#F7F6F3',
    icon: loadIcon('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-launcher.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  launcherWindow.loadFile(path.join(__dirname, '..', 'launcher', 'index.html'))
  launcherWindow.once('ready-to-show', () => launcherWindow.show())
  launcherWindow.on('closed', () => { launcherWindow = null })
}

function showLauncherWindow () {
  if (!launcherWindow || launcherWindow.isDestroyed()) {
    createLauncherWindow()
    return
  }
  launcherWindow.show()
  launcherWindow.focus()
}

// ------------------------------------------------------------------ 桌宠

/** 默认贴在主屏右下角；存过位置就用存的 */
function ballDefaultPos () {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + wa.width - PET_WIN.width - BALL_MARGIN,
    y: wa.y + wa.height - PET_WIN.height - BALL_MARGIN
  }
}

function savedBallPos () {
  const saved = store && store.get('ballPos')
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) }
  }
  return ballDefaultPos()
}

/** 把矩形夹到所在显示器的工作区内，免得球被拖到看不见的地方 */
function clampToWorkArea (x, y, width, height) {
  const area = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea
  return {
    x: Math.max(area.x, Math.min(Math.round(x), area.x + area.width - width)),
    y: Math.max(area.y, Math.min(Math.round(y), area.y + area.height - height))
  }
}

function createBallWindow () {
  const pos = clampToWorkArea(savedBallPos().x, savedBallPos().y, PET_WIN.width, PET_WIN.height)

  ballWindow = new BrowserWindow({
    ...pos,
    width: PET_WIN.width,
    height: PET_WIN.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    title: '发弹幕',
    webPreferences: {
      preload: path.join(__dirname, 'preload-ball.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  ballWindow.setAlwaysOnTop(true, 'screen-saver')
  ballWindow.loadFile(path.join(__dirname, '..', 'ball', 'index.html'))

  // showInactive：不抢当前窗口的焦点，尽量"无感"
  ballWindow.once('ready-to-show', () => ballWindow.showInactive())

  // 从托盘/加入窗口点"显示桌宠"时，位置重新按屏幕校准一次
  ballWindow.on('closed', () => { ballWindow = null })
}

function isBallVisible () {
  return !!ballWindow && !ballWindow.isDestroyed() && ballWindow.isVisible()
}

function showBall () {
  if (!ballWindow || ballWindow.isDestroyed()) {
    createBallWindow()
    updateTrayMenu()
    return
  }
  const b = ballWindow.getBounds()
  const pos = clampToWorkArea(b.x, b.y, b.width, b.height)
  ballWindow.setBounds({ ...pos, width: b.width, height: b.height })
  ballWindow.showInactive()
  updateTrayMenu()
}

function hideBall () {
  if (isBallVisible()) ballWindow.hide()
  updateTrayMenu()
}

function toggleBall () {
  if (isBallVisible()) hideBall()
  else showBall()
}

/**
 * 展开桌宠：面板向上向左长出来，小球仍停在原来的位置 ——
 * 所以窗口右边界和上边界都往外撑，展开后小球刚好落在面板右下角。
 */
function expandBall () {
  if (!ballWindow || ballWindow.isDestroyed()) return
  // 服务器要求口令且当前没过：面板多留一行输入口令的高度
  const needToken = !!(joinClient && currentMode() === 'join' &&
    state.joinStatus === 'open' && joinClient.canSend === false)
  const panelH = BALL_PANEL.height + (needToken ? 46 : 0)
  const b = ballWindow.getBounds()
  const target = clampToWorkArea(
    b.x + b.width - BALL_PANEL.width,
    b.y + b.height - panelH,
    BALL_PANEL.width,
    panelH
  )
  ballWindow.setBounds({ ...target, width: BALL_PANEL.width, height: panelH })
  ballWindow.focus()
  return target
}

function collapseBall () {
  if (!ballWindow || ballWindow.isDestroyed()) return
  const pos = clampToWorkArea(savedBallPos().x, savedBallPos().y, PET_WIN.width, PET_WIN.height)
  ballWindow.setBounds({ ...pos, width: PET_WIN.width, height: BALL_SIZE })
  return pos
}

/** 桌宠需要的全部状态：身份、颜色、连接情况 */
function ballPublicState () {
  const mode = currentMode()
  const connected = mode === 'join'
    ? state.joinStatus === 'open'
    : (!!state.port && !state.serverError)
  return {
    identity: {
      name: store ? (store.get('senderName') || '') : '',
      anonymous: !!(store && store.get('senderAnonymous'))
    },
    color: store ? (store.get('senderColor') || PRESET_COLORS[1]) : PRESET_COLORS[1],
    colors: PRESET_COLORS,
    connected,
    mode,
    /** 加入模式连着口令服务器且当前没发言权限：桌宠要亮出口令输入 */
    needToken: mode === 'join' && connected && joinClient && joinClient.canSend === false,
    /** 服务器昵称政策：'required' 强制实名 | 'free' 允许匿名 | null 未知 */
    namePolicy: namePolicyState(),
    textMax: LIMITS.TEXT_MAX,
    nameMax: LIMITS.NAME_MAX
  }
}

function pushBallState () {
  safeSend(ballWindow, 'ball:state', ballPublicState())
}

/** 主机本机发送走本地房间；加入端走与主机的那根 ws —— 校验/限流/屏蔽词都在主机那份实现里 */
async function sendFromBall (text) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('内容不能为空')

  // 强制实名：没填昵称直接给明确提示，引导去身份面板填名字
  if (namePolicyState() === 'required' && !store.get('senderName')) {
    throw new Error(REJECT_TEXT.NEED_NAME || '服务器要求填昵称才能发言')
  }

  if (currentMode() === 'join') {
    if (!joinClient || state.joinStatus !== 'open') throw new Error('还没连上主机')
    await joinClient.send({
      text: clean,
      name: senderDisplayName(),
      color: store.get('senderColor')
    })
    return true
  }

  if (!server) throw new Error('弹幕服务还没起来')
  const result = server.room.publishLocal({
    text: clean,
    name: senderDisplayName(),
    color: store.get('senderColor')
  })
  if (!result.ok) throw new Error(REJECT_TEXT[result.code] || '发送失败')
  return true
}

/**
 * 服务器昵称政策对发送端而言的状态：
 *   'required' 强制实名：匿名已关，必须填昵称才能发言；
 *   'free'     允许匿名；
 *   null       未知（加入模式连的是旧版主机，没告知过）。
 */
function namePolicyState () {
  if (currentMode() === 'join') {
    return joinClient ? joinClient.namePolicy : null
  }
  return store.get('forceNickname') ? 'required' : 'free'
}

function anonAllowed () {
  return namePolicyState() !== 'required'
}

/** 允许匿名且勾了匿名 → 匿名；否则用昵称（没填就交空，由服务器决定显示/拒绝） */
function senderDisplayName () {
  if (store.get('senderAnonymous') && anonAllowed()) return '匿名'
  return store.get('senderName') || ''
}

/** 切换模式或重新选择：改完配置整个应用重启，最干净 */
/**
 * 彻底停掉当前模式的窗口与后台任务（模式切换专用；退出应用走 before-quit，别调它）。
 * 窗口用 destroy() 直接销毁：控制台的 close 事件会被拦截成"隐藏到托盘"，close() 绕不开。
 */
async function teardownModeRuntime () {
  tearingDown = true
  if (server) { await server.stop().catch(() => {}); server = null }
  if (joinClient) { joinClient.disconnect(); joinClient = null }
  if (discoveryBroadcaster) { discoveryBroadcaster.stop(); discoveryBroadcaster = null }
  if (discoveryListener) { discoveryListener.stop(); discoveryListener = null }
  if (tunnel && tunnel.status().running) tunnel.stop()
  for (const w of [controlWindow, joinWindow, overlayWindow]) {
    if (w && !w.isDestroyed()) w.destroy()
  }
  controlWindow = null
  joinWindow = null
  overlayWindow = null

  state.port = null
  state.addresses = []
  state.address = null
  state.url = null
  state.subnet = ''
  state.online = 0
  state.overlayReady = false
  state.overlayHealth = null
  state.selfCheck = { status: 'unknown', message: '' }
  state.serverError = null
  state.joinStatus = 'idle'
  state.joinError = null
  state.qrDataUrl = null
  state.recent = []
  overlayReloads = 0
  // destroy() 会触发弹幕层的 render-process-gone（reason=killed），那是正常拆卸不是崩溃，
  // 延迟几秒再关标记（渲染进程退出事件可能晚到），避免误报“渲染进程异常退出”
  setTimeout(() => { tearingDown = false }, 3000)
}

let switchingMode = false

/**
 * 原地切换模式：不重启进程。以前是 store 写入后 app.relaunch()+app.exit(0)，
 * 但便携版 exe 是解压到临时目录运行的，退出后重启目标可能已被清理，
 * 结果就是"程序直接关了再也起不来"，而且 mode 已经落盘，下次打开就"自动变发送端"。
 * 现在改为原地拆掉旧模式的窗口和服务，再起新模式。
 */
async function enterMode (mode) {
  if (switchingMode) return
  if (mode !== 'host' && mode !== 'join') return
  switchingMode = true
  try {
    log('info', mode === 'host' ? '切换到主机模式…' : '切换到加入模式…')
    await teardownModeRuntime()
    store.set({ mode })
    if (mode === 'join') startJoinMode()
    else await startHostMode()
    updateTrayMenu()
    log('info', mode === 'host' ? '已进入主机模式' : '已进入加入模式')
  } catch (err) {
    log('error', `切换模式失败：${err.message}`)
  } finally {
    switchingMode = false
  }
}

function switchMode () {
  // 单模式安装包（主机版/加入版）不允许切换，装的是哪个就是哪个
  if (FORCED_MODE) {
    log('warn', `当前安装包已锁定为「${FORCED_MODE === 'host' ? '主机' : '加入'}」模式，无法切换`)
    return
  }
  // 只弹模式选择窗口，不动正在跑的模式——用户直接关掉选择窗口就维持现状
  showLauncherWindow()
}

/** 命令行 --join <host[:port]>：直接以加入模式启动 */
function readCliJoin () {
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--join') return argv[i + 1] || ''
    if (argv[i].startsWith('--join=')) return argv[i].slice('--join='.length)
  }
  return null
}

function startHostMode () {
  // 主机不再显示滚动弹幕：弹幕层只在加入端渲染，主机看控制台里的「最近弹幕」就够了。
  // 这样同机测试也不会出现双层弹幕。
  createControlWindow()
  return restartServer().then(() => {})
}

function startJoinMode () {
  createOverlayWindow()
  createJoinWindow()
  // 加入端的主要动作就是发言，进模式就把球放到桌面上（不想留就右键收起，托盘可再调出来）
  showBall()

  joinClient = new JoinClient({ onLog: log })
  joinClient.onDanmaku = item => onDanmaku(item)
  joinClient.onStats = stats => {
    state.online = stats.online || 0
    safeSend(joinWindow, 'join:stats', { online: state.online })
  }
  joinClient.onClear = () => sendOverlay('overlay:clear')
  joinClient.onPause = paused => {
    state.paused = !!paused
    sendOverlay(paused ? 'overlay:pause' : 'overlay:resume')
  }
  joinClient.onStatus = (status, detail) => {
    state.joinStatus = status
    state.joinError = detail || null
    if (status === 'open') log('info', `已连接主机 ${joinClient.origin}`)
    else if (status === 'connecting') log('info', `正在连接 ${joinClient.origin}…`)
    else if (status === 'closed') log('warn', `与主机断开（${detail || '未知原因'}），将自动重连`)
    safeSend(joinWindow, 'join:status', { status, detail })
    pushBallState()
    updateTrayMenu()
  }

  // 让主机侧也知道本机的发言身份（HELLO 里会带上）
  joinClient.setIdentity(senderDisplayName())
  // 主机昵称政策变化（HELLO 回执 / CONFIG 广播）：同步桌宠和加入窗口
  joinClient.onNamePolicy = policy => {
    log('info', policy === 'required'
      ? '服务器已关闭匿名：需要填写昵称才能发言'
      : '服务器允许匿名发言')
    pushBallState()
    safeSend(joinWindow, 'join:name-policy', { namePolicy: policy })
  }
  // 发言权限变化（口令填对/被拒）：同步桌宠和加入窗口
  joinClient.onCanSend = canSend => {
    log('info', canSend ? '房间口令校验通过，可以发言了' : '服务器开启了发言口令，当前只能观看')
    pushBallState()
    safeSend(joinWindow, 'join:can-send', { canSend })
    if (ballExpanded) expandBall() // 面板高度要随口令输入行增减
  }
  joinClient.onTokenRejected = msg => {
    log('warn', `房间口令校验失败：${msg}`)
    safeSend(ballWindow, 'ball:token-result', { ok: false, msg })
    safeSend(joinWindow, 'join:token-result', { ok: false, msg })
  }

  // 自动发现：监听局域网内主机的 UDP 广播，列表变化就推给加入窗口
  if (!discoveryListener) {
    discoveryListener = new DiscoveryListener({ onLog: log })
    discoveryListener.onChange = list => safeSend(joinWindow, 'join:discovered', { hosts: list })
    discoveryListener.start()
  }

  const saved = store.get('joinUrl')
  if (saved) {
    joinClient.connect(saved)
    joinClient.setRoomToken(store.get('joinToken') || '')
  }
}

// ------------------------------------------------------------------ 托盘

function loadIcon (file) {
  const img = nativeImage.createFromPath(path.join(ASSETS, file))
  return img.isEmpty() ? undefined : img
}

function updateTrayMenu () {
  if (!tray) return
  const mode = currentMode()
  const items = []

  if (mode === 'join') {
    const st = state.joinStatus
    const stText = { open: '已连接', connecting: '连接中…', closed: '已断开', idle: '未连接' }[st] || st
    items.push({ label: `状态：${stText}`, enabled: false })
    if (joinClient && joinClient.origin) items.push({ label: joinClient.origin, enabled: false })
    items.push({ type: 'separator' })
    items.push({ label: '加入设置', click: showJoinWindow })
    items.push({
      label: st === 'open' ? '断开主机' : '立即连接',
      enabled: !!joinClient,
      click: () => {
        if (!joinClient) return
        if (st === 'open') joinClient.disconnect()
        else {
          const saved = store.get('joinUrl')
          if (saved) {
            joinClient.connect(saved)
            joinClient.setRoomToken(store.get('joinToken') || '')
          }
        }
      }
    })
    items.push({ label: ballLabel(), click: toggleBall })
    items.push({ label: pausedLabel(), click: () => setPaused(!store.get('paused')) })
    items.push({ label: '清空屏幕', click: () => doClear() })
  } else if (mode === 'host') {
    items.push({ label: `在线设备：${state.online}`, enabled: false })
    items.push({ label: state.url || '未获取到局域网地址', enabled: false })
    items.push({ type: 'separator' })
    items.push({ label: '打开控制台', click: showControlWindow })
    items.push({ label: ballLabel(), click: toggleBall })
    items.push({ label: pausedLabel(), click: () => setPaused(!store.get('paused')) })
    items.push({ label: '清空屏幕', click: () => doClear() })
    items.push({
      label: '鼠标穿透（勾选=可点到桌面）',
      type: 'checkbox',
      checked: true,
      click: item => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.setIgnoreMouseEvents(item.checked, { forward: true })
          log('info', item.checked ? '弹幕层已开启鼠标穿透' : '弹幕层已锁定鼠标（临时）')
        }
      }
    })
    items.push({ type: 'separator' })
    items.push({ label: '复制访问地址', enabled: !!state.url, click: () => { if (state.url) clipboard.writeText(state.url) } })
  } else {
    items.push({ label: '请选择运行模式', enabled: false })
    items.push({ label: '打开模式选择', click: showLauncherWindow })
  }

  items.push({ type: 'separator' })
  if (!FORCED_MODE) {
    // 走 switchMode：只弹模式选择窗口，原地切换，不重启进程
    items.push({ label: '切换模式', click: switchMode })
  }
  items.push({ label: '退出', click: () => { quitting = true; app.quit() } })
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function pausedLabel () {
  return store && store.get('paused') ? '恢复上屏' : '暂停上屏'
}

function ballLabel () {
  return isBallVisible() ? '隐藏桌宠' : '显示桌宠'
}

function createTray () {
  // 托盘用单独生成的 32px 图，运行时缩放会发虚
  const icon = loadIcon('tray.png') || loadIcon('icon.png')
  tray = new Tray(icon || nativeImage.createEmpty())
  tray.setToolTip('LAN Danmaku · 局域网弹幕')
  updateTrayMenu()
  tray.on('double-click', showModeWindow)
  tray.on('click', showModeWindow)
}

// ------------------------------------------------------------------ 动作

function setPaused (next) {
  store.set({ paused: !!next })
  state.paused = !!next
  sendOverlay(next ? 'overlay:pause' : 'overlay:resume')
  // 主机模式还要通知所有发送端；加入模式只影响本机
  if (currentMode() === 'host' && server) {
    server.broadcast({ type: next ? MSG.PAUSE : MSG.RESUME })
  }
  log('info', next ? '已暂停上屏' : '已恢复上屏')
  pushState()
}

function doClear () {
  sendOverlay('overlay:clear')
  if (currentMode() === 'host' && server) server.broadcast({ type: MSG.CLEAR })
  log('info', '已清空弹幕层')
}

async function restartServer () {
  // 服务重启端口可能变化，旧隧道指向的本地端口就失效了，直接关掉让用户重开
  if (tunnel && tunnel.status().running) {
    tunnel.stop()
    log('warn', '服务已重启，公网隧道已断开，需要的话请重新一键开启')
  }
  if (server) {
    await server.stop().catch(() => {})
    server = null
  }
  // 服务重启 = 端口可能变了，旧的发现广播跟着换
  if (discoveryBroadcaster) {
    discoveryBroadcaster.stop()
    discoveryBroadcaster = null
  }
  try {
    server = new DanmakuServer({ getConfig: () => store.get(), onLog: log })
    // 把房间事件接到主进程：弹幕推给弹幕层，统计推给控制台
    server.room.onDanmaku = item => onDanmaku(item)
    server.room.onStats = stats => {
      state.online = stats.online
      safeSend(controlWindow, 'control:stats', stats)
      pushState()
    }

    const preferred = store.get('port')
    const port = await server.start(preferred)
    if (port !== preferred) {
      store.set({ port })
      log('warn', `端口 ${preferred} 被占用，已自动改用 ${port}`)
    }
    state.port = port
    state.serverError = null
    log('info', `弹幕服务已启动，监听 0.0.0.0:${port}`)

    // 服务起来就开始广播"我在这"，加入端的自动发现靠它
    discoveryBroadcaster = new DiscoveryBroadcaster({ port, onLog: log })
    discoveryBroadcaster.start()
  } catch (err) {
    state.serverError = err.message
    state.port = null
    log('error', `服务启动失败：${err.message}`)
  }

  refreshAddresses()
  await refreshQr()
  pushState()
  if (!state.serverError) runSelfCheck()
}

function onDanmaku (item) {
  state.recent.push(item)
  if (state.recent.length > 50) state.recent.splice(0, state.recent.length - 50)
  sendOverlay('overlay:danmaku', item)
  if (currentMode() === 'join') safeSend(joinWindow, 'join:danmaku', item)
  else safeSend(controlWindow, 'control:danmaku', item)
  // 桌宠：有弹幕上屏就挥个手
  safeSend(ballWindow, 'ball:danmaku', item)
}

// ------------------------------------------------------------------ IPC

function registerIpc () {
  ipcMain.on('overlay:ready', () => {
    state.overlayReady = true
    log('info', '弹幕层已就绪')
    const history = currentMode() === 'join'
      ? (joinClient ? joinClient.history.slice(-20) : [])
      : (server ? server.room.history.slice(-20) : [])
    sendOverlay('overlay:init', {
      config: overlayConfig(),
      history
    })
    pushState()
  })

  ipcMain.on('overlay:report', (_e, payload) => {
    state.overlayHealth = payload
  })

  ipcMain.handle('control:get-state', () => publicState())

  // 控制台发送固定弹幕（公告）：不滚动，落点上/中/下，停留 stayMs 后消失
  ipcMain.handle('control:send-fixed', (_e, payload) => {
    if (!server) throw new Error('弹幕服务还没起来')
    const p = payload || {}
    const result = server.room.publishFixed({
      text: p.text,
      position: p.position,
      stayMs: p.stayMs,
      color: p.color,
      style: p.style
    })
    if (!result.ok) throw new Error(REJECT_TEXT[result.code] || '发送失败')
    return result.item
  })

  // ---------------- 加入模式 IPC ----------------

  function joinPublicState () {
    return {
      status: state.joinStatus,
      detail: state.joinError,
      origin: joinClient ? joinClient.origin : null,
      url: store.get('joinUrl'),
      token: store.get('joinToken') || '',
      /** null=服务器没开口令/未知；false=需要口令且当前没过 */
      canSend: joinClient && state.joinStatus === 'open' ? joinClient.canSend : null,
      online: state.online,
      paused: state.paused,
      /** 主机昵称政策：null=未知（旧版主机），'required'=强制实名，'free'=允许匿名 */
      namePolicy: joinClient ? joinClient.namePolicy : null,
      recent: state.recent.slice(-30).reverse(),
      // 发言身份（昵称 / 匿名）：打开发送之前就先定好
      identity: {
        name: store.get('senderName') || '',
        anonymous: !!store.get('senderAnonymous')
      },
      // 外观设置面板需要：本机弹幕层读的就是这份配置（与主机各自独立）
      config: store.get(),
      // 局域网内已发现的主机（自动发现列表）
      discovered: discoveryListener ? discoveryListener.list() : [],
      displays: screen.getAllDisplays().map(d => ({
        id: d.id,
        label: `显示器 ${d.id} · ${d.bounds.width}×${d.bounds.height}`,
        primary: d.id === screen.getPrimaryDisplay().id,
        scaleFactor: d.scaleFactor
      })),
      appVersion: app.getVersion()
    }
  }

  ipcMain.handle('join:get-state', () => joinPublicState())

  // 加入端本机外观设置：只允许外观字段，改完直接应用到本机弹幕层
  const JOIN_APPEARANCE_KEYS = [
    'heightRatio', 'fontSize', 'scrollDuration', 'laneGap',
    'opacity', 'showName', 'displayId'
  ]
  ipcMain.handle('join:set-config', (_e, patch) => {
    const clean = {}
    for (const k of JOIN_APPEARANCE_KEYS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k]
    }
    if (Object.keys(clean).length) {
      store.set(clean)
      log('info', '已更新本机弹幕设置')
      applyConfigToOverlay()
    }
    return joinPublicState()
  })

  // 加入窗口里改口令：存下来并向主机重新校验（不用断开重连）
  ipcMain.handle('join:set-token', (_e, token) => {
    const t = String(token || '').trim()
    store.set({ joinToken: t })
    if (joinClient) joinClient.setRoomToken(t)
    log('info', t ? '房间口令已保存，正在向主机重新校验' : '已清空房间口令')
    return joinPublicState()
  })

  ipcMain.handle('join:connect', (_e, payload) => {
    if (!joinClient) return joinPublicState()
    const input = payload && typeof payload === 'object' ? payload.input : payload
    const token = payload && typeof payload === 'object' ? String(payload.token || '') : ''
    const ok = joinClient.connect(input)
    if (ok) {
      const parsed = parseHostInput(input)
      if (parsed) store.set({ joinUrl: parsed.origin, joinToken: token })
      joinClient.setRoomToken(token)
    } else {
      log('warn', `无效的主机地址：${input}`)
    }
    return joinPublicState()
  })

  ipcMain.handle('join:disconnect', () => {
    if (joinClient) joinClient.disconnect()
    return joinPublicState()
  })

  ipcMain.handle('join:show-ball', () => {
    showBall()
    return true
  })

  ipcMain.handle('join:set-identity', (_e, patch) => {
    const name = String((patch && patch.name) || '').trim().slice(0, LIMITS.NAME_MAX)
    const anonymous = !!(patch && patch.anonymous)
    store.set({ senderName: name, senderAnonymous: anonymous })
    if (joinClient) joinClient.setIdentity(senderDisplayName())
    pushBallState()
    return joinPublicState()
  })

  ipcMain.handle('join:toggle-pause', () => {
    setPaused(!store.get('paused'))
    return true
  })

  ipcMain.handle('join:switch-mode', () => {
    switchMode()
    return true
  })

  ipcMain.on('launcher:choose', (_e, mode) => {
    if (mode !== 'host' && mode !== 'join') return
    const win = launcherWindow
    // 原地切换，不重启进程（重启在便携版下会让程序直接消失）
    enterMode(mode)
    if (win && !win.isDestroyed()) win.close()
  })

  // ---------------- 桌宠 IPC ----------------

  ipcMain.handle('ball:get-state', () => ballPublicState())

  ipcMain.handle('ball:expand', () => {
    ballExpanded = true
    expandBall()
    return ballPublicState()
  })

  ipcMain.handle('ball:collapse', () => {
    ballExpanded = false
    collapseBall()
    return ballPublicState()
  })

  ipcMain.handle('ball:hide', () => {
    hideBall()
    return true
  })

  /**
   * 发送。故意不抛异常：ipcMain.handle 抛出的错误在渲染层会带上
   * "Error invoking remote method ..." 前缀，直接糊在提示条上很难看。
   */
  ipcMain.handle('ball:send', async (_e, payload) => {
    try {
      await sendFromBall(payload && payload.text)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message || '发送失败' }
    }
  })

  // 桌宠面板里填房间口令：存下来并向主机重新校验（不用断开重连）
  ipcMain.handle('ball:set-token', (_e, token) => {
    const t = String(token || '').trim()
    store.set({ joinToken: t })
    if (joinClient) joinClient.setRoomToken(t)
    log('info', t ? '房间口令已保存，正在向主机重新校验' : '已清空房间口令')
    return ballPublicState()
  })

  ipcMain.handle('ball:set-identity', (_e, patch) => {
    const name = String((patch && patch.name) || '').trim().slice(0, LIMITS.NAME_MAX)
    const anonymous = !!(patch && patch.anonymous)
    store.set({ senderName: name, senderAnonymous: anonymous })
    if (joinClient) joinClient.setIdentity(senderDisplayName())
    log('info', anonymous ? '发言身份：匿名' : `发言身份：${name}`)
    pushBallState()
    safeSend(joinWindow, 'join:identity', { name, anonymous })
    return ballPublicState()
  })

  ipcMain.handle('ball:set-color', (_e, color) => {
    const ok = typeof color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim())
    if (ok) store.set({ senderColor: color.trim() })
    return ballPublicState()
  })

  // 拖动：起点由主进程记着，渲染层只上报增量，松手才落盘
  ipcMain.on('ball:drag-start', () => {
    ballDragOrigin = ballWindow && !ballWindow.isDestroyed() ? ballWindow.getBounds() : null
  })

  ipcMain.on('ball:drag', (_e, { dx, dy }) => {
    if (!ballDragOrigin || !ballWindow || ballWindow.isDestroyed()) return
    const { x, y, width, height } = ballDragOrigin
    const pos = clampToWorkArea(x + Number(dx || 0), y + Number(dy || 0), width, height)
    ballWindow.setBounds({ ...pos, width, height })
  })

  ipcMain.on('ball:drag-end', () => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      const b = ballWindow.getBounds()
      // 展开态下窗口是整块面板，换算回小球的左上角再存
      const expanded = b.width > PET_WIN.width + 1
      const pos = expanded
        ? { x: b.x + BALL_PANEL.width - PET_WIN.width, y: b.y + BALL_PANEL.height - PET_WIN.height }
        : { x: b.x, y: b.y }
      store.set({ ballPos: pos })
    }
    ballDragOrigin = null
  })


  ipcMain.handle('control:set-config', async (_e, patch) => {
    const before = store.get()
    const after = store.set(patch || {})

    // 强制实名开关（服务器级）：广播给所有连接的发送端，同步桌宠的匿名选项
    if (after.forceNickname !== before.forceNickname) {
      log('info', after.forceNickname
        ? '强制实名已开启：发送端不能匿名，必须填昵称才能发言'
        : '强制实名已关闭：允许匿名发言')
      if (server) {
        server.broadcast({ type: MSG.CONFIG, config: { namePolicy: after.forceNickname ? 'required' : 'free' } })
      }
      pushBallState()
    }

    if (after.port !== before.port) {
      log('info', `端口改为 ${after.port}，正在重启服务…`)
      await restartServer()
      return publicState()
    }

    if (after.displayId !== before.displayId || after.heightRatio !== before.heightRatio) {
      relayoutOverlay()
    }

    applyConfigToOverlay()
    return publicState()
  })

  ipcMain.handle('control:reset-config', () => {
    store.reset()
    applyConfigToOverlay()
    return publicState()
  })

  ipcMain.handle('control:action', async (_e, { name, payload }) => {
    switch (name) {
      case 'pause':
        setPaused(true)
        break
      case 'resume':
        setPaused(false)
        break
      case 'clear':
        doClear()
        break
      case 'copy-url':
        if (state.url) {
          clipboard.writeText(state.url)
          log('info', `已复制 ${state.url}`)
        }
        break
      case 'open-url':
        if (state.url) shell.openExternal(state.url)
        break
      case 'open-firewall':
        if (process.platform === 'win32') {
          // 深链到 Windows 安全中心的防火墙页，省得用户自己一层层点进去找
          shell.openExternal('windowsdefender://network').catch(() => {
            log('warn', '没能直接打开防火墙设置，请手动搜索「允许应用通过防火墙」')
          })
        } else {
          log('warn', '请手动检查系统防火墙设置')
        }
        break
      case 'recheck':
        await runSelfCheck()
        break
      case 'restart-server':
        await restartServer()
        break
      case 'tunnel-start': {
        const st = tunnel.start()
        if (st.error) log('warn', `隧道启动失败：${st.error}`)
        else log('info', '正在建立公网隧道…')
        break
      }
      case 'tunnel-stop': {
        tunnel.stop()
        log('info', '公网隧道已关闭')
        break
      }
      case 'copy-tunnel-url': {
        const ts = tunnel.status()
        if (ts.url) {
          clipboard.writeText(ts.url)
          log('info', `已复制 ${ts.url}`)
        }
        break
      }
      case 'select-adapter':
        store.set({ adapterAddress: payload && payload.address })
        refreshAddresses()
        await refreshQr()
        pushState()
        break
      case 'open-config-dir':
        shell.showItemInFolder(store.file)
        break
      case 'open-dev-url':
        if (state.url) shell.openExternal(state.url)
        break
      default:
        log('warn', `未知动作：${name}`)
    }
    return publicState()
  })
}

// ------------------------------------------------------------------ 生命周期

// E2E 专用钩子：只有设置了 LAN_DANMAKU_TEST_HOOKS 才暴露，生产环境不存在
if (process.env.LAN_DANMAKU_TEST_HOOKS) {
  globalThis.__test = {
    enterMode: mode => enterMode(mode),
    showLauncher: () => showLauncherWindow(),
    snapshot: () => ({
      mode: currentMode(),
      port: state.port,
      serverError: state.serverError,
      joinStatus: state.joinStatus,
      online: state.online,
      windows: {
        launcher: !!(launcherWindow && !launcherWindow.isDestroyed()),
        control: !!(controlWindow && !controlWindow.isDestroyed()),
        join: !!(joinWindow && !joinWindow.isDestroyed()),
        overlay: !!(overlayWindow && !overlayWindow.isDestroyed()),
        ball: !!(ballWindow && !ballWindow.isDestroyed())
      }
    })
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showModeWindow)

  app.whenReady().then(async () => {
    store = new Store(path.join(app.getPath('userData'), 'config.json'))

    // 一键公网：cloudflared 快速隧道。打包后在 exe / resources 目录找二进制，
    // 开发态在项目根和 PATH 里找；找不到时控制台会给出提示
    tunnel = new TunnelManager({
      getConfig: () => store.get(),
      onLog: log,
      extraDirs: [
        path.dirname(app.getPath('exe')),
        process.resourcesPath || '',
        path.join(__dirname, '..', '..')
      ]
    })

    screen.on('display-added', () => { relayoutOverlay(); pushState() })
    screen.on('display-removed', () => { relayoutOverlay(); pushState() })
    screen.on('display-metrics-changed', () => { relayoutOverlay(); pushState() })

    registerIpc()
    createTray()

    // 模式优先级：构建锁定的模式 > 命令行 --join > 记住的配置 > 弹出模式选择窗口
    const cliJoin = readCliJoin()
    let mode = currentMode()
    if (cliJoin !== null && FORCED_MODE !== 'host') {
      mode = 'join'
      const parsed = parseHostInput(cliJoin)
      store.set({ mode, joinUrl: parsed ? parsed.origin : store.get('joinUrl') })
    }

    // 一体化版：每次启动都让用户选模式，不自动恢复上次的模式
    // （否则上次选过"加入"，之后每次打开都"莫名其妙自动变成发送端"）
    if (APP_VARIANT === 'all' && cliJoin === null) {
      mode = null
      store.set({ mode: null })
    }

    if (!mode) {
      createLauncherWindow()
      return
    }
    if (mode === 'join') startJoinMode()
    else await startHostMode()
  })

  app.on('window-all-closed', () => {
    // 有意留空：服务要在托盘里继续跑
  })

  app.on('before-quit', async () => {
    quitting = true
    if (tunnel) tunnel.destroy()
    if (server) await server.stop().catch(() => {})
    if (joinClient) joinClient.disconnect()
    if (discoveryBroadcaster) discoveryBroadcaster.stop()
    if (discoveryListener) discoveryListener.stop()
  })

  process.on('uncaughtException', err => {
    log('error', `未捕获异常：${err.message}`)
  })
}
