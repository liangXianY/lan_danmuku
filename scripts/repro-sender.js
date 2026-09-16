'use strict';

// 用本机 Chrome 复现发送页问题：抓 console 报错、失败请求、最终截图
const path = require('path')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = process.argv[2] || 'http://192.168.11.26:7321/'

async function main () {
  const { chromium } = require('playwright-core')
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  })
  const page = await browser.newPage()

  const logs = []
  page.on('console', m => logs.push(`[console.${m.type()}] ${m.text()}`))
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`))
  page.on('requestfailed', r => logs.push(`[requestfailed] ${r.url()} :: ${r.failure() && r.failure().errorText}`))
  page.on('response', r => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`) })

  await page.goto(URL, { waitUntil: 'load', timeout: 15000 })
  await page.waitForTimeout(5000) // 给 WS 握手和渲染留时间

  const state = await page.evaluate(() => {
    const g = id => { const el = document.getElementById(id); return el ? el.textContent.trim() : null }
    return {
      title: document.title,
      sheets: document.styleSheets.length,
      statusText: g('status') || g('statusTitle'),
      sendBtnDisabled: (document.getElementById('send') || {}).disabled,
      recentCount: document.querySelectorAll('#recent li').length,
      bodySnapshot: document.body.className
    }
  })

  console.log(JSON.stringify({ url: URL, state, logs }, null, 2))

  await page.screenshot({ path: path.join(__dirname, '..', 'sender-repro.png'), fullPage: false })
  console.log('screenshot saved: sender-repro.png')

  // 再实测一次 WS 能否在浏览器环境里建立
  const wsTest = await page.evaluate(() => new Promise(resolve => {
    try {
      const ws = new WebSocket('ws://192.168.11.26:7321')
      const t = setTimeout(() => { resolve('TIMEOUT'); ws.close() }, 5000)
      ws.onopen = () => { clearTimeout(t); resolve('OPEN'); ws.close() }
      ws.onerror = () => { clearTimeout(t); resolve('ERROR') }
    } catch (e) { resolve('EXCEPTION: ' + e.message) }
  }))
  console.log('ws_test_from_browser=' + wsTest)

  await browser.close()
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
