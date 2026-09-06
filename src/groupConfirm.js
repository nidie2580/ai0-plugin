/**
 * 群操作「同行评审」（其他模型一致确认）
 *
 * 背景：多模型互聊开启时，某个模型可能在回复里自行带出群操作指令（如封禁/踢人/禁言）。
 * 若只有单个模型这么判断，且仅校验权限合法性就执行，可能出现"用户只是发了个你好，
 * 模型误判要封禁/踢出管理员"一类风险。因此：在执行前，把该操作连同用户消息、上下文，
 * 转发给【其他模型】做合理性确认（y/n）。
 *
 * 规则（与需求一致，2026-09 修订）：
 *  1) 仅在多模型互聊开启（multiChat=true）且存在其他可用模型时生效。
 *  2) 调用异常（超时/网络错/接口失败）的评审模型「排除出票」，不计入投票集；
 *     已参与评审的模型必须全部明确同意(y) 才放行。
 *  3) 能正常回复但读不出 y/n 的评审模型，视为否决 → 该操作按取消处理（安全优先）。
 *     所有评审模型均调用异常（无任何参与者）时也无法确认 → 取消。
 *  4) 评审确认是"前置门"，独立于 groupOps 的 4 条硬验证与权限校验。
 *
 * 全程吞异常：评审失败不抛错，只影响"该操作是否放行"。
 */
import * as llm from './llm.js'
import * as chatService from './chatService.js'
import { safeLogger } from './globals.js'

// 群操作指令匹配（与 groupOps 一致：非群操作 image/agent 跳过）
const ACTION_RE = /\[action:(\w+):([^\]]*)\]/g
const NON_GROUP_ACTIONS = new Set(['image', 'agent', 'member_list', 'music'])
// 无目标型群操作：targetUid 取空。
// recall（撤回消息）：目标是消息 id，不是 QQ 号，同样按无目标处理（targetUid=null）。
const NO_TARGET_ACTIONS = new Set(['mute_all', 'title_display', 'set_group_name', 'set_notice', 'group_search', 'member_list', 'recall'])

/**
 * 判断当前是否启用「群操作同行评审」：
 *   需同时满足 chat.multiModel.enabled、chat.multiModel.multiChat !== false、
 *   chat.multiModel.groupConfirm !== false，且至少 2 个可用模型。
 * 单模型、多聊关闭、或显式关闭 groupConfirm 时都不介入（零影响）。
 */
export function isGroupReviewEnabled() {
  try {
    const mm = chatService.getMultiModelConfig ? chatService.getMultiModelConfig() : null
    const enabled = mm
      ? (mm.enabled === true && mm.multiChat !== false && mm.groupConfirm !== false)
      : false
    if (!enabled) return false
    return chatService.listConfiguredModels().length >= 2
  } catch (_) {
    return false
  }
}

/** 从回复文本中提取待评审的群操作指令。@returns {Array<{full,type,args,targetUid}>} */
export function parseGroupActions(replyText) {
  if (typeof replyText !== 'string') return []
  const out = []
  let m
  ACTION_RE.lastIndex = 0
  while ((m = ACTION_RE.exec(replyText)) !== null) {
    if (NON_GROUP_ACTIONS.has(m[1])) continue
    out.push({ full: m[0], type: m[1], args: m[2].split(':'), targetUid: NO_TARGET_ACTIONS.has(m[1]) ? null : m[2].split(':')[0] })
  }
  return out
}

function describeAction(a) {
  const args = (a.args || []).join(':')
  return `[action:${a.type}:${args}]`
}

/**
 * 对单个操作构建给评审模型的提示词（给足上下文：操作、用户消息、上下文、角色要求）。
 */
function buildReviewPrompt({ action, userText, requesterUid, targetUid, groupId, groupContextText }) {
  const lines = [
    '你是一名严格的群管理安全评审。请判断下面这条"AI 拟执行的群操作"是否合理、是否与用户当前消息和上下文相符。',
    '只回答一行：y 表示同意执行，n 表示不同意执行。',
    '',
    `用户原始消息：${userText || '(空)'}`,
    `请求者QQ：${requesterUid || '未知'}`,
    `目标QQ：${targetUid || '无目标'}`,
    `群号：${groupId || '未知'}`,
    `拟执行操作：${describeAction(action)}`,
  ]
  if (groupContextText) lines.push(`群上下文参考：${groupContextText}`)
  lines.push('请只输出 y 或 n（可附极简理由，但首字符必须是 y/n）。')
  return lines.join('\n')
}

function parseYorN(text) {
  const t = String(text || '').trim().toLowerCase()
  const first = t.charAt(0)
  if (first === 'y') return 'y'
  if (first === 'n') return 'n'
  return null
}

/**
 * 让单个评审模型对全部待评审操作做一次判定。可用 judgeFn 注入以测试。
 * 判定值约定（对应评审聚合规则）：
 *   'y'       → 明确同意
 *   'n'       → 明确否决
 *   'unknown' → 模型正常响应，但读不出 y/n（视为否决，安全优先）
 *   'error'   → 模型调用异常（超时/网络错等），排除出票，不计入投票集
 * @param {{judgeKey:string, actions:Array, userText:string, requesterUid:string,
 *   groupId:string, groupContextText:string, judgeFn?:Function}} opts
 * @returns {Promise<Map<string,string>>} full → 'y' | 'n' | 'unknown' | 'error'
 */
