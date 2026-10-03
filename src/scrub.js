/**
 * 敏感令牌确定性脱敏。
 * 独立成模块以打破 helper.js ↔ globals.js 的循环依赖：
 * helper.js 与 globals.js（sanitizeLog）都需要本函数，但二者互相 import。
 * 本模块只依赖 node:crypto，无项目内依赖。
 */
import crypto from 'node:crypto'

// 已脱敏占位的正则——用于幂等判断：二次 scrub 时不重复替换成嵌套占位。
const SCRUB_MARK_RE = /\[已脱敏:[^\]]+\]/g

/**
 * 把字符串中可识别的密钥/访问令牌指纹替换成 `[已脱敏:类型:前4...后4]`。
 * 设计目标（针对"压缩包中不应带令牌"）：
 *  - 确定性：非依赖模型自觉，任何离开本地的 content 都先过这里；
 *  - 幂等：已脱敏占位不被再次替换；
 *  - 保留少量可读指纹：便于排查是哪一种令牌，但绝不暴露完整密钥。
 * 覆盖：GitHub PAT(ghp_/gho_/ghu_/ghs_/ghr_)、sk-*、Bearer 头、AWS(AKIA/ASIA)、
 *        Xoxp/Slack 令牌、OpenAI 风格长 token、以及 `key: <长串>` 键值对形式。
 * @param {string} text
 * @returns {string}
 */
export function scrubSensitiveTokens(text) {
  let s = String(text ?? '')
  if (!s) return s

  const repl = (match, type, token) => {
    const t = token
    const head = t.slice(0, 4)
    const tail = t.slice(-4)
    return `[已脱敏:${type}:${head}…${tail}]`
  }

  // 1) 常见成熟前缀类令牌（可识别类型）
  const PREFIX_PATTERNS = [
    { type: 'github-pat', re: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g },
    { type: 'openai-sk', re: /\b(sk-[A-Za-z0-9_-]{20,})\b/g },
    { type: 'aws-secret', re: /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/g },
    { type: 'bearer', re: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{16,})\b/g },
    { type: 'slack', re: /\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g },
  ]
  for (const p of PREFIX_PATTERNS) {
    s = s.replace(p.re, (m, token) => repl(m, p.type, token))
  }

  // 2) 先把"已脱敏占位"藏起来，避免下面的键值对规则误伤占位里的 token 片段，
  //    再无条件执行键值对规则（幂等：占位已被隐藏，不会被二次替换）。
  const sentinel = `\u0000SC0-${crypto.randomBytes(12).toString('hex')}\u0000`
  const hidden = []
  s = s.replace(SCRUB_MARK_RE, (m) => { hidden.push(m); return sentinel })

  // 3) `key: <长串>` / `apiKey=...` / `"password": "..."` 等键值对形式
  //    只匹配明确的凭据类键名（含下划线），值须为较长连续串，避免误伤普通词（如 token・话题、secret・小道消息）。
  const KEYVAL_PATTERNS = [
    { type: 'password', re: /(["']?(?:password|passwd|pwd)["']?\s*[:=]\s*["']?)([A-Za-z0-9.!@#$%^&*._~+/=-]{6,})/gi },
    { type: 'api-key', re: /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|refresh[_-]?token|secret[_-]?key|app[_-]?secret)["']?\s*[:=]\s*["']?)([A-Za-z0-9.\-_~/+${}=]{12,})/gi },
  ]
  for (const kp of KEYVAL_PATTERNS) {
    s = s.replace(kp.re, (m, label, value) => `${label}${repl(m, kp.type, value)}`)
  }

  // 还原占位（哨兵含随机串，避免与原文撞字面量）
  const parts = s.split(sentinel)
  s = parts.map((part, i) => (i < hidden.length ? part + hidden[i] : part)).join('')

  return s
}
