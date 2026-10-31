import https from 'node:https'
import crypto, { X509Certificate } from 'node:crypto'
import { safeLogger, sanitizeLog } from './globals.js'

export const OFFICIAL_KIND = 'official'
export const CUSTOM_KIND = 'custom'
export const OFFICIAL_HOST = 'api.djyun.click'
export const OFFICIAL_API_BASE = 'https://api.djyun.click/v1'
export const OFFICIAL_DISPLAY_NAME = '官方API'
export const OFFICIAL_KEY_PREFIX = 'official'
export const OFFICIAL_REGISTER_PATH = '/plugin/register'
export const OFFICIAL_ASSOCIATE_PATH = '/plugin/associate'
export const OFFICIAL_PLUGIN_NAME = 'ai0-plugin'

function normalizeHostname(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/^\[|\]$/g, '')
}

/**
 * 目标主机是否为官方合作方域名。
 * 精确匹配（2026-10 安全审计 P1）：不再放宽任何子域，避免 *.api.djyun.click
 * 被第三方注册后继承"跳过证书校验"的特权。
 */
export function isOfficialHost(hostname) {
  return normalizeHostname(hostname) === OFFICIAL_HOST
}

/* -------------------------------------------------------------------------- */
/*              官方域名 TLS 证书钉扎（2026-10 安全审计 P1）                   */
/* -------------------------------------------------------------------------- */
// 背景：官方 API 历史上只下发叶子证书、不下发中间证书，标准信任链无法构建，旧实现对
// api.djyun.click 及其所有子域无条件 rejectUnauthorized:false，任何持有该域证书的
// 中间人都可解密流量。现改为：
//   - 仅精确主机放宽 CA 链校验（链不完整，无法用系统信任库）；
//   - 但强制校验证书公钥钉扎：叶子 SPKI 命中已知指纹列表，或叶子由固定的
//     Let's Encrypt YR1/YR2 中间证书真实签发（容忍官方叶子轮换）。二者皆不满足即中止连接。
// 轮换记录：2026-10-11 官方 CDN 将叶子证书由 YR2 签发的旧叶子轮换为 YR1 签发的新叶子
//   （有效期内 SPKI 见下），部分边缘线路可能仍回源旧证书，故新旧指纹同时保留；
//   YR1 中间证书取自 2026-10-17 边缘实链（leaf checkIssued/verify 均通过）。
// 说明：这是 fail-closed 设计——若官方更换 CA/中间证书或改用新密钥，连接会被拒绝，
//       需同步更新下方指纹/中间证书（诊断日志会打印实际观测值，便于比对）。
const OFFICIAL_LEAF_SPKI_SHA256_PINS = [
  'rK/jlci9a5PbYu1mBdnIImXuG6illDiL9MbpIW4rNXg=', // 2026-10-11 轮换后的当前 CDN 叶子（LE YR1 签发）
  'wHjGum84n4Qt1hwIbGu3/zU8IKrtU/1sh2RQb10NUXU=', // 2026-10-11 轮换前的旧叶子（LE YR2 签发），容忍边缘灰度
]
const OFFICIAL_INTERMEDIATE_YR1_PEM = `-----BEGIN CERTIFICATE-----
MIIE2zCCAsOgAwIBAgIRAKICU/FfJpHAXcHOE7m8yk4wDQYJKoZIhvcNAQELBQAw
LjELMAkGA1UEBhMCVVMxDTALBgNVBAoTBElTUkcxEDAOBgNVBAMTB1Jvb3QgWVIw
HhcNMjUwOTAzMDAwMDAwWhcNMjgwOTAyMjM1OTU5WjAzMQswCQYDVQQGEwJVUzEW
MBQGA1UEChMNTGV0J3MgRW5jcnlwdDEMMAoGA1UEAxMDWVIxMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoVi8X2xCYgMXvJxNPKp/oF13UMgmPABB07VC
LNDtoXmt9luEZNJSBV10VyT1Pz6LD8Zq1d2gc43WNl1AdRrj4sEnazbOiz0nPpmG
Bp2hui49oZtDIY6wdKeZAi5BbNU20CH6RSBBMLSQ9cXrH8dxdv4PAJ45ssGML68U
SE3BsjC2a6cAN9L5CgXVIQi5tfNiTPoFZZ3S0OlXqLmmtdV95udWAb5b6e/F49Di
CsH0Y00Ag72BVIb1hzynmKe+X0mERBTtsb3BwmpV9ipeBjMLoR/D9cHxHQCWoi5l
TmXwY015J5rGelz1nZjJuxc2kioaX29XJBnhMkP531rSdG5uMwIDAQABo4HuMIHr
MA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEFBQcDATASBgNVHRMBAf8E
CDAGAQH/AgEAMB0GA1UdDgQWBBQfLzW+RhSCzUCxrnksVXj699Ro+zAfBgNVHSME
GDAWgBTe51tg0CJtQCh9Pw0B/qS1UrRRlDAyBggrBgEFBQcBAQQmMCQwIgYIKwYB
BQUHMAKGFmh0dHA6Ly95ci5pLmxlbmNyLm9yZy8wEwYDVR0gBAwwCjAIBgZngQwB
AgEwJwYDVR0fBCAwHjAcoBqgGIYWaHR0cDovL3lyLmMubGVuY3Iub3JnLzANBgkq
hkiG9w0BAQsFAAOCAgEA0+zvMq3kHig1ddTmmm+RibTr9/RpX7k4buanMMRqbV/y
IvP82zAHN3mvaw+cASuVsdpd0ikjhr4hnhJQLQOzOp2ccKrsdGOAgo0vddeISFAq
EWEV4lmUM3vFF796up+bSgmJ1u6RupDCMxDgF8M3eLvGuj6L0lu3zkQ0KuQLnKxL
tB0oQqn1Idg5CuuGpMvQzk29Pa3D/qHurc0EIM9SxukQuJqq63lxsYyRQFU8yMBO
hq1w5LbfaWNRrz1uklOfI/pYkAb2E2MTZrAMQkBIE2S8Jt1F8gRc96o/xOsrgvSk
a84AisX6xq1lz1Z7jGvrnXc4TMcjxZTjiTaihcYI1JIXZiLtEMSCa5l3cu8YWd6z
dLRQlqRdclVjuQfNHawRJ6GWlkK0QJosivTKwdBw3KxEtzGo8yMHERbsy57gP1UX
HOMcmZYQC0gtyR3SxfenIM/MxC3Ia2Ypab/kQ/CTnlIn2KQ5JUC6NYrGCbhFN9bp
5lKJStEwCUnLpntcrXk5XVDCNv/5RyWpRThkGOV7GetKkQ0qAY8hCzWK6oqnAhDZ
cjlYVdWfqOw3DIOX6EDNBgAqHarRVxyF9QZdOaXSyPJ0ueD2BYJEBgaCGQ8rAaU/
Qc123V5LTXDZW4CcsPBDyhy4v+c8hClAyw/IkJlfBqxB9D+/wvIMHgECZ4ptP6o=
-----END CERTIFICATE-----`
const OFFICIAL_INTERMEDIATE_YR2_PEM = `-----BEGIN CERTIFICATE-----
MIIE2jCCAsKgAwIBAgIQTr0klH4k05SALYSlL9WzGTANBgkqhkiG9w0BAQsFADAu
MQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZUjAe
Fw0yNTA5MDMwMDAwMDBaFw0yODA5MDIyMzU5NTlaMDMxCzAJBgNVBAYTAlVTMRYw
FAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZUjIwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQDZ0LxwBppqh84luqMerV/eeL/fXQ7mLQQv1Lnp
WKZbyvGpx6wh6AfnslAnF6ewTkcHA+gSOoBvm3Dfm06AuGiF+KRut4fAcowqnAQQ
CW98+QPP/eOv/wug7Iyk4NkOxf2I6g2f55T6nJoOTLFcukeRq80JGQEYan+dPFr9
OGUgQK2hGKgNkW87pappsOAuUJcroYhRt5uUis4qaZireiseu32gzDJNBAiKtsvd
6HX4v25bpkRNcS/B/Gtc9kVbUpD+2PLPxdei3Tim55k4tfAEXwD2qyiPTxrTNq6l
N+AMr5g2c1dNqkOTwjxeV6L5lpP1rGiYvLnRaPlOqyZRPW+5AgMBAAGjge4wgesw
DgYDVR0PAQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBIGA1UdEwEB/wQI
MAYBAf8CAQAwHQYDVR0OBBYEFEAVLSZ57TIgnt+ach3WMh+BDIEMMB8GA1UdIwQY
MBaAFN7nW2DQIm1AKH0/DQH+pLVStFGUMDIGCCsGAQUFBwEBBCYwJDAiBggrBgEF
BQcwAoYWaHR0cDovL3lyLmkubGVuY3Iub3JnLzATBgNVHSAEDDAKMAgGBmeBDAEC
ATAnBgNVHR8EIDAeMBygGqAYhhZodHRwOi8veXIuYy5sZW5jci5vcmcvMA0GCSqG
SIb3DQEBCwUAA4ICAQB0ZUQWZ9/Yn9COEpo+JfecMnB0h0vwDm/M66IqXqw3LoaL
mx9lZvRTeDIS67PUeI3yCA2W6PKRD0/FE/G57lOmS+Xy5AaaL00ICGOqjNcCaMWW
8o8nevHOd4i4lqgtznE/28QwlcdJyF8yBiWHpnyjhEpmNWJURgOCOg2xpwRMBCsj
MScqYPtOhBeuYQvSwAEeTML2Ukh6uGuX4E14q65Ja8cdjF5bAldnP1eE4FBaAwsZ
G2fOqqrKV03Y85Nw2btedP1AtliQuJZs/Jo/gXxXdc7LrH3McgnpnbTiAncX7yES
hP6kzQejllqMCIt52HOjxDGWafS7Xw+DKwqmH+Eqy8dcbOuag/1AYlQoKNVK3F5q
Hh6tEDiMqQcLIibGKteE6iHo4A/bIScbzrhXUYuism42ZYzmc48FMVIH3qy4L84E
TdAH2gtxw0PAhvRVXp8HP7wfngpzsN/8xOTpeRSbM4+Qbc56G6+Bifmv6sk1ieQb
NA3wJdl4DDUuQSV8hBgx6zoI1ZSGORprDFux7c6rhc77QZMSRrEgomBeklervEve
86ylWmZ3WWHV6RLMi8xNvjd71r4EPIGgY7BZU/VPBkq+uA7Gb6mbJnFgV43uh3xy
LRFgxIAphIukwTGSMZZR+AI+Qnp0BYTWovHXozOf3H8r6hozEoT02JHn0AeTfA==
-----END CERTIFICATE-----`
const OFFICIAL_SPKI_PINS = OFFICIAL_LEAF_SPKI_SHA256_PINS.map((p) => Buffer.from(p, 'base64'))
const OFFICIAL_INTERMEDIATE_PEMS = [OFFICIAL_INTERMEDIATE_YR1_PEM, OFFICIAL_INTERMEDIATE_YR2_PEM]
let _officialIntermediates = null
function officialIntermediates() {
  if (!_officialIntermediates) {
    _officialIntermediates = OFFICIAL_INTERMEDIATE_PEMS.map((pem) => new X509Certificate(pem))
  }
  return _officialIntermediates
}

