import * as cfg from '../config/index.js'
import * as helper from '../src/helper.js'
import * as chatSvc from '../src/chatService.js'
import * as ws from '../src/webServer.js'
import * as auth from '../src/auth.js'

export class AICommands extends plugin {
  constructor() {
    super({
      name: 'AI0-Commands',
      dsc: 'AI插件命令管理',
      event: 'message',
      priority: 4999,
      rule: [
        {
          reg: '^#ai(帮助|help|菜单)?$',
          fnc: 'help',
          permission: 'all'
        },
        {
          reg: '^#ai(新会话|重置|clear)$',
          fnc: 'resetSession',
          permission: 'all'
        },
        {
          reg: '^#ai模型$',
          fnc: 'showModel',
          permission: 'all'
        },
        {
          reg: '^#ai设置模型\\s+.+',
          fnc: 'setModel',
          permission: 'master'
        },
        {
          reg: '^#ai设置apikey\\s+.+',
          fnc: 'setApiKey',
          permission: 'master'
        },
        {
          reg: '^#ai设置api\\s+.+',
          fnc: 'setApiBase',
          permission: 'master'
        },
        {
          reg: '^#ai添加主人\\s+\\d+',
          fnc: 'addMaster',
          permission: 'master'
        },
        {
          reg: '^#ai(重载|重新加载|reload)$',
          fnc: 'reloadConfig',
          permission: 'master'
        },
        {
          reg: '^#ai(网页管理|web|后台)$',
          fnc: 'webAdmin',
          permission: 'master'
        },
        {
          reg: '^#ai网页(启动|开启)$',
          fnc: 'webStart',
          permission: 'master'
        },
        {
          reg: '^#ai网页(关闭|停止)$',
          fnc: 'webStop',
          permission: 'master'
        },
        {
          reg: '^#ai(生成验证码|验证码)$',
          fnc: 'genCode',
          permission: 'master'
        }
      ]
    })
  }

  async help() {
    const info = ws.getServerInfo()
    const lines = [
      '🤖 AI0-Plugin 帮助菜单',
      '',
      '【对话】',
      '  群聊艾特我 / 私聊直接发消息即可对话',
      '',
      '【常用命令】',
      '  #ai帮助        查看此菜单',
      '  #ai新会话       开启新的对话（清空上下文）',
      '  #ai模型         查看当前使用的模型配置',
      '',
      '【网页管理后台】(仅主人)',
      `  #ai网页管理     生成免登录直链（${info.running ? '运行中' : '未启动'}）`,
      '  #ai网页启动     启动网页后台',
      '  #ai网页关闭     关闭网页后台',
      '  #ai验证码       生成终端验证码（用于网页登录）',
      '',
      '【管理命令】(仅主人)',
      '  #ai设置模型 <模型名>',
      '  #ai设置apikey <key>',
      '  #ai设置api <apiBaseURL>',
      '  #ai添加主人 <QQ号>',
      '  #ai重载         重新加载配置文件',
      '',
      '💡 详细配置：plugins/ai0-plugin/config/config.yaml'
    ]
    return this.e.reply(lines.join('\n'))
  }

  async resetSession() {
    const userId = helper.getUserId(this.e)
    if (!userId) return false
    chatSvc.newSession(userId)
    return this.e.reply('✅ 已开启新的会话，上下文已清空。')
  }

  async showModel() {
    const config = cfg.loadConfig()
    const def = config.model?.default || '未设置'
    const m = config.model?.[def] || {}
    const lines = [
      `当前默认模型配置：${def}`,
      `  名称：${m.name || '(无)'}`,
      `  模型ID：${m.model || '(未设置)'}`,
      `  API地址：${m.apiBase || '(未设置)'}`,
      `  API Key：${m.apiKey ? '已设置' : '(未设置)'}`,
      `  温度：${m.temperature ?? 0.8}`,
      `  MaxTokens：${m.maxTokens ?? 2000}`
    ]
    return this.e.reply(lines.join('\n'))
  }

