import dns from 'node:dns/promises'
import net from 'node:net'
import axios from 'axios'

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
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) return { ok: false, reason: '拒绝访问私有或回环 IP 地址' }
    return { ok: true }
  }
  try {
    const addrs = await dns.lookup(hostname, { all: true })
    if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, reason: '域名无法解析' }
    for (const a of addrs) {
      if (isPrivateIp(a.address)) return { ok: false, reason: '域名解析到私有或回环地址，拒绝访问' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'DNS 解析失败或被阻止' }
  }
}

/**
 * Safe fetch that validates each URL (including redirect targets) before requesting.
 * Returns { ok: true, response, finalUrl } on success or { ok: false, error } on failure.
 */
export async function safeFetchWithRedirects(origUrl, opts = {}, maxRedirects = 3) {
  let current = origUrl
  let redirects = 0
  while (true) {
    const check = await isAllowedOutboundUrl(current).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
    if (!check.ok) return { ok: false, error: check.reason || '拒绝访问该 URL' }
    // Ensure we don't let fetch auto-redirect
    const fetchOpts = { ...(opts || {}), redirect: 'manual' }
    let resp
    try {
      resp = await fetch(current, fetchOpts)
    } catch (err) {
      return { ok: false, error: err.message || String(err) }
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (!loc) return { ok: false, error: `HTTP ${resp.status}` }
      const next = new URL(loc, current).toString()
      redirects += 1
      if (redirects > maxRedirects) return { ok: false, error: '重定向次数过多' }
      // validate next before following
      const chk2 = await isAllowedOutboundUrl(next).catch(() => ({ ok: false, reason: '重定向目标 URL 校验失败' }))
      if (!chk2.ok) return { ok: false, error: chk2.reason || '拒绝重定向目标' }
      // follow to next
      current = next
      continue
    }
    return { ok: true, response: resp, finalUrl: current }
  }
}

/**
 * Safe axios request that validates redirect targets. options similar to axios.request
 * Returns axios response on success or throws Error on failure
 */
export async function safeAxiosRequest(method, url, data = null, opts = {}, maxRedirects = 3) {
  let current = url
  let redirects = 0
  while (true) {
    const check = await isAllowedOutboundUrl(current).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
    if (!check.ok) throw new Error(check.reason || '拒绝访问该 URL')
    try {
      const conf = Object.assign({}, opts, { method, url: current, data, maxRedirects: 0, validateStatus: () => true })
      const resp = await axios.request(conf)
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers?.location
        if (!loc) throw new Error(`HTTP ${resp.status}`)
        const next = new URL(loc, current).toString()
        redirects += 1
        if (redirects > maxRedirects) throw new Error('重定向次数过多')
        const chk2 = await isAllowedOutboundUrl(next).catch(() => ({ ok: false, reason: '重定向目标 URL 校验失败' }))
        if (!chk2.ok) throw new Error(chk2.reason || '拒绝重定向目标')
        current = next
        continue
      }
      return resp
    } catch (err) {
      throw err
    }
  }
}
