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
        },
        {
          reg: '^#ai(诊断|debug|检查)$',
          fnc: 'diagnose',
          permission: 'all'
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
      '',
      '【诊断命令】',
      '  #ai诊断        检查权限/主人/配置/后台运行状态（任何人可用）',
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
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
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
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
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
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
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
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
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
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
    }
    cfg.loadConfig()
    return this.e.reply('✅ 配置文件已重新加载。')
  }

  async _ensureWebStarted(options = {}) {
    const config = cfg.loadConfig()
    let port = Number(config.web?.port)
    if (!Number.isFinite(port) || port <= 0 || port >= 65536) port = 12580
    let host = (config.web?.host == null) ? '127.0.0.1' : String(config.web?.host).trim()
    if (host === '0') host = '0.0.0.0'
    if (!host) host = '127.0.0.1'
    try {
      await ws.startWebServer(port, host, { forceRestart: !!options.forceRestart })
      return ws.getServerInfo()
    } catch (e) {
      throw new Error(`启动网页后台失败：${e.message}`)
    }
  }

  async webAdmin() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
    }
    let info
    try {
      // 主人调用此命令时强制重启一次，防止改了 config.yaml 后旧的 127.0.0.1 绑定还在
      info = await this._ensureWebStarted({ forceRestart: true })
    } catch (e) {
      return this.e.reply(`❌ ${e.message}`)
    }
    const token = auth.generateMagicLink()
    const baseForMagic = (info.publicUrls && info.publicUrls.length) ? info.publicUrls[0] : info.url
    const url = `${baseForMagic}/magic/${token}`
    const msg = [
      '✅ 网页管理后台已就绪',
      '',
      `监听绑定：${info.host}:${info.port}`,
      '',
      `🔗 免登录直链（10分钟有效，一次有效）：`,
      url,
      '',
      info.publicUrls && info.publicUrls.length > 1
        ? `其它可访问入口（如需走局域网/公网IP，请自行替换直链中的主机名）：\n${info.publicUrls.slice(1).map(u => `  - ${u}`).join('\n')}`
        : '',
      (info.host === '0.0.0.0' || info.host === '::')
        ? `⚠️ 已开启对外监听。若仍无法访问，请确认：\n   1) 云服务器/面板安全组已放行 TCP ${info.port}；\n   2) 本机防火墙（ufw/iptables/firewalld）已放行；\n   3) 访问地址要用真实公网/局域网IP，不要用 0.0.0.0。`
        : '',
      '',
      '⚠️ 请妥善保管该链接，任何持有此链接的人均可访问后台。',
      '如果是群聊环境，建议撤回此消息或私聊使用。'
    ].filter(Boolean).join('\n')
    return this.e.reply(msg)
  }

  async webStart() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
    }
    try {
      // 用户显式「启动」时，若配置变了就自动重启使用新 host/port
      const info = await this._ensureWebStarted({ forceRestart: true })
      const lines = [
        `✅ 网页管理后台：${info.running ? '运行中' : '未运行'}`,
        `监听绑定：${info.host}:${info.port}`
      ]
      if (info.publicUrls && info.publicUrls.length) {
        lines.push('可访问地址：')
        for (const u of info.publicUrls) lines.push(`  - ${u}`)
      }
      if (info.host === '0.0.0.0' || info.host === '::') {
        lines.push(`⚠️ 对外监听已开启。若仍无法访问，需要放行 TCP ${info.port} 端口（安全组+系统防火墙）。`)
      }
      return this.e.reply(lines.join('\n'))
    } catch (e) {
      return this.e.reply(`❌ ${e.message}`)
    }
  }

  async webStop() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
    }
    const ok = await ws.stopWebServer()
    return this.e.reply(ok ? '✅ 网页管理后台已关闭。' : '网页后台当前未运行。')
  }

  async genCode() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
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

  async diagnose() {
    const e = this.e
    const userId = helper.getUserId(e)
    const groupId = helper.getGroupId(e)
    const sources = helper.listMasterSources()
    const allMasters = helper.listMasters()
    const isMasterNow = helper.isMaster(userId, e)
    const isAllowedNow = helper.isUserAllowed(userId, groupId, e)

    // 事件对象自带 isMaster / master
    const eProps = []
    if ('isMaster' in e) eProps.push(`isMaster=${e.isMaster}`)
    if ('master' in e) eProps.push(`master=${e.master}`)
    if ('isAdmin' in e) eProps.push(`isAdmin=${e.isAdmin}`)
    if ('permission' in e) eProps.push(`permission=${e.permission}`)

    const cfgData = cfg.loadConfig()
    const modelDefault = cfgData.model?.default || '(未设置)'
    const mm = cfgData.model?.[modelDefault] || {}
    const modelStatus = []
    if (mm.apiBase) modelStatus.push('apiBase已配置')
    if (mm.apiKey && !/^\s*$/.test(mm.apiKey) && !/sk-your-api|^\*+$/.test(mm.apiKey)) {
      modelStatus.push('apiKey已设置')
    } else {
      modelStatus.push('⚠️ apiKey未设置')
    }
    if (mm.model) modelStatus.push(`model=${mm.model}`)

    const info = ws.getServerInfo()
    // 配置声明 vs 实际绑定 不一致时，重点提示
    const declaredHost = (cfgData.web && cfgData.web.host != null) ? String(cfgData.web.host) : '(未填，默认127.0.0.1)'
    const declaredPort = (cfgData.web && cfgData.web.port != null) ? Number(cfgData.web.port) : '(未填，默认12580)'
    const bindMismatch = info.running && (info.host !== String(declaredHost).trim() || Number(info.port) !== Number(declaredPort))
    const webLines = []
    if (info.running) {
      webLines.push(`✅ 运行中（实际绑定 ${info.host}:${info.port}）`)
      if (info.publicUrls && info.publicUrls.length) {
        webLines.push(`  可访问地址（${info.publicUrls.length} 个）：`)
        for (const u of info.publicUrls) webLines.push(`    - ${u}`)
      }
      if (bindMismatch) {
        webLines.push(`  ⚠️ 实际绑定与配置声明不一致！配置声明 host=${declaredHost} port=${declaredPort}`)
        webLines.push(`     → 请发送 #ai网页启动 强制重启（会按 config.yaml 重新绑定），或直接重启 Yunzai。`)
      }
      if (info.host === '0.0.0.0' || info.host === '::') {
        webLines.push(`  ⚠️ 已开启对外监听。若仍无法访问：安全组/防火墙放行 TCP ${info.port}，并用真实公网/局域网 IP 访问。`)
      }
    } else {
      webLines.push('未启动（发送 #ai网页启动 或 在 config.yaml 中设置 web.autoStart:true）')
    }
    webLines.push(`  配置声明：host=${declaredHost}  port=${declaredPort}  autoStart=${cfgData.web?.autoStart === false ? 'false' : 'true'}`)

    const lines = [
      '🩺 AI0-Plugin 诊断报告',
      '',
      '【当前用户】',
      `  user_id  : ${userId ?? '无法读取'}`,
      `  group_id : ${groupId ?? '(私聊)'}` + (eProps.length ? `\n  e对象    : ${eProps.join(', ')}` : ''),
      `  主人判定 : ${isMasterNow ? '✅ 是主人' : '❌ 不是主人'}`,
      `  允许对话 : ${isAllowedNow ? '✅ 通过' : '❌ 被拒绝'}`,
      '',
      '【主人来源】',
      `  框架全局(Config)：${sources.framework.length ? sources.framework.join(', ') : '(空)'}`,
      `  插件配置(permissions.masters)：${sources.plugin.length ? sources.plugin.join(', ') : '(空)'}`,
      `  合并后的主人总数：${allMasters.length}（${allMasters.length ? allMasters.join(', ') : '⚠️ 无主人'}）`,
      '',
      '【模型配置】',
      `  默认模型 key：${modelDefault}`,
      `  状态：${modelStatus.join('、')}`,
      '',
      '【网页后台】',
      webLines.join('\n'),
      '',
      '💡 常见「0.0.0.0 改了还是 127.0.0.1」快速处理：',
      '  1) 改完 config.yaml 后发送：#ai网页启动   （会强制按新配置重启，忽略旧绑定）',
      '  2) 云服务器还需要：安全组入方向放行 TCP 端口、系统防火墙（ufw/firewalld/iptables）放行',
      '  3) 访问地址不能写 0.0.0.0，要换成服务器真实公网IP或局域网IP（上面的诊断已列出候选）',
      '  4) 如果 YAML 里写的是裸 host: 0.0.0.0（没加引号），部分解析器会把它当作数字 0，建议写 host: "0.0.0.0" 更稳妥',
      '',
      '💡 如果主人判定一直是❌：',
      '  1) XRK-Yunzai 自带主人系统（config/matcher 中的 master），通常在 Yunzai 根目录 config/ 配置即可。我们会自动读取它。',
      '  2) 也可以改 plugins/ai0-plugin/config/config.yaml 的 permissions.masters，然后发送 #ai重载 或重启。',
      '  3) 不确定就把这里的诊断截图发出来对照。'
    ]

    // 对不是主人且调用了 master 命令的人，顺手给出 tips
    if (!isMasterNow && allMasters.length === 0) {
      lines.push('', '⚠️ 没有任何主人！请先配置主人，再使用 #ai网页管理 等命令。')
    }

    return e.reply(lines.join('\n'))
  }
}
