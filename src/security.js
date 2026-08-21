import dns from 'node:dns/promises'
import net from 'node:net'

/**
 * 判断 IP 是否为私有/回环/链路本地/保留地址（SSRF 防护用）。
 * 使用纯数字位运算，覆盖 IPv4 与 IPv6 的规范形式及 IPv4-mapped IPv6。
 *
 * IPv4 覆盖：0/8 保留、10/8 私有、100.64/10 CGNAT、127/8 回环、
 * 169.254/16 链路本地、172.16/12 私有、192.0.0/24 保留、
 * 192.168/16 私有、198.18/15 基准测试、224/4 组播、240/4 保留。
 *
 * IPv6 覆盖：:: 未指定、::1 回环、::ffff:x.x.x.x 与 ::ffff:xxxx:xxxx
 * IPv4-mapped（解包转 IPv4 判断）、fc00::/7 ULA、fe80::/10 链路本地、
 * ff00::/8 组播。
 */
function isPrivateIp(ip) {
  if (!ip) return false
  const v = net.isIP(ip)
  if (v === 4) return isPrivateIpv4(ip)
  if (v === 6) return isPrivateIpv6(ip)
  return false
}

function parseIpv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const a = +m[1], b = +m[2], c = +m[3], d = +m[4]
  if (a > 255 || b > 255 || c > 255 || d > 255) return null
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

function isPrivateIpv4(ip) {
  const n = parseIpv4(ip)
  if (n == null) return true // 非法格式一律拒绝（fail-closed）
  const inNet = (base, maskLen) => {
    const mask = maskLen === 0 ? 0 : (~0 << (32 - maskLen)) >>> 0
    return (n & mask) === (base & mask)
  }
  if (inNet(0x00000000, 8)) return true     // 0.0.0.0/8 保留
  if (inNet(0x0A000000, 8)) return true     // 10.0.0.0/8 私有
  if (inNet(0x64400000, 10)) return true    // 100.64.0.0/10 CGNAT
  if (inNet(0x7F000000, 8)) return true     // 127.0.0.0/8 回环
  if (inNet(0xA9FE0000, 16)) return true    // 169.254.0.0/16 链路本地
  if (inNet(0xAC100000, 12)) return true    // 172.16.0.0/12 私有
  if (inNet(0xC0000000, 24)) return true    // 192.0.0.0/24 IETF 保留
  if (inNet(0xC0A80000, 16)) return true    // 192.168.0.0/16 私有
  if (inNet(0xC6120000, 15)) return true    // 198.18.0.0/15 基准测试
  if ((n >>> 28) >= 0b1110) return true     // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
  return false
}

/** 把 IPv6 后 32 位（两个 16 位段）转成 IPv4 字符串 */
function v6TailToIpv4(hexSegs) {
  if (hexSegs.length !== 2) return null
  const h0 = hexSegs[0], h1 = hexSegs[1]
  if (typeof h0 !== 'number' || typeof h1 !== 'number') return null
  if (h0 < 0 || h0 > 0xffff || h1 < 0 || h1 > 0xffff) return null
  return `${h0 >> 8}.${h0 & 0xff}.${h1 >> 8}.${h1 & 0xff}`
}

function isPrivateIpv6(ip) {
  const l = ip.toLowerCase()
  if (l === '::') return true                                     // 未指定
  if (l === '::1' || l === '0:0:0:0:0:0:0:1') return true         // 回环
  // IPv4-mapped：::ffff:a.b.c.d / 0:0:0:0:0:ffff:a.b.c.d
  let m4 = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || l.match(/^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (m4) return isPrivateIpv4(m4[1])
  // IPv4-mapped 十六进制：::ffff:7f00:1 / 0:0:0:0:0:ffff:7f00:1
  let mh = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) || l.match(/^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mh) {
    const ipv4 = v6TailToIpv4([parseInt(mh[1], 16), parseInt(mh[2], 16)])
    if (ipv4) return isPrivateIpv4(ipv4)
    return true // 无法解析的 ::ffff 形式，fail-closed
  }
  if (l.startsWith('fc') || l.startsWith('fd')) return true        // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]/.test(l)) return true                     // fe80::/10 链路本地
  if (l.startsWith('ff')) return true                              // ff00::/8 组播
  return false
}

/**
 * 校验出站 URL 是否允许访问（SSRF 防护）。
 * 返回 { ok: true } 或 { ok: false, reason }。
 *
 * 注意：校验与实际请求是两次独立 DNS 解析，存在 DNS rebinding 的
 * TOCTOU 窗口（攻击者可在校验后切换 DNS 记录指向内网）。对高安全
 * 场景，应改为解析后直接连接 IP 并固定 Host 头，此处为尽力而为。
 */
export async function isAllowedOutboundUrl(u) {
  if (!u || typeof u !== 'string') return { ok: false, reason: '非法 URL' }
  let parsed
  try {
    parsed = new URL(u)
  } catch (err) {
    return { ok: false, reason: '无法解析的 URL' }
  }
  // 浏览器风格 URL 中 IPv6 hostname 带方括号（如 [::1]），net.isIP 对
  // 带括号形式返回 0，需剥离括号后再判定，否则会误走 DNS 分支。
  const rawHost = parsed.hostname
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost

  const v = net.isIP(hostname)
  if (v === 4 || v === 6) {
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