/**
 * 对官方域名 TLS 对端 socket 做钉扎评估，返回各验证分支结果（供诊断日志与排障使用，
 * 见 docs/CERT_PINNING_FIX_20261017.md 方案一）。
 * pinned 为 true 当且仅当：叶子证书 SPKI 命中固定指纹，
 * 或叶子 SAN 精确覆盖官方域名且由固定 YR1/YR2 中间证书【真实签发】。
 */
export function evaluateOfficialPinning(socket) {
  const diag = {
    pinned: false,
    spkiMatched: false,
    sanMatched: false,
    issuerMatched: false,
    signatureVerified: false,
    spkiSha256: null,
    fingerprint256: null,
    pubkeyLen: null,
    subject: null,
    issuer: null,
    subjectaltname: null,
    error: null,
  }
  try {
    if (!socket || typeof socket.getPeerCertificate !== 'function') {
      diag.error = 'socket 未提供 getPeerCertificate'
      return diag
    }
    const cert = socket.getPeerCertificate(true)
    if (!cert || !cert.pubkey) {
      diag.error = '未取得对端证书或证书无 pubkey'
      return diag
    }
    const spki = Buffer.isBuffer(cert.pubkey) ? cert.pubkey : Buffer.from(cert.pubkey)
    diag.pubkeyLen = spki.length
    const digest = crypto.createHash('sha256').update(spki).digest()
    diag.spkiSha256 = digest.toString('base64')
    diag.fingerprint256 = cert.fingerprint256 || null
    diag.subject = cert.subject ? JSON.stringify(cert.subject) : null
    diag.issuer = cert.issuer ? JSON.stringify(cert.issuer) : null
    diag.subjectaltname = typeof cert.subjectaltname === 'string' ? cert.subjectaltname : null
    // 分支一：叶子 SPKI 钉扎
    diag.spkiMatched = OFFICIAL_SPKI_PINS.some(
      (pin) => digest.length === pin.length && crypto.timingSafeEqual(digest, pin),
    )
    // 分支二（SAN）：叶子必须精确覆盖官方域名，防御"合法 CA 签给别家域名"的证书
    if (diag.subjectaltname) {
      diag.sanMatched = diag.subjectaltname
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .includes(`dns:${OFFICIAL_HOST}`)
    }
    // 分支三/四（签发链）：checkIssued 仅比对 DN/AKID（可被伪造 CA 满足），必须叠加
    // verify 做签名校验，二者同时满足才放行，防止自签 CA 伪造 DN 绕过钉扎（2026-10 审查修复）。
    const leaf = typeof socket.getPeerX509Certificate === 'function' ? socket.getPeerX509Certificate() : null
    if (leaf && typeof leaf.checkIssued === 'function' && typeof leaf.verify === 'function') {
      for (const inter of officialIntermediates()) {
        try {
          if (leaf.checkIssued(inter) && leaf.verify(inter.publicKey)) {
            diag.issuerMatched = true
            diag.signatureVerified = true
            break
          }
        } catch (_) {
          // 该中间证书与叶子不匹配或校验异常，继续尝试下一张
        }
      }
    }
    diag.pinned = diag.spkiMatched || (diag.sanMatched && diag.issuerMatched && diag.signatureVerified)
    return diag
  } catch (err) {
    // 不再静默吞异常（原 catch (_) 丢失定位线索）：记录到诊断字段，仍按 fail-closed 拒绝
    diag.error = sanitizeLog(err?.message || err)
    return diag
  }
}

