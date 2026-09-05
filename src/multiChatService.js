/**
 * 网页端「模型互聊」服务
 *
 * 与 QQ 通道的 chatService.handleChat 并行：Web 后台里，登录者以"请求人的 QQ 号"身份，
 * 可选单个/多个模型、让这些模型"以各自模型名身份"就同一问题作答，模型间可互聊，
 * 并在多个回答中自动选出最合适的一条作为推荐结果。
 *
 * 与 QQ 链路的差异：
 *  1)会话仅内存/临时（不写入 llm 持久化 history 文件），刷新/重启后自然清零；
 *  2)用户身份取登录会话绑定的 QQ（未绑定则用机器人自身 QQ 号或 '机器人'）；
 *  3)回答以"纯文本 + [*] 前缀"生成，供前端聊天界面展示；同时写入独立互聊日志 chat-log。
 *
 * 所有 I/O 吞异常（Web 端辅助能力，失败不阻断主流程）。
 */
import * as cfg from '../config/index.js'
import * as llm from './llm.js'
import * as chatLog from './chatLog.js'
import * as chatService from './chatService.js'
import { safeLogger } from './globals.js'

const DEFAULT_SYSTEM_PROMPT = [
  '你是一个友善、乐于助人的AI助手，正在通过"模型互聊"界面与用户交流。',
  '请用简洁、自然的中文回答用户的问题。',
  '- 如果涉及违规/违法/敏感内容，请直接拒绝回答。',
  '- 保持礼貌。',
].join('\n')

// 临时会话（仅内存，重启即清）：conversations.set(userId, [msg...])
// 结构继承 chatService 的 [*] 标记协议，方便复用 collectArchiveReplies 提取其他模型发言。
const conversations = new Map()
const MAX_CONV = 2000
const MAX_MSGS = 60

function getSystemPrompt() {
  try {
    const rawCfg = cfg.loadConfig() || {}
    const p = rawCfg.system && rawCfg.system.prompt
    if (typeof p === 'string' && p.length) return p
    if (p === '') return ''
  } catch (_) {}
  return DEFAULT_SYSTEM_PROMPT
}

/** 登录者展示名：优先登录绑定的 QQ；无绑定则用机器人自身 QQ，再兜底 '机器人'。 */
export function resolveUserLabel(token = null, req = null) {
  try {
    const identity = req ? req.webIdentity : null
    if (identity && String(identity).trim()) return String(identity).trim()
  } catch (_) {}
  try {
    const selfId = cfg.get('bot.self_id', '') || cfg.get('bot.uin', '')
    if (selfId && String(selfId).trim()) return String(selfId).trim()
  } catch (_) {}
  return '机器人'
}

function modelDisplayName(key) {
  const m = cfg.loadConfig().model || {}
  return String(m[key]?.name || m[key]?.model || key)
}

function pruneConversation() {
  if (conversations.size <= MAX_CONV) return
  const need = conversations.size - MAX_CONV
  for (const k of conversations.keys()) {
    if (need <= 0) break
    conversations.delete(k)
  }
}

function getConversation(userId) {
  return conversations.get(userId) || []
}

/** 内存会话追加：保留最近 MAX_MSGS 条，防止无限膨胀。 */
function pushMessages(userId, msgs) {
  let next = [...getConversation(userId), ...(msgs || [])]
  if (next.length > MAX_MSGS) next = next.slice(-MAX_MSGS)
  conversations.set(userId, next)
  pruneConversation()
}

/**
 * 用默认模型（或 judgeModel）从多个回答里选出最合适的一条。
 * @returns {{model:string, text:string}} 选中的回答；失败时退回第一条。
 */
