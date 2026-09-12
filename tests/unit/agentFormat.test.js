import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractAgentCommands,
  hasAgentCommand,
  stripAgentActionTags,
  setRateLimitRetryConfig,
  runAgentLoop,
  continueAgentInHistory
} from '../../src/agent.js'

// 模型"跑偏"时会照搬通用 tool_call 模板（<tool_calls>/<invoke>/<command>）
// 或把方括号写成尖括号伪标签（<action:agent:...>）。这些格式若不被识别，Agent 将完全不执行。

describe('agent: Agent 指令多格式解析', () => {
  test('官方方括号格式', () => {
    assert.deepEqual(extractAgentCommands('执行 [action:agent:ls -la] 完成'), ['ls -la'])
    assert.equal(hasAgentCommand('执行 [action:agent:ls -la] 完成'), true)
  })

  test('尖括号伪标签：闭合标签被写成 </action:agent:命令首词>', () => {
    assert.deepEqual(
      extractAgentCommands('<action:agent:cd ai0-plugin && git log -1</action:agent:cd>'),
      ['cd ai0-plugin && git log -1']
    )
  })

  test('尖括号伪标签：带冒号闭合 / 不带冒号 / 未闭合', () => {
    assert.deepEqual(extractAgentCommands('<action:agent:echo hi</action:agent>'), ['echo hi'])
    assert.deepEqual(extractAgentCommands('<action:agent>whoami</action:agent>'), ['whoami'])
    assert.deepEqual(extractAgentCommands('先看看 <action:agent:pwd> 吧'), ['pwd'])
  })

  test('tool_calls + invoke + command 标签：提取全部命令', () => {
    const text = [
      '<tool_calls>',
      '<invoke name="Bash">',
      '<command>ls -la</command>',
      '<description>列目录</description>',
      '</invoke>',
      '<invoke name="Bash">',
      '<command>git status</command>',
      '</invoke>',
      '</tool_calls>'
    ].join('\n')
    assert.deepEqual(extractAgentCommands(text), ['ls -la', 'git status'])
  })

  test('tool_calls + parameter name="command"', () => {
    const text = '<tool_calls><invoke name="Bash"><parameter name="command">pwd</parameter></invoke></tool_calls>'
    assert.deepEqual(extractAgentCommands(text), ['pwd'])
  })

  test('tool_call JSON 参数', () => {
    const text = '<tool_call>{"name":"Bash","arguments":{"command":"echo hi"}}</tool_call>'
    assert.deepEqual(extractAgentCommands(text), ['echo hi'])
  })

  test('HTML 实体解码（tool_call 常见转义）', () => {
    assert.deepEqual(
      extractAgentCommands('<command>ls &amp;&amp; echo &quot;ok&quot;</command>'),
      ['ls && echo "ok"']
    )
  })

  test('无指令返回空，hasAgentCommand=false', () => {
    assert.deepEqual(extractAgentCommands('这是一段普通回复'), [])
    assert.equal(hasAgentCommand('这是一段普通回复'), false)
  })

  test('stripAgentActionTags 剥离全部标记、保留正文', () => {
    const text = '开始\n<tool_calls><invoke name="Bash"><command>ls</command></invoke></tool_calls>\n结束 [action:agent:pwd]'
    const clean = stripAgentActionTags(text)
    assert.equal(clean.includes('tool_calls'), false)
    assert.equal(clean.includes('action:agent'), false)
    assert.match(clean, /开始/)
    assert.match(clean, /结束/)
  })

  test('混合格式按出现顺序提取', () => {
    const text = '[action:agent:echo A] 然后 <action:agent:echo B> 再 <tool_calls><invoke><command>echo C</command></invoke></tool_calls>'
    assert.deepEqual(extractAgentCommands(text), ['echo A', 'echo B', 'echo C'])
  })
})

describe('agent: 多格式在循环中真正执行', () => {
  after(() => setRateLimitRetryConfig(60_000, 3))

  test('runAgentLoop 执行 tool_calls 格式命令', async () => {
    setRateLimitRetryConfig(10, 1)
    let n = 0
    const callFn = async () => {
      n++
      if (n === 1) return { text: '<tool_calls><invoke name="Bash"><command>echo tool-ok</command></invoke></tool_calls>' }
      return { text: '完成' }
    }
    const result = await runAgentLoop({ task: 't', maxRounds: 3, callFn })
    assert.equal(result.done, true)
    assert.equal(result.logs.length, 1)
    assert.equal(result.logs[0].cmd, 'echo tool-ok')
    assert.equal(result.logs[0].ok, true)
  })

  test('continueAgentInHistory 执行尖括号格式并剥离残留标签', async () => {
    setRateLimitRetryConfig(10, 1)
    let n = 0
    const callFn = async () => {
      n++
      if (n === 1) return { text: '接着 <action:agent:echo angle-ok</action:agent:echo>' }
      return { text: '完成' }
    }
    const result = await continueAgentInHistory({
      history: [{ role: 'user', content: 'hi' }],
      assistantText: '开始 [action:agent:echo first-ok]',
      callFn
    })
    assert.equal(result.done, true)
    assert.equal(result.logs.length, 2)
    assert.equal(result.logs[0].cmd, 'echo first-ok')
    assert.equal(result.logs[1].cmd, 'echo angle-ok')
    assert.equal(result.finalText, '完成')
  })
})
