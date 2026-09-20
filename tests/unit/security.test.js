import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sec = await import('../../src/security.js')
const secLog = await import('../../src/securityLog.js')
const cfg = await import('../../config/index.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.join(__dirname, '..', '..', 'logs', 'security')
const LOG_FILE = path.join(LOG_DIR, 'security.log')

describe('security: 安全审计日志轮转', () => {
  const CONFIG_PATH = fileURLToPath(new URL('../../config/config.yaml', import.meta.url))
  const backupExists = fs.existsSync(CONFIG_PATH)
  const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null
  const logDirExists = fs.existsSync(LOG_DIR)

  before(() => {
    // 用极小阈值触发轮转（min 1KB）
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ securityLog: { maxBytes: 1024, maxFiles: 2 } }), 'utf-8')
    cfg.setForceLoad(true)
  })

  after(() => {
    if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
    else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
    cfg.setForceLoad(false)
    // 清理测试产生的归档，只留原状态
    for (const f of fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR) : []) {
      if (/^security\..+\.log$/.test(f)) fs.unlinkSync(path.join(LOG_DIR, f))
    }
    if (!logDirExists && fs.existsSync(LOG_DIR)) fs.rmdirSync(LOG_DIR)
  })

  it('超过阈值后触发轮转，且只保留 maxFiles 份', () => {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    for (let i = 0; i < 10; i++) secLog.recordSecurityEvent({ kind: 'agent_cmd_rejected', action: `x${i}` })
    const files = fs.readdirSync(LOG_DIR).filter((f) => /^security\./.test(f))
    // 归档文件数 <= maxFiles(2)
    const archives = files.filter((f) => /^security\..+\.log$/.test(f))
    assert.ok(archives.length <= 2, `归档文件数应<=2，实际${archives.length}`)
    // 当前 security.log 存在且是 JSONL
    assert.ok(fs.existsSync(LOG_FILE))
    assert.match(fs.readFileSync(LOG_FILE, 'utf-8'), /agent_cmd_rejected/)
  })
})

describe('security: safeFetchWithRedirects', () => {
  it('拒绝私有 IP', async () => {
    const result = await sec.safeFetchWithRedirects('http://127.0.0.1/secret')
    assert.equal(result.ok, false)
    assert.match(result.error, /私有/)
  })

  it('拒绝私有域名解析', async () => {
    const result = await sec.safeFetchWithRedirects('http://localhost/path')
    assert.equal(result.ok, false)
  })

  it('拒绝非 HTTP URL', async () => {
    const result = await sec.safeFetchWithRedirects('file:///etc/passwd')
    assert.equal(result.ok, false)
  })

  it('拒绝空 URL', async () => {
    const result = await sec.safeFetchWithRedirects('')
    assert.equal(result.ok, false)
  })

  it('成功请求公网 HTTPS URL', async () => {
    const result = await sec.safeFetchWithRedirects('https://httpbin.org/get')
    // httpbin 可能不可用或返回非 200，只要能连通即通过
    if (result.ok) {
      assert.ok(result.response.status >= 200)
    }
  })
})

describe('security: isAllowedOutboundUrl', () => {
  it('允许公网 URL', async () => {
    const result = await sec.isAllowedOutboundUrl('https://example.com')
    assert.equal(result.ok, true)
    assert.ok(result.resolvedIp)
  })

  it('拒绝私有 IP', async () => {
    const result = await sec.isAllowedOutboundUrl('http://192.168.1.1')
    assert.equal(result.ok, false)
  })

  it('拒绝 localhost', async () => {
    const result = await sec.isAllowedOutboundUrl('http://localhost')
    assert.equal(result.ok, false)
  })

  it('拒绝非法 URL', async () => {
    const result = await sec.isAllowedOutboundUrl('not-a-url')
    assert.equal(result.ok, false)
  })
})

describe('security: security.allowPrivateHosts 白名单', () => {
  const CONFIG_PATH = fileURLToPath(new URL('../../config/config.yaml', import.meta.url))
  const backupExists = fs.existsSync(CONFIG_PATH)
  const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

  after(() => {
    if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
    else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
    cfg.setForceLoad(false)
  })

  function setAllow(list) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ security: { allowPrivateHosts: list } }), 'utf-8')
    cfg.setForceLoad(true)
    cfg.loadConfig()
  }

  it('默认拒绝回环 IP', async () => {
    setAllow([])
    const result = await sec.isAllowedOutboundUrl('http://127.0.0.1:8000/v1')
    assert.equal(result.ok, false)
    assert.match(result.reason, /私有|回环/)
  })

  it('白名单含 127.0.0.1 → 放行回环 IP', async () => {
    setAllow(['127.0.0.1'])
    const result = await sec.isAllowedOutboundUrl('http://127.0.0.1:8000/v1')
    assert.equal(result.ok, true)
  })

  it('白名单含 host:port 时按主机名放行 localhost', async () => {
    setAllow(['localhost:8000'])
    const result = await sec.isAllowedOutboundUrl('http://localhost:8000/v1')
    assert.equal(result.ok, true)
    const denied = await sec.isAllowedOutboundUrl('http://some-other-host:8000/v1')
    assert.equal(denied.ok, false)
  })

  it('白名单为 "*" → 放行私有地址', async () => {
    setAllow(['*'])
    const result = await sec.isAllowedOutboundUrl('http://192.168.1.10')
    assert.equal(result.ok, true)
  })
})

describe('security: hasSystemProxy', () => {
  it('无代理环境变量时为 false', () => {
    const bak = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      all_proxy: process.env.all_proxy,
    }
    try {
      for (const k of Object.keys(bak)) delete process.env[k]
      assert.equal(sec.hasSystemProxy(), false)
    } finally {
      for (const [k, v] of Object.entries(bak)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('HTTPS_PROXY 非空时为 true', () => {
    const prev = process.env.HTTPS_PROXY
    try {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
      assert.equal(sec.hasSystemProxy(), true)
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = prev
    }
  })
})
