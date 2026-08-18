import { randomUUID } from 'node:crypto'
import * as cfg from '../config/index.js'
import * as llm from './llm.js'
import * as helper from './helper.js'
import * as groupOps from './groupOps.js'

const userSession = new Map()

function getUserSessionKey(userId) {
  return `current:${userId}`
}

export function getCurrentSession(userId) {
  const k = getUserSessionKey(userId)
  let sid = userSession.get(k)
  if (!sid) {
    sid = randomUUID()
    userSession.set(k, sid)
  }
  return sid
}

export function newSession(userId) {
  const sid = randomUUID()
  userSession.set(getUserSessionKey(userId), sid)
  return sid
}

/**
 * 把解析出来的上下文（引用消息 + 转发聊天记录 + 当前消息）注入进 history。
 * 注入顺序：
 *   1) 原始 system prompt（如果配置了）
 *   2) 如果 includeSenderTag=true，追加一条"对话格式约定"system 提示（告诉LLM每条消息都带【发件人】标签）
 *   3) 如果引用消息里包含"合并转发聊天记录"：把转发节点按顺序平铺成 user/assistant 对话（默认）
 *   4) 如果被引用消息本身是普通文本：把它作为引用上下文
 *   5) 如果当前消息里包含"合并转发聊天记录"：把转发节点按顺序平铺（当前消息若包含引用+正文+转发三者，放在引用之后、当前正文之前）
 *   6) 最后放当前用户正文（带/不带发件人标签，看 includeSenderTag）
 */
function injectContextIntoHistory({ history, sysPrompt, parsed, opts, modelConfigName = 'AI' }) {
  const includeSenderTag = !!opts.includeSenderTag
  const includeQuote = !!opts.includeQuote
  const includeForward = !!opts.includeForward
  const quoteAsSystem = !!opts.quoteAsSystem

  let next = history.slice()

  // 1) system prompt + 对话格式约定
  const systemLines = []
  if (sysPrompt) systemLines.push(sysPrompt)
  if (includeSenderTag) {
    systemLines.push(
      '【对话格式约定】：以下对话中每条用户消息都会附带发件人标识（形如"【张三】：\n内容"）；若某个发件人以"（AI）"结尾，说明这条消息就是你（机器人/AI）之前发送的消息。' +
        '请你在回复时区分不同发言者，针对被引用/被转发的上下文也能准确理解对方在跟谁说、说的是什么。' +
        '你的最终回复只需要输出回答内容本身，不需要再在回复开头重复"【某某】"标签。'
    )
  }
  if (systemLines.length) {
    const existingSys = next.length && next[0].role === 'system' ? next[0].content : ''
    const merged = existingSys
      ? existingSys + (existingSys.endsWith('\n') ? '' : '\n') + systemLines.join('\n\n')
      : systemLines.join('\n\n')
    next = [{ role: 'system', content: merged }, ...(existingSys ? next.slice(1) : next)]
  }

  // 2) 引用消息里的合并转发（通常比"被引用的那一条单消息"更早）
  if (includeForward && Array.isArray(parsed.forwardFromQuote) && parsed.forwardFromQuote.length) {
    for (const turn of parsed.forwardFromQuote) {
      if (!turn || !turn.text) continue
      next.push({
        role: turn.isBot ? 'assistant' : 'user',
        content: includeSenderTag
          ? helper.formatTurnForPrompt({ ...turn, tagBotAs: modelConfigName })
          : turn.text
      })
    }
  }

  // 3) 被引用的消息本身（通常是用户"回复"按钮引用的那条）
  if (includeQuote && parsed.quote && parsed.quote.text) {
    if (quoteAsSystem) {
      // 作为一条单独的 system 说明喂进去，减少引用文本被"当成是新的用户提问"的概率
      const q = parsed.quote
      const desc =
        `【引用消息】用户引用了下面这条消息作为上下文（原消息发送者：${q.name || (q.isBot ? 'AI' : '用户')}${q.isBot ? '（AI）' : ''}，user_id=${q.user_id ?? '未知'}）：` +
        `\n${includeSenderTag ? helper.formatTurnForPrompt({ ...q, tagBotAs: modelConfigName }) : q.text}`
      next.push({ role: 'system', content: desc })
    } else {
      next.push({
        role: parsed.quote.isBot ? 'assistant' : 'user',
        content: includeSenderTag
          ? helper.formatTurnForPrompt({ ...parsed.quote, tagBotAs: modelConfigName })
          : parsed.quote.text
      })
    }
  }

  // 4) 当前消息里包含的合并转发（用户直接把一段聊天记录贴给你）
  if (includeForward && Array.isArray(parsed.forwardFromCurrent) && parsed.forwardFromCurrent.length) {
    next.push({
      role: 'system',
      content: `【当前消息附带的合并转发聊天记录（共 ${parsed.forwardFromCurrent.length} 条）如下，按时间顺序排列：`
    })
    for (const turn of parsed.forwardFromCurrent) {
      if (!turn || !turn.text) continue
      next.push({
        role: turn.isBot ? 'assistant' : 'user',
        content: includeSenderTag
          ? helper.formatTurnForPrompt({ ...turn, tagBotAs: modelConfigName })
          : turn.text
      })
    }
  }

  // 5) 当前用户的正文（helper 已剥离 reply/quote 段，避免重复注入引用）
  const cur = parsed.current
  if (cur && cur.text) {
    next.push({
      role: 'user',
      content: includeSenderTag
        ? helper.formatTurnForPrompt({ ...cur, tagBotAs: modelConfigName })
        : cur.text
    })
  }

  return next
}