/**
 * 校验官方域名 TLS 对端 socket 是否满足钉扎要求（fail-closed 布尔入口，保持旧 API）。
 */
export function isPinnedOfficialSocket(socket) {
  return evaluateOfficialPinning(socket).pinned
}

/**
 * 当前运行副本的叶子 SPKI 钉扎列表（base64）。公开只读副本，供测试与诊断比对，
 * 用于确认"运行时加载的代码"与预期钉扎数据一致（诊断文档 3.C）。
 */
export function officialLeafSpkiSha256Pins() {
  return [...OFFICIAL_LEAF_SPKI_SHA256_PINS]
}

/**
 * 官方域名专用 https agent：放宽 CA 链校验（链不完整），但在 secureConnect 后、
 * 发送应用数据前核对证书钉扎，不匹配立即销毁 socket（fail-closed）。
 * 不复用 checkServerIdentity——rejectUnauthorized:false 下其错误未必致命。
 */
class PinnedOfficialHttpsAgent extends https.Agent {
  createConnection(options, callback) {
    const socket = super.createConnection(options, callback)
    socket.once('secureConnect', () => {
      const r = evaluateOfficialPinning(socket)
      const ctx =
        `address=${sanitizeLog(socket.remoteAddress)} port=${socket.remotePort} ` +
        `servername=${sanitizeLog(options?.servername)} pubkeyLen=${r.pubkeyLen ?? 'n/a'} ` +
        `spkiSha256=${sanitizeLog(r.spkiSha256)} fingerprint256=${sanitizeLog(r.fingerprint256)} ` +
        `subject=${sanitizeLog(r.subject)} issuer=${sanitizeLog(r.issuer)} ` +
        `san=${sanitizeLog(r.subjectaltname)}`
      if (r.pinned) {
        // 方案一诊断：真实请求路径的观测值，与 agent 初始化日志中的钉扎列表比对即可定位数据漂移
        safeLogger.info(`[ai0-plugin pin-debug] 官方域名证书钉扎命中 ${ctx}`)
        return
      }
      safeLogger.error(
        `[ai0-plugin pin-reject] 官方域名证书钉扎校验失败 ${ctx} ` +
          `spkiMatched=${r.spkiMatched} sanMatched=${r.sanMatched} ` +
          `issuerMatched=${r.issuerMatched} signatureVerified=${r.signatureVerified}` +
          (r.error ? ` error=${r.error}` : ''),
      )
      const err = new Error('官方域名证书钉扎校验失败，已中止连接（可能的中间人攻击）')
      err.code = 'AI0_OFFICIAL_PIN_MISMATCH'
      err.details = { ...r, address: socket.remoteAddress, servername: options?.servername }
      socket.destroy(err)
    })
    return socket
  }
}

