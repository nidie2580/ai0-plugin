/**
 * 安全审计日志 + 会话安全元数据
 *
 * 两个职责：
 *  1) 审计日志流：所有安全敏感事件（Agent 命令执行/拒绝、群操作执行/被拒、Agent 异常）
 *     追加写入 logs/security/security.log（JSONL，一行一个事件，含时间/用户/动作/结果/原因）。
 *  2) 会话安全元数据：当事件携带 userId+sessionId 时，同步写入
 *     data/history/<userId>/<sessionId>.meta.json，记录该会话是否使用了 Agent、
 *     是否有风险事件（命令被拒 / 群操作被拒 / Agent 出错等），供 Web 会话列表标注。
 *
 * 所有 I/O 均吞异常（安全审计不能影响主流程），对外永不 throw。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeLogger, sanitizeLog } from './globals.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.join(__dirname, '..')
const HISTORY_DIR = path.join(PLUGIN_ROOT, 'data', 'history')
const SECURITY_LOG_DIR = path.join(PLUGIN_ROOT, 'logs', 'security')
const SECURITY_LOG_FILE = path.join(SECURITY_LOG_DIR, 'security.log')

/** 各事件 kind 对应的风险标签（用于会话列表标注）；不在映射里的不算风险 */
const RISK_LABELS = {
  agent_cmd_rejected: '命令被拒',
  agent_timeout: 'Agent超时',
  agent_error: 'Agent出错',
  group_op_denied: '群操作被拒',
  group_op_failed: '群操作失败',
}

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (_) {}
}

/** 与 llm.historyFile 一致的路径段校验，防止把不可信 id 拼进路径 */
function safeId(v, re) {
  const s = String(v ?? '')
  return re.test(s) ? s : null
}
const SAFE_USER = /^\d{1,20}$/
const SAFE_SESSION = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function metaFile(userId, sessionId) {
  const u = safeId(userId, SAFE_USER)
  const s = safeId(sessionId, SAFE_SESSION)
  if (!u || !s) return null
  return path.join(HISTORY_DIR, u, `${s}.meta.json`)
}

function readMeta(userId, sessionId) {
  const f = metaFile(userId, sessionId)
  if (!f || !fs.existsSync(f)) return {}
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'))
    return obj && typeof obj === 'object' ? obj : {}
  } catch (_) {
    return {}
  }
}

/**
 * 记录一条安全事件。
 * @param {object} ev
 * @param {string} ev.kind    事件类型（见 RISK_LABELS，另加 agent_cmd / group_op）
 * @param {string} [ev.userId] QQ 号
 * @param {string} [ev.sessionId] 会话 UUID（有则更新会话元数据）
 * @param {string} [ev.groupId] 群号
 * @param {string} ev.action  动作描述（如执行/被拒的命令、群操作类型）
 * @param {boolean} [ev.ok]    是否成功
 * @param {string} [ev.reason] 拒绝/失败原因
 */
export function recordSecurityEvent(ev = {}) {
  const kind = String(ev.kind || 'unknown')
  const entry = {
    ts: new Date().toISOString(),
    kind,
    userId: ev.userId != null ? String(ev.userId) : undefined,
    sessionId: ev.sessionId != null ? String(ev.sessionId) : undefined,
    groupId: ev.groupId != null ? String(ev.groupId) : undefined,
    action: sanitizeLog(ev.action ?? '').slice(0, 200),
    ok: ev.ok === true,
    reason: ev.reason ? sanitizeLog(ev.reason).slice(0, 300) : undefined,
    detail: ev.detail ? sanitizeLog(ev.detail).slice(0, 500) : undefined,
  }
  // 1) 审计日志流（JSONL）
  try {
    ensureDir(SECURITY_LOG_DIR)
    fs.appendFileSync(SECURITY_LOG_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 })
  } catch (err) {
    safeLogger.error(`[ai0-plugin] 安全审计日志写入失败: ${err?.message || err}`)
  }
  // 2) 会话安全元数据
  const f = metaFile(ev.userId, ev.sessionId)
  if (!f) return
  try {
    const meta = readMeta(ev.userId, ev.sessionId)
    if (/^agent/i.test(kind)) meta.agentUsed = true
    const label = RISK_LABELS[kind]
    if (label) {
      meta.risks = Array.isArray(meta.risks) ? meta.risks : []
      if (!meta.risks.includes(label)) meta.risks.push(label)
    }
    ensureDir(path.dirname(f))
    const tmp = f + '.tmp.' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(meta), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, f)
  } catch (err) {
    safeLogger.error(`[ai0-plugin] 会话安全元数据写入失败: ${err?.message || err}`)
  }
}

/** 读取会话安全元数据（无则返回 {}） */
export function getSessionMeta(userId, sessionId) {
  return readMeta(userId, sessionId)
}
