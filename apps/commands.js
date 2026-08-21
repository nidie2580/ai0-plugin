import * as cfg from '../config/index.js'
import * as helper from '../src/helper.js'
import * as chatSvc from '../src/chatService.js'
import * as ws from '../src/webServer.js'
import * as auth from '../src/auth.js'
import * as llm from '../src/llm.js'
import { safeLogger } from '../src/globals.js'

let svgR = null
try { svgR = await import('../src/svgRender.js') } catch (_) {}

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
          permission: 'master'
        },
        {
          reg: '^#ai(群诊断|检查群|群检查)$',
          fnc: 'groupDiagnose',
          permission: 'master'
        },
        {
          reg: '^#ai(测试模型|模型测试|测模型)(\\s+\\S+)?$',
          fnc: 'testModel',
          permission: 'master'
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
    const e = this.e
    const info = ws.getServerInfo()
    // 生成 SVG 图片：本地文件绝对路径，用 segment.image(绝对路径) 发送
    // （避免直接塞 Buffer 触发 NapCat "rich media transfer failed"）
    try {
      // 清理过旧的临时文件（每个用户发帮助时轻量执行一次）
      svgR?.cleanupOldTmp?.()
      const svgPath = svgR?.renderHelp?.()
      // 注意：e.reply 参数必须是「纯单个 segment.image(path)」，不要混发 text，
      //       否则 NapCat/LLOneBot 会被判为富媒体复合消息导致转换失败。
      await e.reply(helper.safeSegmentImage(svgPath))
      // 如果需要提示信息，单独再发一条（中间换行隔断）
      setTimeout(() => {
        e.reply([
          '💡 如果上方图片无法正常显示，请参考简版：',
          '  · 对话：群聊@机器人 / 私聊直接发消息',
          '  · 常用：#ai新会话 · #ai模型 · #切换模型 1.3',
          '  · 群管：@机器人 禁言/踢人/授头衔（AI判断权限后执行）',
          '  · 生图：@机器人 画一只猫咪（需网页端开启生图模型）',
          `  · 网页：#ai网页管理（${info.running ? '运行中' : '未启动'}）`,
          '  · 诊断：#ai诊断 · #ai测试模型 [平台key]'
        ].join('\n')).catch(() => {})
      }, 1200)
      return true
    } catch (err) {
      const lines = [
        '🤖 AI0-Plugin 帮助菜单（图片生成失败，回退文字版）',
        '',
        '【对话】',
        '  群聊艾特我 / 私聊直接发消息即可对话',
        '  全局AI开启时，指定群内无需@也能回复',
        '',
        '【常用命令】',
        '  #ai帮助        查看此菜单',
        '  #ai新会话       开启新的对话（清空上下文）',
        '  #ai模型         查看当前使用的模型配置',
        '  #切换模型                 查看所有 API 平台及可用模型',
        '  #切换模型 1.3              平台号.模型号 切换',
        '  #切换模型 [平台key] [模型名]   指定平台和模型名',
        '  #切换模型 上一页/下一页    模型过多时翻页',
        '',
        '【群管理（AI驱动）】',
        '  @机器人 禁言一下@某人 10分钟',
        '  @机器人 踢了@某人',
        '  @机器人 给我个头衔 大佬',
        '',
        '【图片生成】',
        '  @机器人 画一只可爱的猫咪',
        '',
        '【全局AI】(仅主人)',
        '  #ai全局ai 开/关/查看',
        '',
        '【网页管理后台】(仅主人)',
        `  #ai网页管理     生成免登录直链（${info.running ? '运行中' : '未启动'}）`,
        '  #ai网页启动 / 关闭',
        '  #ai验证码       生成终端验证码',
        '',
        '【管理命令】(仅主人)',
        '  #切换模型 [n.m|模型名|平台key 模型名]',
        '  #ai设置模型 / #ai设置apikey / #ai设置api',
        '  #ai添加主人 <QQ号>',
        '  #ai重载         重新加载配置文件',
        '',
        '【诊断命令】(仅主人)',
        '  #ai诊断         权限/主人/配置/后台检查',
        '  #ai测试模型 [key]    测试指定平台的接口',
        '',
        '💡 详细配置：plugins/ai0-plugin/config/config.yaml'
      ]
      return e.reply(lines.join('\n'))
    }
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
      return this.e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
    }
    const text = helper.getMessageText(this.e).replace(/^#ai设置模型\s+/, '').trim()
    if (!text) return this.e.reply('用法：#ai设置模型 <模型ID>')
    // 过滤控制字符，限制长度，防止 YAML 注入
    const safe = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 128)
    if (!safe) return this.e.reply('❌ 模型ID 包含非法字符')
    const config = cfg.loadConfig()
    const def = config.model?.default || 'openai-compatible'
    if (!config.model) config.model = {}
    if (!config.model[def]) config.model[def] = {}
    config.model[def].model = safe
    cfg.saveConfig(config)
    return this.e.reply(`✅ 已将默认模型ID设置为：${safe}`)
  }

  async setApiKey() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
    }
    const text = helper.getMessageText(this.e).replace(/^#ai设置apikey\s+/, '').trim()
    if (!text) return this.e.reply('用法：#ai设置apikey <你的apikey>')
    // API Key 仅拒绝控制字符和明显危险字符（换行、引号、尖括号）
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f"<>]/.test(text) || text.length < 4 || text.length > 512) {
      return this.e.reply('❌ API Key 格式不合法（不允许控制字符/引号/尖括号，4-512位）')
    }
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
      return this.e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
    }
    const text = helper.getMessageText(this.e).replace(/^#ai设置api\s+/, '').trim()
    if (!text) return this.e.reply('用法：#ai设置api <apiBaseURL>')
    // 校验 URL 格式：必须是 http/https 协议
    let parsed
    try { parsed = new URL(text) } catch { return this.e.reply('❌ URL 格式不合法（需以 http:// 或 https:// 开头）') }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return this.e.reply('❌ 仅支持 http:// 和 https:// 协议')
    }
    // 过滤控制字符
    const safe = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 512)
    const config = cfg.loadConfig()
    const def = config.model?.default || 'openai-compatible'
    if (!config.model) config.model = {}
    if (!config.model[def]) config.model[def] = {}
    config.model[def].apiBase = safe
    cfg.saveConfig(config)
    return this.e.reply(`✅ API Base 已设置为：${safe}`)
  }

  async addMaster() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
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
    const e = this.e
    const userId = helper.getUserId(e)
    if (!helper.isMaster(userId, e)) {
      return e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
    }
    // 1. 先强制把缓存打失效（无论 mtime 是否变化都重新解析一遍）
    try { cfg.saveConfig?.(cfg.loadConfig?.() || {}) } catch (_) {}
    cfg.setForceLoad?.(true)
    const config = cfg.loadConfig()
    cfg.setForceLoad?.(false)

    // 2. 如果 web 正在运行 → 使用新配置强制重启（host/port 变动会立刻生效；
    //    旧 server 会被关闭并触发 closeAllConnections，避免重启后旧路由持续引用旧闭包造成内存泄漏）
    const wasRunning = ws.isRunning?.()
    if (wasRunning) {
      try {
        await ws.stopWebServer()
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] #ai重载关闭旧网页后台异常: ${err.message}`)
      }
      try {
        const bind = cfg.getWebBindFromConfig?.()
        const port = bind?.port ?? (Number(config?.web?.port) || 12580)
        const host = bind?.host ?? ((config?.web?.host ? String(config.web.host).trim() : '127.0.0.1') || '127.0.0.1')
        await ws.startWebServer(port, host, { forceRestart: true })
      } catch (err) {
        return e.reply(`⚠️ 配置已重载，但网页后台重启失败：${err.message}\n（你仍可手动发送 #ai网页启动 再试一次）`)
      }
    }

    // 3. 给 #ai诊断 加上"上次重载时间"，并顺带清除缓存过大的 LRU 型 Map（防止长期运行无限增长）
    globalThis.__ai0_reload_ts = Date.now()

    // 4. 如果有 YAML 解析错误（坏文件已被降级），明确提示用户
    const lastErr = typeof cfg.getLastConfigError === 'function' ? cfg.getLastConfigError() : null

    const parts = ['✅ 配置文件已重新加载。']
    if (wasRunning) parts.push('（网页后台已按新配置强制重启，旧连接已清理，无路由/监听器泄漏）')
    if (lastErr) parts.push(`⚠️ 但检测到 YAML 解析错误：${lastErr.msg}\n已自动退回默认/备份模板；请手动检查 ${lastErr.file} 的缩进与格式（常见坑是层级不对齐）。`)
    return e.reply(parts.join('\n'))
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
    const e = this.e
    const userId = helper.getUserId(e)
    const isGroup = !!e.group_id
    const isPrivate = !!e.user_id && !isGroup  // 纯私聊

    // —— 第一步：主人身份校验（群聊/私聊都必须过；顺序放最前，防止非主人浪费好友检测成本）
    if (!helper.isMaster(userId, e)) {
      const noTip = [
        '❌ 「#ai网页管理」仅机器人主人可用。',
        `（当前账号 QQ=${userId ?? '未知'} 未被识别为主人，请联系机器人主人确认权限）`
      ]
      if (isGroup) noTip.push('如你确实是主人，请先把机器人添加为好友后再在群里使用此命令（可提高校验优先级）。')
      return e.reply(noTip.join('\n'))
    }

    // —— 第二步：确保网页后台已启动
    let info
    try {
      info = await this._ensureWebStarted({ forceRestart: true })
    } catch (err) {
      return e.reply(`❌ ${err.message}`)
    }

    const token = auth.generateMagicLink()
    const baseForMagic = (info.publicUrls && info.publicUrls.length) ? info.publicUrls[0] : info.url
    const url = `${baseForMagic}/magic/${token}`
    const msgLines = [
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
    ].filter(Boolean)
    const privateMsg = msgLines.join('\n')

    // —— 第三步：私聊 → 直接把直链发回当前会话
    if (isPrivate) {
      return e.reply(privateMsg)
    }

    // —— 群聊分支：必须先发好友检测，通过后把直链「发私信」而不是群里贴链接
    //    1. 先检测是否好友/能否私信（不是好友无法主动发私信，必须先让用户加好友）
    //    2. 失败时群内明确提示「先添加好友」
    //    3. 成功时发送私信，并在群内回「已发送到你的私信」，绝对不把敏感直链落在群消息里
    const friendCheck = await helper.isBotFriend(userId).catch(err => ({ ok: false, reason: err.message }))
    if (!friendCheck.ok) {
      const selfId = String(e.self_id ?? (global.Bot || global.bot)?.uin ?? (global.Bot || global.bot)?.self_id ?? '')
      const selfNick = String(
        (global.Bot || global.bot)?.nickname ??
        (global.Bot || global.bot)?.info?.nickname ??
        '机器人'
      )
      const parts = [
        '⚠️ 「#ai网页管理」涉及敏感登录信息，群聊中只会发送到你的私信。',
        `但当前无法主动给你发私信：${friendCheck.reason || '未查询到好友关系'}。`,
        '',
        `请先添加机器人 QQ${selfId ? '（' + selfId + '）' : ''}「${selfNick}」为好友，`,
        `或先私聊机器人发送任意消息建立临时会话后，再回到群里发送「#ai网页管理」。`
      ]
      return e.reply(parts.join('\n'))
    }

    // 能发私信 → 直接发私信
    const dm = await helper.sendPrivate(userId, privateMsg).catch(err => ({ ok: false, reason: err.message }))
    if (dm.ok) {
      const confirmLines = [
        '✅ 已把网页管理后台的免登录直链发送到你的私信，请切换到私聊窗口查看。',
        '（为避免敏感直链在群聊中被他人截获，群内不显示链接。）'
      ]
      return e.reply(confirmLines.join('\n'))
    }

    // 最后兜底：理论上 isBotFriend 已经过了不该到这里；但如果发私信真炸了，
    // 就明确在群里告知「添加好友失败原因」，仍然不把直链发在群里。
    return e.reply(
      [
        '⚠️ 「#ai网页管理」涉及敏感登录信息，仅通过私信发送。',
        `虽然已检测到你已具备可私信条件，但主动发送私信失败：${dm.reason || '未知错误'}。`,
        '请先尝试私聊机器人发一句任意话建立会话，或者删除好友重新添加，再重试命令。'
      ].join('\n')
    )
  }

  async webStart() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
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
      return this.e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
    }
    const ok = await ws.stopWebServer()
    return this.e.reply(ok ? '✅ 网页管理后台已关闭。' : '网页后台当前未运行。')
  }

  async genCode() {
    const userId = helper.getUserId(this.e)
    if (!helper.isMaster(userId, this.e)) {
      return this.e.reply('❌ 此命令仅主人可用')
    }
    // 验证码仅在私聊中发送，防止群聊泄露
    if (helper.getGroupId(this.e)) {
      return this.e.reply('❌ 请在私聊中使用此命令，避免验证码在群聊中泄露')
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
    // 诊断命令包含敏感信息（主人列表、apiBase等），仅允许私聊执行
    if (groupId) {
      return e.reply('❌ 诊断命令包含敏感配置信息，请在私聊中使用')
    }
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
      '  1) 插件会自动读取 Yunzai 框架的主人配置（globalThis.Config.master / matcher.master），以及插件自身的 permissions.masters。',
      '  2) 也可以改 plugins/ai0-plugin/config/config.yaml 的 permissions.masters，然后发送 #ai重载 或重启。',
      '  3) 不确定就把这里的诊断截图发出来对照。'
    ]

    // 对不是主人且调用了 master 命令的人，顺手给出 tips
    if (!isMasterNow && allMasters.length === 0) {
      lines.push('', '⚠️ 没有任何主人！请先配置主人，再使用 #ai网页管理 等命令。')
    }

    return e.reply(lines.join('\n'))
  }

  /** #ai群诊断：输出群+成员接口的原始数据与可用方法清单 */
  async groupDiagnose() {
    const e = this.e
    if (!e.group_id) return e.reply('⚠️ 此命令仅在群聊中可用。')
    const groupId = e.group_id
    const userId = helper.getUserId(e)
    const bot = global.Bot || global.bot

    const lines = ['🩺 AI0-Plugin 群诊断报告', '']

    // 1) 事件对象上现成的信息
    lines.push('【1. 事件对象 e 上的群信息（适配器直接注入）】')
    lines.push(`  e.group_id = ${e.group_id}`)
    lines.push(`  e.group_name / groupName = ${e.group_name ?? e.groupName ?? e.group?.groupName ?? '(无)'}`)
    lines.push(`  e.self_id / 机器人QQ = ${e.self_id ?? bot?.uin ?? bot?.self_id ?? '(无)'}`)
    lines.push(`  e.sender = ${JSON.stringify({
      user_id: e.sender?.user_id,
      nickname: e.sender?.nickname,
      card: e.sender?.card,
      role: e.sender?.role,
      permission: e.sender?.permission,
      group_role: e.sender?.group_role,
      memberRole: e.sender?.memberRole,
      type: e.sender?.type,
    }, null, 2).replace(/\n/g, '\n  ')}`)
    lines.push('')

    // 2) pickGroup 的方法清单
    lines.push('【2. pickGroup 返回对象可用方法 / 属性（前 50 条）】')
    let group = null
    try {
      group = bot?.pickGroup?.(groupId) ?? bot?.getGroup?.(groupId) ?? bot?.Group?.pick?.(groupId) ?? null
    } catch (_) { group = null }
    if (!group) {
      lines.push('  ❌ 取不到 group 对象（pickGroup 返回 null/undefined）')
    } else {
      const protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(group)).filter(k => typeof group[k] === 'function').slice(0, 40)
      const ownKeys = Object.keys(group).filter(k => typeof group[k] !== 'function').slice(0, 20)
      lines.push(`  方法：${protoKeys.join(', ') || '(无)'}`)
      lines.push(`  属性：${ownKeys.join(', ') || '(无)'}`)
      // 直接访问属性：部分适配器直接挂在 group 根上
      const direct = {
        name: group.name ?? group.groupName ?? group.group_name ?? null,
        ownerUin: group.ownerUin ?? group.owner ?? group.owner_id ?? null,
        memberCount: group.memberCount ?? group.member_count ?? group.memberNum ?? null,
        members: Array.isArray(group.members) ? `Array(${group.members.length})` : (group.members ? typeof group.members : null),
        memberList: Array.isArray(group.memberList) ? `Array(${group.memberList.length})` : null,
        info: group.info ? `typeof=${typeof group.info},keys=${JSON.stringify(Object.keys(group.info).slice(0, 20))}` : null,
      }
      lines.push(`  group.直接属性 = ${JSON.stringify(direct, null, 2).replace(/\n/g, '\n  ')}`)
    }
    lines.push('')

    // 3) 手动调用本插件内部封装的 getGroupInfo / getMemberInfo（导出给诊断用）
    lines.push('【3. 插件内部封装 getGroupInfo() 结果】')
    try {
      const info = await import('../src/groupOps.js').then(async (m) => {
        // 由于 getGroupInfo 没导出，只能重新调用一次内部函数；这里直接走导出的 _roleOf 路径不适用，
        // 因此我们直接在下面手动再调 pickGroup 来重现，为了不新增 export 影响 chatService
        return '(需结合下方第4/5条手动判断)'
      })
      lines.push(`  ${info}`)
    } catch (err) {
      lines.push(`  错误: ${err.message}`)
    }
    lines.push('')

    // 4) 手动调用 pickGroup.getInfo / getGroupInfo 等方法
    lines.push('【4. 手动调用 pickGroup.*Info* 方法（逐个尝试，含原始返回字段）】')
    if (group) {
      const methods = ['getInfo', 'getGroupInfo', 'info', 'fetchInfo', 'refreshInfo', 'getDetail']
      for (const m of methods) {
        if (typeof group[m] !== 'function') continue
        try {
          const t0 = Date.now()
          const r = await group[m]()
          const dt = Date.now() - t0
          const rtype = Object.prototype.toString.call(r).slice(8, -1)
          if (r && typeof r === 'object') {
            const keys = Object.keys(r)
            const sample = {}
            for (const k of keys.slice(0, 18)) sample[k] = typeof r[k] === 'object' ? (Array.isArray(r[k]) ? `Array(${r[k].length})` : '{...}') : r[k]
            lines.push(`  ✅ group.${m}() → ${rtype} · ${dt}ms · keys=[${keys.join(', ')}]`)
            lines.push(`     sample: ${JSON.stringify(sample).slice(0, 260)}`)
          } else {
            lines.push(`  ✅ group.${m}() → ${rtype} · ${dt}ms · 值=${String(r).slice(0, 120)}`)
          }
        } catch (err) {
          lines.push(`  ❌ group.${m}() → 异常: ${err.message}`)
        }
      }
    }
    lines.push('')

    // 5) 手动调用 getMemberInfo(userId)
    lines.push(`【5. 手动调用 pickGroup.getMemberInfo(发送者=${userId}) → 原始返回】`)
    if (group && userId) {
      const methods = ['getMemberInfo', 'getMember', 'getGroupMemberInfo']
      for (const m of methods) {
        if (typeof group[m] !== 'function') continue
        try {
          const t0 = Date.now()
          const r = await group[m](userId)
          const dt = Date.now() - t0
          if (r && typeof r === 'object') {
            const sample = {}
            for (const k of Object.keys(r).slice(0, 20)) {
              sample[k] = typeof r[k] === 'object' ? (Array.isArray(r[k]) ? `Array(${r[k].length})` : '{...}') : r[k]
            }
            lines.push(`  ✅ group.${m}(${userId}) → ${Date.now() - t0}ms`)
            lines.push(`     ${JSON.stringify(sample).slice(0, 400)}`)
          } else {
            lines.push(`  ⚠️ group.${m}(${userId}) → 返回=${String(r).slice(0, 100)} · ${dt}ms`)
          }
        } catch (err) {
          lines.push(`  ❌ group.${m}(${userId}) → 异常: ${err.message}`)
        }
      }
      // getMemberMap 尝试
      if (typeof group.getMemberMap === 'function') {
        try {
          const map = await group.getMemberMap()
          let count = 0
          if (map) {
            count = map.size ?? Object.keys(map).length ?? 0
            // 找发送者
            let hit = null
            if (map.get) hit = map.get(userId) ?? map.get(String(userId)) ?? map.get(Number(userId))
            else hit = map[userId] ?? map[String(userId)]
            lines.push(`  ✅ group.getMemberMap() → size=${count}`)
            lines.push(`     get(userId) = ${hit ? JSON.stringify(hit).slice(0, 300) : '(未找到该用户条目)'}`)
          } else {
            lines.push(`  ⚠️ group.getMemberMap() → null`)
          }
        } catch (err) {
          lines.push(`  ❌ group.getMemberMap() → 异常: ${err.message}`)
        }
      }
    }
    lines.push('')

    // 6) 插件 buildIdentityContext 最终注入的内容（验证全链路）
    lines.push('【6. 插件实际注入到 system prompt 的身份信息（buildIdentityContext 结果）】')
    try {
      const go = await import('../src/groupOps.js')
      const ctx = typeof go.buildIdentityContext === 'function' ? await go.buildIdentityContext(e) : '(未导出)'
      if (!ctx) {
        lines.push('  (空)')
      } else {
        // 分段输出，避免太长刷屏
        const parts = String(ctx).split('\n')
        lines.push(` （共 ${parts.length} 行，仅展示前 25 行）`)
        for (const line of parts.slice(0, 25)) lines.push('  ' + line)
        if (parts.length > 25) lines.push(`  ...(${parts.length - 25} 行省略)`)
      }
    } catch (err) {
      lines.push(`  错误: ${err.message}`)
    }

    // 6) 能力总结
    lines.push('')
    lines.push('【6. 操作能力检测】')
    const caps = [
      ['禁言', typeof group?.muteMember === 'function' || typeof group?.mute === 'function'],
      ['踢出', typeof group?.kickMember === 'function' || typeof group?.kick === 'function'],
      ['设置管理员', typeof group?.setAdmin === 'function'],
      ['设置头衔', typeof group?.setTitle === 'function'],
      ['获取成员信息', typeof group?.getMemberInfo === 'function' || typeof group?.getMember === 'function' || typeof group?.getMemberMap === 'function'],
      ['获取群信息', typeof group?.getGroupInfo === 'function' || typeof group?.getInfo === 'function'],
    ]
    for (const [name, ok] of caps) {
      lines.push(`  ${ok ? '✅' : '❌'} ${name}`)
    }

    return e.reply(lines.join('\n'))
  }

  async testModel() {
    const e = this.e
    const text = helper.getMessageText(e)
    const m = (text || '').match(/^#ai(测试模型|模型测试|测模型)\s*(\S+)?\s*$/)
    const modelKey = (m && m[2]) ? m[2] : null

    // 测试模型包含 apiBase 等配置信息，仅允许私聊执行
    const groupId = helper.getGroupId(e)
    if (groupId) {
      return e.reply('❌ 模型测试包含配置信息，请在私聊中使用')
    }

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
   * #切换模型 [平台编号.模型编号 | 模型名 | 平台key 模型名/编号 | 平台key]
   * 多 API 平台切换：
   *   - 无参数：并发探测所有 provider 的 /models，分组展示「平台A: 模型1,2,...」「平台B: ...」
   *   - 单参数：
   *       "1.3"      → 平台 1 的第 3 个模型
   *       "kimi-k2"  → 在所有平台中按名称模糊匹配（精确 > 大小写不敏感 > 包含）
   *       "1"        → 仅当只有一个平台时按模型编号；多平台时提示用 "1.x" 格式
   *       "kimi"     → 若 kimi 是 provider key，则把默认平台切到 kimi（保留 kimi 现有模型）
   *   - 双参数：第一个视为 provider key，第二个为模型名或编号
   *       例："#切换模型 kimi kimi-k2.6" 或 "#切换模型 kimi 1"
   * 切换到非默认平台时，会同步把 default 字段指向新平台。
   */
  async switchModel() {
    const e = this.e
    const userId = helper.getUserId(e)
    if (!helper.isMaster(userId, e)) {
      return e.reply('❌ 此命令仅主人可用（请联系机器人主人确认权限）')
    }
    const raw = helper.getMessageText(e)
    const re = /^#(ai)?(切换模型|切模型|换模型)\s*(.*)?$/s
    const m = raw.match(re)
    const argStr = (m && m[3] ? m[3].trim() : '')
    const args = argStr.split(/\s+/).filter(Boolean)

    const config = cfg.loadConfig()
    const modelCfg = config.model || {}
    const defaultKey = modelCfg.default || 'openai-compatible'

    // 收集所有 provider 段（排除 default 字段、非对象字段）
    const providerKeys = Object.keys(modelCfg).filter(k =>
      k !== 'default' && modelCfg[k] && typeof modelCfg[k] === 'object'
    )
    if (!providerKeys.length) {
      return e.reply('❌ 未配置任何模型 provider，请先在网页管理后台「多API平台」选项卡中添加。')
    }

    // 参数解析
    let targetKey = null              // 显式指定的 provider key
    let targetModel = ''             // 模型名或编号字符串
    let switchDefaultOnly = false    // 仅切换默认平台，不改模型
    let pageNav = null               // 'prev' | 'next' | number(目标页码)

    if (args.length >= 2) {
      if (providerKeys.includes(args[0])) {
        targetKey = args[0]
        targetModel = args.slice(1).join(' ').trim()
      } else {
        targetModel = argStr
      }
    } else if (args.length === 1) {
      const a = args[0]
      if (providerKeys.includes(a)) {
        targetKey = a
        switchDefaultOnly = true
      } else if (/^上一页$/i.test(a) || /^prev$/i.test(a)) {
        pageNav = 'prev'
      } else if (/^下一页$/i.test(a) || /^next$/i.test(a)) {
        pageNav = 'next'
      } else if (/^第\s*(\d+)\s*页$/.test(a)) {
        pageNav = parseInt(RegExp.$1, 10)
      } else if (/^(\d+)\/(\d+)$/.test(a)) {
        pageNav = parseInt(RegExp.$1, 10)
      } else {
        targetModel = a
      }
    }

    // 并发探测所有 provider 的可用模型
    await e.reply(`🔍 正在探测 ${providerKeys.length} 个 API 平台的可用模型列表（GET /models）...`)
    const providerModels = {}
    await Promise.all(providerKeys.map(async (key) => {
      try {
        const info = await llm.listAvailableModels({ modelKey: key })
        providerModels[key] = {
          ok: !!info.ok,
          models: Array.isArray(info.models) ? info.models : [],
          url: info.url || '',
          status: info.status,
          error: info.error
        }
      } catch (err) {
        providerModels[key] = { ok: false, models: [], error: err.message || String(err) }
      }
    }))

    const currentDefaultModel = modelCfg[defaultKey]?.model || ''

    // 构建统一 providerData（复用）
    let totalAvail = 0
    for (const key of providerKeys) {
      const pm = providerModels[key]
      if (pm.ok && Array.isArray(pm.models)) totalAvail += pm.models.length
    }
    const providerData = providerKeys.map((key, pIdx) => ({
      key,
      idx: pIdx + 1,
      isDefault: key === defaultKey,
      online: !!providerModels[key]?.ok,
      error: providerModels[key]?.error || (providerModels[key]?.ok ? null : `HTTP ${providerModels[key]?.status || '-'}`),
      url: providerModels[key]?.url || '',
      currentModel: modelCfg[key]?.model || '',
      models: providerModels[key]?.models || []
    }))

    // 读取用户上次查看页码（每个用户独立保存，临时 Map，重启失效）
    const PAGE_SESSION_KEY = '__switch_model_page'
    if (!globalThis[PAGE_SESSION_KEY]) globalThis[PAGE_SESSION_KEY] = new Map()
    const pageStore = globalThis[PAGE_SESSION_KEY]
    const totalPages = svgR?.countPages?.(providerData) ?? 1
    let currentPage = 1
    try {
      if (pageNav === 'prev') currentPage = (pageStore.get(userId) || 1) - 1
      else if (pageNav === 'next') currentPage = (pageStore.get(userId) || 1) + 1
      else if (typeof pageNav === 'number') currentPage = pageNav
      currentPage = Math.max(1, Math.min(currentPage, totalPages))
    } catch (_) { currentPage = 1 }

    // ---------- 无参数 / 翻页：列出（图片版，支持分页） ----------
    if ((!targetModel && !switchDefaultOnly) || pageNav) {
      pageStore.set(userId, currentPage)
      try {
        const { svgPath, pageNum, totalPages: actualTotal, hasPrev, hasNext } = svgR?.renderModelListPages?.(providerData, currentPage) || {}
        // 清理旧临时文件
        svgR?.cleanupOldTmp?.()
        // 只发图片，不要和 text 混发
      await e.reply(helper.safeSegmentImage(svgPath))
        setTimeout(() => {
          const navHint = []
          if (hasPrev) navHint.push('← #切换模型 上一页')
          if (hasNext) navHint.push('#切换模型 下一页 →')
          if (actualTotal > 1) navHint.push(`（#切换模型 第 N 页 可直跳）`)
          const hint = [
            `🔁 多平台模型切换 · 当前 ${pageNum}/${actualTotal} 页`,
            `  默认：${defaultKey} · ${currentDefaultModel || '(未设置)'}  共 ${totalAvail} 可用模型`,
            '',
            '切换：① #切换模型 1.3    ② #切换模型 kimi-k2.6    ③ #切换模型 kimi 1',
            (navHint.length ? '翻页：' + navHint.join('  ·  ') : '')
          ].filter(Boolean).join('\n')
          e.reply(hint).catch(() => {})
        }, 1200)
        return true
      } catch (err) {
        // 图片生成失败时退化为文字版（单平台最多显示 15 条）
        const lines = ['🔁 多平台模型切换助手（图片生成失败，退化为文字版）']
        lines.push(`  当前页：${currentPage}/${totalPages} · 默认：${defaultKey} · ${currentDefaultModel || '(未设置)'}`)
        lines.push('')
        providerKeys.forEach((key, pIdx) => {
          const pm = providerModels[key]
          const isDefault = (key === defaultKey)
          const tag = isDefault ? ' ⭐默认' : ''
          lines.push(`【${pIdx + 1}. ${key}】${tag}（${pm.ok ? '在线' : '离线'}）`)
          if (!pm.ok) {
            lines.push(`  ❌ 探测失败：${pm.error || `HTTP ${pm.status || '-'}`}`)
            return
          }
          if (!pm.models.length) {
            lines.push(`  📄 该账号未返回任何可用模型`)
            return
          }
          const curModel = modelCfg[key]?.model || ''
          lines.push(`  当前模型：${curModel || '(未设置)'}  共 ${pm.models.length} 个可用模型`)
          lines.push(`  （单平台只列前 15 条）：`)
          pm.models.slice(0, 15).forEach((id, idx) => {
            const cur = (id === curModel) ? ' ← 当前' : ''
            lines.push(`    ${pIdx + 1}.${idx + 1}) ${id}${cur}`)
          })
          if (pm.models.length > 15) lines.push(`    ...(${pm.models.length - 15} 个未展示，直接 "#切换模型 模型名" 切换)`)
        })
        lines.push('')
        lines.push('切换：#切换模型 1.3 | #切换模型 kimi 1 | #切换模型 kimi  | 翻页：#切换模型 上一页/下一页')
        return e.reply(lines.join('\n'))
      }
    }

    // ---------- 仅切换默认平台（不改模型） ----------
    if (switchDefaultOnly && targetKey) {
      const config2 = cfg.loadConfig()
      if (!config2.model) config2.model = {}
      const oldDefault = config2.model.default || defaultKey
      if (oldDefault === targetKey) {
        return e.reply(`ℹ️ 默认平台已经是 ${targetKey}，无需切换。`)
      }
      config2.model.default = targetKey
      const ok = cfg.saveConfig(config2)
      if (!ok) return e.reply(`❌ 保存配置失败，请查看 Yunzai 日志。`)
      const newModel = config2.model[targetKey]?.model || '(未设置)'
      return e.reply([
        `✅ 默认平台已切换`,
        `  原默认平台：${oldDefault}`,
        `  新默认平台：${targetKey}`,
        `  当前使用模型：${newModel}`,
        ``,
        `💡 上下文不会自动重置，需要新会话可发送 "#ai新会话"。`
      ].join('\n'))
    }

    // ---------- 有 targetModel：解析最终的平台 + 模型 ----------
    let finalKey = null
    let finalModel = ''

    // 情况 A：显式指定了 provider key
    if (targetKey) {
      finalKey = targetKey
      if (/^\d+$/.test(targetModel)) {
        const n = parseInt(targetModel, 10)
        const list = providerModels[finalKey]?.models || []
        if (!list.length) return e.reply(`❌ 平台 ${finalKey} 没有可用模型列表可按编号选，请改用 "#切换模型 ${finalKey} <模型ID>" 直接写名字。`)
        if (n < 1 || n > list.length) return e.reply(`❌ 编号 ${n} 超出范围（平台 ${finalKey} 可用编号 1 ~ ${list.length}）`)
        finalModel = list[n - 1]
      } else {
        finalModel = targetModel
        // 在指定平台列表里做大小写归一化匹配
        const list = providerModels[finalKey]?.models || []
        if (list.length && !list.includes(finalModel)) {
          const ci = list.find(id => id.toLowerCase() === finalModel.toLowerCase())
          if (ci) finalModel = ci
        }
      }
    }
    // 情况 B：按 "平台编号.模型编号" 格式
    else if (/^\d+\.\d+$/.test(targetModel)) {
      const [pStr, mStr] = targetModel.split('.')
      const pIdx = parseInt(pStr, 10)
      const mIdx = parseInt(mStr, 10)
      if (pIdx < 1 || pIdx > providerKeys.length) {
        return e.reply(`❌ 平台编号 ${pIdx} 超出范围（可用 1 ~ ${providerKeys.length}）`)
      }
      finalKey = providerKeys[pIdx - 1]
      const list = providerModels[finalKey]?.models || []
      if (!list.length) return e.reply(`❌ 平台 ${finalKey} 没有可用模型列表可按编号选，请改用 "#切换模型 ${finalKey} <模型ID>" 直接写名字。`)
      if (mIdx < 1 || mIdx > list.length) return e.reply(`❌ 模型编号 ${mIdx} 超出范围（平台 ${finalKey} 可用编号 1 ~ ${list.length}）`)
      finalModel = list[mIdx - 1]
    }
    // 情况 C：纯数字编号
    else if (/^\d+$/.test(targetModel)) {
      if (providerKeys.length === 1) {
        finalKey = providerKeys[0]
        const n = parseInt(targetModel, 10)
        const list = providerModels[finalKey]?.models || []
        if (!list.length) return e.reply(`❌ 平台 ${finalKey} 没有可用模型列表可按编号选，请改用 "#切换模型 <模型ID>" 直接写名字。`)
        if (n < 1 || n > list.length) return e.reply(`❌ 编号 ${n} 超出范围（可用 1 ~ ${list.length}）`)
        finalModel = list[n - 1]
      } else {
        return e.reply([
          `❌ 当前共有 ${providerKeys.length} 个平台，单数字编号无法唯一定位。`,
          `请使用 "#切换模型 [平台编号].[模型编号]" 格式（例：#切换模型 1.3）`,
          `或使用 "#切换模型 [平台key] [模型名/编号]" 格式（例：#切换模型 kimi 1）`,
          `发送 "#切换模型"（无参数）可查看所有平台的模型编号。`
        ].join('\n'))
      }
    }
    // 情况 D：按模型名跨平台匹配
    else {
      const lower = targetModel.toLowerCase()
      for (const key of providerKeys) {
        const list = providerModels[key]?.models || []
        // 1. 精确
        let found = list.find(id => id === targetModel)
        // 2. 大小写不敏感
        if (!found) found = list.find(id => id.toLowerCase() === lower)
        // 3. 包含
        if (!found) found = list.find(id => id.toLowerCase().includes(lower))
        if (found) {
          finalKey = key
          finalModel = found
          break
        }
      }
      if (!finalKey) {
        // 没在任何平台找到 → 当模型ID处理，落到默认平台
        finalKey = defaultKey
        finalModel = targetModel
      }
    }

    // 写入配置
    const config2 = cfg.loadConfig()
    if (!config2.model) config2.model = {}
    if (!config2.model[finalKey]) config2.model[finalKey] = {}
    const before = String(config2.model[finalKey].model || '')
    const oldDefault = config2.model.default || defaultKey
    config2.model[finalKey].model = finalModel
    // 切换到非默认平台时，自动把 default 指向新平台（让用户立即用上新模型）
    if (finalKey !== oldDefault) {
      config2.model.default = finalKey
    }
    const ok = cfg.saveConfig(config2)
    if (!ok) return e.reply(`❌ 保存配置失败，请查看 Yunzai 日志。`)

    const lines = [
      `✅ 模型切换完成`,
      `  平台：${finalKey}${finalKey !== oldDefault ? `（默认平台已由 ${oldDefault} 切到 ${finalKey}）` : ''}`,
      `  原模型：${before || '(未设置)'}`,
      `  新模型：${finalModel}`,
      ``
    ]
    const list = providerModels[finalKey]?.models || []
    if (list.length && list.includes(finalModel)) {
      lines.push(`✔ 新模型在平台 ${finalKey} 的可用列表内，可直接使用。`)
    } else {
      lines.push(`⚠ 新模型"${finalModel}"未出现在平台 ${finalKey} 的 /models 返回列表中（可能是本账号未开通 / 服务商返回列表不全）。`)
      lines.push(`  若调用失败，可发送 "#ai测试模型 ${finalKey}" 或 "#切换模型"（无参数）查看本账号实际可用模型。`)
    }
    lines.push(``, `💡 上下文不会自动重置，需要新会话可发送 "#ai新会话"。`)
    return e.reply(lines.join('\n'))
  }
}