let _officialHttpsAgent = null
/**
 * 供官方域名使用的 https agent。全局复用，避免每次请求新建连接池。
 */
export function officialHttpsAgent() {
  if (!_officialHttpsAgent) {
    _officialHttpsAgent = new PinnedOfficialHttpsAgent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 30000 })
    // 打印当前运行副本的钉扎数据：用于排查"运行时加载的代码与手工测试代码不一致"
    // （诊断文档 3.C，比对日志中 pin-debug 的 spkiSha256 即可确认）
    safeLogger.info(
      `[ai0-plugin] 官方域名钉扎 agent 初始化 leafSpkiPins=${OFFICIAL_LEAF_SPKI_SHA256_PINS.join(',')} ` +
        `intermediates=${OFFICIAL_INTERMEDIATE_PEMS.length}`,
    )
  }
  return _officialHttpsAgent
}

export function isOfficialKind(kind) {
  return String(kind || '').trim().toLowerCase() === OFFICIAL_KIND
}

export function normalizeProviderKind(kind) {
  return isOfficialKind(kind) ? OFFICIAL_KIND : CUSTOM_KIND
}

export function allocateOfficialKey(existingKeys) {
  const taken = new Set((existingKeys || []).map((k) => String(k || '').trim()).filter(Boolean))
  if (!taken.has(OFFICIAL_KEY_PREFIX)) return OFFICIAL_KEY_PREFIX
  let n = 2
  while (taken.has(`${OFFICIAL_KEY_PREFIX}-${n}`)) n++
  return `${OFFICIAL_KEY_PREFIX}-${n}`
}

