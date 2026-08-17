import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cfg from './config/index.js'
import * as ws from './src/webServer.js'

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

setTimeout(async () => {
  try {
    const config = cfg.loadConfig()
    const autoStart = config.web?.autoStart !== false
    if (autoStart) {
      const port = Number(config.web?.port) || 12580
      const host = config.web?.host || '127.0.0.1'
      try {
        await ws.startWebServer(port, host)
        const info = ws.getServerInfo()
        logger.info(`[ai0-plugin] 网页后台：${info.url}  (主人发送 #ai网页管理 获取直链)`)
      } catch (err) {
        logger.warn(`[ai0-plugin] 网页后台启动失败（端口占用？）：${err.message}`)
      }
    }
  } catch (e) {
    logger.warn(`[ai0-plugin] 初始化网页后台出错：${e.message}`)
  }
}, 500)

const appsDir = path.join(__dirname, 'apps')
const apps = {}
if (fs.existsSync(appsDir)) {
  for (const file of fs.readdirSync(appsDir).filter(f => f.endsWith('.js'))) {
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
