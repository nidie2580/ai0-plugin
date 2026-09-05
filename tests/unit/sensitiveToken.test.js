import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// 敏感令牌脱敏回归测试
// 覆盖点：
//  - S1：常见前缀类令牌被归一化为 [已脱敏:<类型>:<前4>…<后4>]（GitHub PAT / sk- / Bearer / AWS）。
//  - S2：键值对形式（apiKey= / password:）也脱敏。
//  - S3：普通闲聊词（token・secret・通行证・话题）不误伤。
//  - S4：幂等——对已脱敏文本再次调用不产生嵌套占位。
//  - S5：空串 / null 安全返回，不抛错。

const { scrubSensitiveTokens } = await import('../../src/helper.js')

const MARK = (type, head, tail) => `[已脱敏:${type}:${head}…${tail}]`

describe('敏感令牌脱敏', () => {
  it('S1a: GitHub PAT 脱敏且不暴露泄露体', () => {
    // 测试占位：ghp_ + 36个'a'，命中 PAT 规则但绝非真实密钥（避免触发 GitHub 密钥扫描）
    const fakePat = 'ghp_' + 'a'.repeat(36)
    const out = scrubSensitiveTokens('令牌是 ' + fakePat + '，请克隆')
    assert.match(out, /\[已脱敏:github-pat:ghp_…aaaa\]/)
    // 完整令牌必须整体消失
    assert.ok(!out.includes(fakePat))
  })

  it('S1b: OpenAI sk- / Bearer / AWS 均脱敏', () => {
    // 全部用运行时构造的假值，命中规则但绝非真实密钥，避免触发 GitHub Secret Scanning
    const fakeSk = 'sk-' + 'b'.repeat(36)
    const fakeJwt = 'eyJ' + 'c'.repeat(24) + '.def'
    const fakeAws = 'AKIA' + 'A'.repeat(16)
    assert.match(scrubSensitiveTokens('k=' + fakeSk), /\[已脱敏:openai-sk:sk-b…bbbb\]/)
    assert.match(scrubSensitiveTokens('Bearer ' + fakeJwt), /\[已脱敏:bearer:eyJc….def\]/)
    assert.match(scrubSensitiveTokens(fakeAws), /\[已脱敏:aws-secret:AKIA…AAAA\]/)
  })

  it('S2: apiKey= / password: 键值对脱敏', () => {
    const fakeKey = 'w'.repeat(20)
    assert.match(scrubSensitiveTokens('apiKey=' + fakeKey), /\[已脱敏:api-key:wwww…wwww\]/)
    assert.match(scrubSensitiveTokens('password: "hunter2"'), /\[已脱敏:password:hunt…ter2\]/)
  })

  it('S3: 普通闲聊词不误伤', () => {
    const out = scrubSensitiveTokens('令牌是 通行证，token 话题，secret 小道消息，没有密钥')
    // 不含任何脱敏占位
    assert.ok(!out.includes('[已脱敏:'))
  })

  it('S4: 幂等——不产生嵌套占位', () => {
    const fakePat = 'ghp_' + 'a'.repeat(36)
    const fakeKey = 'w'.repeat(20)
    const once = scrubSensitiveTokens(fakePat + ' 和 apiKey=' + fakeKey)
    assert.match(once, /\[已脱敏:github-pat:ghp_…aaaa\]/)
    assert.match(once, /\[已脱敏:api-key:wwww…wwww\]/)
    const twice = scrubSensitiveTokens(once)
    assert.equal(twice, once)
    // 幂等：彻底还原一致，占位数量不变（不存在被二次替换）。
    const countMark = (s) => (s.match(/\[已脱敏:/g) || []).length
    assert.equal(countMark(twice), countMark(once))
  })

  it('S5: 空串/非字符串安全', () => {
    assert.equal(scrubSensitiveTokens(''), '')
    assert.equal(scrubSensitiveTokens(null), '')
    assert.equal(scrubSensitiveTokens(undefined), '')
  })
})
