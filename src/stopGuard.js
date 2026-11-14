/**
 * 群级「停止」防循环闸门
 *
 * 用途：群里如果多个机器人互相触发（A 发图带"滚" → 本插件全局AI回复 → A 又触发…），
 * 人或管理员在群里发 `#停止` / `#stop` 即可立刻掐断，支持两种缓冲：
 *
 *   #停止            → 默认缓冲 3 秒（期间任何全局AI/艾特都不触发）
 *   #停止 10s / 10秒 → 10 秒内不触发
 *   #停止 10次       → 需要再被触发（@/全局AI）10 次才恢复正常
 *   #停止 0 / off    → 立即解除
 *
 * 语义：
 *  - 时间模式：窗口内所有触发都被丢弃（不消耗次数）
 *  - 次数模式：每来一次本该触发的消息，计数 -1，直到 0 才恢复
 */

const DEFAULT_SECONDS = 3
const MAX_SECONDS = 3600
const MAX_TIMES = 500

const state = new Map() // groupId -> { mode: 'time'|'count', until: number, remaining: number }

function key(groupId) {
  return String(groupId ?? '')
}

/** 解析参数：返回 { mode, seconds, times } 或 null（非法） */
export function parseArg(arg) {
  const raw = String(arg ?? '').trim()
  if (!raw) return { mode: 'time', seconds: DEFAULT_SECONDS }
  if (/^(0|off|关闭|解除)$/i.test(raw)) return { mode: 'clear' }

  let m = raw.match(/^(\d+)\s*(s|秒|sec|seconds?)?$/i)
  if (m) {
    const n = Number(m[1])
    if (!Number.isFinite(n)) return null
    return { mode: 'time', seconds: Math.min(Math.max(n, 0), MAX_SECONDS) }
  }
  m = raw.match(/^(\d+)\s*(次|times?|条)$/i)
  if (m) {
    const n = Number(m[1])
    if (!Number.isFinite(n)) return null
    return { mode: 'count', times: Math.min(Math.max(n, 0), MAX_TIMES) }
  }
  return null
}

/** 设置/清除闸门，返回给人看的提示 */
export function setStop(groupId, arg, now = Date.now()) {
  const k = key(groupId)
  const opt = parseArg(arg)
  if (!opt) {
    return { ok: false, msg: '参数格式： #停止 [秒数/次数]，例如 #停止 10s、#停止 10次、#停止 0' }
  }
  if (opt.mode === 'clear') {
    state.delete(k)
    return { ok: true, msg: '已解除停止状态，恢复正常回复' }
  }
  if (opt.mode === 'count') {
    if (opt.times <= 0) {
      state.delete(k)
      return { ok: true, msg: '已解除停止状态，恢复正常回复' }
    }
    state.set(k, { mode: 'count', remaining: opt.times, until: 0 })
    return { ok: true, msg: `已暂停：接下来 ${opt.times} 次触发将被忽略（@ 或全局AI 均计入）` }
  }
  if (opt.seconds <= 0) {
    state.delete(k)
    return { ok: true, msg: '已解除停止状态，恢复正常回复' }
  }
  state.set(k, { mode: 'time', until: now + opt.seconds * 1000, remaining: 0 })
  return { ok: true, msg: `已暂停 ${opt.seconds} 秒，期间不会响应任何消息` }
}

/**
 * 本次触发是否应被丢弃。
 * 时间模式：窗口内丢弃且不消耗；次数模式：每触发一次扣 1，扣到 0 自动解除。
 */
export function shouldSuppress(groupId, now = Date.now()) {
  const k = key(groupId)
  const rec = state.get(k)
  if (!rec) return false
  if (rec.mode === 'time') {
    if (now < rec.until) return true
    state.delete(k)
    return false
  }
  if (rec.remaining > 0) {
    rec.remaining -= 1
    if (rec.remaining <= 0) state.delete(k)
    return true
  }
  state.delete(k)
  return false
}

/** 当前状态（用于命令回显/诊断） */
export function getStatus(groupId, now = Date.now()) {
  const rec = state.get(key(groupId))
  if (!rec) return null
  if (rec.mode === 'time') {
    const left = Math.max(0, Math.ceil((rec.until - now) / 1000))
    return { mode: 'time', secondsLeft: left }
  }
  return { mode: 'count', remaining: rec.remaining }
}

/** 仅测试用：清空全部状态 */
export function _reset() { state.clear() }
