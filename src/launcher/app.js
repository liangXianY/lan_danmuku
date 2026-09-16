'use strict';

;(function () {
  document.getElementById('pickHost').addEventListener('click', () => {
    window.launcherApi.choose('host')
  })
  document.getElementById('pickJoin').addEventListener('click', () => {
    window.launcherApi.choose('join')
  })
})()
