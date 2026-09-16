'use strict';

/**
 * 打包产物自检：不启动 GUI，直接检查 app.asar 里的 package.json
 * 是否带上了预期的 appMode（主机版=host / 加入版=join）。
 *
 * 用法：node scripts/verify-package.js dist/host host
 *
 * 为什么要这么查：模式锁靠 electron-builder 的 extraMetadata 注入 package.json，
 * 一旦配置写错（比如 extraMetadata 放错层级），安装包会变回"双模式 + 弹启动选择窗"，
 * 而这种退化在解包目录里肉眼看不出来，只能读 asar。
 */
const fs = require('fs')
const path = require('path')

const dir = process.argv[2] || 'release/host'
const expect = process.argv[3] || 'host'

const unpacked = path.join(dir, 'win-unpacked')
const asar = path.join(unpacked, 'resources', 'app.asar')

const out = []
let failures = 0

function check (name, ok, detail = '') {
  if (!ok) failures++
  out.push(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? '  → ' + detail : ''}`)
}

if (!fs.existsSync(unpacked)) {
  console.log(`找不到解包目录：${unpacked}`)
  process.exit(1)
}

const exes = fs.readdirSync(unpacked).filter(f => f.endsWith('.exe'))
check('解包目录里有可执行文件', exes.length > 0, exes.join(', '))

if (!fs.existsSync(asar)) {
  check('存在 app.asar', false, asar)
  console.log(out.join('\n'))
  process.exit(1)
}
check('存在 app.asar', true)

// asar 只是简单的归档容器，文件内容原样存放，所以直接按字节搜索即可。
// 注意 electron-builder 写 package.json 是带缩进的，冒号后面可能有空格，
// 所以用正则匹配而不是精确字符串。
const buf = fs.readFileSync(asar)
const text = buf.toString('utf8')

const re = new RegExp(`"appMode"\\s*:\\s*"${expect}"`)
const m = re.exec(text)
check('app.asar 内注入了 appMode', /"appMode"/.test(text))

if (m) {
  check(`appMode 值为 ${expect}`, true, text.slice(m.index, m.index + 40).replace(/[\x00-\x1f]/g, '').trim())
} else {
  const any = /"appMode"\s*:\s*"(\w+)"/.exec(text)
  check(`appMode 值为 ${expect}`, false, any ? `实际是 ${any[1]}` : '没找到 appMode 字段')
}

// 服务端代码不该跑进加入版（虽然同仓库，但加入版理论上是纯客户端）
const hasServer = text.includes('DanmakuServer')
out.push(`  [INFO] asar 内含 DanmakuServer 代码：${hasServer ? '是' : '否'}`)

// 悬浮球资源是最容易"漏进去"的一类：页面在 src/ball/ 下，
// files 白名单一旦写窄，开发态一切正常、装完点球没反应。
//
// 注意：asar 的头部是**目录树 JSON**，文件名是分开存的，
// 所以不能像查 package.json 那样在整块字节里搜 "ball/index.html"（永远搜不到）。
// 必须用 asar 库把文件清单列出来再比对。
let entryList = []
try {
  const asarLib = require('@electron/asar')
  entryList = asarLib
    .listPackage(asar)
    .map(p => p.replace(/\\/g, '/').replace(/^\//, ''))
} catch (err) {
  out.push(`  [INFO] 无法列出 asar 文件清单：${err.message}`)
}

const hasEntry = p => entryList.includes(p)
check('asar 内含桌宠页面', hasEntry('src/ball/index.html'), `清单 ${entryList.length} 项`)
check('asar 内含桌宠脚本', hasEntry('src/ball/ball.js'))
check('asar 内含桌宠样式', hasEntry('src/ball/ball.css'))
check('asar 内含桌宠预加载', hasEntry('src/main/preload-ball.js'))
check('asar 内含桌宠帧图（idle）', hasEntry('assets/pet/row-idle.png'))
check('asar 内含桌宠帧图（failed）', hasEntry('assets/pet/row-failed.png'))
check('asar 内含加入窗口脚本', hasEntry('src/join/app.js'))

// 发行产物
const artifacts = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => f.endsWith('.exe') || f.endsWith('.blockmap'))
  : []
out.push(`  [INFO] 构建产物：${artifacts.length ? artifacts.join(', ') : '（无，可能只跑了 --dir）'}`)

console.log(`\n== 校验 ${dir} （期望模式 ${expect}）==`)
console.log(out.join('\n'))
console.log(failures === 0 ? '\n结果：全部通过\n' : `\n结果：${failures} 项失败\n`)
process.exit(failures === 0 ? 0 : 1)