export function officialPreset(overrides = {}) {
  return {
    kind: OFFICIAL_KIND,
    name: overrides.name || OFFICIAL_DISPLAY_NAME,
    apiBase: OFFICIAL_API_BASE,
    apiKey: overrides.apiKey || '',
    model: overrides.model || '',
    temperature: overrides.temperature ?? 0.8,
    maxTokens: overrides.maxTokens ?? 2000,
    timeout: overrides.timeout ?? 60000,
  }
}

export function forceOfficialApiBase(entry) {
  if (entry && typeof entry === 'object' && isOfficialKind(entry.kind)) {
    entry.apiBase = OFFICIAL_API_BASE
  }
  return entry
}

export function hasOfficialApiKey(entry) {
  const key = String(entry?.apiKey || '').trim()
  if (!key) return false
  if (/^\*+$/.test(key)) return false
  return true
}

export function omitOfficialApiBase(entry) {
  if (!entry || typeof entry !== 'object' || !isOfficialKind(entry.kind)) return entry
  const { apiBase: _hidden, ...rest } = entry
  return rest
}

export function omitOfficialSecrets(entry) {
  if (!entry || typeof entry !== 'object' || !isOfficialKind(entry.kind)) return entry
  const { apiBase: _hiddenBase, apiKey: hiddenKey, ...rest } = entry
  rest.keyReady = hasOfficialApiKey({ apiKey: hiddenKey })
  return rest
}

export function redactOfficialText(text) {
  const host = OFFICIAL_HOST.replace(/\./g, '\\.')
  return String(text || '')
    .replace(new RegExp(`https?:\\/\\/[^\\s"'<>]*${host}[^\\s"'<>]*`, 'gi'), '[official]')
    .replace(new RegExp(host, 'gi'), '[official]')
}

export function omitOfficialProbeUrl(info, kind) {
  if (!info || typeof info !== 'object' || !isOfficialKind(kind)) return info
  const { url: _hidden, ...rest } = info
  if (rest.error) rest.error = redactOfficialText(rest.error)
  if (rest.msg) rest.msg = redactOfficialText(rest.msg)
  if (rest.note) rest.note = redactOfficialText(rest.note)
  return rest
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    const v = obj[k]
    if (v == null) continue
    const s = String(v).trim()
    if (s) return v
  }
  return undefined
}