  async setModel() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    const text = helper.getMessageText(this.e).replace(/^#ai设置模型\s+/, '').trim()
    if (!text) return this.e.reply('用法：#ai设置模型 <模型ID>')
    const config = cfg.loadConfig()
    const def = config.model?.default || 'openai-compatible'
    if (!config.model) config.model = {}
    if (!config.model[def]) config.model[def] = {}
    config.model[def].model = text
    cfg.saveConfig(config)
    return this.e.reply(`✅ 已将默认模型ID设置为：${text}`)
  }

  async setApiKey() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    const text = helper.getMessageText(this.e).replace(/^#ai设置apikey\s+/, '').trim()
    if (!text) return this.e.reply('用法：#ai设置apikey <你的apikey>')
    const config = cfg.loadConfig()
    const def = config.model?.default || 'openai-compatible'
    if (!config.model) config.model = {}
    if (!config.model[def]) config.model[def] = {}
    config.model[def].apiKey = text
    cfg.saveConfig(config)
    return this.e.reply('✅ API Key 已保存。')
  }

  async setApiBase() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    const text = helper.getMessageText(this.e).replace(/^#ai设置api\s+/, '').trim()
    if (!text) return this.e.reply('用法：#ai设置api <apiBaseURL>')
    const config = cfg.loadConfig()
    const def = config.model?.default || 'openai-compatible'
    if (!config.model) config.model = {}
    if (!config.model[def]) config.model[def] = {}
    config.model[def].apiBase = text
    cfg.saveConfig(config)
    return this.e.reply(`✅ API Base 已设置为：${text}`)
  }

  async addMaster() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    const match = helper.getMessageText(this.e).match(/^#ai添加主人\s+(\d+)/)
    if (!match) return this.e.reply('用法：#ai添加主人 <QQ号>')
    const newMaster = match[1]
    const config = cfg.loadConfig()
    if (!config.permissions) config.permissions = {}
    if (!Array.isArray(config.permissions.masters)) config.permissions.masters = []
    if (config.permissions.masters.map(String).includes(newMaster)) {
      return this.e.reply('该用户已经是主人。')
    }
    config.permissions.masters.push(newMaster)
    cfg.saveConfig(config)
    return this.e.reply(`✅ 已添加主人：${newMaster}`)
  }

  async reloadConfig() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    cfg.loadConfig()
    return this.e.reply('✅ 配置文件已重新加载。')
  }

  async _ensureWebStarted() {
    if (ws.isRunning()) return ws.getServerInfo()
    const config = cfg.loadConfig()
    const port = Number(config.web?.port) || 12580
    const host = config.web?.host || '127.0.0.1'
    try {
      await ws.startWebServer(port, host)
      return ws.getServerInfo()
    } catch (e) {
      throw new Error(`启动网页后台失败：${e.message}`)
    }
  }

  async webAdmin() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    let info
    try {
      info = await this._ensureWebStarted()
    } catch (e) {
      return this.e.reply(`❌ ${e.message}`)
    }
    const token = auth.generateMagicLink()
    const url = `${info.url}/magic/${token}`
    const msg = [
      '✅ 网页管理后台已就绪',
      '',
      `🔗 免登录直链（10分钟有效，一次有效）：`,
      url,
      '',
      '⚠️ 请妥善保管该链接，任何持有此链接的人均可访问后台。',
      '如果是群聊环境，建议撤回此消息或私聊使用。'
    ].join('\n')
    return this.e.reply(msg)
  }

  async webStart() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    try {
      const info = await this._ensureWebStarted()
      return this.e.reply(`✅ 网页管理后台已启动：${info.url}\n绑定地址：${info.host}:${info.port}`)
    } catch (e) {
      return this.e.reply(`❌ ${e.message}`)
    }
  }

  async webStop() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    const ok = await ws.stopWebServer()
    return this.e.reply(ok ? '✅ 网页管理后台已关闭。' : '网页后台当前未运行。')
  }

  async genCode() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    try {
      await this._ensureWebStarted()
    } catch (e) {
      // 继续即可
    }
    const { code } = auth.generateTerminalCode()
    const info = ws.getServerInfo()
    const lines = [
      '🔐 网页管理登录验证码（5分钟有效）：',
      '',
      `    ${code}`,
      '',
      info.url ? `访问：${info.url}` : '',
      '（验证码会同时打印在 Yunzai 运行终端）'
    ].filter(Boolean)
    return this.e.reply(lines.join('\n'))
  }
}
