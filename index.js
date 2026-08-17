import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
)

logger.info(`--------- AI0-Plugin v${packageJson.version} ---------`)

if (!global.segment) {
  global.segment = (await import('oicq')).segment ?? {}
}

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
