/**
 * 记忆指令：#记忆/#记住、#全局记忆、#记忆搜索、#查看记忆、#删除记忆
 * 作用域：群聊 → group-<群号>；私聊 → user-<用户>；#全局记忆 → global（仅主人）
 * 注意：plugin 基类由 Yunzai 全局注入（与本插件其他 app 一致），不显式 import
 */
import * as cfg from '../config/index.js'
import * as helper from '../src/helper.js'
import * as memory from '../src/memory.js'

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
    await e.reply(ok ? `✅ 已记到${label}：${text.slice(0, 80)}` : '❌ 记忆写入失败')
    return true
  }

  async addGlobal(e) {
    const m = e.msg.match(/^#全局记忆[ :：]?([\s\S]+)$/)
    const text = (m?.[1] || '').trim()
    if (!text) return false
    const ok = memory.writeGlobal(text)
    await e.reply(ok ? '✅ 已记到全局记忆（所有会话可见）' : '❌ 写入失败')
    return true
  }

  async search(e) {
    const m = e.msg.match(/^#记忆搜索[ :：]?([\s\S]+)$/)
    const q = (m?.[1] || '').trim()
    if (!q) return false
    const { scope } = this._scope(e)
    const hits = memory.searchMemory([scope, 'global'], q, 8)
    await e.reply(hits.length ? `🔎 记忆检索（${q.slice(0, 30)}）：\n${hits.join('\n')}` : `没有找到与「${q.slice(0, 30)}」相关的记忆`)
    return true
  }

  async list(e) {
    const { scope, label } = this._scope(e)
    const rec = memory.listRecent(scope, 3, 1200)
    await e.reply(rec.length ? `📒 ${label}（近3天，共${rec.length}条）：\n${rec.join('\n')}` : `${label}暂无内容`)
    return true
  }

  async del(e) {
    const m = e.msg.match(/^#删除记忆[ :：]?([\s\S]+)$/)
    const q = (m?.[1] || '').trim()
    if (!q) return false
    const { scope } = this._scope(e)
    const n = memory.deleteEntries([scope, 'global'], q)
    await e.reply(n ? `🗑️ 已删除 ${n} 条含「${q.slice(0, 30)}」的记忆` : `没有找到含「${q.slice(0, 30)}」的记忆`)
    return true
  }
}
