import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  fetchOfficialBroadcasts,
  getBroadcastMediaUrl,
} from '../../src/officialBroadcast.js'

let seq = 0
function tmpCachePath() {
  return path.join(os.tmpdir(), `ai0-broadcast-test-${process.pid}-${Date.now()}-${seq++}.json`)
}

function okDeps(overrides = {}) {
  return {
    loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
    getInstanceId: () => 'a'.repeat(32),
    ...overrides,
  }
}

const SAMPLE_BROADCASTS = [
  { id: 4, title: '服务升级通知', content: '今晚 23:00 维护', media_type: 'text', media_url: '', execute_at: '2026-09-24 23:00', created_at: '2026-09-24 09:00:12' },
  { id: 5, title: '新模型上线', content: '', media_type: 'image', media_url: 'https://media.example.com/data/broadcasts/a.png', execute_at: '2026-09-24 10:00', created_at: '2026-09-24 09:30:44' },
]

describe('officialBroadcast', () => {
  it('首次拉取成功写缓存；TTL 内再取命中缓存，不再发请求', async () => {
    let calls = 0
    const cachePath = tmpCachePath()
    const deps = okDeps({
      cachePath,
      request: async () => {
        calls++
        return { status: 200, data: { ok: true, broadcasts: SAMPLE_BROADCASTS } }
      },
    })
    const r1 = await fetchOfficialBroadcasts({}, deps)
    assert.equal(r1.ok, true)
    assert.equal(r1.stale, false)
    assert.equal(r1.broadcasts.length, 2)
    // 媒体地址保留在缓存里供代理使用；text 类型一律清空
    assert.equal(r1.broadcasts[1].media_url, 'https://media.example.com/data/broadcasts/a.png')
    assert.equal(r1.broadcasts[0].media_url, '')

    const r2 = await fetchOfficialBroadcasts({}, deps)
    assert.equal(r2.ok, true)
    assert.equal(r2.cached, true)
    assert.equal(r2.broadcasts.length, 2)
    assert.equal(calls, 1)
  })

  it('鉴权失败：保留旧缓存并标记 stale，错误经脱敏回传', async () => {
    const cachePath = tmpCachePath()
    const deps = okDeps({
      cachePath,
      request: async () => ({ status: 200, data: { ok: true, broadcasts: SAMPLE_BROADCASTS } }),
    })
    await fetchOfficialBroadcasts({}, deps)

    const r = await fetchOfficialBroadcasts({ force: true }, okDeps({
      cachePath,
      request: async () => ({ status: 401, data: { ok: false, code: 'UNAUTHORIZED', message: '实例密钥或 API Key 无效' } }),
    }))
    assert.equal(r.ok, false)
    assert.equal(r.stale, true)
    assert.equal(r.code, 'UNAUTHORIZED')
    assert.match(r.error, /无效/)
    assert.equal(r.broadcasts.length, 2)
  })

  it('请求异常：无缓存时返回 ok:false 且不抛出；30 秒内节流不再请求', async () => {
    const cachePath = tmpCachePath()
    let calls = 0
    const deps = okDeps({
      cachePath,
      request: async () => {
        calls++
        throw new Error('connect timeout')
      },
    })
    const r1 = await fetchOfficialBroadcasts({}, deps)
    assert.equal(r1.ok, false)
    assert.equal(r1.broadcasts.length, 0)
    assert.match(r1.error, /暂不可达/)

    const r2 = await fetchOfficialBroadcasts({}, deps)
    assert.equal(r2.ok, false)
    assert.equal(r2.stale, true)
    assert.equal(calls, 1)
  })

  it('force 刷新绕过缓存与节流', async () => {
    const cachePath = tmpCachePath()
    let calls = 0
    const base = okDeps({
      cachePath,
      request: async () => {
        calls++
        return { status: 200, data: { ok: true, broadcasts: SAMPLE_BROADCASTS } }
      },
    })
    await fetchOfficialBroadcasts({}, base)
    await fetchOfficialBroadcasts({ force: true }, base)
    assert.equal(calls, 2)
  })

  it('未配置官方 API：直接返回未配置，不发请求', async () => {
    const cachePath = tmpCachePath()
    let calls = 0
    const r = await fetchOfficialBroadcasts({ force: true }, {
      cachePath,
      loadConfig: () => ({ model: { default: 'x', x: { kind: 'custom' } } }),
      getInstanceId: () => 'a'.repeat(32),
      request: async () => { calls++; return { status: 200, data: { ok: true, broadcasts: [] } } },
    })
    assert.equal(r.ok, false)
    assert.equal(r.error, '未配置官方 API')
    assert.equal(calls, 0)
  })

  it('实例 ID 非法：不发请求', async () => {
    const cachePath = tmpCachePath()
    let calls = 0
    const r = await fetchOfficialBroadcasts({ force: true }, okDeps({
      cachePath,
      getInstanceId: () => 'not-a-hex-id',
      request: async () => { calls++; return { status: 200, data: { ok: true, broadcasts: [] } } },
    }))
    assert.equal(r.ok, false)
    assert.match(r.error, /实例身份无效/)
    assert.equal(calls, 0)
  })

  it('清洗：非法条目丢弃，标题/正文脱敏官方域名，非法媒体地址清空', async () => {
    const cachePath = tmpCachePath()
    const r = await fetchOfficialBroadcasts({ force: true }, okDeps({
      cachePath,
      request: async () => ({
        status: 200,
        data: {
          ok: true,
          broadcasts: [
            { id: 'abc', title: '无效 id' },
            { id: 2, title: '' },
            { id: 7, title: '访问 api.djyun.click 控制台', content: '详情见 https://api.djyun.click/console', media_type: 'voice', media_url: 'ftp://bad/x.mp3' },
            { id: 8, title: '语音通知', media_type: 'voice', media_url: 'https://media.example.com/v.mp3' },
          ],
        },
      }),
    }))
    assert.equal(r.ok, true)
    assert.equal(r.broadcasts.length, 2)
    const b7 = r.broadcasts.find((b) => b.id === 7)
    const b8 = r.broadcasts.find((b) => b.id === 8)
    assert.match(b7.title, /\[official\]/)
    assert.ok(!b7.title.includes('api.djyun.click'))
    assert.match(b7.content, /\[official\]/)
    assert.equal(b7.media_url, '')
    assert.equal(b8.media_url, 'https://media.example.com/v.mp3')
  })

  it('getBroadcastMediaUrl：仅返回缓存内条目的媒体地址', async () => {
    const cachePath = tmpCachePath()
    const deps = okDeps({
      cachePath,
      request: async () => ({ status: 200, data: { ok: true, broadcasts: SAMPLE_BROADCASTS } }),
    })
    await fetchOfficialBroadcasts({}, deps)
    assert.equal(getBroadcastMediaUrl(5, { cachePath }), 'https://media.example.com/data/broadcasts/a.png')
    assert.equal(getBroadcastMediaUrl(4, { cachePath }), '')
    assert.equal(getBroadcastMediaUrl(999, { cachePath }), '')
    assert.equal(getBroadcastMediaUrl('abc', { cachePath }), '')
    assert.equal(getBroadcastMediaUrl(0, { cachePath }), '')
    assert.equal(getBroadcastMediaUrl(-1, { cachePath }), '')
  })

  it('请求 URL 带实例密钥且不出现 pending/ack 路径', async () => {
    const cachePath = tmpCachePath()
    let seenUrl = ''
    await fetchOfficialBroadcasts({ force: true }, okDeps({
      cachePath,
      request: async (method, url) => {
        seenUrl = url
        return { status: 200, data: { ok: true, broadcasts: [] } }
      },
    }))
    assert.match(seenUrl, /\/plugin\/broadcasts\?instance_id=a{32}&provider_key=official$/)
    assert.ok(!seenUrl.includes('/pending'))
    assert.ok(!seenUrl.includes('/ack'))
  })
})
