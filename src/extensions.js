/**
 * 扩展（extension）加载器
 *
 * 设计目标：
 *  - 扩展是独立目录：extensions/<id>/manifest.json + 入口 JS（+ 可选 web/ 静态页）
 *  - 与主插件解耦：单个扩展加载/运行失败只影响它自己，不影响后台与其它扩展
 *  - 启停状态存在 data/extensions-state.json（不碰 config.yaml，避免与网页保存冲突）
 *  - 扩展默认无鉴权能力：挂在 /api/ext/<id> 的路由统一套 requireAuth，静态页同样需要登录
 *
 * manifest.json 约定：
 *   {
 *     "id": "app-manager",              // 必须与目录名一致，^[a-z0-9][a-z0-9-]{1,31}$
 *     "name": "App 管理",
 *     "version": "1.0.0",
 *     "description": "在手机 App 里完成网页后台的管理操作",
 *     "author": "ai0",
 *     "icon": "📱",                      // 可选，扩展列表显示用
 *     "main": "index.js",                // 相对路径，必须落在扩展目录内
 *     "web": "web"                       // 可选：静态页面目录，挂到 /ext/<id>/
 *   }
 *
 * 入口 JS 需导出 default（或具名 register）函数：
 *   export default function register({ router, app, cfg, logger, dir, dataDir, manifest, requireAuth, requireCsrf, requireApiRate }) {}
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.join(__dirname, '..')

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
const STATE_FILE = process.env.AI0_EXTENSIONS_STATE
  ? path.resolve(process.env.AI0_EXTENSIONS_STATE)
  : path.join(PLUGIN_ROOT, 'data', 'extensions-state.json')

/** 扩展根目录（测试可用 AI0_EXTENSIONS_DIR 覆盖） */
export function extensionsDir() {
  return process.env.AI0_EXTENSIONS_DIR
    ? path.resolve(process.env.AI0_EXTENSIONS_DIR)
    : path.join(PLUGIN_ROOT, 'extensions')
}

/* ------------------------------------------------------------------ */
/*                          状态持久化                                 */
/* ------------------------------------------------------------------ */

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return { disabled: Array.isArray(raw?.disabled) ? raw.disabled.filter((x) => typeof x === 'string') : [] }
  } catch (_) {
    return { disabled: [] }
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ disabled: [...new Set(state.disabled)] }, null, 2))
    fs.renameSync(tmp, STATE_FILE)
    return true
  } catch (_) {
    return false
  }
}

export function isEnabled(id) {
  return !readState().disabled.includes(id)
}

/** 返回 { ok, enabled }；未安装的 id 直接拒绝 */
export function setEnabled(id, enabled) {
  const all = listExtensions()
  if (!all.some((e) => e.id === id)) return { ok: false, msg: '扩展不存在' }
  const state = readState()
  const set = new Set(state.disabled)
  if (enabled) set.delete(id)
  else set.add(id)
  state.disabled = [...set]
  if (!writeState(state)) return { ok: false, msg: '状态写入失败' }
  return { ok: true, enabled: !!enabled }
}

/* ------------------------------------------------------------------ */
/*                          manifest 校验                              */
/* ------------------------------------------------------------------ */

/**
 * 校验一个 manifest 对象。
 * @param {any} m 解析后的 JSON
 * @param {string} dirName 扩展目录名（必须与 id 一致）
 * @returns {{ok:true, manifest:object}|{ok:false, error:string}}
 */
export function validateManifest(m, dirName) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'manifest 不是对象' }
  const id = String(m.id || '').trim()
  if (!ID_RE.test(id)) return { ok: false, error: 'id 非法（需小写字母/数字/连字符，2-32 位）' }
  if (id !== dirName) return { ok: false, error: `id 与目录名不一致（${id} ≠ ${dirName}）` }
  const main = String(m.main || '').trim()
  if (!main || path.isAbsolute(main) || main.split(/[\\/]/).includes('..')) {
    return { ok: false, error: 'main 必须是扩展目录内的相对路径' }
  }
  const web = m.web == null ? '' : String(m.web).trim()
  if (web && (path.isAbsolute(web) || web.split(/[\\/]/).includes('..'))) {
    return { ok: false, error: 'web 必须是扩展目录内的相对路径' }
  }
  return {
    ok: true,
    manifest: {
      id,
      name: String(m.name || id).slice(0, 40),
      version: String(m.version || '0.0.0').slice(0, 20),
      description: String(m.description || '').slice(0, 200),
      author: String(m.author || '').slice(0, 40),
      icon: String(m.icon || '🧩').slice(0, 4),
      main,
      web,
    },
  }
}

