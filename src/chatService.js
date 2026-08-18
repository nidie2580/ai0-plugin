import { randomUUID } from 'node:crypto'
import * as cfg from '../config/index.js'
import * as llm from './llm.js'
import * as helper from './helper.js'

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

  let matched = false
  let pureText = text

  if (isGroup) {
    if (!groupAtReply) return false
    if (helper.isAtBot(e)) {
      matched = true
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

  if (!matched || !pureText) return false

  if (cfg.get('response.typingDelay', 0) > 0) {
    try {
      if (isGroup && e.group_id) {
        (e.bot || Bot).pickGroup?.(e.group_id).sendMsg?.('我正在思考中...')
          .catch(() => {})
      } else if (userId) {
        (e.bot || Bot).pickFriend?.(userId).sendMsg?.('我正在思考中...')
          .catch(() => {})
      }
    } catch {}
  }

  const contextSize = cfg.get('chat.contextSize', 10)
  const sysPrompt = cfg.get('system.prompt', '')
  const sessionId = getCurrentSession(userId)

  const maxSessions = cfg.get('chat.maxSessionsPerUser', 3)
  const timeoutMs = cfg.get('chat.sessionTimeout', 1800000)
  llm.cleanupOldSessions(userId, maxSessions, timeoutMs)

  let history = llm.loadHistory(userId, sessionId)
  if (sysPrompt && (!history.length || history[0].role !== 'system')) {
    history = [{ role: 'system', content: sysPrompt }, ...history]
  }

  history.push({ role: 'user', content: pureText })

  if (history.length > contextSize * 2 + 2) {
    const sys = history[0].role === 'system' ? [history[0]] : []
    const rest = history.slice(sys.length)
    history = [...sys, ...rest.slice(-contextSize * 2)]
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
    history.push({ role: 'assistant', content: replyText })
    llm.saveHistory(userId, sessionId, history)
  }

  let finalText = replyText || '（没有产生回复内容）'
  if (cfg.get('response.showModelTag', true) && modelName) {
    finalText += `\n\n—— ${modelName}`
  }

  await helper.replyText(e, finalText)
  return true
}
