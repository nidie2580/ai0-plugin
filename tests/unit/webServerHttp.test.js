import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createApp } from '../../src/webServer.js'
import * as auth from '../../src/auth.js'
import * as loginGuard from '../../src/loginGuard.js'

// webServer HTTP 装配层安全测试（此前完全无覆盖，2026-10 审查补齐）。
// 覆盖点：
//  - W1：未认证访问受保护接口 → 401。
//  - W2：验证码登录端到端：错误 code 拒绝；正确 code 通过并下发 HttpOnly cookie。
//  - W3：登录态 GET /api/config → 200 且 apiKey 全量脱敏（不回显真实字符）。
//  - W4：CSRF 双提交：缺 header → 403；cookie/header 齐备但值不匹配 → 403。
//  - W5：POST /api/config 对话参数类型校验（temperature 注入字符串被拒，不落盘）。
//  - W6：登录守卫锁定态：异身份待审批期间，持有效会话访问 /api/config → 423；
//        终端放行后解锁恢复 200。
//
// 说明：只走"拒绝路径"，POST /api/config 不触发 saveConfig，不写真实 config.yaml。

let server
let base

function startServer() {
  return new Promise((resolve) => {
    const app = createApp()
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
}

function cookiesFromRes(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean)
  const jar = {}
  for (const line of set) {
    const [pair] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return jar
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
}

async function req(method, urlPath, { headers = {}, body = null } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch (_) {}
  return { status: res.status, res, json }
}

describe('webServer HTTP 安全装配层', async () => {
  await startServer()

  after(() => new Promise((resolve) => server.close(resolve)))

  await it('W1: 未认证访问 /api/config → 401', async () => {
    const r = await req('GET', '/api/config')
    assert.equal(r.status, 401)
  })

  await it('W2: 验证码登录：错误 code 拒绝；正确 code 直通（首登）并下发 cookie', async () => {
    // QQ 生成场景拿不到 Web clientIp，createdIp='unknown'，不绑定 IP（与 auth.js 注释一致）
    const { id, code } = auth.generateTerminalCode('unknown', SHARED_IDENTITY)
    const bad = await req('POST', '/api/login/code', { body: { codeId: id, code: 'wrong-wrong-wrong1' } })
    assert.equal(bad.json.ok, false)
    assert.match(String(bad.json.msg), /验证码错误/)
    const good = await req('POST', '/api/login/code', { body: { codeId: id, code } })
    assert.equal(good.json.ok, true)
    assert.equal(good.json.needVerify, undefined)
    const jar = cookiesFromRes(good.res)
    assert.ok(jar.ai0_session, '应下发 session cookie')
    assert.ok(jar.ai0_csrf, '应下发 csrf cookie（double-submit 前端可读）')
    return jar
  })

  await it('W3: 登录态 GET /api/config → 200 且 apiKey 全量脱敏', async () => {
    const jar = await authedJar()
    const r = await req('GET', '/api/config', { headers: { cookie: cookieHeader(jar) } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    for (const [k, v] of Object.entries(r.json.config.model || {})) {
      if (k === 'default' || !v || typeof v !== 'object') continue
      if (v.apiKey) {
        assert.ok(!/sk-[A-Za-z0-9_-]{20,}/.test(v.apiKey), `模型 ${k} 的 apiKey 不得明文回显`)
      }
    }
  })

  await it('W4: CSRF 双提交：缺 header → 403；值不匹配 → 403', async () => {
    const jar = await authedJar()
    const noHeader = await req('POST', '/api/config', {
      headers: { cookie: cookieHeader(jar) },
      body: { config: {} },
    })
    assert.equal(noHeader.status, 403)
    assert.match(String(noHeader.json.msg), /CSRF/)
    const wrong = await req('POST', '/api/config', {
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': 'deadbeef'.repeat(4) },
      body: { config: {} },
    })
    assert.equal(wrong.status, 403)
  })

  await it('W5: POST /api/config temperature 注入字符串被类型校验拒绝（XSS 纵深）', async () => {
    const jar = await authedJar()
    const r = await req('POST', '/api/config', {
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.ai0_csrf },
      body: {
        config: {
          model: {
            default: 'openai-compatible',
            'openai-compatible': {
              name: '测试', apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'm',
              temperature: '" onfocus=alert(1) autofocus="',
            },
          },
        },
      },
    })
    assert.equal(r.json.ok, false)
    assert.match(String(r.json.msg), /temperature/)
  })

  await it('W6: 守卫锁定态：有效会话也被 423 拦截，终端放行后恢复', async () => {
    const jar = await authedJar()
    // 放行前先确认正常可访问
    const before = await req('GET', '/api/config', { headers: { cookie: cookieHeader(jar) } })
    assert.equal(before.status, 200)

    const rec = loginGuard.createPending({ identity: 'attacker-qq', ip: '203.0.113.9' })
    try {
      const locked = await req('GET', '/api/config', { headers: { cookie: cookieHeader(jar) } })
      assert.equal(locked.status, 423)
      assert.equal(locked.json.locked, true)
      const lockedWrite = await req('POST', '/api/config', {
        headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.ai0_csrf },
        body: { config: {} },
      })
      assert.equal(lockedWrite.status, 423)
    } finally {
      // 用放行码解锁，避免污染同文件后续用例
      loginGuard.approve(rec.code)
    }
    const unlocked = await req('GET', '/api/config', { headers: { cookie: cookieHeader(jar) } })
    assert.equal(unlocked.status, 200)
  })
})

let _jar = null
const SHARED_IDENTITY = 'wtest-identity'
async function authedJar() {
  if (_jar) return _jar
  // 与 W2 使用同一身份（首登已建立主身份），避免异身份登录进入待审批流程
  const { id, code } = auth.generateTerminalCode('unknown', SHARED_IDENTITY)
  const r = await req('POST', '/api/login/code', { body: { codeId: id, code } })
  assert.equal(r.json.ok, true, '登录应成功')
  assert.equal(r.json.needVerify, undefined, '主身份重复登录应直通')
  _jar = cookiesFromRes(r.res)
  return _jar
}