async function pickBestAnswer({ question, replies, modelDisplay }) {
  const usable = (Array.isArray(replies) ? replies : []).filter((r) => r.text)
  if (!usable.length) return null
  if (usable.length === 1) return usable[0]
  const judgeKey = cfg.get('chat.multiModel.judgeModel', null) || cfg.get('model.default', 'openai-compatible')
  try {
    const numbered = usable.map((r, i) => `${i + 1}. [${modelDisplay(r.modelKey)}]\n${r.text}`).join('\n\n')
    const judgePrompt = [
      `请根据用户的问题，从下面 ${usable.length} 个不同模型的回答里选出【最合适、最贴合用户意图】的一个。`,
      `只输出你选择的那一项的编号（一个数字），不要输出其他内容。`,
      ``,
      `用户问题：${question}`,
      ``,
      `回答列表：`,
      numbered,
    ].join('\n')
    const msgs = [
      { role: 'system', content: '你是严谨的回答评审，从候选里挑最优，只回答编号数字。' },
      { role: 'user', content: judgePrompt },
    ]
    const res = await llm.chatCompletions(msgs, { modelKey: judgeKey, temperature: 0.2, overrideMaxTokens: 16 })
    const txt = String(res?.text || '').trim()
    const m = txt.match(/(\d+)/)
    const idx = m ? parseInt(m[1], 10) - 1 : -1
    if (idx >= 0 && idx < usable.length) return usable[idx]
    // 无法解析时，尝试识别选中项文本里出现的模型展示名
    for (const r of usable) {
      if (txt && txt.includes(modelDisplay(r.modelKey))) return r
    }
    return usable[0]
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 最优回答裁判调用失败（退回第一条）: ${err?.message || err}`)
    return usable[0]
  }
}

/**
 * 执行一轮网页端模型互聊。
 * @param {{
 *   userId:string, userLabel?:string,
 *   question:string,
 *   modelKeys?:string[],          // 选中的模型 key；缺省=全部已配置模型
 *   multiChat?:boolean,           // 是否让模型彼此看到历史发言
 * }} opts
 * @returns {Promise<{ok:boolean, replies:Array<{modelKey:string,model:string,text:string}>,
 *   best?:{model:string,text:string}|null, msg?:string}>}
 */
export async function runWebMultiChat({ userId, userLabel, question, modelKeys, multiChat }) {
  try {
    const cfgMM = cfg.get('chat.multiModel', {}) || {}
    const multiChatEnabled = cfgMM.multiChat !== false && multiChat !== false

    // 参与模型：用户选中的（过滤掉不可用），缺省=全部已配置
    const all = chatService.listConfiguredModels()
    const chosen = Array.isArray(modelKeys) && modelKeys.length && modelKeys.some((k) => all.includes(k))
      ? all.filter((k) => modelKeys.includes(k))
      : all
    if (!chosen.length) {
      return { ok: false, msg: '没有可用的模型，请先在「多API平台」配置至少一个模型' }
    }

    const display = (k) => modelDisplayName(k)
    const questionStr = String(question || '').trim()
    if (!questionStr) return { ok: false, msg: '问题不能为空' }

    // —— 组装请求历史：system + 内存会话历史 + 本轮用户消息 ——
    const sysPrompt = getSystemPrompt()
    const sys = {
      role: 'system',
      content: multiChatEnabled ? sysPrompt + '\n\n' + chatService.MULTI_CHAT_PROTOCOL : sysPrompt,
    }
    const prior = getConversation(userId).map((m) => (m && typeof m === 'object' ? { ...m } : m))
    const baseHistory = [sys, ...prior]

    // 从内存历史提取"其他模型的 [*] 发言"
    const archiveReplies = chatService.collectArchiveReplies(baseHistory)

    // 并行调用各模型：互相独立，失败互不影响
    const tasks = chosen.map(async (k) => {
      const userMsg = { role: 'user', content: questionStr }
      let reqHistory = [...baseHistory, userMsg]
      // 互聊开启时注入历史中其他模型的发言，模型可看到彼此旧话
      reqHistory = chatService.buildMultiChatRequest({
        reqHistory,
        archiveReplies,
        modelKey: k,
        modelDisplay: display,
        multiChatEnabled,
      })
      const res = await llm.chatCompletions(reqHistory, { modelKey: k })
      return { modelKey: k, text: String(res?.text || '').trim() }
    })
    const results = await Promise.allSettled(tasks)
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value).filter((r) => r.text)
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length) {
      safeLogger.warn(`[ai0-plugin] 网页互聊有 ${failed.length} 个模型调用失败: ${String(failed[0].reason?.message || failed[0].reason)}`)
    }

    const replies = ok.map((r) => ({ modelKey: r.modelKey, model: display(r.modelKey), text: r.text }))

    // 自动选最优
    let best = null
    if (replies.length) {
      best = await pickBestAnswer({ question: questionStr, replies, modelDisplay: display })
    }

    // 写入内存会话：本轮用户消息 + 各模型 [*] 发言（供下一轮互聊可见）
    const convMsgs = [{ role: 'user', content: questionStr }]
    if (multiChatEnabled) {
      for (const r of replies) {
        const flat = String(r.text || '').replace(/\s*\n\s*/g, '；')
        convMsgs.push({ role: 'assistant', content: `[*] ${r.model}：${flat}` })
      }
    } else {
      for (const r of replies) {
        convMsgs.push({ role: 'assistant', content: String(r.text || '') })
      }
    }
    pushMessages(userId, convMsgs)

    // 独立互聊日志（与 QQ 链路共用 chat-log，供「模型互聊 · 日志」页展示）
    try {
      if (replies.length) {
        chatLog.appendChatLog({
          userId,
          sessionId: 'web:' + userId,
          question: questionStr.slice(0, 4000),
          replies: replies.map((r) => ({ model: r.model, text: r.text.slice(0, 8000) })),
        })
      }
    } catch (logErr) {
      safeLogger.warn(`[ai0-plugin] 网页互聊写入日志失败: ${logErr?.message || logErr}`)
    }

    return { ok: true, replies, best }
  } catch (err) {
    safeLogger.error(`[ai0-plugin] 网页互聊执行异常: ${err?.message || err}`)
    return { ok: false, msg: '模型互聊执行出错，请检查模型配置后重试' }
  }
}

/** 读取某用户的临时会话历史（供前端聊天界面展示，仅内存）。 */
export function readWebConversation(userId) {
  try {
    return getConversation(userId)
  } catch (_) {
    return []
  }
}

/** 清空某用户的临时会话（对应「清空聊天」按钮）。 */
export function clearWebConversation(userId) {
  conversations.delete(userId)
}
