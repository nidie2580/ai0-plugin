/**
 * 记忆指令：#记忆/#记住、#全局记忆、#记忆搜索、#查看记忆、#删除记忆
 * 作用域：群聊 → group-<群号>；私聊 → user-<用户>；#全局记忆 → global（仅主人）
 * 注意：plugin 基类由 Yunzai 全局注入（与本插件其他 app 一致），不显式 import
 *
 * 2026-11-18：接入 API 平台远端记忆（/v1/memory）。本地永远先写，远端同步失败只影响 ☁️ 标记。
 */
import * as cfg from '../config/index.js'
import * as helper from '../src/helper.js'
import * as memory from '../src/memory.js'
import * as remote from '../src/remoteMemory.js'

export class AIMemory extends plugin {
  constructor() {
    super({
      name: 'AI0-Memory',
      dsc: 'AI插件长期记忆',
      event: 'message',
      priority: 4980,
      rule: [
        { reg: '^#(记忆|记住)[ :：]([\\s\\S]+)$', fnc: 'add', permission: 'all', log: false },
        { reg: '^#全局记忆[ :：]([\\s\\S]+)$', fnc: 'addGlobal', permission: 'master', log: false },
        { reg: '^#记忆搜索[ :：]([\\s\\S]+)$', fnc: 'search', permission: 'all', log: false },
        { reg: '^#(查看记忆|记忆列表)$', fnc: 'list', permission: 'all', log: false },
        { reg: '^#删除记忆[ :：]([\\s\\S]+)$', fnc: 'del', permission: 'master', log: false },
      ],
    })
  }

  _scope(e) {
    const groupId = helper.getGroupId(e)
    const userId = helper.getUserId(e)
    const isGroup = !!groupId
    const scope = isGroup ? `group-${groupId}` : `user-${userId}`
    const label = isGroup ? '本群记忆' : '个人记忆'
    return { scope, label, isGroup, userId }
  }

  async add(e) {
    if (cfg.get('memory.enabled', true) === false) return false
    const m = e.msg.match(/^#(?:记忆|记住)[ :：]?([\s\S]+)$/)
    const text = (m?.[1] || '').trim()
    if (!text) return false
    const { scope, label } = this._scope(e)
    const ok = memory.writeEntry(scope, text)
    let synced = false
    if (ok) {
      try {
        synced = await remote.push(scope, text)
      } catch {
        synced = false
      }
    }
    await e.reply(ok ? `✅ 已记到${label}：${text.slice(0, 80)}${synced ? ' ☁️' : ''}` : '❌ 记忆写入失败')
    return true
  }

  async addGlobal(e) {
    const m = e.msg.match(/^#全局记忆[ :：]?([\s\S]+)$/)
    const text = (m?.[1] || '').trim()
    if (!text) return false
    const ok = memory.writeGlobal(text)
    let synced = false
    if (ok) {
      try {
        synced = await remote.push('global', text)
      } catch {
        synced = false
      }
    }
    await e.reply(ok ? `✅ 已记到全局记忆（所有会话可见）${synced ? ' ☁️' : ''}` : '❌ 写入失败')
    return true
  }

  async search(e) {
    const m = e.msg.match(/^#记忆搜索[ :：]?([\s\S]+)$/)
    const q = (m?.[1] || '').trim()
    if (!q) return false
    const { scope } = this._scope(e)
    const hits = memory.searchMemory([scope, 'global'], q, 8)
    let cloud = []
    try {
      cloud = await remote.search(q, { limit: 5 })
    } catch {
      cloud = []
    }
    const lines = [...hits, ...cloud.map((t) => `☁️ ${t}`)]
    await e.reply(
      lines.length
        ? `🔎 记忆检索（${q.slice(0, 30)}）：\n${lines.join('\n')}`
        : `没有找到与「${q.slice(0, 30)}」相关的记忆`
    )
    return true
  }

  async list(e) {
    const { scope, label } = this._scope(e)
    const rec = memory.listRecent(scope, 3, 1200)
    let cloud = ''
    try {
      const st = await remote.stats()
      if (st.count > 0) {
        cloud = `\n☁️ 云端共 ${st.count} 条（${(st.used / 1048576).toFixed(1)}/${(st.quota / 1048576).toFixed(0)}MB）`
      }
    } catch {
      cloud = ''
    }
    await e.reply(rec.length ? `📒 ${label}（近3天，共${rec.length}条）：\n${rec.join('\n')}${cloud}` : `${label}暂无内容${cloud}`)
    return true
  }

  async del(e) {
    const m = e.msg.match(/^#删除记忆[ :：]?([\s\S]+)$/)
    const q = (m?.[1] || '').trim()
    if (!q) return false
    const { scope } = this._scope(e)
    const n = memory.deleteEntries([scope, 'global'], q)
    let rn = 0
    try {
      rn = await remote.removeMatching(q)
    } catch {
      rn = 0
    }
    await e.reply(
      n || rn
        ? `🗑️ 已删除 ${n} 条含「${q.slice(0, 30)}」的记忆${rn ? `，云端 ${rn} 条` : ''}`
        : `没有找到含「${q.slice(0, 30)}」的记忆`
    )
    return true
  }
}
