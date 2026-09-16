'use strict'

const os = require('os')

/** 虚拟网卡特征词 —— 有线局域网场景下要把它们排到后面 */
const VIRTUAL_HINTS = [
  'vmware', 'virtualbox', 'vethernet', 'hyper-v', 'loopback',
  'docker', 'wsl', 'tap', 'tun', 'npcap', 'bluetooth',
  'zerotier', 'tailscale', 'radmin', 'virtual'
]

/** 有线网卡特征词 —— 排到前面，用户的场景就是网线直连/交换机 */
const WIRED_HINTS = ['eth', 'en', 'ethernet', '以太网', '本地连接', 'local area']

function isPrivateIPv4 (ip) {
  const p = String(ip).split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (p[0] === 10) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  // 169.254.x.x 是拿不到 DHCP 时的自分配地址，连不通
  return false
}

function matchHint (name, hints) {
  const n = String(name).toLowerCase()
  return hints.some(h => n.includes(h))
}

/**
 * 枚举本机可用的私网 IPv4，按"有线 > 无线 > 虚拟"排序。
 * 同一台机器插网线又开 WiFi 时，默认取到有线那个。
 */
function listLocalIPv4 () {
  const out = []
  const ifaces = os.networkInterfaces()

  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue
      if (addr.internal) continue
      if (!isPrivateIPv4(addr.address)) continue
      out.push({
        name,
        address: addr.address,
        virtual: matchHint(name, VIRTUAL_HINTS),
        wired: matchHint(name, WIRED_HINTS)
      })
    }
  }

  out.sort((a, b) => {
    // 1. 非虚拟优先
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1
    // 2. 有线优先
    if (a.wired !== b.wired) return a.wired ? -1 : 1
    // 3. 192.168 段优先（办公/家用局域网最常见）
    const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)
    if (rank(a.address) !== rank(b.address)) return rank(a.address) - rank(b.address)
    return a.name.localeCompare(b.name)
  })

  return out
}

/** 网段前缀，用于在界面上提示"发送端必须在同一网段" */
function subnetOf (ip) {
  const p = String(ip).split('.')
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : ''
}

module.exports = { listLocalIPv4, isPrivateIPv4, subnetOf }
