'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** 控制台窗口的对外通道 */
contextBridge.exposeInMainWorld('controlApi', {
  getState: () => ipcRenderer.invoke('control:get-state'),
  setConfig: patch => ipcRenderer.invoke('control:set-config', patch),
  resetConfig: () => ipcRenderer.invoke('control:reset-config'),
  action: (name, payload) => ipcRenderer.invoke('control:action', { name, payload }),
  sendFixed: payload => ipcRenderer.invoke('control:send-fixed', payload),

  onState: cb => ipcRenderer.on('control:state', (_e, state) => cb(state)),
  onDanmaku: cb => ipcRenderer.on('control:danmaku', (_e, item) => cb(item)),
  onLog: cb => ipcRenderer.on('control:log', (_e, entry) => cb(entry)),
  onStats: cb => ipcRenderer.on('control:stats', (_e, stats) => cb(stats))
})
