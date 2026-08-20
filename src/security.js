import dns from 'node:dns/promises'
import net from 'node:net'

function isPrivateIp(ip) {
  if (!ip) return false
  const v = net.isIP(ip)
  if (v === 4) {
    if (ip === '127.0.0.1') return true
    if (ip.startsWith('10.')) return true
    if (ip.startsWith('192.168.')) return true
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true
    if (ip.startsWith('169.254.')) return true
    return false
  }
  if (v === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    return false
  }
  return false
}

export async function isAllowedOutboundUrl(u) {
  if (!u || typeof u !== 'string') return { ok: false, reason: '非法 URL' }
  let parsed
  try {
    parsed = new URL(u)
  } catch (err) {
    return { ok: false, reason: '无法解析的 URL' }
  }
  const hostname = parsed.hostname
  // If hostname is IP literal
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return { ok: false, reason: '拒绝访问私有或回环 IP 地址' }
    return { ok: true }
  }

  // hostname is a domain — resolve to all addresses and ensure none are private
  try {
    const addrs = await dns.lookup(hostname, { all: true })
    if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, reason: '域名无法解析' }
    for (const a of addrs) {
      if (isPrivateIp(a.address)) return { ok: false, reason: '域名解析到私有或回环地址，拒绝访问' }
    }
    return { ok: true }
  } catch (err) {
    // DNS lookup may fail for various reasons; treat as disallowed to be safe
    return { ok: false, reason: 'DNS 解析失败或被阻止' }
  }
}
