/**
 * 模型互聊记录（独立日志）
 *
 * 单独记录"多模型互聊"轮次（multiModel 开启且产生了多个模型发言时写入一条），
 * 供 Web 后台「互聊记录」页面实时查看与翻历史。与 securityLog 一致：
 * 所有 I/O 吞异常（日志不能影响主流程），对外永不 throw。
 *
 * 存储：data/chat-log.json —— 倒序数组（最新的在最前），每条含
 *   { id, ts, userId, sessionId, question, replies:[{model,text}] }
 *   MAX_ENTRIES 上限裁剪，避免无限膨胀。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.join(__dirname, '..')
// 日志文件路径：默认 data/chat-log.json；测试可用 AI0_CHATLOG_FILE 覆盖到临时路径，
// 避免污染真实数据目录（也便于并发测试隔离）。
const CHATLOG_DIR = path.join(PLUGIN_ROOT, 'data')
const CHATLOG_FILE = process.env.AI0_CHATLOG_FILE
  ? path.resolve(process.env.AI0_CHATLOG_FILE)
  : path.join(CHATLOG_DIR, 'chat-log.json')

// 最多保留的互聊轮次（最新的在列）；超出时裁剪最旧的
const MAX_ENTRIES = 200

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (_) {}
}

/** 读取全部记录（倒序：最新在前）。文件不存在/损坏返回空数组 */
export function readChatLog() {
  ensureDir(CHATLOG_DIR)
  try {
    if (!fs.existsSync(CHATLOG_FILE)) return []
    const arr = JSON.parse(fs.readFileSync(CHATLOG_FILE, 'utf-8'))
    return Array.isArray(arr) ? arr : []
  } catch (_) {
    return []
  }
}

/**
 * 追加一条互聊记录；在数组最前端插入（最新在前），并裁剪超出上限的旧记录。
 * @param {{userId:string, sessionId:string, question:string, replies:Array<{model:string,text:string}>}} entry
 * @returns {boolean} 是否写入成功（仅用于日志/测试判断，失败不抛错）
 */
export function appendChatLog(entry) {
  try {
    ensureDir(CHATLOG_DIR)
    const list = readChatLog()
    const rec = {
      id: randomUUID(),
      ts: Date.now(),
      userId: String(entry?.userId ?? ''),
      sessionId: String(entry?.sessionId ?? ''),
      question: String(entry?.question ?? '').slice(0, 4000),
      replies: Array.isArray(entry?.replies)
        ? entry.replies.map((r) => ({
            model: String(r?.model ?? ''),
            text: String(r?.text ?? '').slice(0, 8000),
          }))
        : [],
    }
    const next = [rec, ...list].slice(0, MAX_ENTRIES)
    fs.writeFileSync(CHATLOG_FILE, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
    return true
  } catch (err) {
    return false
  }
}

/**
 * 查询互聊记录。
 * @param {{limit?:number, offset?:number}} opts  limit 返回条数(默认 50)；offset 分页起点
 * @returns {{total:number, items:Array<object>}} items 为倒序切片
 */
export function queryChatLog({ limit = 50, offset = 0 } = {}) {
  const all = readChatLog()
  const l = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 50))
  const o = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0)
  return { total: all.length, items: all.slice(o, o + l) }
}
