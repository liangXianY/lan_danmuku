'use strict';

const { contextBridge, ipcRenderer } = require('electron')

/** 加入模式窗口的对外通道 */
contextBridge.exposeInMainWorld('joinApi', {
  getState: () => ipcRenderer.invoke('join:get-state'),
  connect: (input, token) => ipcRenderer.invoke('join:connect', { input, token }),
  disconnect: () => ipcRenderer.invoke('join:disconnect'),
  showBall: () => ipcRenderer.invoke('join:show-ball'),
  setIdentity: patch => ipcRenderer.invoke('join:set-identity', patch),
  togglePause: () => ipcRenderer.invoke('join:toggle-pause'),
  switchMode: () => ipcRenderer.invoke('join:switch-mode'),
  setConfig: patch => ipcRenderer.invoke('join:set-config', patch),
  /** 房间口令：连接后也能改，主进程会向主机重新校验 */
  setRoomToken: token => ipcRenderer.invoke('join:set-token', token),

  onStatus: cb => ipcRenderer.on('join:status', (_e, payload) => cb(payload)),
  onStats: cb => ipcRenderer.on('join:stats', (_e, payload) => cb(payload)),
  onIdentity: cb => ipcRenderer.on('join:identity', (_e, payload) => cb(payload)),
  onDanmaku: cb => ipcRenderer.on('join:danmaku', (_e, item) => cb(item)),
  onDiscovered: cb => ipcRenderer.on('join:discovered', (_e, payload) => cb((payload && payload.hosts) || [])),
  onCanSend: cb => ipcRenderer.on('join:can-send', (_e, payload) => cb(payload && payload.canSend)),
  onTokenResult: cb => ipcRenderer.on('join:token-result', (_e, payload) => cb(payload || {})),
  /** 主机昵称政策变化：cb 收到 { namePolicy }（'required'|'free'）；旧版主机不会推送 */
  onNamePolicy: cb => ipcRenderer.on('join:name-policy', (_e, payload) => cb(payload || {}))
})
