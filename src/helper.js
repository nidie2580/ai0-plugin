import * as cfg from '../config/index.js'

function readFrameworkMasters() {
  const masters = new Set()
  try {
    if (typeof global !== 'undefined' && global.Config) {
      const g = global.Config
      for (const k of ['master', 'masters', 'masterQQ', 'qq', 'owner']) {
        const v = g[k]
        if (!v) continue
        ;(Array.isArray(v) ? v : [v]).forEach(x => {
          if (x != null && x !== '') masters.add(String(x))
        })
      }
      if (g.matcher) {
        const m = g.matcher
        for (const k of ['master', 'masters', 'masterQQ', 'qq', 'owner']) {
          const v = m[k]
          if (!v) continue
          ;(Array.isArray(v) ? v : [v]).forEach(x => {
            if (x != null && x !== '') masters.add(String(x))
          })
        }
      }
    }
  } catch (_) { /* ignore */ }
  return [...masters]
}

function readPluginMasters() {
  const v = cfg.get('permissions.masters', []) || []
  return (Array.isArray(v) ? v : [v]).map(x => String(x)).filter(Boolean)
}

export function listMasters() {
  const merged = new Set()
  for (const x of readFrameworkMasters()) merged.add(x)
  for (const x of readPluginMasters()) merged.add(x)
  return [...merged]
}

export function listMasterSources() {
  return {
    framework: readFrameworkMasters(),
    plugin: readPluginMasters()
  }
}

export function isMaster(userId, e = null) {
  if (userId == null) return false
  const uid = String(userId)

  // 1. Yunzai 框架事件对象自带字段
  if (e) {
    const em = e.isMaster ?? e.master
    if (em === true || em === 'true' || em === 1) return true
    if (em === false) {
      // 某些分支的 isMaster 默认 false，但插件里配置主人应允许，这里不提前 return false
    }
  }

  // 2. plugin 自己的配置文件（config.yaml: permissions.masters）
  if (readPluginMasters().includes(uid)) return true

  // 3. Yunzai 框架 Config（全局配置里的 master 列表）
  if (readFrameworkMasters().includes(uid)) return true

  return false
}

export function isUserAllowed(userId, groupId = null, e = null) {
  const mode = cfg.get('permissions.whitelistMode', false)
  const blockedUsers = (cfg.get('permissions.blockedUsers', []) || []).map(String)
  const allowedUsers = (cfg.get('permissions.allowedUsers', []) || []).map(String)
  const blockedGroups = (cfg.get('permissions.blockedGroups', []) || []).map(String)
  const allowedGroups = (cfg.get('permissions.allowedGroups', []) || []).map(String)

  const uid = userId != null ? String(userId) : null
  const gid = groupId != null ? String(groupId) : null

  if (uid && isMaster(uid, e)) return true

  if (uid && blockedUsers.includes(uid)) return false
  if (gid != null && blockedGroups.includes(gid)) return false

  if (mode) {
    const userOk = !uid || allowedUsers.length === 0 || allowedUsers.includes(uid)
    const groupOk = gid == null || allowedGroups.length === 0 || allowedGroups.includes(gid)
    return userOk && groupOk
  }

  return true
}

export function getUserId(e) {
  return e?.user_id ?? e?.sender?.user_id ?? e?.from_user ?? null
}

export function getGroupId(e) {
  return e?.group_id ?? e?.message?.group_id ?? e?.from_group ?? null
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