async function askSingleModel({ judgeKey, actions, userText, requesterUid, groupId, groupContextText, judgeFn }) {
  const result = new Map()
  const callJudge = judgeFn || ((msgs, o) => llm.chatCompletions(msgs, o))
  for (const a of actions) {
    try {
      const prompt = buildReviewPrompt({ action: a, userText, requesterUid, targetUid: a.targetUid, groupId, groupContextText })
      const msgs = [
        { role: 'system', content: '你是群管理安全评审，只输出 y 或 n。' },
        { role: 'user', content: prompt },
      ]
      const res = await callJudge(msgs, { modelKey: judgeKey, temperature: 0, overrideMaxTokens: 16 })
      // 无异常=正常参与评审。能回复但解析不出 y/n → 记 unknown（视为否决）。
      result.set(a.full, parseYorN(res?.text) || 'unknown')
    } catch (err) {
      // 调用异常（超时/网络错/接口失败）= 该模型未参与评审，排除出票（不视为否决，也不放行依据）
      safeLogger.warn(`[ai0-plugin] 群操作评审模型 ${judgeKey} 调用失败(排除出票): ${err?.message || err}`)
      result.set(a.full, 'error')
    }
  }
  return result
}

/**
 * 对 replyText 里所有群操作做「其他模型一致确认」。
 * @param {{
 *   replyText:string, groupId:string, e:object|null, userText:string,
 *   judgeModelKeys?:string[]  // 评审模型（缺省=全部已配置模型）
 *   judgeFn?:Function         // 评审模型调用函数（测试注入），缺省用 llm.chatCompletions
 * }} opts
 * @returns {Promise<{actions:Array, verdicts:Array<{full,type,ok:boolean,reasons:string[]}>}>}
 *   判定结果：ok=true 表示全部参与评审模型一致同意（调用异常模型已排除，不计入）；
 *   ok=false 表示被取消（有参与模型否决 / 能回复但读不出 y/n 视为否决 / 全部模型均异常无参与者）。
 *   评审模型不足 2 个（无真正"其他模型"可确认）→ 全部取消（安全优先）。
 */
export async function reviewGroupActions({ replyText, groupId, e, userText, judgeModelKeys, judgeFn } = {}) {
  try {
    const actions = parseGroupActions(replyText)
    if (!actions.length) return { actions, verdicts: [] }

    // 评审模型集合：默认=全部已配置模型；可从参数指定。
    const allUsable = chatService.listConfiguredModels()
    let judgeKeys = Array.isArray(judgeModelKeys) && judgeModelKeys.length
      ? judgeModelKeys
      : allUsable
    judgeKeys = judgeKeys.filter((k) => allUsable.includes(k))

    // 「同行评审」至少要 1 个"其他模型"。若评审模型不足 2 个 → 无法互为确认，安全起见取消。
    if (judgeKeys.length < 2) {
      safeLogger.info(`[ai0-plugin] 群操作同行评审：评审模型不足(=${judgeKeys.length})，安全起见取消。`)
      return {
        actions,
        verdicts: actions.map((a) => ({ full: a.full, type: a.type, ok: false, reasons: ['评审模型不足(需>=2个可确认模型)'] })),
      }
    }

    const requesterUid = extractRequesterUid(e)
    const groupContextText = extractGroupContextText(groupId)

    // 并行：每个评审模型各自判定所有操作
    const perModel = await Promise.all(
      judgeKeys.map((k) => askSingleModel({ judgeKey: k, actions, userText, requesterUid, groupId, groupContextText, judgeFn }))
    )

    // 汇总（2026-09 修订）：异常模型排除出票，不参与判定；
    // 参与模型需全部 y 才放行；n / unknown（能回复但读不出 y/n）→ 取消。
    const verdicts = actions.map((a) => {
      const votes = perModel.map((map) => map.get(a.full))
      const participating = votes.filter((v) => v !== 'error')
      const excludedCount = votes.length - participating.length

      if (participating.length === 0) {
        // 无任何参与者：全部评审模型都调用异常，无法确认 → 取消
        return { full: a.full, type: a.type, ok: false, reasons: ['评审模型全部调用异常，无参与者可确认，操作取消'] }
      }

      if (participating.every((v) => v === 'y')) {
        const base = '全部参与评审模型一致同意'
        return {
          full: a.full,
          type: a.type,
          ok: true,
          reasons: excludedCount > 0 ? [`${base}（${excludedCount} 个调用异常模型已排除出票）`] : [base],
        }
      }

      const reasons = []
      votes.forEach((v, i) => {
        if (v === 'n') reasons.push(`模型${i + 1}否决`)
        else if (v === 'unknown') reasons.push(`模型${i + 1}能回复但未明确同意(y/n)，视为否决`)
        else if (v === 'error') reasons.push(`模型${i + 1}调用异常，已排除出票`)
      })
      if (!reasons.length) reasons.push('未获一致同意')
      return { full: a.full, type: a.type, ok: false, reasons }
    })

    return { actions, verdicts }
  } catch (err) {
    safeLogger.error(`[ai0-plugin] 群操作同行评审异常: ${err?.message || err}`)
    return { actions: parseGroupActions(replyText), verdicts: [] }
  }
}

function extractRequesterUid(e) {
  try {
    if (!e) return ''
    const uid = e.user_id ?? e.sender?.user_id ?? e.qq ?? ''
    return String(uid || '')
  } catch (_) { return '' }
}

function extractGroupContextText(groupId) {
  // 由调用方注入更完整的群上下文（可选），默认空。评审提示词已含操作/用户消息/目标。
  try { return groupId ? String(groupId) : '' } catch (_) { return '' }
}
