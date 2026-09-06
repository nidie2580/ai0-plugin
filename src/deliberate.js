/**
 * 多模型协同（讨论收敛）服务
 *
 * 把"多个模型各自作答"升级为"先互相商量、再输出一份统一回复"：
 *   Round 1  每个参与模型独立回答用户问题（作为各自初始立场）。
 *   Round ≥2 每个模型看到其他模型上一轮的发言，可选择"同意其中某一版本"
 *            （作为团队最终答案）或输出自己修订后的完整版本。
 *            每轮要求以固定行收尾：`同意编号<k>` 或 `不同意`，供本地收敛判定。
 *  收敛判定  某轮中 ≥2 个且过半的不同模型同意同一编号 → 采纳该版本为统一回复。
 *  未收敛    达到 maxRounds 仍无共识 → 由裁判模型综合各模型最新立场生成统一回复。
 *
 * 与同行评审(groupConfirm)一致的安全语义：
 *   - 调用异常模型本轮排除出票（不阻塞其他人继续讨论）；
 *   - 保留 process(transcript) 供网页端展示讨论过程、QQ 端只发最终一条。
 *
 * llmCall 可注入以做纯逻辑单元测试。
 */
import * as cfg from '../config/index.js'
import * as llm from './llm.js'
import { safeLogger } from './globals.js'

const DEFAULT_MAX_ROUNDS = 3

/** 统计已配置可用（apiKey+apiBase 非空）的模型数（避免与 chatService 循环依赖）。 */
export function countConfiguredModels() {
  try {
    const m = cfg.loadConfig().model || {}
    const defaultKey = m.default || 'openai-compatible'
    const usable = (k) => {
      const c = m[k]
      return c && typeof c === 'object' && String(c.apiKey || '').trim() && String(c.apiBase || '').trim()
    }
    const keys = Object.keys(m).filter((k) => k !== 'default' && usable(k))
    if (usable(defaultKey) && !keys.includes(defaultKey)) keys.push(defaultKey)
    return keys.length
  } catch (_) { return 0 }
}

function readDeliberateConfig() {
  const mm = cfg.get('chat.multiModel', {}) || {}
  const rounds = Number(mm.maxRounds)
  return {
    enabled: mm.deliberate === true,
    maxRounds: Number.isInteger(rounds) && rounds >= 2 && rounds <= 8 ? rounds : DEFAULT_MAX_ROUNDS,
    judgeKey: String(mm.judgeModel || '') || (cfg.get('model.default', 'openai-compatible')),
  }
}

/** 从模型文本末尾解析"同意/不同意"表决行。返回 { agree: index|null, disagree:boolean, body } */
export function parseVerdict(text) {
  const t = String(text || '')
  const lines = String(t).split('\n').map((x) => x.trim())
  let agree = null
  let disagree = false
  let body = t
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const agreeM = line.match(/^结论[:：]?\s*同意\s*编号\s*([1-9]\d*)/i)
    const disagreeM = line.match(/^结论[:：]?\s*不同意/i)
    if (agreeM) {
      agree = parseInt(agreeM[1], 10) - 1
      body = lines.slice(0, i).join('\n').trim()
      break
    }
    if (disagreeM) {
      disagree = true
      body = lines.slice(0, i).join('\n').trim()
      break
    }
    // 只允许扫描末尾几行，防止正文中偶然提到"不同意"
    if (i < lines.length - 4) break
  }
  return { agree, disagree, body: body.trim() || String(t).trim() }
}

function baseSystemPrompt(modelKey) {
  const m = cfg.loadConfig().model || {}
  const name = String(m[modelKey]?.name || m[modelKey]?.model || modelKey)
  return [
    `你是参与"多模型协同讨论"的 AI 之一，你的模型名是「${name}」。`,
    '目标：与团队其他 AI 一起讨论，针对用户的问题给出一份最准确的答案。',
    '要求：',
    '  1) 有理有据地陈述你的观点，尊重并吸收其他模型说得对的地方。',
    '  2) 若你认为某份发言已经足够好，可以直接同意它，不必重复创作。',
    '  3) 若你认为还有更优答案，给出你修订后的完整版本（覆盖完整答案，不要只说"补充一点"）。',
  ].join('\n')
}

