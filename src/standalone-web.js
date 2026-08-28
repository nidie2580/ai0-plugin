import os from 'node:os'
import * as ws from './webServer.js'
import * as auth from './auth.js'

function localIPs() {
  const nets = os.networkInterfaces()
  const ips = []
  for (const key of Object.keys(nets)) {
    for (const n of nets[key]) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address)
    }
  }
  return ips
}

async function main() {
  const port = Number(process.env.AI0_PORT) || 12580
  // 默认只绑定本机（与 README 文档一致）；需局域网访问时显式设置 AI0_HOST=0.0.0.0
  const host = process.env.AI0_HOST || '127.0.0.1'
  try {
    await ws.startWebServer(port, host)
  } catch (e) {
    console.error('启动失败：', e.message)
    process.exit(1)
  }
  const info = ws.getServerInfo()
  const ips = ['127.0.0.1', ...localIPs()]
  console.log('\n======== AI0-Plugin 网页管理后台 ========')
  for (const ip of ips) {
    console.log(`  本机访问：http://${ip}:${port}`)
  }
  console.log('')
  console.log('首次登录需使用「终端验证码」（ID 固定为 stdin）：')
  // 独立启动场景拿不到 Web clientIp，显式传 'unknown'：
  //  verifyCode 内部退化为单次使用 + rate limit + 5 次错误作废防护（不强制 IP 一致，避免 IP 劫持 DoS）。
  // 验证码 ID 用 'stdin' 标识（可读），替代原来的 32 位 hex。
  auth.generateTerminalCode('unknown', 'stdin')
  console.log('')
  console.log('提示：复制上述 ID + Code，在网页「终端验证码登录」处填入即可。')
  console.log('==========================================\n')
}

main()
