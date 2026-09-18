'use strict'
/**
 * 智能打包脚本：绕过火绒实时扫描间歇性锁死 electron 解包的问题。
 *
 * 逐形态串行打包；打包期间每 10s 采样 win-unpacked 目录，
 * 连续 4 次无变化判定卡死 → taskkill 杀进程树 → 清半成品 → 重试。
 * 每形态最多重试 4 次；dist/<variant>/ 出现当前版本且 >10MB 的 exe 视为成功。
 *
 * 用法：node scripts/build-smart.js [host|join|all ...]（缺省三形态全打）
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = 'D:/lan-danmaku'
const DIST = path.join(ROOT, 'dist')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const VARIANTS = process.argv.slice(2).length ? process.argv.slice(2) : ['host', 'join', 'all']
const MAX_TRIES = 4
const SAMPLE_MS = 10000
const STALE_SAMPLES = 4

function log (...args) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...args)
}

function dirSize (d) {
  let files = 0
  let bytes = 0
  ;(function walk (dir) {
    let list
    try { list = fs.readdirSync(dir) } catch (e) { return }
    for (const f of list) {
      const p = path.join(dir, f)
      let st
      try { st = fs.statSync(p) } catch (e) { continue }
      if (st.isDirectory()) walk(p)
      else { files++; bytes += st.size }
    }
  })(d)
  return { files, bytes }
}

function exeDone (variant) {
  try {
    return fs.readdirSync(path.join(DIST, variant))
      .some(f => f.endsWith('.exe') && f.includes(VERSION) &&
        // NSIS 生成 exe 是先建文件再慢慢写入：半成品可能只有几百 KB，
        // 必须加大小下限，否则安装器刚落笔就被误判"完成"
        fs.statSync(path.join(DIST, variant, f)).size > 10 * 1024 * 1024)
  } catch (e) { return false }
}

function cleanUnpacked (variant) {
  try { fs.rmSync(path.join(DIST, variant, 'win-unpacked'), { recursive: true, force: true }) } catch (e) { /* ignore */ }
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

/** 打包一次；resolve('done') 成功 | resolve('stuck') 卡死被杀 | resolve('exit') 进程退出未成功 */
function buildOnce (variant) {
  return new Promise(resolve => {
    log(`${variant}: 启动 electron-builder（第 ? 次尝试内）`)
    const child = spawn(process.execPath, ['node_modules/electron-builder/cli.js', '--win', '--config', `build/${variant}.yml`], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
        ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })

    // exe 出现只是"半程"：NSIS 还在写文件 + 收尾。提前 resolve 会让父进程
    // 退出时孤儿化安装器，留下几百 KB 的半成品 exe（0.5.4 all 形态踩过）。
    // 所以 exe 命中后只标记，真正完成以安装器进程自然退出为准。
    let exeSeen = false
    let exeSeenAt = 0
    let stale = 0
    let last = null
    const watcher = setInterval(() => {
      if (!exeSeen && exeDone(variant)) {
        exeSeen = true
        exeSeenAt = Date.now()
        log(`${variant}: 目标 exe 已出现，等安装器进程收尾…`)
        return
      }
      if (exeSeen) {
        // 收尾阶段不再判卡死；90s 还不退出就兜底放行（exe 大小已校验过）
        if (Date.now() - exeSeenAt > 90000) {
          clearInterval(watcher)
          resolve('done')
        }
        return
      }
      let cur = null
      try { cur = dirSize(path.join(DIST, variant, 'win-unpacked')) } catch (e) { cur = null }
      const sig = cur ? `${cur.files}:${cur.bytes}` : 'none'
      if (last === sig) stale++
      else stale = 0
      last = sig
      if (stale >= STALE_SAMPLES) {
        clearInterval(watcher)
        log(`${variant}: 疑似卡死（${STALE_SAMPLES} 次采样无变化，状态 ${sig}），杀进程重试`)
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch (e) { /* ignore */ }
        setTimeout(() => resolve('stuck'), 3000)
      }
    }, SAMPLE_MS)

    child.on('exit', code => {
      clearInterval(watcher)
      if (exeDone(variant)) return resolve('done')
      log(`${variant}: 进程退出 code=${code}，未产出 exe`)
      log(out.slice(-500))
      resolve('exit')
    })
  })
}

;(async () => {
  const results = {}
  for (const variant of VARIANTS) {
    let ok = false
    for (let attempt = 1; attempt <= MAX_TRIES && !ok; attempt++) {
      log(`=== ${variant} 第 ${attempt}/${MAX_TRIES} 次尝试 ===`)
      cleanUnpacked(variant)
      const r = await buildOnce(variant)
      ok = r === 'done'
      results[variant] = ok ? 'ok' : `fail(${r})`
      if (ok) log(`${variant}: ✓ 打包完成`)
      else if (attempt === MAX_TRIES) log(`${variant}: ✗ ${MAX_TRIES} 次均失败，放弃`)
    }
  }
  log('==== 汇总 ====')
  for (const v of VARIANTS) log(`${v}: ${results[v] || 'skip'}`)
  process.exit(Object.values(results).every(r => r === 'ok') ? 0 : 1)
})()