export function officialRegisterUrl() {
  return `${OFFICIAL_API_BASE}${OFFICIAL_REGISTER_PATH}`
}

export function officialAssociateUrl() {
  return `${OFFICIAL_API_BASE}${OFFICIAL_ASSOCIATE_PATH}`
}

export function sanitizeOfficialUsername(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return ''
  if (s.length > 64) return ''
  if (/[\u0000-\u001f<>]/.test(s)) return ''
  if (/\s/.test(s)) return ''
  return s
}

export function sanitizeOfficialQq(value) {
  const s = String(value == null ? '' : value).trim()
  if (!/^[1-9][0-9]{4,11}$/.test(s)) return ''
  return s
}

/**
 * 关联校验用邮箱：合作方须校验该用户名绑定的邮箱等于 `<QQ>@qq.com`。
 * QQ 非法时返回空串，调用方应直接拒绝关联。
 */
export function officialAssociateExpectedEmail(value) {
  const qq = sanitizeOfficialQq(value)
  return qq ? `${qq}@qq.com` : ''
}

/**
 * 用户手填的绑定邮箱。允许字母别名（微信注册的 QQ 邮箱常是字母形式），
 * 因此只做通用邮箱格式校验，不强制 `<QQ>@qq.com`。
 */
export function sanitizeOfficialEmail(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s || s.length > 254) return ''
  if (/[\u0000-\u001f\u007f<>\s]/.test(s)) return ''
  if (!/^[^@]{1,64}@[^@.]+(?:\.[^@.]+)+$/.test(s)) return ''
  return s
}

export function buildOfficialRegisterPayload({
  instanceId,
  providerKey,
  displayName,
  operatorId,
  pluginVersion,
} = {}) {
  const plugin = OFFICIAL_PLUGIN_NAME
  const version = String(pluginVersion || '').trim()
  const inst = String(instanceId || '').trim()
  const key = String(providerKey || '').trim()
  const name = String(displayName || OFFICIAL_DISPLAY_NAME).trim() || OFFICIAL_DISPLAY_NAME
  const operator = String(operatorId || '').trim()
  const qq = sanitizeOfficialQq(operator)
  const payload = {
    plugin,
    pluginVersion: version,
    plugin_version: version,
    instanceId: inst,
    instance_id: inst,
    providerKey: key,
    provider_key: key,
    displayName: name,
    display_name: name,
  }
  if (qq) {
    payload.operatorId = qq
    payload.operator_id = qq
    payload.qq = qq
  } else if (operator && operator !== 'master-magic' && operator !== 'unknown') {
    payload.operatorId = operator
    payload.operator_id = operator
  }
  return payload
}

export function parseOfficialRegisterResponse(status, data) {
  const body = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}
  const nested = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {}
  const apiKey = String(
    pickFirst(body, ['apiKey', 'api_key', 'key'])
    || pickFirst(nested, ['apiKey', 'api_key', 'key'])
    || '',
  ).trim()
  const explicitFail = body.ok === false || body.success === false
  const httpOk = Number(status) >= 200 && Number(status) < 300
  if (httpOk && apiKey && !explicitFail) {
    const usernameRaw = pickFirst(body, ['username', 'userName', 'user_name', 'account'])
      || pickFirst(nested, ['username', 'userName', 'user_name', 'account'])
      || ''
    return {
      ok: true,
      apiKey,
      username: sanitizeOfficialUsername(usernameRaw),
      keyId: String(pickFirst(body, ['keyId', 'key_id']) || pickFirst(nested, ['keyId', 'key_id']) || '').trim(),
      expiresAt: pickFirst(body, ['expiresAt', 'expires_at']) || pickFirst(nested, ['expiresAt', 'expires_at']) || null,
    }
  }
  let code = String(pickFirst(body, ['code', 'errorCode', 'error_code']) || '').trim()
  if (!code) {
    if (Number(status) === 429) code = 'RATE_LIMITED'
    else if (Number(status) === 401 || Number(status) === 403) code = 'UNAUTHORIZED'
    else if (Number(status) === 409) code = 'ALREADY_REGISTERED'
    else code = 'REGISTER_FAILED'
  }
  const rawMsg = pickFirst(body, ['message', 'msg', 'error']) || pickFirst(nested, ['message', 'msg', 'error']) || '官方密钥签发失败'
  return {
    ok: false,
    code,
    message: redactOfficialText(String(rawMsg)),
    status: Number(status) || 0,
  }
}

