import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cfg from './config/index.js'
import * as ws from './src/webServer.js'
import * as helper from './src/helper.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
)

logger.info(`--------- AI0-Plugin v${packageJson.version} ---------`)

if (!global.segment) {
  try {
    global.segment = (await import('oicq')).segment ?? {}
  } catch (_) { global.segment = {} }
}

setTimeout(() => {
  try {
    const s = helper.listMasterSources()
    const all = helper.listMasters()
    logger.info(`[ai0-plugin] 主人列表：框架(${s.framework.length})=[${s.framework.join(',') || '-'}] + 插件(${s.plugin.length})=[${s.plugin.join(',') || '-'}] → 合并 ${all.length} 人: ${all.join(',') || '(空，管理命令将不可用!)'}`)
    if (!all.length) {
      logger.warn(`[ai0-plugin] ⚠️ 未检测到任何主人！可在 Yunzai 全局 config/matcher.master 或 插件 config.yaml 的 permissions.masters 中配置。`)
    }
  } catch (e) {
    logger.warn(`[ai0-plugin] 读取主人列表失败：${e.message}`)
  }
}, 600)

setTimeout(async () => {
  try {
    const autoStart = cfg.get('web.autoStart', true) !== false
    if (autoStart) {
      const { host, port } = cfg.getWebBindFromConfig?.() ?? (() => {
        const c = cfg.loadConfig()
        return { host: c?.web?.host ?? '127.0.0.1', port: c?.web?.port ?? 12580 }
      })()
      try {
        await ws.startWebServer(port, host)
        const info = ws.getServerInfo()
        const lines = [`[ai0-plugin] 网页后台：绑定 ${info.host}:${info.port}（主人发送 #ai网页管理 获取直链; 任何人发送 #ai诊断 查看当前状态）`]
        if (info.publicUrls && info.publicUrls.length) {
          lines.push(`  可访问地址（${info.publicUrls.length} 个）：`)
          for (const u of info.publicUrls) lines.push(`    - ${u}`)
        }
        if (info.host === '0.0.0.0' || info.host === '::') {
          lines.push(`  ⚠️ 已开启对外监听，请确认安全组/防火墙已放行 TCP ${port} 端口。访问请用真实公网/局域网IP，不要用 0.0.0.0。`)
        }
        logger.info(lines.join('\n'))
      } catch (err) {
        logger.warn(`[ai0-plugin] 网页后台启动失败（端口占用？）：${err.message}`)
      }
    }
  } catch (e) {
    logger.warn(`[ai0-plugin] 初始化网页后台出错：${e.message}`)
  }
}, 800)

const appsDir = path.join(__dirname, 'apps')
const apps = {}
const ALLOWED_APPS = new Set(['chat.js', 'commands.js', 'groupOps.js'])
if (fs.existsSync(appsDir)) {
  for (const file of fs.readdirSync(appsDir).filter(f => f.endsWith('.js'))) {
    if (!ALLOWED_APPS.has(file)) {
      logger.warn && logger.warn(`[ai0-plugin] 跳过未授权模块 ${file}（不在白名单中）`)
      continue
    }
    try {
      const mod = await import(`./apps/${file}`)
      for (const key of Object.keys(mod)) {
        apps[key] = mod[key]
      }
    } catch (err) {
      logger.error(`[ai0-plugin] 加载模块 ${file} 失败: ${err.message}`)
    }
  }
}

export { apps }
