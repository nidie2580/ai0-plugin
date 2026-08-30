// 真实复现：拉取服务器上当前部署的 app.js，注入到 dashboard.html 严格单次执行
const fs = require('fs')
const path = require('path')
const { JSDOM, requestInterceptor } = require('jsdom')

const ROOT = '/workspace'
const html = fs.readFileSync(path.join(ROOT, 'web', 'dashboard.html'), 'utf-8')

// 重写 app.js 请求为内联内容（保留 data-route），避免 jsdom 内部 fetch 导致双执行
let _appJs = null
requestInterceptor.register((req) => {
  if (req.url.includes('app.js') && !req.url.includes('app.css')) {
    if (!_appJs) _appJs = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'app.js'), 'utf-8')
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/javascript' },
      body: Buffer.from(_appJs, 'utf-8')
    }
  }
  if (req.url.includes('app.css')) {
    try {
      const css = fs.readFileSync(path.join(ROOT, 'web', 'assets', 'app.css'), 'utf-8')
      return { statusCode: 200, headers: { 'content-type': 'text/css' }, body: Buffer.from(css, 'utf-8') }
    } catch {}
  }
  return null
})

const errors = []
const dom = new JSDOM(html, {
  url: 'http://64.90.13.100:9178/',
  runScripts: 'dangerously',
  resources: 'usable',
  beforeParse(window) {
    window.alert = (m) => { errors.push('ALERT: ' + m); console.log('ALERT:', m) }
    window.fetch = async (url) => {
      const u = String(url)
      const j = (obj, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(obj), json: async () => obj })
      if (u.includes('/api/config')) return j({ config: { model: { default: 'openai-compatible', 'openai-compatible': { name: 'op' } }, chat: {}, system: {}, agent: {}, permissions: {}, response: {}, web: { port: 12580, host: '127.0.0.1' } } })
      if (u.includes('/api/guard/status')) return j({ locked: false, pending: [] })
      return j({})
    }
  }
})

const { window } = dom
window.addEventListener('error', (e) => {
  errors.push('[error] ' + e.message + ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno)
  console.log('[error]', e.message, '@', e.filename, e.lineno + ':' + e.colno)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  errors.push('[rejection] ' + ((r && (r.message || String(r))) || r))
  console.log('[rejection]', r && (r.message || String(r)))
})

setTimeout(() => {
  const tag = window.document.getElementById('cfgTag')
  console.log('\n=== RESULT ===')
  console.log('cfgTag text:', tag ? JSON.stringify(tag.textContent) : '(no cfgTag)')
  console.log('__AI0_BUILD__:', window.__AI0_BUILD__)
  console.log('typeof bindEvent:', typeof window.bindEvent, '(window.bindEvent)')
  console.log('errors:', errors.length)
  if (errors.length) errors.forEach(e => console.log('  -', e))
  process.exit(0)
}, 500)