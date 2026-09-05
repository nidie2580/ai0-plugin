/* global document, window, fetch */

// 构建版本戳：用于在手机上确认加载的 app.js 是否最新（若值不符 = 浏览器在用旧缓存）
window.__AI0_BUILD__ = '20260905b'

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, { method = 'GET', body, raw = false, timeout = 0 } = {}) {
  const opts = {
    method,
    headers: { 'Accept': 'application/json' },
    credentials: 'same-origin'
  }
  if (body != null) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  // CSRF: POST/DELETE 时从 cookie 读取 token 并附带到 header
  if (method === 'POST' || method === 'DELETE') {
    const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ai0_csrf='))?.split('=')[1]
    if (csrf) opts.headers['X-CSRF-Token'] = csrf
  }
  // 可选超时（毫秒）：防止 fetch 被挂起导致页面无限停留在加载状态
  if (timeout > 0) {
    const ctrl = new AbortController()
    opts.signal = ctrl.signal
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      return await doFetch(path, opts, raw)
    } finally {
      clearTimeout(timer)
    }
  }
  return doFetch(path, opts, raw)
}
async function doFetch(path, opts, raw) {
  const r = await fetch(path, opts)
  const text = await r.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (raw) return { status: r.status, ok: r.ok, data }
  return data
}

const route = document.currentScript?.dataset.route || ''

// ============== 全局错误捕获 ==============
// 任何未捕获的同步错误或 Promise 拒绝都会在这里弹窗显示具体报错（含行号），
// 否则在手机上无法定位「卡在加载中」的真正原因。
window.addEventListener('error', function (e) {
  const msg = `AI0 Dashboard Error: ${e.message}\n${e.filename || ''}:${e.lineno || '?'}:${e.colno || '?'}`
  try { alert(msg) } catch (_) {}
  console.error('[ai0] 全局错误:', e.error || e.message)
  const t = $('#cfgTag'); if (t) t.textContent = '初始化失败'
})
window.addEventListener('unhandledrejection', function (e) {
  const r = e.reason
  const msg = `AI0 Unhandled Rejection: ${(r && r.message) || String(r)}`
  try { alert(msg) } catch (_) {}
  console.error('[ai0] 未处理 Promise 拒绝:', r)
  const t = $('#cfgTag'); if (t) t.textContent = '初始化失败'
})

// ============== 深色 / 浅色主题 ==============
const THEME_KEY = 'ai0_theme'
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  const apply = (dark) => document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  if (saved === 'dark') apply(true)
  else if (saved === 'light') apply(false)
  else apply(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const toggle = $('#themeToggle')
  if (toggle && typeof toggle.addEventListener === 'function') {
    toggle.addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') !== 'dark'
      apply(dark)
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
    })
  }
}
initTheme()

// ============== Login ==============
if (route === 'login') {
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'))
      $$('.tab-pane').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active')
    })
  })

  const codeIdInput = $('#codeIdInput')
  const input = $('#codeInput')
  const err = $('#err')
  const waitPane = $('#waitPane')
  input?.addEventListener('input', () => {
    input.value = input.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
    err.textContent = ''
  })
  codeIdInput?.addEventListener('input', () => {
    codeIdInput.value = codeIdInput.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 64)
    err.textContent = ''
  })
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
  codeIdInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })

  {
    const el = $('#loginBtn')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', doLogin)
  }

  function showWait() {
    waitPane?.classList.remove('hidden')
  }

  async function pollClaim(pendingId) {
    // 等到管理员放行后签收会话并进入控制台
    const timer = setInterval(async () => {
      try {
        const st = await api('/api/login/code/need-verify', { method: 'POST', body: { pendingId } })
        if (st && st.approved) {
          clearInterval(timer)
          const cl = await api('/api/login/code/claim', { method: 'POST', body: { pendingId } })
          if (cl && cl.ok) { location.href = '/'; return }
          err.textContent = cl?.msg || '放行失败，请稍后重试'
        }
      } catch (_) {}
    }, 2500)
  }

  async function doLogin() {
    err.textContent = ''
    const codeId = (codeIdInput?.value || '').trim()
    const code = input.value.trim()
    if (!codeId) {
      err.textContent = '请输入验证码 ID（你的 QQ 号或 stdin）'
      return
    }
    if (code.length !== 16) {
      err.textContent = '请输入 16 位字母数字验证码'
      return
    }
    const r = await api('/api/login/code', { method: 'POST', body: { codeId, code } })
    if (r.ok && r.needVerify) {
      showWait()
      if (r.pendingId) pollClaim(r.pendingId)
      return
    }
    if (r.ok) {
      location.href = '/'
    } else {
      err.textContent = r.msg || '登录失败'
    }
  }
}

