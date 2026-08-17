import * as cfg from '../config/index.js'

export function isMaster(userId) {
  const masters = cfg.get('permissions.masters', [])
  return masters.map(String).includes(String(userId))
}

export function isUserAllowed(userId, groupId = null) {
  const mode = cfg.get('permissions.whitelistMode', false)
  const blockedUsers = (cfg.get('permissions.blockedUsers', []) || []).map(String)
  const allowedUsers = (cfg.get('permissions.allowedUsers', []) || []).map(String)
  const blockedGroups = (cfg.get('permissions.blockedGroups', []) || []).map(String)
  const allowedGroups = (cfg.get('permissions.allowedGroups', []) || []).map(String)

  const uid = String(userId)
  const gid = groupId != null ? String(groupId) : null

  if (isMaster(uid)) return true

  if (blockedUsers.includes(uid)) return false
  if (gid != null && blockedGroups.includes(gid)) return false

  if (mode) {
    const userOk = allowedUsers.length === 0 || allowedUsers.includes(uid)
    const groupOk = gid == null || allowedGroups.length === 0 || allowedGroups.includes(gid)
    return userOk && groupOk
  }

  return true
}

export function getUserId(e) {
  return e?.user_id ?? e?.sender?.user_id ?? null
}

export function getGroupId(e) {
  return e?.group_id ?? e?.message?.group_id ?? null
}

export function getMessageText(e) {
  if (!e.message) return ''
  let text = ''
  for (const seg of e.message) {
    if (seg.type === 'text') text += (seg.text || '')
  }
  return text.trim()
}

export function isAtBot(e) {
  if (!e.message || !e.self_id) return false
  const selfId = String(e.self_id)
  for (const seg of e.message) {
    if (seg.type === 'at' && String(seg.qq) === selfId) return true
  }
  return false
}

export async function replyForward(e, text) {
  if (!e.group_id) return e.reply(text)
  try {
    const bot = e.bot ?? Bot
    const msg = typeof text === 'string'
      ? [{ type: 'text', text }]
      : text
    if (typeof e.bot?.makeForwardMsg === 'function') {
      const nodes = [
        {
          user_id: e.self_id || 0,
          nickname: 'AI',
          message: msg
        }
      ]
      const forwardMsg = await bot.makeForwardMsg(nodes)
      return e.reply(forwardMsg)
    }
  } catch (err) {
    logger.warn(`[ai0-plugin] 转发消息失败，降级为普通回复: ${err.message}`)
  }
  return e.reply(text)
}

export async function replyText(e, text, options = {}) {
  const threshold = cfg.get('response.forwardThreshold', 500)
  const useForward = cfg.get('response.useForwardMsg', true)
  if (useForward && typeof text === 'string' && text.length > threshold) {
    return replyForward(e, text)
  }
  return e.reply(text, false, options)
}
