import * as cfg from '../config/index.js'
import * as helper from '../src/helper.js'

/**
 * AI0-Plugin 群操作命令模块
 *
 * 群管理操作（踢出/禁言/管理员/头衔）已改为 AI 驱动：
 *   用户像聊天一样对 AI 说"@机器人 禁言一下@某人 10分钟"
 *   AI 判断合法性后在回复中输出操作指令，插件自动执行
 *   （核心逻辑见 src/groupOps.js + src/chatService.js）
 *
 * 本文件仅保留全局AI开关命令。
 */
export class GroupOps extends plugin {
  constructor() {
    super({
      name: 'AI0-GroupOps',
      dsc: 'AI群操作：全局AI开关',
      event: 'message',
      priority: 4500,
      rule: [
        { reg: '^#ai(全局ai|全局AI|globalai)(\\s+\\S+)?$', fnc: 'toggleGlobalAI', permission: 'master' },
      ]
    })
  }

  /** #ai全局ai on/off 或 #ai全局ai（查看状态） */
  async toggleGlobalAI() {
    const e = this.e
    const userId = helper.getUserId(e)
    const masters = helper.listMasters()
    if (!masters.includes(String(userId))) {
      return e.reply('❌ 仅机器人主人可以切换全局AI模式。')
    }

    const text = helper.getMessageText(e)
    const arg = text.replace(/^#ai(全局ai|全局AI|globalai)\s*/i, '').trim().toLowerCase()

    const config = cfg.loadConfig()
    if (!config.chat) config.chat = {}

    if (arg === 'on' || arg === '开' || arg === '开启' || arg === 'true') {
      config.chat.globalAI = true
      if (e.group_id) {
        if (!Array.isArray(config.chat.globalAIGroups)) config.chat.globalAIGroups = []
        const gid = String(e.group_id)
        if (!config.chat.globalAIGroups.includes(gid)) {
          config.chat.globalAIGroups.push(gid)
        }
      }
      cfg.saveConfig(config)
      const groups = (config.chat.globalAIGroups || []).join(', ')
      return e.reply(`✅ 全局AI已开启\n当前启用群：${groups || '(未设置，群聊中将不生效)'}\n\n💡 开启后，这些群内所有消息都会触发AI回复（无需@）。AI同时具备群管理能力（踢出/禁言/头衔等）。`)
    }

    if (arg === 'off' || arg === '关' || arg === '关闭' || arg === 'false') {
      config.chat.globalAI = false
      cfg.saveConfig(config)
      return e.reply('✅ 全局AI已关闭，群聊中仅回复@机器人的消息。')
    }

    const status = config.chat?.globalAI ? '✅ 开启' : '❌ 关闭'
    const groups = (config.chat?.globalAIGroups || []).join(', ')
    return e.reply(
      `全局AI模式：${status}\n` +
      `启用群号：${groups || '(空)'}\n\n` +
      `用法：\n` +
      `  #ai全局ai 开  → 开启（当前群自动加入列表）\n` +
      `  #ai全局ai 关  → 关闭\n` +
      `  也可在 config.yaml 中手动设置 chat.globalAIGroups 列表`
    )
  }
}
