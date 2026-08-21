/* global document, window, fetch */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, { method = 'GET', body, raw = false } = {}) {
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
  const r = await fetch(path, opts)
  const text = await r.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (raw) return { status: r.status, ok: r.ok, data }
  return data
}

const route = document.currentScript?.dataset.route || ''

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

  const input = $('#codeInput')
  const err = $('#err')
  input?.addEventListener('input', () => {
    input.value = input.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
    err.textContent = ''
  })
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })

  $('#loginBtn')?.addEventListener('click', doLogin)

  async function doLogin() {
    const code = input.value.trim()
    if (code.length !== 6) {
      err.textContent = '请输入 6 位数字验证码'
      return
    }
    const r = await api('/api/login/code', { method: 'POST', body: { code } })
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
      if (a.dataset.view === 'image') loadImageConfig()
      if (a.dataset.view === 'providers') loadProviders()
      if (a.dataset.view === 'about') loadAbout()
    })
  })

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' })
    location.href = '/'
  })

  // ---- Config ----
  let currentConfig = null
  let currentModelKey = null
  const saveMsg = $('#saveMsg')

  $('#saveCfg').addEventListener('click', saveConfig)
  $('#resetCfg').addEventListener('click', loadConfig)

  async function loadConfig() {
    saveMsg.textContent = ''
    const resp = await api('/api/config')
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

    $('#system_prompt').value = resp.config.system?.prompt || ''

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
    `
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
      sessionTimeout: parseInt($('#chat_sessionTimeout').value, 10) || -1
    }
    c.system = { prompt: $('#system_prompt').value }
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
      host: $('#web_host').value.trim() || '127.0.0.1'
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
  $('#refreshSessBtn').addEventListener('click', loadSessions)
  $('#closeSessionBtn').addEventListener('click', () => {
    $('#sessDetailCard').classList.add('hidden')
  })
  $('#delSessionBtn').addEventListener('click', async () => {
    const tag = $('#sessDetailTag').textContent
    const [userId, sessionId] = tag.split('/')
    if (!userId || !sessionId) return
    if (!confirm(`删除该会话？（${userId}/${sessionId}）`)) return
    await api(`/api/sessions/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    $('#sessDetailCard').classList.add('hidden')
    await loadSessions()
  })

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
        item.innerHTML = `
          <div class="sess-preview">${escapeHtml(s.preview || '(空会话)')}</div>
          <div class="sess-meta">${s.msgCount}条 · ${time}</div>
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
    if (!r.ok) { box.innerHTML = `<p class="err">${r.msg || '加载失败'}</p>`; return }
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
  $('#runTestBtn').addEventListener('click', async () => {
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

  $('#saveProviders')?.addEventListener('click', saveProviders)
  $('#addProviderBtn')?.addEventListener('click', () => addProvider())
  $('#probeAllBtn')?.addEventListener('click', probeAllProviders)

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
        if (f === 'temperature' || f === 'maxTokens' || f === 'timeout') v = parseFloat(v) || 0
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
        apiBase: p.apiBase || '',
        apiKey: p.apiKey || '',
        model: p.model || '',
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
    const apiKey = card?.querySelector(`[data-field="apiKey"]`)?.value?.trim() || p.apiKey
    const key = card?.querySelector(`[data-field="key"]`)?.value?.trim() || p.key
    // 如果 key/apiBase/apiKey 跟现有 config 里的不一致，需要先临时保存到后端再探测
    const cfgResp = await api('/api/config')
    const modelCfg = cfgResp.config?.model || {}
    const exist = modelCfg[key]
    const needSave = !exist || exist.apiBase !== apiBase || (apiKey && !apiKey.includes('****') && exist.apiKey !== apiKey)
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
  $('#saveImgCfg')?.addEventListener('click', saveImageConfig)
  $('#testImgBtn')?.addEventListener('click', testImageGen)

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
      apiKey: $('#img_apiKey').value.trim(),
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
        preview.innerHTML = `<img src="${escapeHtml(r.url)}" style="max-width:100%;border-radius:8px" />`
      }
    } else {
      info.className = 'save-msg err'
      info.textContent = `❌ 失败（${dur}ms）`
      out.textContent = `错误详情：\n${r.error || r.msg || '未知错误'}`
    }
  }

  // ---- helpers ----
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
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

  // 初始化
  loadConfig()
}
