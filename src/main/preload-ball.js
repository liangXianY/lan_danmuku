'use strict';

const { contextBridge, ipcRenderer } = require('electron')

/** 桌宠窗口的对外通道 —— 只暴露必要动作，渲染进程碰不到 Node */
contextBridge.exposeInMainWorld('ballApi', {
  getState: () => ipcRenderer.invoke('ball:get-state'),

  /** 展开 / 收起（主进程负责改窗口尺寸，改完回调通知渲染层切视图） */
  expand: () => ipcRenderer.invoke('ball:expand'),
  collapse: () => ipcRenderer.invoke('ball:collapse'),
  hide: () => ipcRenderer.invoke('ball:hide'),

  /** 发言：resolve 表示主机已回 ACK，reject(Error) 带失败原因 */
  send: payload => ipcRenderer.invoke('ball:send', payload),

  /** 身份：昵称 + 匿名（打开发送之前就定好，之后每次发言直接用） */
  setIdentity: patch => ipcRenderer.invoke('ball:set-identity', patch),
  setColor: color => ipcRenderer.invoke('ball:set-color', color),

  /** 房间口令：连上口令服务器时在面板里直接填，不用断开重连 */
  setToken: token => ipcRenderer.invoke('ball:set-token', token),

  /** 拖动小球：按住移动时逐个增量上报，松手才落盘记住位置 */
  dragStart: () => ipcRenderer.send('ball:drag-start'),
  drag: (dx, dy) => ipcRenderer.send('ball:drag', { dx, dy }),
  dragEnd: () => ipcRenderer.send('ball:drag-end'),

  onMode: cb => ipcRenderer.on('ball:mode', (_e, payload) => cb(payload)),
  onState: cb => ipcRenderer.on('ball:state', (_e, payload) => cb(payload)),
  /** 口令校验结果（填错时主进程主动推）：{ ok: false, msg } */
  onTokenResult: cb => ipcRenderer.on('ball:token-result', (_e, payload) => cb(payload || {})),
  /** 有弹幕上屏时通知桌宠（它挥个手） */
  onDanmaku: cb => ipcRenderer.on('ball:danmaku', (_e, item) => cb(item))
})
