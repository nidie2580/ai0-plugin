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
  const host = process.env.AI0_HOST || '0.0.0.0'
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
  console.log('首次登录需使用「终端验证码」：')
  auth.generateTerminalCode()
  console.log('')
  console.log('提示：复制上述 6 位验证码，在网页「终端验证码登录」处填入即可。')
  console.log('==========================================\n')
}

main()