export function officialRegisterErrorForClient(err) {
  const raw = redactOfficialText(err?.message || String(err || '官方服务暂不可达'))
  if (/timeout|timed out|ECONNABORTED/i.test(raw)) return '官方服务响应超时，请稍后重试'
  if (/certificate|UNABLE_TO_VERIFY|CERT_/i.test(raw)) return '官方服务证书校验失败'
  if (/ECONNREFUSED|ENOTFOUND|network|socket/i.test(raw)) return '官方服务暂不可达'
  if (/拒绝访问|重定向|SSRF|私有|回环/i.test(raw)) return '官方服务暂不可达'
  return '官方密钥签发失败，请稍后重试'
}

export function getOfficialMeta() {
  return {
    displayName: OFFICIAL_DISPLAY_NAME,
    keyPrefix: OFFICIAL_KEY_PREFIX,
    connectivityUnconfirmed: true,
    certMayBeInvalid: true,
    hasRegister: true,
    hint: '官方 API 为可选项，地址由服务端管理，后台不展示。请先点「注册获取密钥」（由合作方签发，本页不显示密钥），成功后再确认平台用户名并关联 QQ，然后「拉取模型列表」。充值请在合作方网页处理。',
  }
}

export function buildOfficialAssociatePayload({
  instanceId,
  providerKey,
  username,
  operatorId,
  email,
  bindCode,
  pluginVersion,
} = {}) {
  const plugin = OFFICIAL_PLUGIN_NAME
  const version = String(pluginVersion || '').trim()
  const inst = String(instanceId || '').trim()
  const key = String(providerKey || '').trim()
  const user = sanitizeOfficialUsername(username)
  const operator = sanitizeOfficialQq(operatorId)
  const userEmail = sanitizeOfficialEmail(email)
  const code = String(bindCode == null ? '' : bindCode).replace(/\s+/g, '')
  const payload = {
    plugin,
    pluginVersion: version,
    plugin_version: version,
    instanceId: inst,
    instance_id: inst,
    providerKey: key,
    provider_key: key,
  }
  // 归属证明：平台网页「个人中心 → 插件关联」生成的 6 位一次性关联码。
  // 平台已不再仅凭「用户名 + 邮箱文本一致」改绑实例（防 QQ 邮箱可猜测被冒用）。
  if (code) payload.bind_code = code
  // 用户名可选：留空表示「按 QQ 优先匹配」，由合作方依据 operatorId 反查账号。
  if (user) {
    payload.username = user
    payload.user_name = user
  }
  if (operator) {
    payload.operatorId = operator
    payload.operator_id = operator
    payload.qq = operator
  }
  // 第一段：期望邮箱取 `<QQ>@qq.com`；第二段：用户手填的实际绑定邮箱。
  // 合作方按 expect_email / email 校验该用户名绑定邮箱是否一致。
  if (userEmail) {
    payload.email = userEmail
    payload.expectEmail = userEmail
    payload.expect_email = userEmail
  } else if (operator) {
    const expectEmail = `${operator}@qq.com`
    payload.expectEmail = expectEmail
    payload.expect_email = expectEmail
  }
  return payload
}

const ASSOCIATE_VERIFY_KEYS = [
  'verified', 'identityVerified', 'identity_verified',
  'emailVerified', 'email_verified', 'emailMatched', 'email_matched',
]

