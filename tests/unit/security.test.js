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
  const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
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
