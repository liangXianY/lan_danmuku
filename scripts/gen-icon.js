'use strict'

/**
 * 生成应用图标。
 * 刻意不引任何图形库：一个 512×512 的图标用不着装 sharp / canvas，
 * 手写一个最小 PNG 编码器不到 80 行，还省掉了原生模块编译的麻烦。
 *
 *   node scripts/gen-icon.js
 *
 * 产出：assets/icon.png（托盘与窗口用）、build/icon.png（electron-builder 打包用）
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ------------------------------------------------------------------ PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng (width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ------------------------------------------------------------------ 图形

const TEAL = [15, 110, 86]
const AMBER = [239, 159, 39]
const WHITE = [255, 255, 255]
const CLEAR = [0, 0, 0, 0]

/** 圆角矩形的有符号距离：<0 在内部 */
function sdRoundRect (px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r)
  const qy = Math.abs(py - cy) - (halfH - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/**
 * 在 size×size 上绘制图标。
 * SUPERSAMPLE 倍超采样后取平均，边缘就自然抗锯齿了，不用手写 coverage。
 */
function render (size, supersample) {
  const S = size * supersample
  const buf = Buffer.alloc(S * S * 4)

  const inset = 0.055
  const radius = 0.225

  // 三条弹幕轨道：长度错落，中间那条用琥珀色点缀
  const bars = [
    { y: 0.325, x0: 0.20, x1: 0.80, color: WHITE },
    { y: 0.50, x0: 0.285, x1: 0.715, color: AMBER },
    { y: 0.675, x0: 0.20, x1: 0.615, color: WHITE }
  ]

  for (let y = 0; y < S; y++) {
    const ny = (y + 0.5) / S
    for (let x = 0; x < S; x++) {
      const nx = (x + 0.5) / S

      const inBody = sdRoundRect(nx, ny, 0.5, 0.5, 0.5 - inset, 0.5 - inset, radius) <= 0
      if (!inBody) continue

      let color = TEAL
      for (const bar of bars) {
        const cx = (bar.x0 + bar.x1) / 2
        const halfW = (bar.x1 - bar.x0) / 2
        const halfH = 0.045
        if (sdRoundRect(nx, ny, cx, bar.y, halfW, halfH, halfH) <= 0) {
          color = bar.color
          break
        }
      }

      const o = (y * S + x) * 4
      buf[o] = color[0]
      buf[o + 1] = color[1]
      buf[o + 2] = color[2]
      buf[o + 3] = 255
    }
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4)
  const n = supersample * supersample
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const o = ((y * supersample + sy) * S + (x * supersample + sx)) * 4
          const alpha = buf[o + 3]
          // 按 alpha 加权，否则透明区会把颜色拉灰
          r += buf[o] * alpha
          g += buf[o + 1] * alpha
          b += buf[o + 2] * alpha
          a += alpha
        }
      }
      const o = (y * size + x) * 4
      if (a === 0) {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0
      } else {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round(a / n)
      }
    }
  }

  return out
}

// ------------------------------------------------------------------ 主流程

const root = path.join(__dirname, '..')
const targets = [
  path.join(root, 'assets', 'icon.png'),
  path.join(root, 'build', 'icon.png')
]

const SIZE = 512
const png = encodePng(SIZE, SIZE, render(SIZE, 4))

for (const file of targets) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, png)
  console.log(`已生成 ${path.relative(root, file)}  (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`)
}

// 托盘图标要小尺寸，单独存一份省得运行时缩放发虚
const small = encodePng(32, 32, render(32, 8))
const trayFile = path.join(root, 'assets', 'tray.png')
fs.writeFileSync(trayFile, small)
console.log(`已生成 assets/tray.png  (32×32, ${(small.length / 1024).toFixed(1)} KB)`)

// Windows 安装包需要 .ico：把 256×256 的 PNG 直接封装进 ICO 容器
// （Vista+ 原生支持 PNG 压缩的 ICO，免掉手写 BMP/DIB 编码）
const png256 = encodePng(256, 256, render(256, 4))
const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // 图像数量
// ICONDIRENTRY 从偏移 6 开始，字段是紧凑排布的：
// width(1) height(1) colorCount(1) reserved(1) planes(2) bitCount(2) bytesInRes(4) offset(4)
header.writeUInt8(0, 6) // width: 256 用 0 表示
header.writeUInt8(0, 7) // height: 同上
header.writeUInt8(0, 8) // 调色板色数
header.writeUInt8(0, 9) // reserved
header.writeUInt16LE(1, 10) // color planes
header.writeUInt16LE(32, 12) // bits per pixel
header.writeUInt32LE(png256.length, 14) // 图像数据长度
header.writeUInt32LE(22, 18) // 数据偏移 = 6(ICONDIR) + 16(ICONDIRENTRY)
const icoFile = path.join(root, 'build', 'icon.ico')
fs.writeFileSync(icoFile, Buffer.concat([header, png256]))
console.log(`已生成 build/icon.ico  (256×256, ${(png256.length / 1024).toFixed(1)} KB)`)
