import * as cfg from '../config/index.js'
import * as helper from '../src/helper.js'
import * as chatSvc from '../src/chatService.js'
import * as ws from '../src/webServer.js'
import * as auth from '../src/auth.js'
import * as llm from '../src/llm.js'

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
        },
        {
          reg: '^#ai(测试模型|模型测试|测模型)(\\s+\\S+)?$',
          fnc: 'testModel',
          permission: 'all'
        },
        {
          reg: '^#(ai)?(切换模型|切模型|换模型)(\\s+\\S+(\\s+\\S+)?)?$',
          fnc: 'switchModel',
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
      '  全局AI开启时，指定群内无需@也能回复',
      '',
      '【常用命令】',
      '  #ai帮助        查看此菜单',
      '  #ai新会话       开启新的对话（清空上下文）',
      '  #ai模型         查看当前使用的模型配置',
      '  #切换模型 [编号|模型名]  一键切换当前账号可用模型',
      '',
      '【群操作】',
      '  #ai踢出 @某人             踢出群员（群主/管理员/主人可用）',
      '  #ai禁言 @某人 10分钟      禁言群员（同上权限）',
      '  #ai解禁 @某人             解除禁言',
      '  #ai设置管理员 @某人       任命管理员（仅主人，机器人须为群主）',
      '  #ai取消管理员 @某人       撤销管理员（仅主人）',
      '  #ai头衔 <头衔名>          给自己设头衔（所有人可用）',
      '  #ai头衔 @某人 <头衔名>    给他人设头衔（群主/管理员/主人）',
      '',
      '【全局AI】(仅主人)',
      '  #ai全局ai 开    开启（当前群自动加入列表）',
      '  #ai全局ai 关    关闭',
      '  #ai全局ai       查看当前状态',
      '',
      '【网页管理后台】(仅主人)',
      `  #ai网页管理     生成免登录直链（${info.running ? '运行中' : '未启动'}）`,
      '  #ai网页启动     启动网页后台',
      '  #ai网页关闭     关闭网页后台',
      '  #ai验证码       生成终端验证码（用于网页登录）',
      '',
      '【管理命令】(仅主人)',
      '  #切换模型 [n|模型名]  快速切换',
      '  #ai设置模型 <模型名>',
      '  #ai设置apikey <key>',
      '  #ai设置api <apiBaseURL>',
      '  #ai添加主人 <QQ号>',
      '  #ai重载         重新加载配置文件',
      '',
      '',
      '【诊断命令】',
      '  #ai诊断        检查权限/主人/配置/后台运行状态（任何人可用）',
      '  #ai测试模型 [key]    测试默认模型（或指定 key）的 /models 探测 + /chat/completions 调用',
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
    const bind = cfg.getWebBindFromConfig?.()
    let port, host
    if (bind) {
      port = bind.port
      host = bind.host
    } else {
      const config = cfg.loadConfig()
      port = Number(config.web?.port)
      if (!Number.isFinite(port) || port <= 0 || port >= 65536) port = 12580
      host = (config.web?.host == null) ? '127.0.0.1' : String(config.web?.host).trim()
      if (host === '0') host = '0.0.0.0'
      if (!host) host = '127.0.0.1'
    }
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

    // 计算归一化后的 base（不做网络请求，直接本地给提示）
    let modelDiag = null
    try {
      if (mm.apiBase) {
        const norm = llm.normalizeApiBase(mm.apiBase)
        const chatUrl = llm.buildEndpoint(norm, '/chat/completions')
        const modelsUrl = llm.buildEndpoint(norm, '/models')
        modelDiag = {
          rawBase: String(mm.apiBase),
          normalizedBase: norm,
          chatUrl,
          modelsUrl
        }
      }
    } catch (_) {}

    const info = ws.getServerInfo()
    // 配置声明 vs 归一化 vs 实际绑定 三段展示，彻底排查 "写了0.0.0.0还是127.0.0.1"
    const declaredHostRaw = (cfgData.web && cfgData.web.host != null) ? String(cfgData.web.host) : '(未填，默认127.0.0.1)'
    const declaredPortRaw = (cfgData.web && cfgData.web.port != null) ? cfgData.web.port : '(未填，默认12580)'
    const bind = cfg.normalizeWebBind?.({ host: cfgData.web?.host, port: cfgData.web?.port }) || null
    const normalizedHost = bind ? bind.host : null
    const normalizedPort = bind ? bind.port : null
    const bindMismatch = info.running && ((normalizedHost != null && info.host !== normalizedHost) || (normalizedPort != null && Number(info.port) !== Number(normalizedPort)))
    const webLines = []
    if (info.running) {
      webLines.push(`✅ 运行中（实际绑定 ${info.host}:${info.port}）`)
      if (info.publicUrls && info.publicUrls.length) {
        webLines.push(`  可访问地址（${info.publicUrls.length} 个）：`)
        for (const u of info.publicUrls) webLines.push(`    - ${u}`)
      }
      if (bindMismatch) {
        webLines.push(`  ⚠️ 实际绑定与“归一化后配置”不一致！归一化后 host=${normalizedHost ?? '-'} port=${normalizedPort ?? '-'}`)
        webLines.push(`     → 请发送 #ai网页启动 强制重启（会关闭旧实例并按最新 config.yaml 重新绑定），或直接重启 Yunzai。`)
      }
      if (info.host === '0.0.0.0' || info.host === '::') {
        webLines.push(`  ⚠️ 已开启对外监听。若仍无法访问：安全组/防火墙放行 TCP ${info.port}，并用真实公网/局域网 IP 访问。`)
      }
    } else {
      webLines.push('未启动（发送 #ai网页启动 或 在 config.yaml 中设置 web.autoStart:true）')
    }
    webLines.push(`  配置声明(原始)：host=${declaredHostRaw}  port=${declaredPortRaw}  autoStart=${cfgData.web?.autoStart === false ? 'false' : 'true'}`)
    if (normalizedHost != null || normalizedPort != null) {
      webLines.push(`  配置声明(归一化后)：host=${normalizedHost ?? '-'}  port=${normalizedPort ?? '-'}`)
    }

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
      modelDiag ? `  原始 apiBase ：${modelDiag.rawBase}\n  归一化 apiBase：${modelDiag.normalizedBase}\n  /chat/completions → ${modelDiag.chatUrl}\n  /models          → ${modelDiag.modelsUrl}` : '',
      '',
      '【网页后台】',
      webLines.join('\n'),
      '',
      '💡 Kimi/DeepSeek 等 404 快速处理：',
      '  1) 发送 #ai测试模型  进行一键检测：会打 /models 探测 + /chat/completions 真实请求并把最终URL/HTTP状态/响应体都告诉你。',
      '  2) apiBase 推荐写法：Kimi=https://api.moonshot.cn/v1   DeepSeek=https://api.deepseek.com/v1   （不要写 /chat/completions，也不要裸域名不带 /v1）',
      '  3) #ai诊断 上方已打印我们实际会请求的 /chat/completions URL，你可以直接核对：',
      '     - Kimi 必须形如 https://api.moonshot.cn/v1/chat/completions',
      '     - 不能出现 //chat/completions 或 /v1/v1/chat/completions 这种重复段',
      '  4) 404 时 Yunzai 运行日志里已经会输出 “base(原始) / base(归一化) / url” 三段 + 完整响应体 JSON，把那段贴出来即可精确定位。',
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

  async testModel() {
    const e = this.e
    const text = helper.getMessageText(e)
    const m = (text || '').match(/^#ai(测试模型|模型测试|测模型)\s*(\S+)?\s*$/)
    const modelKey = (m && m[2]) ? m[2] : null

    const config = cfg.loadConfig()
    const defaultKey = config.model?.default || 'openai-compatible'
    const useKey = modelKey || defaultKey
    const usedModel = config.model?.[useKey]
    const statusLines = [`🧪 AI 模型连通性测试（key=${useKey}）`]
    if (!usedModel) {
      statusLines.push(`❌ 模型 key=${useKey} 不存在，可用 key：${Object.keys(config.model || {}).join('、') || '(无)'}`)
      return e.reply(statusLines.join('\n'))
    }

    statusLines.push('', `【配置】`)
    const rawBase = String(usedModel.apiBase || '(空)')
    statusLines.push(`  apiBase 原始   : ${rawBase}`)
    let normalized = '', chatUrl = '', modelsUrl = ''
    try {
      normalized = llm.normalizeApiBase(rawBase)
      chatUrl = llm.buildEndpoint(normalized, '/chat/completions')
      modelsUrl = llm.buildEndpoint(normalized, '/models')
    } catch (err) {
      normalized = `(归一化失败: ${err.message})`
    }
    statusLines.push(`  apiBase 归一化 : ${normalized}`)
    statusLines.push(`  model           : ${usedModel.model || '(未设置)'}`)
    statusLines.push(`  → GET  ${modelsUrl}`)
    statusLines.push(`  → POST ${chatUrl}`)

    // 1) 先探测 /models
    let probe = null
    try {
      await e.reply(statusLines.join('\n') + `\n\n① 正在探测 /models ...`)
      probe = await llm.probeModelConnection({ modelKey: useKey })
    } catch (err) {
      probe = { ok: false, message: err.message || String(err) }
    }
    const probeLines = [`\n【① /models 探测${probe?.ok ? ' ✅' : ' ❌'}】`]
    if (probe?.url) probeLines.push(`  URL    : ${probe.url}`)
    probeLines.push(`  HTTP   : ${probe?.status ?? '-'}${probe?.code ? '  code=' + probe.code : ''}  耗时 ${probe?.latencyMs ?? '-'} ms`)
    if (probe?.ok) {
      probeLines.push(`  结果   : ✅ /models 可达（鉴权 & 域名/端口基本正确）`)
      const avail = Array.isArray(probe?.availableModels) ? probe.availableModels : []
      if (avail.length) {
        probeLines.push(`  本账号可用模型（${avail.length} 个）: ${avail.join(', ')}`)
        const cfgModel = String(usedModel.model || '').trim()
        if (cfgModel && !avail.includes(cfgModel)) {
          probeLines.push(`  ⚠ 你当前配置的 model="${cfgModel}" 不在可用列表里 → 很可能是模型名写错或账号未开通权限。`)
        }
      }
    } else {
      probeLines.push(`  结果   : ❌ /models 不可达`)
      if (probe?.message) probeLines.push(`  错误   : ${probe.message}`)
    }
    await e.reply(probeLines.join('\n'))

    // 2) 再实际调用 /chat/completions
    const chatLines = [`【② /chat/completions 真实调用】`]
    try {
      const msgs = [{ role: 'user', content: '请只用一句话回复：ping 成功，并说明你使用的模型名。' }]
      const t0 = Date.now()
      const r = await llm.chatCompletions(msgs, { modelKey: useKey })
      const dt = Date.now() - t0
      chatLines.push(`  URL    : ${chatUrl}`)
      chatLines.push(`  HTTP   : 200 OK（${dt} ms）`)
      chatLines.push(`  模型名 : ${r.modelName || '-'}`)
      if (r.usage) chatLines.push(`  usage  : ${JSON.stringify(r.usage)}`)
      chatLines.push(`  回复内容：\n${r.text || '(空)'}`)
      chatLines.unshift('【② /chat/completions 真实调用 ✅】')
    } catch (err) {
      chatLines.unshift('【② /chat/completions 真实调用 ❌】')
      chatLines.push(`  URL    : ${chatUrl}`)
      chatLines.push(`  错误   : ${err.message || String(err)}`)
      chatLines.push(``, '💡 若为 HTTP 404/401/403/429，请看上面对应小节中的解释。同时请去 Yunzai 运行日志里找 [ai0-plugin] LLM HTTP ... 日志，有完整的响应体 JSON。')
    }
    return e.reply(chatLines.join('\n'))
  }

  /**
   * #切换模型 [编号|模型名|key 模型名]
   * - 无参数：探测 /models，列出所有可用模型（标当前值），提示用户发 "#切换模型 1" 或 "#切换模型 kimi-k2.6"
   * - 纯数字 n：选第 n 个模型
   * - 其他：直接当模型 ID
   * - 两个参数：第一个视为 modelKey（provider 段名），第二个视为模型名
   */
  async switchModel() {
    const e = this.e
    const userId = helper.getUserId(e)
    if (!helper.isMaster(userId, e)) {
      return e.reply('❌ 此命令仅主人可用（可发送 #ai诊断 排查）')
    }
    const raw = helper.getMessageText(e)
    const re = /^#(ai)?(切换模型|切模型|换模型)\s*(.*)?$/s
    const m = raw.match(re)
    const args = (m && m[3] ? m[3].trim() : '').split(/\s+/).filter(Boolean)

    const config = cfg.loadConfig()
    const defaultKey = config.model?.default || 'openai-compatible'
    let useKey = defaultKey
    let target = ''
    if (args.length === 1) {
      target = args[0]
    } else if (args.length >= 2) {
      const maybeKey = args[0]
      if (config.model && Object.prototype.hasOwnProperty.call(config.model, maybeKey)) {
        useKey = maybeKey
        target = args.slice(1).join(' ').trim()
      } else {
        target = args.join(' ').trim()
      }
    }
    const cfgModel = config.model?.[useKey]
    if (!cfgModel) return e.reply(`❌ 模型配置段 key=${useKey} 不存在，可用 key：${Object.keys(config.model || {}).join('、') || '(无)'}`)
    if (!cfgModel.apiBase || !cfgModel.apiKey) return e.reply(`❌ 模型配置段 key=${useKey} 还没有设置 apiBase 或 apiKey，先设置后再切换。`)

    // 第一步：探测 /models 获取本账号可用模型列表
    let listInfo = null
    try {
      await e.reply(`🔍 正在探测账号「${useKey}」的可用模型列表（GET /models）...`)
      listInfo = await llm.listAvailableModels({ modelKey: useKey })
    } catch (err) {
      return e.reply(`❌ 探测失败：${err.message || String(err)}`)
    }
    const availableModels = Array.isArray(listInfo?.models) ? listInfo.models : []
    const currentModel = String(cfgModel.model || '').trim()

    // 第二步：无参数 → 直接列出
    if (!target) {
      if (!listInfo?.ok || !availableModels.length) {
        const header = listInfo?.ok ? '❌ 本账号未返回任何可用模型' : `❌ 探测失败（HTTP ${listInfo?.status || '-'}）`
        const lines = [
          header,
          `  请求: ${listInfo?.url || '-'}`,
          `  当前已配置模型: ${currentModel || '(未设置)'}`,
          ``,
          `此时仍可以直接用 "#切换模型 <模型名>" 手动输入（例如 #切换模型 kimi-k2.6）。`
        ]
        return e.reply(lines.join('\n'))
      }
      const lines = [
        `🔁 模型切换助手（key=${useKey}）`,
        `  当前模型: ${currentModel || '(未设置)'}`,
        `  可用模型共 ${availableModels.length} 个：`
      ]
      availableModels.slice(0, 50).forEach((id, idx) => {
        const cur = (id === currentModel) ? '  ← 当前使用' : ''
        lines.push(`  ${String(idx + 1).padStart(2, ' ')}) ${id}${cur}`)
      })
      if (availableModels.length > 50) lines.push(`  ...(${availableModels.length - 50} 个未展示，直接写完整模型名即可切换)`)
      lines.push(``, `切换方式二选一：`)
      lines.push(`  ① 发 "#切换模型 1" / "#切换模型 2" 按编号切换`)
      lines.push(`  ② 发 "#切换模型 ${availableModels[0] || '模型ID'}" 直接写名字切换`)
      if (availableModels.length > 1) lines.push(`  ③ 指定其他 provider 段: "#切换模型 ${useKey} ${availableModels[1] || '模型ID'}"`)
      return e.reply(lines.join('\n'))
    }

    // 第三步：有参数 → 支持「纯数字编号」或「直接写模型名」
    let nextModel = target
    if (/^\d+$/.test(target)) {
      const n = parseInt(target, 10)
      if (!availableModels.length) return e.reply(`❌ 当前没有可用模型列表可按编号选，请改用 "#切换模型 <模型ID>" 直接写名字。`)
      if (n < 1 || n > availableModels.length) return e.reply(`❌ 编号 ${n} 超出范围（可用编号 1 ~ ${availableModels.length}）`)
      nextModel = availableModels[n - 1]
    } else {
      // 写名字时若探测成功，做一次"存在提示"但允许强制切换（防止 /models 接口不可达但用户知道正确模型名）
      if (availableModels.length && !availableModels.includes(nextModel)) {
        const lower = availableModels.map(x => x.toLowerCase())
        const exact = lower.includes(nextModel.toLowerCase()) ? availableModels.find(x => x.toLowerCase() === nextModel.toLowerCase()) : null
        if (exact) {
          nextModel = exact
        }
      }
    }

    // 写入配置
    const config2 = cfg.loadConfig()
    if (!config2.model) config2.model = {}
    if (!config2.model[useKey]) config2.model[useKey] = {}
    const before = String(config2.model[useKey].model || '')
    config2.model[useKey].model = nextModel
    const ok = cfg.saveConfig(config2)
    if (!ok) return e.reply(`❌ 保存配置失败，请查看 Yunzai 日志。`)

    const lines = [
      `✅ 模型切换完成（key=${useKey}）`,
      `  原模型: ${before || '(未设置)'}`,
      `  新模型: ${nextModel}`,
      ``
    ]
    if (availableModels.length && availableModels.includes(nextModel)) {
      lines.push(`✔ 新模型在当前账号可用模型列表内，可直接使用。`)
    } else {
      lines.push(`⚠ 新模型"${nextModel}"未出现在 /models 返回的可用列表中（可能是本账号未开通 / 服务商返回列表不全）。`)
      lines.push(`  若调用失败，可发送 "#ai测试模型" 或 "#切换模型"（无参数）查看本账号实际可用模型。`)
    }
    lines.push(``, `💡 上下文不会自动重置，需要新会话可发送 "#ai新会话"。`)
    return e.reply(lines.join('\n'))
  }
}
