'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** 弹幕层唯一的对外通道，保持最小暴露面 */
contextBridge.exposeInMainWorld('overlayBridge', {
  /** 通知主进程弹幕层已就绪，主进程随后会推配置和历史 */
  ready: () => ipcRenderer.send('overlay:ready'),

  onInit: cb => ipcRenderer.on('overlay:init', (_e, payload) => cb(payload)),
  onDanmaku: cb => ipcRenderer.on('overlay:danmaku', (_e, item) => cb(item)),
  onClear: cb => ipcRenderer.on('overlay:clear', () => cb()),
  onPause: cb => ipcRenderer.on('overlay:pause', () => cb()),
  onResume: cb => ipcRenderer.on('overlay:resume', () => cb()),
  onConfig: cb => ipcRenderer.on('overlay:config', (_e, cfg) => cb(cfg)),

  /** 上报渲染侧健康度，控制台用来显示"渲染是否正常" */
  report: payload => ipcRenderer.send('overlay:report', payload)
})