export async function handleChat(e) {
  const userId = helper.getUserId(e)
  const groupId = helper.getGroupId(e)
  const text = helper.getMessageText(e)
  const isGroup = !!groupId

  if (!userId || !text) return false

  if (!helper.isUserAllowed(userId, groupId, e)) {
    return false
  }

  const groupAtReply = cfg.get('chat.groupAtReply', true)
  const privateReply = cfg.get('chat.privateReply', true)
  const triggerPrefix = cfg.get('chat.triggerPrefix', []) || []

  // 全局AI模式：开启后在指定群内所有消息都回复，不需要@
  const globalAI = cfg.get('chat.globalAI', false) === true
  const globalAIGroups = (cfg.get('chat.globalAIGroups', []) || []).map(String)
  const globalAIIgnorePrefix = cfg.get('chat.globalAIIgnorePrefix', ['#', '/', '！']) || []

  // 先做一次结构化解析（同时会把引用消息/合并转发聊天记录递归展开）
  const parsed = helper.parseMessageWithContext?.(e) || {
    current: { user_id: userId != null ? String(userId) : null, name: '', text, isBot: false },
    quote: null,
    forwardFromQuote: [],
    forwardFromCurrent: []
  }

  // 触发条件：原逻辑基于 `text`（完整文本）做前缀/at 判断，避免因剥离 reply 段导致误判；纯文本内容后续改用 parsed.current.text
  let matched = false
  let pureText = text

  if (isGroup) {
    // 全局AI模式：在指定群内，所有非命令消息都触发
    const inGlobalGroup = globalAI && globalAIGroups.includes(String(groupId))
    const isIgnored = globalAIIgnorePrefix.some(p => text.startsWith(p))

    if (inGlobalGroup && !isIgnored) {
      matched = true
    }

    // 原有逻辑：@机器人 或 前缀触发（与全局AI叠加，不会互斥）
    if (!matched) {
      if (!groupAtReply && !inGlobalGroup) return false
      if (helper.isAtBot(e)) {
        matched = true
      }
    }

    // 去掉 @机器人 部分
    if (matched) {
      pureText = pureText
        .replace(/^@\S+\s*/, '')
        .replace(/\s*@\S+$/, '')
        .trim()
    }
  } else {
    if (privateReply) matched = true
  }

  for (const prefix of triggerPrefix) {
    if (text.startsWith(prefix)) {
      matched = true
      pureText = text.slice(prefix.length).trim()
      break
    }
  }

  if (!matched) return false

  // 如果 parsed.current.text 能拿到更干净的正文（已去掉 reply/quote 段等），优先用它
  const baseForPure = (parsed.current?.text && typeof parsed.current.text === 'string')
    ? parsed.current.text
    : text
  if (baseForPure) {
    let trimmed = baseForPure
    for (const prefix of triggerPrefix) {
      if (trimmed.startsWith(prefix)) {
        trimmed = trimmed.slice(prefix.length).trim()
        break
      }
    }
    if (isGroup) {
      trimmed = trimmed.replace(/^@\S+\s*/, '').replace(/\s*@\S+$/, '').trim()
    }
    if (trimmed) pureText = trimmed
  }
  if (!pureText) return false
  // 把纯净版正文回填，后面注入 history 时也用它，避免重复引用段
  if (parsed.current) parsed.current.text = pureText

  // 「我正在思考中」占位消息：默认关闭。想开启的话在 config.yaml 写 response.showThinkingHint: true
  const showThinkingHint = cfg.get('response.showThinkingHint', false)
  const thinkingDelay = Math.max(0, Number(cfg.get('response.thinkingDelay', 0) ?? cfg.get('response.typingDelay', 0) ?? 0))

  if (showThinkingHint) {
    const sendHint = () => {
      try {
        if (isGroup && e.group_id) {
          (e.bot || Bot).pickGroup?.(e.group_id).sendMsg?.('我正在思考中...').catch(() => {})
        } else if (userId) {
          (e.bot || Bot).pickFriend?.(userId).sendMsg?.('我正在思考中...').catch(() => {})
        }
      } catch {}
    }
    if (thinkingDelay > 0) setTimeout(sendHint, thinkingDelay)
    else sendHint()
  }

  const contextSize = cfg.get('chat.contextSize', 10)
  const sysPrompt = cfg.get('system.prompt', '')
  const sessionId = getCurrentSession(userId)

  const maxSessions = cfg.get('chat.maxSessionsPerUser', 3)
  const timeoutMs = cfg.get('chat.sessionTimeout', 1800000)
  llm.cleanupOldSessions(userId, maxSessions, timeoutMs)

  // 新增上下文开关：默认开启；用户可在 config.yaml 关闭其中任何一项
  const contextOpts = {
    includeQuote: cfg.get('chat.includeQuote', true) !== false,
    includeForward: cfg.get('chat.includeForward', true) !== false,
    includeSenderTag: cfg.get('chat.includeSenderTag', true) !== false,
    quoteAsSystem: cfg.get('chat.quoteAsSystem', true) !== false,
  }
  const modelCfg = cfg.loadConfig().model || {}
  const defaultKey = modelCfg.default || 'openai-compatible'
  const modelNameCfg = modelCfg?.[defaultKey]?.name || modelCfg?.[defaultKey]?.model || 'AI'

  let history = llm.loadHistory(userId, sessionId)
  if (sysPrompt && (!history.length || history[0].role !== 'system')) {
    history = [{ role: 'system', content: sysPrompt }, ...history]
  }

  // 群聊时注入群操作上下文（主人列表/请求者角色/目标角色/机器人角色/操作规则/动作格式）
  let groupContext = null
  if (isGroup && cfg.get('groupOps.enabled', true) !== false) {
    try {
      groupContext = await groupOps.buildGroupContext(e)
    } catch (err) {
      logger.warn(`[ai0-plugin] 构建群操作上下文失败: ${err.message}`)
    }
  }

  // 注入引用消息 + 合并转发 + 发件人标签
  history = injectContextIntoHistory({
    history,
    sysPrompt: groupContext ? sysPrompt + '\n\n' + groupContext : sysPrompt,
    parsed,
    opts: contextOpts,
    modelConfigName: modelNameCfg
  })

  // 裁剪：确保总消息数不爆炸（系统提示始终保留）
  if (history.length > contextSize * 2 + 8) {
    const sys = []
    let idx = 0
    while (idx < history.length && history[idx].role === 'system') {
      sys.push(history[idx])
      idx++
    }
    const rest = history.slice(idx)
    history = [...sys, ...rest.slice(-(contextSize * 2 + 2))]
  }

  let replyText = ''
  let modelName = ''
  try {
    const res = await llm.chatCompletions(history)
    replyText = res.text
    modelName = res.modelName
  } catch (err) {
    logger.error(`[ai0-plugin] LLM 调用失败: ${err.message}`)
    replyText = `(调用失败：${err.message?.replace(/sk-[A-Za-z0-9]+/g, 'sk-***') || '未知错误'})`
  }

  if (replyText) {
    // 如果是群聊且开启了群操作，解析AI回复中的操作指令并执行
    if (isGroup && groupContext) {
      try {
        const { cleanText, results } = await groupOps.parseAndExecuteActions(replyText, groupId)
        // 用干净文本（去掉操作指令后的）存入历史和回复
        replyText = cleanText
        if (results.length) {
          const actionReport = results.map(r =>
            r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`
          ).join('\n')
          replyText = replyText + '\n\n' + actionReport
          logger.info(`[ai0-plugin] 群操作执行结果: ${JSON.stringify(results)}`)
        }
      } catch (err) {
        logger.error(`[ai0-plugin] 群操作执行异常: ${err.message}`)
      }
    }

    history.push({ role: 'assistant', content: replyText })
    llm.saveHistory(userId, sessionId, history)
  }

  // 默认只输出 AI 纯回复，不加任何固定后缀。想追加模型名标签可在 config.yaml 里 response.showModelTag: true
  let finalText = replyText || '（没有产生回复内容）'
  if (cfg.get('response.showModelTag', false) && modelName) {
    finalText += `\n\n—— ${modelName}`
  }

  await helper.replyText(e, finalText)
  return true
}