// ============== Dashboard ==============
if (route === 'dashboard') {
  // --- View switching
  $$('.nav-item').forEach(a => {
    a.addEventListener('click', () => {
      $$('.nav-item').forEach(x => x.classList.remove('active'))
      $$('.view').forEach(v => v.classList.remove('active'))
      a.classList.add('active')
      document.getElementById('view-' + a.dataset.view).classList.add('active')
      if (a.dataset.view === 'sessions') loadSessions()
      if (a.dataset.view === 'chatlog') { loadChatlog(); startChatlogTimerIfNeeded(); initChatAcrossApp() }
      else stopChatlogTimer()
      if (a.dataset.view === 'image') loadImageConfig()
      if (a.dataset.view === 'providers') loadProviders()
      if (a.dataset.view === 'about') loadAbout()
    })
  })

  {
    const el = $('#logoutBtn')
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' })
        location.href = '/'
      })
    }
  }

  // ---- 登录守卫：锁定遮罩 + 放行提示轮询 ----
  (function initGuard() {
    const lockEl = $('#guardLock')
    const guardCmd = $('#guardCmd')
    const guardTip = $('#guardTip')
    const listEl = $('#guardPendingList')
    if (!lockEl) return
    const esc = escapeHtml
    let closing = false
    async function poll() {
      if (closing) return
      let st = null
      try { st = await api('/api/guard/status') } catch (_) {}
      const locked = st && st.locked
      lockEl.classList.toggle('hidden', !locked)
      if (st && st.pending && st.pending.length) {
        const req = st.pending.filter(p => !p.approved)[0]
        if (req) {
          guardCmd.textContent = `继续操作 ${req.approveCode}`
          guardTip.innerHTML = `请求人：${esc(req.identity)} · IP：${esc(req.ip)}<br>放行码：<code>${esc(req.approveCode)}</code>（也可输入请求人 QQ：<code>${esc(req.identity)}</code>）`
        }
        const nonApproved = st.pending.filter(p => !p.approved)
        listEl.innerHTML = nonApproved.length
          ? '<p class="hint">待放行请求：</p>' + nonApproved.map(p =>
              `<div class="guard-item">${esc(p.identity)} <span class="muted">(${esc(p.ip)})</span> — 放行码 <code>${esc(p.approveCode)}</code></div>`
            ).join('')
          : ''
      }
      // 有未放行请求时冻结控制台指针；放行后自动解除
      if (locked) document.body.classList.add('guard-locked')
      else document.body.classList.remove('guard-locked')
    }
    // 立即轮询一次，并每 2.5s 刷新
    poll()
    setInterval(poll, 2500)
    window.addEventListener('beforeunload', () => { closing = true })
  })()

  // ---- Config ----
  let currentConfig = null
  let currentModelKey = null
  const saveMsg = $('#saveMsg')

  {
    const el = $('#saveCfg')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', saveConfig)
  }
  {
    const el = $('#resetCfg')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', loadConfig)
  }

  async function loadConfig() {
    saveMsg.textContent = ''
    let resp
    try {
      // 10s 超时：若 /api/config 被代理/网络挂起，也立即给用户反馈，而不是无限“加载中…”
      resp = await api('/api/config', { timeout: 10000 })
    } catch (e) {
      const aborted = e && e.name === 'AbortError'
      $('#cfgTag').textContent = aborted ? '加载超时' : '加载失败'
      saveMsg.className = 'save-msg err'
      saveMsg.textContent = (aborted ? '配置加载超时（10s），请刷新重试' : '配置加载失败：' + (e && e.message || '网络错误')) + '，请刷新页面重试'
      console.error('[ai0] /api/config 加载失败：', e)
      return
    }
    if (!resp.ok) { $('#cfgTag').textContent = '加载失败'; return }
    currentConfig = resp.config
    $('#cfgTag').textContent = '已加载'
    $('#cfg_default').value = resp.config.model?.default || 'openai-compatible'

    buildModelTabs(resp.config.model || {})
    const mkey = resp.config.model?.default || currentModelKey || Object.keys(resp.config.model || {})[0]
    selectModel(mkey)

    // chat
    $('#chat_groupAtReply').value = String(resp.config.chat?.groupAtReply ?? true)
    $('#chat_privateReply').value = String(resp.config.chat?.privateReply ?? true)
    $('#chat_contextSize').value = resp.config.chat?.contextSize ?? 10
    $('#chat_maxSessionsPerUser').value = resp.config.chat?.maxSessionsPerUser ?? 3
    $('#chat_triggerPrefix').value = (resp.config.chat?.triggerPrefix || []).join(',')
    $('#chat_sessionTimeout').value = resp.config.chat?.sessionTimeout ?? 1800000
    const mmCfg = resp.config.chat?.multiModel || {}
    $('#chat_multiModel_enabled').value = String(mmCfg.enabled ?? false)
    $('#chat_multiModel_multiChat').value = String(mmCfg.multiChat ?? false)
    $('#chat_multiModel_atModel').value = String(mmCfg.atModel ?? true)
    const lgCfg = resp.config.chat?.loopGuard || {}
    $('#chat_loopGuard_enabled').value = String(lgCfg.enabled ?? true)
    $('#chat_loopGuard_windowMs').value = lgCfg.windowMs ?? 20000
    $('#chat_loopGuard_maxReplies').value = lgCfg.maxReplies ?? 4
    $('#chat_loopGuard_cooldownMs').value = lgCfg.cooldownMs ?? 60000

    $('#system_prompt').value = resp.config.system?.prompt || ''
    $('#agent_maxRounds').value = resp.config.agent?.maxRounds ?? 5
    $('#agent_hardTimeoutMs').value = resp.config.agent?.hardTimeoutMs ?? 600000

    $('#perm_mode').value = String(resp.config.permissions?.whitelistMode ?? false)
    $('#perm_masters').value = (resp.config.permissions?.masters || []).join(',')
    $('#perm_allowedUsers').value = (resp.config.permissions?.allowedUsers || []).join(',')
    $('#perm_allowedGroups').value = (resp.config.permissions?.allowedGroups || []).join(',')
    $('#perm_blockedUsers').value = (resp.config.permissions?.blockedUsers || []).join(',')
    $('#perm_blockedGroups').value = (resp.config.permissions?.blockedGroups || []).join(',')

    $('#resp_useForwardMsg').value = String(resp.config.response?.useForwardMsg ?? true)
    $('#resp_forwardThreshold').value = resp.config.response?.forwardThreshold ?? 500
    $('#resp_showModelTag').value = String(resp.config.response?.showModelTag ?? true)
    $('#resp_typingDelay').value = resp.config.response?.typingDelay ?? 500
    $('#web_port').value = resp.config.web?.port ?? 12580
    $('#web_host').value = resp.config.web?.host ?? '127.0.0.1'
    $('#web_trustProxy').checked = !!resp.config.web?.trustProxy
  }

  function buildModelTabs(models) {
    const tabs = $('#modelsTabs')
    tabs.innerHTML = ''
    const keys = Object.keys(models || {})
    if (!keys.length) { tabs.innerHTML = '<span class="hint">暂无模型配置</span>'; return }
    keys.forEach(k => {
      const b = document.createElement('div')
      b.className = 'model-tab'
      b.textContent = k
      b.onclick = () => selectModel(k)
      tabs.appendChild(b)
    })
  }

  function selectModel(key) {
    currentModelKey = key
    $$('.model-tab').forEach(t => {
      t.classList.toggle('active', t.textContent === key)
    })
    const model = currentConfig.model?.[key] || {}
    const form = $('#modelForm')
    form.innerHTML = `
      <label>配置 Key (唯一标识)<input id="m_key" value="${escapeHtml(key)}"/></label>
      <label>显示名称<input id="m_name" value="${escapeHtml(model.name || '')}"/></label>
      <label>API Base<input id="m_apiBase" value="${escapeHtml(model.apiBase || '')}" placeholder="https://.../v1"/></label>
      <label>API Key<input id="m_apiKey" value="${escapeHtml(model.apiKey || '')}" placeholder="sk-..." autocomplete="off"/></label>
      <label>模型 ID<input id="m_model" value="${escapeHtml(model.model || '')}"/></label>
      <label>温度 (temperature)<input id="m_temperature" type="number" step="0.1" min="0" max="2" value="${model.temperature ?? 0.8}"/></label>
      <label>Max Tokens<input id="m_maxTokens" type="number" min="1" value="${model.maxTokens ?? 2000}"/></label>
      <label>超时 (ms)<input id="m_timeout" type="number" min="1000" value="${model.timeout ?? 60000}"/></label>
      <label>深度思考 (thinking)
        <select id="m_thinking"><option value="false">关闭</option><option value="true">开启</option></select>
      </label>
      <label>支持图片输入 (vision)
        <select id="m_vision"><option value="false">关闭</option><option value="true">开启</option></select>
      </label>
      <label>联网检索 (web)
        <select id="m_web"><option value="false">关闭</option><option value="true">开启</option></select>
      </label>
    `
    $('#m_thinking').value = String(model.thinking ?? false)
    $('#m_vision').value = String(model.vision ?? false)
    $('#m_web').value = String(model.web ?? false)
  }

  function readFormModel() {
    const oldKey = currentModelKey
    const newKey = $('#m_key').value.trim() || oldKey
    const obj = {}
    for (const id of ['name', 'apiBase', 'apiKey', 'model']) {
      const v = document.getElementById('m_' + id)?.value ?? ''
      if (v) obj[id] = v
    }
    const temperature = parseFloat(document.getElementById('m_temperature')?.value)
    const maxTokens = parseInt(document.getElementById('m_maxTokens')?.value, 10)
    const timeout = parseInt(document.getElementById('m_timeout')?.value, 10)
    if (!Number.isNaN(temperature)) obj.temperature = temperature
    if (!Number.isNaN(maxTokens)) obj.maxTokens = maxTokens
    if (!Number.isNaN(timeout)) obj.timeout = timeout
    // 布尔开关：读取 select 真假
    const boolOf = (id) => document.getElementById('m_' + id)?.value === 'true'
    obj.thinking = boolOf('thinking')
    obj.vision = boolOf('vision')
    obj.web = boolOf('web')
    return { oldKey, newKey, obj }
  }

  async function saveConfig() {
    saveMsg.className = 'save-msg'
    saveMsg.textContent = '保存中…'
    if (!currentConfig) { saveMsg.textContent = '配置尚未加载'; return }
    const c = JSON.parse(JSON.stringify(currentConfig))
    c.model = c.model || {}
    c.model.default = $('#cfg_default').value.trim() || c.model.default

    // 更新当前正在编辑的模型（若 key 改名则迁移）
    const { oldKey, newKey, obj } = readFormModel()
    if (oldKey && oldKey !== newKey && c.model[oldKey]) {
      delete c.model[oldKey]
    }
    c.model[newKey] = { ...(c.model[newKey] || {}), ...obj }
    if (c.model.default === oldKey && oldKey !== newKey) c.model.default = newKey

    c.chat = {
      groupAtReply: $('#chat_groupAtReply').value === 'true',
      privateReply: $('#chat_privateReply').value === 'true',
      contextSize: parseInt($('#chat_contextSize').value, 10) || 10,
      maxSessionsPerUser: parseInt($('#chat_maxSessionsPerUser').value, 10) || 3,
      triggerPrefix: splitCsv($('#chat_triggerPrefix').value),
      sessionTimeout: parseInt($('#chat_sessionTimeout').value, 10) || -1,
      multiModel: {
        enabled: $('#chat_multiModel_enabled').value === 'true',
        multiChat: $('#chat_multiModel_multiChat').value === 'true',
        atModel: $('#chat_multiModel_atModel').value === 'true'
      },
      loopGuard: {
        enabled: $('#chat_loopGuard_enabled').value === 'true',
        windowMs: parseInt($('#chat_loopGuard_windowMs').value, 10) || 20000,
        maxReplies: parseInt($('#chat_loopGuard_maxReplies').value, 10) || 4,
        cooldownMs: parseInt($('#chat_loopGuard_cooldownMs').value, 10) || 60000
      }
    }
    c.system = { prompt: $('#system_prompt').value }

    // Agent 配置：maxRounds 前端校验（≥1 正整数，无 20 硬上限），越界拒绝保存
    const maxRounds = parseInt($('#agent_maxRounds').value, 10)
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10000) {
      saveMsg.className = 'save-msg err'
      saveMsg.textContent = '❌ Agent 最大执行轮数必须为 1-10000 之间的整数'
      return
    }
    c.agent = { ...(c.agent || {}), maxRounds }
    // Agent 硬超时（ms）：30s~30min，默认 600000（10 分钟）
    const hardTimeoutMs = parseInt($('#agent_hardTimeoutMs').value, 10)
    if (Number.isFinite(hardTimeoutMs) && hardTimeoutMs >= 30000 && hardTimeoutMs <= 1800000) {
      c.agent.hardTimeoutMs = hardTimeoutMs
    }
    c.permissions = {
      whitelistMode: $('#perm_mode').value === 'true',
      masters: splitCsvInt($('#perm_masters').value),
      allowedUsers: splitCsvInt($('#perm_allowedUsers').value),
      allowedGroups: splitCsvInt($('#perm_allowedGroups').value),
      blockedUsers: splitCsvInt($('#perm_blockedUsers').value),
      blockedGroups: splitCsvInt($('#perm_blockedGroups').value)
    }
    c.response = {
      useForwardMsg: $('#resp_useForwardMsg').value === 'true',
      forwardThreshold: parseInt($('#resp_forwardThreshold').value, 10) || 500,
      showModelTag: $('#resp_showModelTag').value === 'true',
      typingDelay: parseInt($('#resp_typingDelay').value, 10) || 0
    }
    c.web = {
      port: parseInt($('#web_port').value, 10) || 12580,
      host: $('#web_host').value.trim() || '127.0.0.1',
      trustProxy: $('#web_trustProxy').checked === true
    }

    const r = await api('/api/config', { method: 'POST', body: { config: c } })
    if (r.ok) {
      saveMsg.className = 'save-msg ok'
      saveMsg.textContent = '✅ ' + (r.msg || '保存成功')
      await loadConfig()
    } else {
      saveMsg.className = 'save-msg err'
      saveMsg.textContent = '❌ ' + (r.msg || '保存失败')
    }
  }

  // ---- Sessions ----
  let lastSessions = []
  {
    const el = $('#refreshSessBtn')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', loadSessions)
  }
  {
    const el = $('#closeSessionBtn')
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('click', () => {
        $('#sessDetailCard').classList.add('hidden')
      })
    }
  }
  {
    const el = $('#delSessionBtn')
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('click', async () => {
        const tag = $('#sessDetailTag').textContent
        const [userId, sessionId] = tag.split('/')
        if (!userId || !sessionId) return
        if (!confirm(`删除该会话？（${userId}/${sessionId}）`)) return
        await api(`/api/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
        $('#sessDetailCard').classList.add('hidden')
        await loadSessions()
      })
    }
  }

  // ---- 模型互聊记录 ----
  const CHATLOG_PAGE = 30
  let chatlogOffset = 0
  let chatlogTimer = null

  function fmtTime(ts) { return new Date(ts).toLocaleString() }

  function renderChatlogEntry(entry) {
    const card = document.createElement('div')
    card.className = 'chatlog-item'
    const time = fmtTime(entry.ts)
    const meta = `${entry.userId ? `用户 ${escapeHtml(entry.userId)}` : '用户'}${
      entry.sessionId ? ' · ' + escapeHtml(entry.sessionId.slice(0, 8)) + '…' : ''
    }`
    card.innerHTML = `
      <div class="chatlog-head">
        <div class="chatlog-q">💬 <span class="chatlog-q-text">${escapeHtml(entry.question || '(无问题)')}</span></div>
        <span class="chatlog-time">${time}</span>
      </div>
      <div class="chatlog-meta">${meta} · ${(entry.replies || []).length} 个模型发言</div>
      <div class="chatlog-replies"></div>
    `
    const repliesBox = card.querySelector('.chatlog-replies')
    for (const r of (entry.replies || [])) {
      const rep = document.createElement('div')
      rep.className = 'chatlog-reply'
      rep.innerHTML = `<span class="modelname">🤖 ${escapeHtml(r.model || '模型')}</span><span class="body">${escapeHtml(r.text || '').replace(/\n/g, '<br>')}</span>`
      repliesBox.appendChild(rep)
    }
    return card
  }

  async function loadChatlog({ append = false } = {}) {
    const wrap = $('#chatlogList')
    if (!append) { chatlogOffset = 0; wrap.innerHTML = '<p class="empty">加载中…</p>' }
    let r
    try {
      r = await api(`/api/chat-log?limit=${CHATLOG_PAGE}&offset=${append ? chatlogOffset : 0}`)
    } catch (e) {
      if (!append) wrap.innerHTML = '<p class="empty">加载失败</p>'
      return
    }
    if (!r.ok) { if (!append) wrap.innerHTML = '<p class="empty">加载失败</p>'; return }
    const data = r.data || {}
    const items = data.items || []
    const total = data.total ?? 0
    $('#chatlogTag').textContent = `${total} 条记录`
    if (!items.length) {
      if (!append) wrap.innerHTML = '<p class="empty">暂无互聊记录。开启多模型互聊后，模型间的对话会自动记录在这里。</p>'
      $('#chatlogMoreBtn').style.display = 'none'
      return
    }
    if (append) {
      chatlogOffset += items.length
      for (const e of items) wrap.appendChild(renderChatlogEntry(e))
    } else {
      chatlogOffset = items.length
      wrap.innerHTML = ''
      const frag = document.createDocumentFragment()
      for (const e of items) frag.appendChild(renderChatlogEntry(e))
      wrap.appendChild(frag)
    }
    $('#chatlogMoreBtn').style.display = (chatlogOffset < total) ? '' : 'none'
  }

  function stopChatlogTimer() {
    if (chatlogTimer) { clearInterval(chatlogTimer); chatlogTimer = null }
  }
  function startChatlogTimerIfNeeded() {
    stopChatlogTimer()
    if ($('#chatlogAuto')?.checked) chatlogTimer = setInterval(() => loadChatlog(), 5000)
  }

  {
    const el = $('#refreshChatlogBtn')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', () => loadChatlog())
  }
  {
    const el = $('#chatlogAuto')
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('change', () => { if (el.checked) loadChatlog(); startChatlogTimerIfNeeded() })
    }
  }
  {
    const el = $('#chatlogMoreBtn')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', () => loadChatlog({ append: true }))
  }

  // ---- 模型互聊：日志 / 聊天 双模式 ----
  // 聊天模式以登录者身份(QQ)向模型发消息，可选单个/多个模型；模型以各自模型名身份作答，
  // 模型间可互聊，并自动选出最合适的一条回答。会话仅存内存，刷新后重来。
  let chatMode = 'chatlog'          // 'chatlog' | 'chat'
  let micInitDone = false
  let chatHistory = []              // 内存中的聊天消息（用于渲染当前聊天框）
  let micBusy = false
  const micModelIndex = new Map()   // key → { key, name }

  function initChatAcrossApp() {
    if (micInitDone) return
    micInitDone = true
    setupChatModeToggle()
    bindMicEvents()
    loadMicModelList()
  }

  function showChatMode(mode) {
    chatMode = mode
    $$('#chatlogModeToggle .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode))
    $('#chatlogPane').classList.toggle('hidden', mode !== 'chatlog')
    $('#chatPane').classList.toggle('hidden', mode !== 'chat')
    if (mode === 'chatlog') { loadChatlog(); startChatlogTimerIfNeeded() }
    else { stopChatlogTimer(); loadMicIdentity() }
  }

  function setupChatModeToggle() {
    const toggle = $('#chatlogModeToggle')
    if (!toggle) return
    $$('#chatlogModeToggle .seg-btn').forEach(b => {
      b.addEventListener('click', () => showChatMode(b.dataset.mode))
    })
  }

  async function loadMicModelList() {
    const wrap = $('#micModelList')
    if (!wrap) return
    try {
      const resp = await api('/api/config')
      const modelCfg = (resp && resp.config && resp.config.model) || {}
      micModelIndex.clear()
      let html = ''
      for (const k of Object.keys(modelCfg)) {
        if (k === 'default') continue
        const m = modelCfg[k]
        if (!m || typeof m !== 'object') continue
        const name = m.name || m.model || k
        micModelIndex.set(k, { key: k, name })
        html += `<label class="chip"><input type="checkbox" value="${escapeHtml(k)}" checked/> ${escapeHtml(name)}</label>`
      }
      if (!html) { wrap.innerHTML = '<span class="hint">暂无模型配置。</span>'; return }
      wrap.innerHTML = html
    } catch (e) {
      wrap.innerHTML = '<span class="hint">模型列表加载失败</span>'
    }
  }

  async function loadMicIdentity() {
    const label = $('#chatAsLabel')
    try {
      const r = await api('/api/multi-chat')
      if (r && r.identity) label.textContent = escapeHtml(r.identity)
      else if (r && r.ok) label.textContent = await resolveFallbackIdentity()
    } catch (_) {}
  }

  async function resolveFallbackIdentity() {
    try {
      const cfgResp = await api('/api/config')
      const botId = (cfgResp.config?.bot?.self_id || cfgResp.config?.bot?.uin || '')
      return botId ? botId : '机器人'
    } catch (_) { return '机器人' }
  }

  function selectedModelKeys() {
    return $$('#micModelList input[type="checkbox"]:checked').map(el => el.value)
  }

  function appendMic(html) {
    const box = $('#micChatBox')
    if (!box) return
    const empty = box.querySelector('.empty')
    if (empty) empty.remove()
    const node = document.createElement('div')
    node.className = 'mic-msg'
    node.innerHTML = html
    box.appendChild(node)
    box.scrollTop = box.scrollHeight
  }

  function renderChatHistory() {
    const box = $('#micChatBox')
    if (!box) return
    if (!chatHistory.length) {
      box.innerHTML = '<p class="empty">选择模型并发送消息开始互聊。</p>'
      return
    }
    box.innerHTML = ''
    for (const m of chatHistory) {
      const node = document.createElement('div')
      node.className = 'mic-msg ' + (m.role === 'user' ? 'user' : 'bot')
      node.innerHTML = m.html
      box.appendChild(node)
    }
    box.scrollTop = box.scrollHeight
  }

  function setMicBusy(busy, text) {
    micBusy = busy
    const el = $('#micBusy')
    if (el) el.textContent = text
    const btn = $('#micSendBtn')
    if (btn) btn.disabled = busy
  }

  async function sendMic() {
    if (micBusy) return
    const input = $('#micInput')
    const question = (input?.value || '').trim()
    if (!question) return
    const keys = selectedModelKeys()
    if (!keys.length) { alert('请至少选择一个模型'); return }
    input.value = ''

    const userHtml = `<div class="mic-bubble user-bubble">${escapeHtml(question)}</div>`
    chatHistory.push({ role: 'user', html: userHtml })
    renderChatHistory()
    setMicBusy(true, '模型互聊中，请稍候…')

    try {
      const r = await api('/api/multi-chat', { method: 'POST', body: { question, modelKeys: keys } })
      if (!r.ok) {
        setMicBusy(false, '互聊失败：' + (r.msg || '未知错误'))
        chatHistory.push({ role: 'bot', html: `<div class="mic-bubble bot-bubble">⚠️ ${escapeHtml(r.msg || '互聊失败')}</div>` })
        renderChatHistory()
        return
      }
      const identity = r.identity || ''
      const best = r.best
      const replies = r.replies || []
      let botHtml = ''
      for (const rep of replies) {
        const isBest = best && rep.model === best.model && rep.text === best.text
        botHtml += `<div class="mic-bubble bot-bubble${isBest ? ' best' : ''}"><div class="mic-model">🤖 ${escapeHtml(rep.model)}${isBest ? ' ✅ 最优' : ''}</div><div class="mic-text">${escapeHtml(rep.text).replace(/\n/g, '<br>')}</div></div>`
      }
      chatHistory.push({ role: 'bot', html: botHtml || '<div class="mic-bubble bot-bubble">(无回答)</div>' })
      renderChatHistory()
      setMicBusy(false, '完成')
      // 刷新"当前以谁身份显示"
      $('#chatAsLabel').textContent = identity ? escapeHtml(identity) : $('#chatAsLabel').textContent
    } catch (e) {
      setMicBusy(false, '互聊失败：' + (e && e.message || '网络错误'))
    }
  }

  function clearMic() {
    chatHistory = []
    const box = $('#micChatBox')
    if (box) box.innerHTML = '<p class="empty">选择模型并发送消息开始互聊。</p>'
    api('/api/multi-chat', { method: 'POST', body: { clear: true } }).catch(() => {})
  }

  function bindMicEvents() {
    const send = $('#micSendBtn')
    if (send && typeof send.addEventListener === 'function') send.addEventListener('click', sendMic)
    const input = $('#micInput')
    if (input && typeof input.addEventListener === 'function') {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMic() })
    }
    const clear = $('#micClearBtn')
    if (clear && typeof clear.addEventListener === 'function') clear.addEventListener('click', clearMic)
  }

  async function loadSessions() {
    const r = await api('/api/sessions')
    if (!r.ok) { $('#sessTag').textContent = '加载失败'; return }
    lastSessions = r.data || []
    const total = lastSessions.reduce((a, u) => a + u.sessions.length, 0)
    $('#sessTag').textContent = `${lastSessions.length} 位用户 / ${total} 个会话`

    const wrap = $('#sessionsList')
    if (!lastSessions.length) { wrap.innerHTML = '<p class="hint">暂无会话数据。</p>'; return }

    wrap.innerHTML = ''
    for (const u of lastSessions) {
      const card = document.createElement('div')
      card.className = 'sess-user'
      card.innerHTML = `
        <div class="sess-user-head">
          <b>用户 <code>${escapeHtml(u.userId)}</code></b>
          <span class="tag">${u.sessions.length} 会话 / ${u.totalMessages} 条</span>
        </div>
        <div class="sess-list"></div>
      `
      const list = card.querySelector('.sess-list')
      if (!u.sessions.length) {
        list.innerHTML = '<div class="sess-preview hint">（无会话）</div>'
      }
      for (const s of u.sessions) {
        const item = document.createElement('div')
        item.className = 'sess-item'
        const time = new Date(s.mtime).toLocaleString()
        const badges = []
        if (s.agentUsed) badges.push('<span class="badge badge-agent" title="该会话使用了 Agent 执行命令">🤖 Agent</span>')
        for (const r of (s.risks || [])) badges.push(`<span class="badge badge-risk" title="该会话存在安全风险事件">⚠️ ${escapeHtml(r)}</span>`)
        item.innerHTML = `
          <div class="sess-preview">${escapeHtml(s.preview || '(空会话)')}</div>
          <div class="sess-meta">${s.msgCount}条 · ${time}${badges.length ? ' · ' + badges.join(' ') : ''}</div>
        `
        item.onclick = () => loadSessionDetail(u.userId, s.id)
        list.appendChild(item)
      }
      wrap.appendChild(card)
    }
  }

  async function loadSessionDetail(userId, sessionId) {
    $('#sessDetailCard').classList.remove('hidden')
    $('#sessDetailTag').textContent = `${userId}/${sessionId}`
    const r = await api(`/api/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`)
    const box = $('#sessDetail')
    if (!r.ok) { box.innerHTML = `<p class="err">${escapeHtml(r.msg || '加载失败')}</p>`; return }
    const arr = r.data || []
    if (!arr.length) { box.innerHTML = '<p class="hint">该会话无消息记录。</p>'; return }
    box.innerHTML = ''
    for (const m of arr) {
      const el = document.createElement('div')
      el.className = 'msg ' + (m.role || 'unknown')
      const roleLabel = { system: '📋 系统', user: '👤 用户', assistant: '🤖 助手' }[m.role] || m.role
      el.innerHTML = `<small>${roleLabel}</small>${escapeHtml(m.content || '').replace(/\n/g, '<br>')}`
      box.appendChild(el)
    }
  }

  // ---- Model test ----
  {
    const el = $('#runTestBtn')
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('click', async () => {
    const info = $('#testInfo')
    const out = $('#testOut')
    info.className = 'save-msg'
    info.textContent = '请求中…（先探测 /models + 再发起 /chat/completions）'
    out.classList.add('hidden')
    const body = {
      message: $('#test_msg').value,
      modelKey: $('#test_modelKey').value.trim() || null
    }
    const t0 = Date.now()
    const r = await api('/api/test-model', { method: 'POST', body })
    const dur = Date.now() - t0
    out.classList.remove('hidden')
    if (r.ok) {
      info.className = 'save-msg ok'
      info.textContent = `✅ 成功（${dur}ms · 模型 ${escapeHtml(r.modelName || '')}）`
      const availList = (r.probe && Array.isArray(r.probe.availableModels) && r.probe.availableModels.length)
        ? `可用模型（${r.probe.availableModels.length} 个）: ${r.probe.availableModels.join(', ')}\n` : ''
      out.textContent =
        `模型名: ${r.modelName || '-'}\n` +
        `耗时: ${dur} ms\n` +
        (r.probe ? `探测: ${r.probe.method || ''} ${r.probe.url || ''} → HTTP ${r.probe.status} (${r.probe.latencyMs ?? '-'} ms)\n` : '') +
        availList +
        `Token使用: ${r.usage ? JSON.stringify(r.usage) : '-'}\n\n` +
        `— 回复 —\n${r.text || '(空)'}`
    } else {
      info.className = 'save-msg err'
      info.textContent = `❌ 失败（${dur}ms）`
      const availList = (r.probe && Array.isArray(r.probe.availableModels) && r.probe.availableModels.length)
        ? `可用模型（${r.probe.availableModels.length} 个）: ${r.probe.availableModels.join(', ')}\n` : ''
      const probePart = r.probe
        ? `探测（${r.probe.method || ''}）:\n  请求: ${r.probe.url || '-'}\n  结果: HTTP ${r.probe.status || '-'}${r.probe.code ? '  code=' + r.probe.code : ''}  ${r.probe.ok ? '✅ 可达' : '❌ 不可达'}${r.probe.latencyMs ? ' (' + r.probe.latencyMs + ' ms)' : ''}\n` + availList
        : ''
      out.textContent = probePart + `错误详情：\n${r.msg || '未知错误'}`
    }
      })
    }
  }

  // ---- About ----
  async function loadAbout() {
    const r = await api('/api/server-info')
    const info = r.info || {}
    $('#aboutInfo').innerHTML = `
      <div class="cmd-box">
Web 后台状态：${info.running ? '运行中' : '未运行'}<br>
访问地址：${escapeHtml(info.url || '-') }<br>
绑定 ${escapeHtml(info.host || '-')} : ${escapeHtml(String(info.port || '-'))}
      </div>
      <p class="hint">如需长期开启，可在 config.yaml 中配置端口与绑定地址（绑定 0.0.0.0 可局域网访问）。</p>
    `
  }

  // ---- Multi-API providers ----
  let providersCache = null  // 完整 config 缓存（含 model 字段）
  let providersList = []     // [{ key, name, apiBase, apiKey, model, temperature, maxTokens, timeout, _origKey }]
  let providersDefault = ''
  // 与后端 API_KEY_PLACEHOLDER 完全一致（/api/config 返回的脱敏占位符）。
  // 任何时候保存：若 apiKey 是空串或占位符，视为"未修改"，发送占位符让后端还原原值。
  const API_KEY_PLACEHOLDER = '********'
  function normalizeApiKeyForSave(v) {
    const s = String(v == null ? '' : v).trim()
    if (!s) return API_KEY_PLACEHOLDER           // 空串 → 保留原 key，避免误清空
    if (s === API_KEY_PLACEHOLDER) return s      // 占位符原样回传
    return s
  }

  {
    const el = $('#saveProviders')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', saveProviders)
  }
  {
    const el = $('#addProviderBtn')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', () => addProvider())
  }
  {
    const el = $('#probeAllBtn')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', probeAllProviders)
  }

  async function loadProviders() {
    const msg = $('#provMsg')
    if (msg) { msg.className = 'save-msg'; msg.textContent = '' }
    const resp = await api('/api/config')
    if (!resp.ok) { $('#provTag').textContent = '加载失败'; return }
    providersCache = resp.config
    const modelCfg = resp.config.model || {}
    providersDefault = modelCfg.default || ''
    providersList = []
    for (const k of Object.keys(modelCfg)) {
      if (k === 'default') continue
      const m = modelCfg[k]
      if (!m || typeof m !== 'object') continue
      providersList.push({
        _origKey: k,
        key: k,
        name: m.name || '',
        apiBase: m.apiBase || '',
        apiKey: m.apiKey || '',
        model: m.model || '',
        temperature: m.temperature ?? 0.8,
        maxTokens: m.maxTokens ?? 2000,
        timeout: m.timeout ?? 60000
      })
    }
    $('#prov_default').value = providersDefault
    $('#provTag').textContent = `${providersList.length} 个平台`
    renderProviders()
  }

  function renderProviders() {
    const wrap = $('#providersList')
    if (!providersList.length) {
      wrap.innerHTML = '<p class="hint">暂无 API 平台。点击「➕ 添加平台」开始配置。</p>'
      return
    }
    wrap.innerHTML = ''
    providersList.forEach((p, idx) => {
      const isDefault = (p.key === providersDefault)
      const card = document.createElement('div')
      card.className = 'provider-card' + (isDefault ? ' default' : '')
      card.innerHTML = `
        <div class="provider-head">
          <span class="provider-idx">#${idx + 1}</span>
          <input class="provider-key" data-idx="${idx}" data-field="key" value="${escapeHtml(p.key)}" placeholder="平台 key（唯一标识，如 kimi）"/>
          ${isDefault ? '<span class="tag">默认</span>' : `<button class="btn sm" data-act="default" data-idx="${idx}">设为默认</button>`}
          <button class="btn sm warn" data-act="del" data-idx="${idx}">删除</button>
        </div>
        <div class="provider-body">
          <label>显示名称<input data-idx="${idx}" data-field="name" value="${escapeHtml(p.name)}" placeholder="如 Kimi"/></label>
          <label>API Base<input data-idx="${idx}" data-field="apiBase" value="${escapeHtml(p.apiBase)}" placeholder="https://api.moonshot.cn/v1"/></label>
          <label>API Key<input data-idx="${idx}" data-field="apiKey" value="${escapeHtml(p.apiKey)}" placeholder="sk-..." autocomplete="off"/></label>
          <label>模型 ID
            <div class="model-row">
              <input data-idx="${idx}" data-field="model" value="${escapeHtml(p.model)}" placeholder="如 kimi-k2.6"/>
              <button class="btn sm" data-act="probe" data-idx="${idx}">🔍 探测</button>
            </div>
            <select class="model-select hidden" data-idx="${idx}"></select>
          </label>
          <label>温度<input data-idx="${idx}" data-field="temperature" type="number" step="0.1" min="0" max="2" value="${p.temperature}"/></label>
          <label>Max Tokens<input data-idx="${idx}" data-field="maxTokens" type="number" min="1" value="${p.maxTokens}"/></label>
          <label>超时(ms)<input data-idx="${idx}" data-field="timeout" type="number" min="1000" value="${p.timeout}"/></label>
        </div>
        <div class="provider-probe hidden" data-idx="${idx}"></div>
      `
      wrap.appendChild(card)
    })

    // 字段编辑：实时同步到 providersList
    $$('#providersList input[data-idx], #providersList [data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.dataset.idx, 10)
        const f = el.dataset.field
        if (!providersList[idx] || !f) return
        let v = el.value
        if (f === 'temperature' || f === 'maxTokens' || f === 'timeout') {
          v = parseFloat(v) || 0
        } else if (typeof v === 'string') {
          // —— P3: 文本字段 trim，避免首尾空白导致：(a) 配置被认为"无效"/"冲突" ——
          // (b) 恰好只含空白的 apiKey 在输入框里看不见，会被当成空串发给后端覆
          // 盖真实 key。注意 apiKey 仅在用户真的输入了"非占位符 + 非空"内容时
          // 才会实际变更（见 saveProviders 的保留占位符逻辑）。
          v = v.trim()
        }
        providersList[idx][f] = v
      })
    })

    // 操作按钮
    $$('#providersList button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10)
        const act = btn.dataset.act
        if (act === 'del') removeProvider(idx)
        else if (act === 'default') setDefaultProvider(idx)
        else if (act === 'probe') probeProvider(idx)
      })
    })

    // 模型选择 select 变化
    $$('#providersList select.model-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx, 10)
        if (!providersList[idx]) return
        providersList[idx].model = sel.value
        const inp = $(`#providersList input[data-idx="${idx}"][data-field="model"]`)
        if (inp) inp.value = sel.value
      })
    })
  }

  function addProvider() {
    // 生成不重复的 key
    let base = 'new-provider'
    let n = 1
    const existing = new Set(providersList.map(p => p.key))
    let key = base
    while (existing.has(key)) {
      n++
      key = `${base}-${n}`
    }
    providersList.push({
      _origKey: key,
      key,
      name: '',
      apiBase: '',
      apiKey: '',
      model: '',
      temperature: 0.8,
      maxTokens: 2000,
      timeout: 60000
    })
    if (!providersDefault) providersDefault = key
    $('#provTag').textContent = `${providersList.length} 个平台`
    renderProviders()
    const msg = $('#provMsg')
    if (msg) { msg.className = 'save-msg'; msg.textContent = `已新增平台「${key}」，记得填写 API Base / Key 后点击「保存全部」。` }
  }

  function removeProvider(idx) {
    if (!providersList[idx]) return
    const k = providersList[idx].key
    if (!confirm(`删除平台「${k}」？该平台的模型配置会被移除。`)) return
    providersList.splice(idx, 1)
    if (providersDefault === k) {
      providersDefault = providersList[0]?.key || ''
    }
    $('#prov_default').value = providersDefault
    $('#provTag').textContent = `${providersList.length} 个平台`
    renderProviders()
  }

  function setDefaultProvider(idx) {
    if (!providersList[idx]) return
    providersDefault = providersList[idx].key
    $('#prov_default').value = providersDefault
    renderProviders()
  }

  async function saveProviders() {
    const msg = $('#provMsg')
    if (!providersCache) { msg.textContent = '配置尚未加载'; return }
    // 同步默认平台输入框
    providersDefault = $('#prov_default').value.trim() || providersList[0]?.key || ''
    // 校验：key 唯一且非空
    const seen = new Set()
    for (const p of providersList) {
      p.key = String(p.key || '').trim()
      if (!p.key) { msg.className = 'save-msg err'; msg.textContent = '❌ 存在 key 为空的平台，请填写后再保存。'; return }
      if (seen.has(p.key)) { msg.className = 'save-msg err'; msg.textContent = `❌ 平台 key「${p.key}」重复，请改名后再保存。`; return }
      seen.add(p.key)
    }
    // 构建 model 段：保留 _origKey 不在的对象直接丢弃
    const c = JSON.parse(JSON.stringify(providersCache))
    const newModel = { default: providersDefault }
    for (const p of providersList) {
      newModel[p.key] = {
        name: p.name || '',
        apiBase: String(p.apiBase || '').trim(),
        apiKey: normalizeApiKeyForSave(p.apiKey),
        model: String(p.model || '').trim(),
        temperature: Number(p.temperature) || 0.8,
        maxTokens: Number(p.maxTokens) || 2000,
        timeout: Number(p.timeout) || 60000
      }
    }
    c.model = newModel

    msg.className = 'save-msg'
    msg.textContent = '保存中…'
    const r = await api('/api/config', { method: 'POST', body: { config: c } })
    if (r.ok) {
      msg.className = 'save-msg ok'
      msg.textContent = '✅ ' + (r.msg || '保存成功')
      await loadProviders()
    } else {
      msg.className = 'save-msg err'
      msg.textContent = '❌ ' + (r.msg || '保存失败')
    }
  }

  async function probeProvider(idx) {
    const p = providersList[idx]
    if (!p) return
    // 先保存当前编辑（避免探测的是旧 key）
    const box = $(`#providersList .provider-probe[data-idx="${idx}"]`)
    if (box) {
      box.classList.remove('hidden')
      box.innerHTML = '<span class="hint">🔍 正在探测 /models ...</span>'
    }
    // 直接读取当前页面输入的临时数据（不强制先保存到后端）
    const card = $$('#providersList .provider-card')[idx]
    const apiBase = card?.querySelector(`[data-field="apiBase"]`)?.value?.trim() || p.apiBase
    const apiKeyRaw = card?.querySelector(`[data-field="apiKey"]`)?.value?.trim()
    const apiKey = apiKeyRaw || p.apiKey
    const key = card?.querySelector(`[data-field="key"]`)?.value?.trim() || p.key
    // 如果 key/apiBase/apiKey 跟现有 config 里的不一致，需要先临时保存到后端再探测
    const cfgResp = await api('/api/config')
    const modelCfg = cfgResp.config?.model || {}
    const exist = modelCfg[key]
    // —— P3: 使用精确匹配占位符，而非 !apiKey.includes('****') ——
    // 否则若某个真实 key 恰好含有 4 个连续星（极少见但可能），会被错判为"未改"而跳过保存。
    const keyActuallyModified = !!apiKeyRaw && apiKeyRaw !== API_KEY_PLACEHOLDER
    const needSave = !exist
      || exist.apiBase !== apiBase
      || (keyActuallyModified && exist.apiKey !== apiKeyRaw)
    if (needSave) {
      // 临时保存一下，方便后端用最新的 key 探测
      await saveProviders()
    }
    const r = await api('/api/providers/probe', { method: 'POST', body: { modelKey: key } })
    if (box) {
      if (r.ok && r.info?.ok) {
        const models = r.info.models || []
        if (!models.length) {
          box.innerHTML = `<span class="hint">✅ /models 可达（HTTP ${r.info.status || '-'}），但本账号未返回任何模型。URL: ${escapeHtml(r.info.url || '-')}</span>`
        } else {
          const sel = $(`#providersList select.model-select[data-idx="${idx}"]`)
          if (sel) {
            sel.innerHTML = `<option value="">— 选择模型 (${models.length} 个可用) —</option>` +
              models.map(m => `<option value="${escapeHtml(m)}"${m === p.model ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')
            sel.classList.remove('hidden')
          }
          box.innerHTML = `<span class="hint">✅ 探测到 ${models.length} 个可用模型（HTTP ${r.info.status || '-'}，${r.info.latencyMs ?? '-'} ms）。可在上方"模型 ID"下拉中选择。</span>`
        }
      } else {
        box.innerHTML = `<span class="err">❌ 探测失败：${escapeHtml(r.info?.error || r.info?.status ? `HTTP ${r.info.status}` : (r.msg || '未知错误'))}<br>URL: ${escapeHtml(r.info?.url || '-')}</span>`
      }
    }
  }

  async function probeAllProviders() {
    const msg = $('#provMsg')
    msg.className = 'save-msg'
    msg.textContent = '🔍 探测中…'
    // 先保存（让后端用最新配置）
    await saveProviders()
    const r = await api('/api/providers/probe-all', { method: 'POST' })
    if (!r.ok) {
      msg.className = 'save-msg err'
      msg.textContent = '❌ ' + (r.msg || '探测失败')
      return
    }
    const results = r.results || []
    let okCount = 0
    let totalModels = 0
    for (const item of results) {
      if (item.ok) {
        okCount++
        totalModels += (item.models || []).length
      }
    }
    // 在每个卡片下面渲染结果
    providersList.forEach((p, idx) => {
      const box = $(`#providersList .provider-probe[data-idx="${idx}"]`)
      const item = results.find(x => x.key === p.key)
      if (!box || !item) return
      box.classList.remove('hidden')
      if (item.ok) {
        const models = item.models || []
        if (!models.length) {
          box.innerHTML = `<span class="hint">✅ /models 可达（HTTP ${item.status || '-'}），但未返回任何模型。</span>`
        } else {
          const sel = $(`#providersList select.model-select[data-idx="${idx}"]`)
          if (sel) {
            sel.innerHTML = `<option value="">— 选择模型 (${models.length} 个可用) —</option>` +
              models.map(m => `<option value="${escapeHtml(m)}"${m === p.model ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')
            sel.classList.remove('hidden')
          }
          box.innerHTML = `<span class="hint">✅ ${models.length} 个模型（${item.latencyMs ?? '-'} ms）</span>`
        }
      } else {
        box.innerHTML = `<span class="err">❌ ${escapeHtml(item.error || `HTTP ${item.status}`)}</span>`
      }
    })
    msg.className = 'save-msg ok'
    msg.textContent = `✅ 探测完成：${okCount}/${results.length} 个平台在线，共 ${totalModels} 个可用模型`
  }

  // ---- Image management ----
  {
    const el = $('#saveImgCfg')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', saveImageConfig)
  }
  {
    const el = $('#testImgBtn')
    if (el && typeof el.addEventListener === 'function') el.addEventListener('click', testImageGen)
  }

  async function loadImageConfig() {
    const r = await api('/api/image-config')
    if (!r.ok) { $('#imgTag').textContent = '加载失败'; return }
    const ic = r.config || {}
    $('#imgTag').textContent = ic.enabled ? '已启用' : '未启用'
    $('#img_enabled').value = String(ic.enabled ?? false)
    $('#img_apiBase').value = ic.apiBase || ''
    $('#img_apiKey').value = ic.apiKey || ''
    $('#img_model').value = ic.model || 'dall-e-3'
    $('#img_defaultSize').value = ic.defaultSize || '1024x1024'
    $('#img_quality').value = ic.quality || 'standard'
    $('#img_timeout').value = ic.timeout ?? 120000
  }

  async function saveImageConfig() {
    const msg = $('#imgSaveMsg')
    msg.className = 'save-msg'
    msg.textContent = '保存中…'
    const ic = {
      enabled: $('#img_enabled').value === 'true',
      apiBase: $('#img_apiBase').value.trim(),
      apiKey: normalizeApiKeyForSave($('#img_apiKey').value),
      model: $('#img_model').value.trim() || 'dall-e-3',
      defaultSize: $('#img_defaultSize').value.trim() || '1024x1024',
      quality: $('#img_quality').value || 'standard',
      timeout: parseInt($('#img_timeout').value, 10) || 120000
    }
    const r = await api('/api/image-config', { method: 'POST', body: { config: ic } })
    if (r.ok) {
      msg.className = 'save-msg ok'
      msg.textContent = '✅ ' + (r.msg || '保存成功')
      await loadImageConfig()
    } else {
      msg.className = 'save-msg err'
      msg.textContent = '❌ ' + (r.msg || '保存失败')
    }
  }

  async function testImageGen() {
    const info = $('#imgSaveMsg')
    const out = $('#imgTestOut')
    const preview = $('#imgTestPreview')
    const prompt = $('#img_test_prompt').value.trim()
    if (!prompt) { info.textContent = '请输入测试提示词'; return }
    info.className = 'save-msg'
    info.textContent = '生成中…（可能需要 10-30 秒）'
    out.classList.add('hidden')
    preview.classList.add('hidden')
    const t0 = Date.now()
    const r = await api('/api/test-image', { method: 'POST', body: { prompt } })
    const dur = Date.now() - t0
    out.classList.remove('hidden')
    if (r.ok) {
      info.className = 'save-msg ok'
      info.textContent = `✅ 生成成功（${dur}ms）`
      out.textContent =
        `模型: ${r.raw?.model || '-'}\n` +
        `耗时: ${dur} ms\n` +
        (r.revisedPrompt ? `优化后的提示词: ${r.revisedPrompt}\n` : '') +
        (r.url ? `图片URL: ${r.url}` : (r.b64 ? '图片已返回(base64)' : ''))
      if (r.url) {
        preview.classList.remove('hidden')
        preview.innerHTML = `<img src="${escapeHtml(r.url)}" class="img-preview" />`
      }
    } else {
      info.className = 'save-msg err'
      info.textContent = `❌ 失败（${dur}ms）`
      out.textContent = `错误详情：\n${r.error || r.msg || '未知错误'}`
    }
  }

  // ---- helpers ----
  function escapeHtml(s) {
    // 包含 / 转义（防 </script> 标签内嵌 JSON 场景，防御深度）
    return String(s ?? '').replace(/[&<>"'/]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;'
    }[c]))
  }
  function splitCsv(v) {
    return String(v || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  }
  function splitCsvInt(v) {
    return splitCsv(v).map(s => {
      const n = parseInt(s, 10)
      return Number.isNaN(n) ? s : n
    })
  }

  // 初始化（正常路径：块内所有绑定成功 → 最后加载配置并填充表单）
  // 若前面发生未捕获的同步错误，会由文件顶部的全局 window.onerror 弹窗提示并写「初始化失败」，
  // 从而避免无提示地停留在「加载中…」。loadConfig 内部自带 10s 超时与错误提示。
  console.log('[AI0] loadConfig START')
  try {
    loadConfig()
  } catch (e) {
    console.error('[ai0] 控制台初始化异常（已尝试继续加载配置）：', e)
    loadConfig().catch(err => console.error('[ai0] 配置加载失败：', err))
  }
}
