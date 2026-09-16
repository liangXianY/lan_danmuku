'use strict';

const { contextBridge, ipcRenderer } = require('electron')

/** 模式选择窗口的对外通道 */
contextBridge.exposeInMainWorld('launcherApi', {
  choose: mode => ipcRenderer.send('launcher:choose', mode)
})