function roundPromptText(question, others) {
  const lines = [
    `用户问题：${question}`,
    '',
    '下面是团队中【其他 AI】上一轮的发言（编号即上文编号）：',
    ...others.map((o) => `${o.label}：\n${o.text}`),
    '',
    '现在给出你的最终表态：',
    '  - 若你同意其中某一份可以作为团队统一回复：请把"同意编号<k>"作为最后一行（k 为编号），正文无需重复该份内容。',
    '  - 若你不同意所有发言：请输出你修订后的完整答案（直接回答用户问题），并在最后一行写"不同意"。',
    '最后一行只允许是：同意编号<k>  或  不同意。',
  ].join('\n')
  return lines
}

/**
 * 执行一轮：让 modelKey 就 question+上轮他人发言作答。
 * 返回 { modelKey, text, agree, disagree, error }
 */
async function askOne({ modelKey, question, others, sysPrompt, history, maxTokens, llmCall, signal }) {
  try {
    const msgs = [
      { role: 'system', content: sysPrompt },
      ...(Array.isArray(history) ? history.map((h) => ({ ...h })) : []),
      { role: 'user', content: others.length ? roundPromptText(question, others) : question },
    ]
    const res = await llmCall(msgs, { modelKey, temperature: 0.4, overrideMaxTokens: maxTokens, signal })
    const text = String(res?.text || '').trim()
    if (!text) return { modelKey, text: '', error: '空回复' }
    const verdict = parseVerdict(text)
    return { modelKey, text: verdict.body, agree: verdict.agree, disagree: verdict.disagree, raw: text }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 协同讨论模型 ${modelKey} 本轮调用失败(排除出票): ${err?.message || err}`)
    return { modelKey, text: '', error: err?.message || String(err) }
  }
}

/**
 * 主持人：未收敛时用裁判模型把各模型最新立场综合成统一回复。
 */
async function synthesizeFinal({ question, texts, judgeKey, llmCall, signal }) {
  const sys = [
    '你是多模型协同讨论的主持人。下面是一场关于某个用户问题的多模型讨论记录。',
    '请综合各模型的合理观点，直接回答用户的问题，输出一份【统一最终回答】。',
    '要求：内容面向提问用户，自然、完整、有条理；不要在回答里提"综合/模型/讨论"等词，也不要再输出编号列表。',
  ].join('\n')
  const user = [
    `用户问题：${question}`,
    '',
    '各模型讨论观点：',
    ...texts.map((t) => `${t.modelName}：${t.text}`),
  ].join('\n')
  const res = await llmCall(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { modelKey: judgeKey, temperature: 0.3, signal }
  )
  return String(res?.text || '').trim()
}

/**
 * 运行一次多模型协同讨论并收敛出统一回复。
 * @param {{
 *   question:string, modelKeys:string[], maxRounds?:number, judgeKey?:string,
 *   history?:Array, signal?:AbortSignal,
 *   llmCall?:Function,   // (messages, {modelKey,temperature,overrideMaxTokens,signal}) => Promise<{text}>
 *   perModelMaxTokens?:number
 * }} opts
 * @returns {Promise<{ok:boolean, finalText:string, converged:boolean,
 *   rounds:Array<{round:number, entries:Array<{modelKey:string,text:string}>}>,
 *   chosenModelKey?:string, msg?:string}>}
 */
export async function runDeliberation({ question, modelKeys, maxRounds, judgeKey, history, signal, llmCall, perModelMaxTokens } = {}) {
  try {
    const q = String(question || '').trim()
    const keys = (Array.isArray(modelKeys) ? modelKeys : []).filter(Boolean)
    if (!q) return { ok: false, finalText: '', converged: false, rounds: [], msg: '问题不能为空' }
    if (!keys.length) return { ok: false, finalText: '', converged: false, rounds: [], msg: '没有可参与的模型' }
    if (keys.length === 1) {
      const cfg2 = readDeliberateConfig()
      const call = llmCall || ((msgs, o) => llm.chatCompletions(msgs, o))
      const one = await askOne({ modelKey: keys[0], question: q, others: [], sysPrompt: baseSystemPrompt(keys[0]), history, maxTokens: perModelMaxTokens, llmCall: call, signal })
      return { ok: !one.error, finalText: one.error ? '(生成失败)' : one.text, converged: false, rounds: [{ round: 1, entries: [one] }], msg: one.error }
    }

    const cfgObj = readDeliberateConfig()
    const totalRounds = Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 8 ? maxRounds : cfgObj.maxRounds
    const judgeKeyReal = judgeKey || cfgObj.judgeKey
    const call = llmCall || ((msgs, o) => llm.chatCompletions(msgs, o))
    const m = cfg.loadConfig().model || {}
    const displayName = (k) => String(m[k]?.name || m[k]?.model || k)

    const rounds = []
    let prevByKey = new Map() // modelKey -> { text }
    let activeKeys = [...keys]

    // —— Round 1：独立首答 ——
    const round1 = await Promise.all(activeKeys.map((k) => askOne({ modelKey: k, question: q, others: [], sysPrompt: baseSystemPrompt(k), history, maxTokens: perModelMaxTokens, llmCall: call, signal })))
    const r1ok = round1.filter((x) => !x.error)
    rounds.push({ round: 1, entries: round1 })
    for (const x of round1) {
      if (!x.error && x.text) prevByKey.set(x.modelKey, { text: x.text })
    }
    if (!prevByKey.size) {
      return { ok: false, finalText: '', converged: false, rounds, msg: '所有模型首轮均调用失败' }
    }
    if (prevByKey.size === 1) {
      const only = [...prevByKey.entries()][0]
      return { ok: true, finalText: only[1].text, converged: false, rounds, msg: '仅一个模型正常作答' }
    }
    activeKeys = [...prevByKey.keys()]

    // —— Round ≥2：互相看到、表态收敛 ——
    for (let r = 2; r <= totalRounds; r++) {
      const othersOf = (k) => activeKeys.filter((x) => x !== k).map((x, i) => {
        const globalIdx = activeKeys.indexOf(x)
        return { label: `${globalIdx + 1}号(${displayName(x)})`, text: prevByKey.get(x)?.text || '(无内容)' }
      })
      const tasks = activeKeys.map((k) => askOne({
        modelKey: k,
        question: q,
        others: othersOf(k),
        sysPrompt: baseSystemPrompt(k),
        history,
        maxTokens: perModelMaxTokens,
        llmCall: call,
        signal,
      }))
      const results = await Promise.all(tasks)
      rounds.push({ round: r, entries: results })

      // 更新最新立场
      const votes = new Map() // index -> count（排除"自己投自己"，计数实际参与的不同模型）
      const participantsThisRound = []
      results.forEach((x) => {
        if (x.error) return
        participantsThisRound.push(x.modelKey)
        if (x.text) prevByKey.set(x.modelKey, { text: x.text })
        if (x.agree != null && x.agree >= 0 && x.agree < activeKeys.length) {
          if (activeKeys[x.agree] !== x.modelKey) {
            votes.set(x.agree, (votes.get(x.agree) || 0) + 1)
          }
        }
      })

      if (participantsThisRound.length === 0) break // 全员异常，无法再推进

      const active = participantsThisRound.length
      if (active >= 2) {
        let bestIdx = -1
        let bestCount = 0
        for (const [idx, cnt] of votes.entries()) {
          if (cnt > bestCount) { bestCount = cnt; bestIdx = idx }
        }
        const need = Math.max(2, Math.ceil(active / 2))
        if (bestCount >= need && bestIdx >= 0) {
          const chosenKey = activeKeys[bestIdx]
          return {
            ok: true,
            finalText: prevByKey.get(chosenKey)?.text || '',
            converged: true,
            rounds,
            chosenModelKey: chosenKey,
          }
        }
      }
    }

    // —— 未收敛：主持人综合 ——
    const texts = activeKeys.map((k) => ({ modelName: displayName(k), text: prevByKey.get(k)?.text || '' })).filter((t) => t.text)
    let finalText = ''
    try {
      finalText = await synthesizeFinal({ question: q, texts, judgeKey: judgeKeyReal, llmCall: call, signal })
    } catch (err) {
      safeLogger.warn(`[ai0-plugin] 协同讨论主持人综合失败，退回首个模型观点: ${err?.message || err}`)
      finalText = texts[0]?.text || ''
    }
    if (!finalText) finalText = texts[0]?.text || '(未收敛且无可用内容)'
    return { ok: true, finalText, converged: false, rounds, msg: '达到最大讨论轮次，已由主持人综合' }
  } catch (err) {
    safeLogger.error(`[ai0-plugin] 协同讨论执行异常: ${err?.message || err}`)
    return { ok: false, finalText: '', converged: false, rounds: [], msg: err?.message || String(err) }
  }
}

/** 判断当前是否启用协同讨论（供调用方读取统一配置入口）。 */
export function isDeliberationEnabled() {
  try { return readDeliberateConfig().enabled } catch (_) { return false }
}

/** 供外部读取判定（与 groupConfirm 风格一致，不依赖 chatService 避免循环依赖）。 */
export function isDeliberationAvailable() {
  try {
    const mm = cfg.get('chat.multiModel', {}) || {}
    if (!mm || mm.enabled !== true || mm.deliberate !== true) return false
    return countConfiguredModels() >= 2
  } catch (_) { return false }
}
