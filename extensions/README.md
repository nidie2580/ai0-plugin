# 扩展目录

每个扩展一个文件夹，结构：

```
extensions/<id>/
├── manifest.json    # 必填：id/name/version/main（id 必须与目录名一致）
├── index.js         # 必填：export default function register(ctx) {}
└── web/             # 可选：静态页面，挂到 /ext/<id>/（需登录）
```

manifest 示例：

```json
{
  "id": "app-manager",
  "name": "App 管理",
  "version": "1.0.0",
  "description": "在手机 App 里完成网页后台的管理操作",
  "author": "ai0",
  "icon": "📱",
  "main": "index.js",
  "web": "web"
}
```

扩展上下文：
`register({ router, app, cfg, logger, dir, dataDir, manifest, requireAuth, requireCsrf, requireApiRate })`

- `router` 已挂在 `/api/ext/<id>` 且强制登录
- 扩展抛错只影响自己，扩展列表会显示错误
- 启停状态存 `data/extensions-state.json`，启停后需重启插件

## 与 git 更新的关系

- `extensions/` **不进仓库**（`.gitignore` 忽略 `extensions/*`，仅保留本 README）
- 因此用户手工放入的第三方扩展（未跟踪文件）在 `git pull`、`git reset --hard` 下都**不会被删除或覆盖**
- ⚠️ 唯一风险是自己写的更新脚本里带 `git clean -fd`（会删未跟踪文件）；云崽自带 `plugins/other/update.js` 没有 clean，可放心
- 需要随插件分发的官方扩展，用单独目录（如 `builtin-extensions/`）跟踪，别放回 `extensions/`
