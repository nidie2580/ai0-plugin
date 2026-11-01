/**
 * IDC 客服交接
 *
 * 设计（用户需求）：AI0 正常回答私聊；当 AI 判断消息属于 IDC 云服务业务时，
 * 输出 [action:idc:handoff]，由本模块把会话交给 idc-assistant 插件：
 *  - 写入其客服状态（data/idc-bot/cs.json 的 users[qq]），模式 ai（智能客服）
 *  - 之后该用户的私聊由 idc-assistant（priority 0）优先接管，AI0 不再抢答
 *
 * 解耦：动态 import 兄弟插件的 support.js（提供 loadCS/saveCS 与路径默认值）；
 * 插件不存在或接口变化时安全降级（返回 ok:false，由调用方给出文字引导）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cfg from '../config/index.js'
import { safeLogger, sanitizeLog } from './globals.js'

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const IDC_ROOT = path.join(PLUGIN_ROOT, '..', 'idc-assistant')
const IDC_SUPPORT = path.join(IDC_ROOT, 'support.js')
const BOT_ROOT = path.join(PLUGIN_ROOT, '..', '..')
const IDC_CS_FILE = path.join(BOT_ROOT, 'data', 'idc-bot', 'cs.json')

/** idc-assistant 插件是否在位 */
export function isAvailable() {
  try { fs.accessSync(IDC_SUPPORT, fs.constants.R_OK); return true } catch (_) { return false }
}

/** 该用户当前是否已处于 IDC 客服会话（避免 AI0 抢话） */
export function isInIdcSession(qq) {
  try {
    if (!qq) return false
    const raw = fs.readFileSync(IDC_CS_FILE, 'utf8')
    const cs = JSON.parse(raw)
    return !!(cs && cs.users && cs.users[String(qq)])
  } catch (_) { return false }
}

/**
 * 把会话交给 IDC 客服。
 * @returns {Promise<{ok:boolean, mode?:string, code?:string, reason?:string}>}
 */
export async function handoffToIdc({ qq, userName = '' } = {}) {
  if (cfg.get('chat.idcHandoff.enabled', true) === false) return { ok: false, reason: 'disabled' }
  if (!qq) return { ok: false, reason: 'no-qq' }
  if (!isAvailable()) return { ok: false, reason: 'idc-assistant 未安装' }
  try {
    const mod = await import('file://' + IDC_SUPPORT)
    const cs = mod.loadCS()
    if (!cs.users) cs.users = {}
    if (!cs.agents) cs.agents = {}
    const key = String(qq)
    const prev = cs.users[key] || {}
    // 已在人工会话中：保持不动（不要把人踢回 AI）
    if (prev.mode === 'agent') {
      return { ok: true, already: true, mode: 'agent', code: prev.code || '' }
    }
    cs.users[key] = {
      ...prev,
      mode: 'ai',
      at: Date.now(),
      history: Array.isArray(prev.history) ? prev.history : [],
      handoffBy: 'ai0',
      handoffName: String(userName || '').slice(0, 40),
    }
    mod.saveCS(cs)
    safeLogger.info(`[ai0-plugin] 私聊 ${key} 已交接给 IDC 客服（AI 判断为 IDC 业务）`)
    return { ok: true, mode: 'ai', code: cs.users[key].code || '' }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] IDC 交接失败: ${sanitizeLog(err?.message || err)}`)
    return { ok: false, reason: sanitizeLog(err?.message || err) }
  }
}