/* ------------------------------------------------------------------ */
/*                          扫描 / 加载                                */
/* ------------------------------------------------------------------ */

let _loaded = false
const _runtime = new Map() // id -> { loaded, error, routes:number }

/**
 * 列出所有扩展（只读文件系统，不执行代码）。
 * @returns {Array<{id,name,version,description,author,icon,dir,manifest,status,error,loaded,enabled}>}
 */
export function listExtensions() {
  const root = extensionsDir()
  let names = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (_) {
    return []
  }
  const disabled = new Set(readState().disabled)
  const out = []
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const dir = path.join(root, name)
    const mf = path.join(dir, 'manifest.json')
    if (!fs.existsSync(mf)) continue
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(mf, 'utf8'))
    } catch (e) {
      out.push({ id: name, name, version: '-', description: '', author: '', icon: '⚠️', dir, manifest: null, status: 'broken', error: `manifest.json 解析失败: ${e.message}`, loaded: false, enabled: false })
      continue
    }
    const v = validateManifest(raw, name)
    if (!v.ok) {
      out.push({ id: name, name, version: '-', description: '', author: '', icon: '⚠️', dir, manifest: null, status: 'broken', error: v.error, loaded: false, enabled: false })
      continue
    }
    const rt = _runtime.get(name) || {}
    const enabled = !disabled.has(name)
    out.push({
      ...v.manifest,
      manifest: v.manifest,
      dir,
      status: !enabled ? 'disabled' : (rt.error ? 'broken' : (rt.loaded ? 'loaded' : 'ready')),
      error: rt.error || '',
      loaded: !!rt.loaded,
      enabled,
      routes: rt.routes || 0,
    })
  }
  return out
}

/**
 * 加载所有已启用扩展。
 * @param {import('express').Express} app
 * @param {object} ctx 传给扩展的上下文（router/logger/cfg 等由本函数补充）
 * @returns {Promise<{loaded:string[], failed:Array<{id:string,error:string}>}>}
 */
export async function loadExtensions(app, ctx = {}) {
  const express = ctx.express
  if (!express) throw new Error('loadExtensions 需要传入 express 模块')
  const result = { loaded: [], failed: [] }
  for (const ext of listExtensions()) {
    if (!ext.enabled || ext.status === 'broken') continue
    if (_runtime.get(ext.id)?.loaded) { result.loaded.push(ext.id); continue }
    try {
      const entry = path.join(ext.dir, ext.manifest.main)
      if (!fs.existsSync(entry)) throw new Error(`入口不存在: ${ext.manifest.main}`)
      const mod = await import(pathToFileURL(entry).href)
      const register = typeof mod.default === 'function' ? mod.default : mod.register
      if (typeof register !== 'function') throw new Error('入口未导出 register/default 函数')

      const router = express.Router()
      app.use(`/api/ext/${ext.id}`, ctx.requireAuth, router)
      if (ext.manifest.web) {
        const webDir = path.join(ext.dir, ext.manifest.web)
        if (fs.existsSync(webDir)) {
          app.use(`/ext/${ext.id}`, ctx.requireAuth, express.static(webDir, { dotfiles: 'deny', maxAge: 0 }))
        }
      }
      await register({
        ...ctx,
        router,
        app,
        dir: ext.dir,
        manifest: ext.manifest,
        logger: ctx.logger || console,
      })
      _runtime.set(ext.id, { loaded: true, error: '', routes: router.stack?.length || 0 })
      result.loaded.push(ext.id)
    } catch (e) {
      const msg = String(e?.message || e)
      _runtime.set(ext.id, { loaded: false, error: msg, routes: 0 })
      result.failed.push({ id: ext.id, error: msg })
      try { (ctx.logger || console).warn(`[ai0-plugin] 扩展 ${ext.id} 加载失败: ${msg}`) } catch (_) {}
    }
  }
  _loaded = true
  return result
}

export function isLoaded() {
  return _loaded
}

/** 仅测试用：清空运行时缓存 */
export function __resetRuntime() {
  _runtime.clear()
  _loaded = false
}