function isTruthyFlag(value) {
  if (value === true || value === 1) return true
  const s = String(value == null ? '' : value).trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

export function parseOfficialAssociateResponse(status, data, opts = {}) {
  const body = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}
  const nested = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {}
  const explicitFail = body.ok === false || body.success === false
  const httpOk = Number(status) >= 200 && Number(status) < 300
  const usernameRaw = pickFirst(body, ['username', 'userName', 'user_name', 'account'])
    || pickFirst(nested, ['username', 'userName', 'user_name', 'account'])
    || ''
  const emailRaw = String(
    pickFirst(body, ['email', 'mail', 'userEmail', 'user_email'])
    || pickFirst(nested, ['email', 'mail', 'userEmail', 'user_email'])
    || '',
  ).trim()
  const returnedUsername = sanitizeOfficialUsername(usernameRaw)

  // 身份校验：必须由合作方证明「该用户名绑定的邮箱 == <QQ>@qq.com」。
  // 仅凭 2xx 就放行会让管理员填 `admin` 冒充他人账号，直接蹭到无限额。
  const expectedEmail = String(opts.expectedEmail || '').trim().toLowerCase()
  const expectedUsername = sanitizeOfficialUsername(opts.expectedUsername || '').toLowerCase()
  const allowQqMatch = !!opts.allowQqMatch && !expectedUsername
  const flagVerified = isTruthyFlag(
    pickFirst(body, ASSOCIATE_VERIFY_KEYS) ?? pickFirst(nested, ASSOCIATE_VERIFY_KEYS),
  )
  const emailVerified = !!(expectedEmail && emailRaw && emailRaw.toLowerCase() === expectedEmail)
  const usernameMismatch = !!(expectedUsername && returnedUsername && returnedUsername.toLowerCase() !== expectedUsername)
  // QQ 优先匹配：未提供用户名时，合作方依据 operatorId(QQ) 反查账号并回传 username，
  // 视为「QQ 已绑定该平台账号」——不需要额外 verified 标记（operatorId 由服务端登录态派生，不可伪造）。
  const qqMatched = !!(allowQqMatch && returnedUsername && httpOk && !explicitFail)
  const identityVerified = qqMatched || ((flagVerified || emailVerified) && !usernameMismatch)

  if (httpOk && !explicitFail && identityVerified) {
    return {
      ok: true,
      username: returnedUsername,
      email: emailRaw,
      verified: true,
      matchedBy: qqMatched ? 'qq' : 'email',
      associated: body.associated !== false && nested.associated !== false,
    }
  }

  let code = String(pickFirst(body, ['code', 'errorCode', 'error_code']) || pickFirst(nested, ['code', 'errorCode', 'error_code']) || '').trim()
  if (!code) {
    if (usernameMismatch) code = 'IDENTITY_MISMATCH'
    else if (httpOk && !explicitFail) code = 'IDENTITY_NOT_VERIFIED'
    else if (Number(status) === 429) code = 'RATE_LIMITED'
    else if (Number(status) === 401 || Number(status) === 403) code = 'UNAUTHORIZED'
    else if (Number(status) === 404) code = 'USER_NOT_FOUND'
    else code = 'ASSOCIATE_FAILED'
  }
  // 平台明示「需要用户提供实际绑定邮箱」：邮箱不是 <QQ>@qq.com 时（如微信注册的字母别名），
  // 插件据此弹窗让用户手填邮箱，再做第二段校验。
  const needEmailRaw = pickFirst(body, ['needEmail', 'need_email']) ?? pickFirst(nested, ['needEmail', 'need_email'])
  const needEmail = isTruthyFlag(needEmailRaw) || code === 'EMAIL_REQUIRED'
  // QQ 优先匹配失败：合作方未找到该 QQ 绑定的账号（或明示需要用户名），前端改为收集用户名后重试。
  const needUsernameRaw = pickFirst(body, ['needUsername', 'need_username']) ?? pickFirst(nested, ['needUsername', 'need_username'])
  const needUsername = isTruthyFlag(needUsernameRaw)
    || code === 'NEED_USERNAME'
    || code === 'USERNAME_REQUIRED'
    || (allowQqMatch && (code === 'USER_NOT_FOUND' || needEmail || code === 'IDENTITY_NOT_VERIFIED' || code === 'IDENTITY_MISMATCH'))
  const identityCodes = ['IDENTITY_NOT_VERIFIED', 'IDENTITY_MISMATCH', 'EMAIL_REQUIRED']
  const defaultMsg = needUsername
    ? '未找到与该 QQ 关联的平台账号，请填写你在该平台注册的用户名后重试'
    : identityCodes.includes(code)
      ? '平台未确认该用户名与其绑定邮箱匹配，请填写该用户名实际绑定的邮箱后重试'
      : code === 'USER_NOT_FOUND'
        ? '未找到该平台用户名，请确认后重试'
        : '关联官方账号失败'
  const rawMsg = pickFirst(body, ['message', 'msg', 'error']) || pickFirst(nested, ['message', 'msg', 'error']) || defaultMsg
  return {
    ok: false,
    code,
    message: redactOfficialText(String(rawMsg)),
    needEmail: needEmail || undefined,
    needUsername: needUsername || undefined,
    status: Number(status) || 0,
  }
}
