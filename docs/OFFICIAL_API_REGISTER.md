# 官方 API 密钥注册约定（给合作方 / Python 后端）

插件不生成 API Key。管理员在网页后台点「注册获取密钥」后，**本插件后端**向合作方注册接口申请，合作方签发 Key，插件把 Key 写入本地 `config.yaml`（`model.<key>.apiKey`）。浏览器拿不到明文 Key，也看不到官方地址。

合作方可用 **Python（FastAPI / Flask / Django）** 实现。请求与响应同时认 **camelCase** 与 **snake_case**。

## 接口

- Method: `POST`
- Path: `/v1/plugin/register`
- 完整 URL: `https://api.djyun.click/v1/plugin/register`
- Content-Type: `application/json; charset=utf-8`
- 超时：插件侧 20 秒
- 鉴权：当前版本请求体无密钥；合作方按 `instance_id` 识别插件实例。后续若要 HMAC，另开字段，保持本路径兼容。

不要把注册接口做成 OpenAI `/v1/chat/completions` 的别名。这是独立的签发接口。

## 请求体

插件会同时带两套字段名，Python 用哪套都可以：

```json
{
  "plugin": "ai0-plugin",
  "pluginVersion": "1.2.0",
  "plugin_version": "1.2.0",
  "instanceId": "32位小写hex",
  "instance_id": "32位小写hex",
  "providerKey": "official",
  "provider_key": "official",
  "displayName": "官方API",
  "display_name": "官方API",
  "operatorId": "123456789",
  "operator_id": "123456789"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `plugin` | 是 | 固定 `ai0-plugin` |
| `plugin_version` / `pluginVersion` | 是 | 插件 semver |
| `instance_id` / `instanceId` | 是 | 该部署的稳定 ID，同一台机器人重复注册应返回同一把 Key |
| `provider_key` / `providerKey` | 是 | 插件内平台 key，如 `official`、`official-2` |
| `display_name` / `displayName` | 否 | 展示名 |
| `operator_id` / `operatorId` | 否 | 后台操作者 QQ；未绑定或占位身份（如 `master-magic`）则省略 |
| `qq` | 否 | 与 `operator_id` 相同，仅当其是合法 QQ 号时带上 |

## 成功响应

HTTP `200` 或 `201`。必须给出非空 `api_key`（或 `apiKey` / `data.api_key`）。**请同时返回平台用户名**（`username` / `user_name` / `userName` / `account` 任一即可）。插件会把用户名展示给管理员做 QQ 关联；不返回时管理员须手动填写。

```json
{
  "ok": true,
  "api_key": "sk-合作方签发的密钥",
  "username": "该平台上的用户名",
  "key_id": "可选，合作方内部 ID",
  "expires_at": null
}
```

等价写法（插件都能解析）：

```json
{ "success": true, "apiKey": "sk-..." }
```

```json
{ "ok": true, "data": { "api_key": "sk-..." } }
```

幂等：同一 `instance_id` + `provider_key` 再次注册，请仍返回 `200` 和**同一把** `api_key`，不要用错误把插件卡住。

## 失败响应

HTTP 4xx/5xx，或 `200` 但 `ok/success` 为 false，且没有可用 `api_key`。

```json
{
  "ok": false,
  "code": "RATE_LIMITED",
  "message": "人类可读原因，禁止包含密钥或内部 URL"
}
```

建议 `code`：

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | 缺字段 / 格式错 |
| `UNAUTHORIZED` | 401/403 | 拒绝该实例 |
| `ALREADY_REGISTERED` | 409 | 仅当你们**不**返回旧 Key、且要管理员走别的流程时使用 |
| `RATE_LIMITED` | 429 | 限流 |
| `REGISTER_FAILED` | 500 | 其它失败 |

`message` 会出现在插件后台。不要写密钥、不要写完整 URL。

## 关联 QQ（本次需要合作方新增）

注册成功后，插件会弹窗让管理员关联账号：**默认只带请求者 QQ**（不带用户名），由你们按 QQ 反查已注册账号并回传用户名；仅当 QQ 未匹配到时，插件才让管理员手填平台用户名。请新增：

- Method: `POST`
- Path: `/v1/plugin/associate`
- 完整 URL: `https://api.djyun.click/v1/plugin/associate`
- Content-Type: `application/json; charset=utf-8`
- 超时：插件侧 20 秒

请求体（同样双写 camelCase / snake_case）。**`username` 可选**：QQ 优先匹配时不带该字段：

```json
{
  "plugin": "ai0-plugin",
  "pluginVersion": "1.2.0",
  "plugin_version": "1.2.0",
  "instanceId": "32位小写hex",
  "instance_id": "32位小写hex",
  "providerKey": "official",
  "provider_key": "official",
  "operatorId": "123456789",
  "operator_id": "123456789",
  "qq": "123456789",
  "expectEmail": "123456789@qq.com",
  "expect_email": "123456789@qq.com"
}
```

QQ 未匹配到时，插件会再带 `username` 重试（此时才有下述字段）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `qq` / `operator_id` | 是 | 插件主人 QQ，用来把扣费/余额记到这个人而不是匿名实例 |
| `username` / `user_name` | 否 | 该用户在你们平台上的用户名。QQ 优先匹配时可省略；省略时请按 `qq` 反查账号并回传其用户名 |
| `expect_email` / `expectEmail` | 否 | 期望该用户名绑定的邮箱。第一段固定为 `<qq>@qq.com`；第二段为用户手填的实际邮箱 |
| `email` | 否 | 仅第二段出现：用户手填的、与该用户名绑定的实际邮箱（可能是字母别名，如 `abc123@qq.com`） |

### 关联流程（QQ 优先）

1. **第零段（默认，无 `username`）**：插件只带 `qq` 调用，请按 `qq` 反查已绑定的账号：
   - 查到 → 直接返回成功（见下），`username` 回传该账号用户名即可，无需其他校验证据；
   - 查不到 → 返回 4xx `USER_NOT_FOUND`（或 `NEED_USERNAME`），插件会弹窗请管理员手填平台用户名后进入下面两段。
2. **第一段**：插件带 `expect_email = <qq>@qq.com` 调用。
   - 若账号绑定邮箱就是 `<qq>@qq.com` → 直接返回成功（见下）。
   - 若账号存在但邮箱不同 → 返回 **`EMAIL_REQUIRED`**，插件会弹窗请用户填写该用户名实际绑定的邮箱。
   - 若账号不存在 → 返回 `USER_NOT_FOUND`。
3. **第二段**：插件带用户手填的 `email` 再次调用，你们校验该邮箱是否与账号绑定邮箱一致。

### 必做的身份校验（安全要求）

第零段的匹配键是登录 QQ——插件从登录态派生，不可伪造，因此你们按 QQ 反查账号即可信任该结果。带 `username` 的第零段之后各段**不再接受「2xx 就算成功」**：只返回 `200` 而不给出校验证据，插件会判定失败。原因：管理员可以随手填 `admin` 这类别人的用户名，如果你们无条件绑定，他就能蹭到该账号的额度。

对于带 `username` 的请求，请在该接口内：

1. 找到 `username` 对应账号；找不到返回 4xx `USER_NOT_FOUND`；
2. 读取该账号绑定的邮箱 `actual_email`；
3. 取期望邮箱 `want_email`：优先用请求里的 `email`，否则用 `expect_email`；
4. 若 `actual_email` 为空或与 `want_email` 不一致（大小写不敏感）：
   - 第一段（请求没带 `email`）→ 返回 **`EMAIL_REQUIRED`**，让插件提示用户补填邮箱；
   - 第二段（请求带了 `email`）→ 返回 `IDENTITY_NOT_VERIFIED`，判定失败；
5. 一致时才执行绑定，成功回包必须带 `"verified": true`（或直接回带 `"email": "<actual_email>"`）。

第一段邮箱不匹配时返回（HTTP 403）：

```json
{ "ok": false, "code": "EMAIL_REQUIRED", "need_email": true, "message": "该用户名绑定的邮箱不是当前 QQ 邮箱，请填写实际绑定邮箱" }
```

第二段仍不匹配时返回（HTTP 403）：

```json
{ "ok": false, "code": "IDENTITY_NOT_VERIFIED", "message": "用户名与该邮箱不匹配" }
```

成功：HTTP `200`：

```json
{ "ok": true, "username": "alice", "email": "abc123@qq.com", "verified": true, "associated": true }
```

插件在带 `username` 时认以下任一表示已验证：`verified` / `identityVerified` / `identity_verified` / `emailVerified` / `email_verified` / `emailMatched` / `email_matched` 为 true，或回包 `email` 等于本次期望邮箱。第零段（无 `username`）只要你们按 QQ 反查到账号并回传非空 `username` 即视为成功。请把该 QQ 绑定到 `username` 对应账号。同一 `instance_id` + `provider_key` + `username` + `qq` 重复调用应幂等成功。

失败建议 `code`：`INVALID_REQUEST` / `USER_NOT_FOUND` / `NEED_USERNAME` / `EMAIL_REQUIRED` / `IDENTITY_NOT_VERIFIED` / `UNAUTHORIZED` / `RATE_LIMITED` / `ASSOCIATE_FAILED`。

## 对话 API（注册成功之后）

签发出的 Key 用于 OpenAI 兼容调用：

- `GET /v1/models`，请求头 `Authorization: Bearer <api_key>`
- `POST /v1/chat/completions`，同上

Base 由插件内置，后台不下发。

## 给合作方 AI 的 FastAPI 示例

把下面存成独立服务即可（端口、HTTPS、域名由你们部署）。字段用 Pydantic `alias` 兼容两种命名。

```python
# pip install fastapi uvicorn pydantic
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from fastapi.responses import JSONResponse

app = FastAPI()

# 示例：内存幂等表。生产请换成数据库。
ISSUED = {}  # (instance_id, provider_key) -> api_key
USERS = {}   # username -> {qq, instance_id}


class RegisterIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    plugin: str
    plugin_version: str = Field(default="", alias="pluginVersion")
    instance_id: str = Field(alias="instanceId")
    provider_key: str = Field(alias="providerKey")
    display_name: Optional[str] = Field(default=None, alias="displayName")
    operator_id: Optional[str] = Field(default=None, alias="operatorId")
    qq: Optional[str] = None


class RegisterOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool = True
    api_key: str = Field(serialization_alias="api_key")
    username: Optional[str] = None
    key_id: Optional[str] = None
    expires_at: Optional[str] = None


def issue_key(instance_id: str, provider_key: str) -> str:
    # TODO: 换成你们真实的签发逻辑
    return f"sk-{instance_id[:8]}-{provider_key}"


@app.post("/v1/plugin/register")
def register(body: RegisterIn):
    if body.plugin != "ai0-plugin":
        return JSONResponse(
            status_code=400,
            content={"ok": False, "code": "INVALID_REQUEST", "message": "未知插件"},
        )
    if not body.instance_id or not body.provider_key:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "code": "INVALID_REQUEST", "message": "缺少 instance_id 或 provider_key"},
        )

    slot = (body.instance_id, body.provider_key)
    api_key = ISSUED.get(slot)
    if not api_key:
        api_key = issue_key(body.instance_id, body.provider_key)
        ISSUED[slot] = api_key

    username = f"plugin-{body.instance_id[:8]}"
    return {
        "ok": True,
        "api_key": api_key,
        "username": username,
        "key_id": f"{body.instance_id}:{body.provider_key}",
        "expires_at": None,
    }


class AssociateIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    plugin: str
    plugin_version: str = Field(default="", alias="pluginVersion")
    instance_id: str = Field(alias="instanceId")
    provider_key: str = Field(alias="providerKey")
    username: Optional[str] = Field(default=None, alias="user_name")  # QQ 优先匹配时为空
    operator_id: Optional[str] = Field(default=None, alias="operatorId")
    qq: Optional[str] = None
    email: Optional[str] = None
    expect_email: Optional[str] = Field(default=None, alias="expectEmail")


# 示例：平台账号表，生产请换成数据库。email 为该账号注册时绑定的邮箱，qq 为关联的插件主人 QQ。
ACCOUNTS = {
    "alice": {"email": "123456789@qq.com", "qq": "123456789"},
    "bob": {"email": "bob.wechat@qq.com", "qq": "987654321"},  # 微信注册的字母别名邮箱
}

QQ_INDEX = {str(a.get("qq")): name for name, a in ACCOUNTS.items() if a.get("qq")}


@app.post("/v1/plugin/associate")
def associate(body: AssociateIn):
    qq = (body.qq or body.operator_id or "").strip()
    username = (body.username or "").strip()
    if body.plugin != "ai0-plugin" or not qq or (not username and body.email):
        return JSONResponse(
            status_code=400,
            content={"ok": False, "code": "INVALID_REQUEST", "message": "缺少 qq（或补充 username 后可带 email）"},
        )

    # 第零段（默认）：没带 username → 按 QQ 反查已注册账号并回传其用户名。
    if not username:
        name = QQ_INDEX.get(qq)
        if not name:
            return JSONResponse(
                status_code=404,
                content={"ok": False, "code": "USER_NOT_FOUND", "message": "该 QQ 尚未关联平台账号，请填写平台用户名"},
            )
        USERS[name] = {"qq": qq, "instance_id": body.instance_id}
        return {
            "ok": True,
            "username": name,
            "email": str(ACCOUNTS[name].get("email") or ""),
            "associated": True,
        }

    account = ACCOUNTS.get(username)
    if not account:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "code": "USER_NOT_FOUND", "message": "用户名不存在"},
        )

    # 关键校验：账号绑定邮箱必须等于本次期望邮箱，否则拒绝绑定。
    # 第一段期望 <qq>@qq.com；第二段期望用户手填的 email。
    user_email = (body.email or "").strip().lower()
    expect_email = (user_email or body.expect_email or f"{qq}@qq.com").strip().lower()
    actual_email = str(account.get("email") or "").strip().lower()
    if not actual_email or actual_email != expect_email:
        if not user_email:
            # 第一段不匹配 → 让插件弹窗请用户补填实际绑定邮箱
            return JSONResponse(
                status_code=403,
                content={
                    "ok": False,
                    "code": "EMAIL_REQUIRED",
                    "need_email": True,
                    "message": "该用户名绑定的邮箱不是当前 QQ 邮箱，请填写实际绑定邮箱",
                },
            )
        return JSONResponse(
            status_code=403,
            content={
                "ok": False,
                "code": "IDENTITY_NOT_VERIFIED",
                "message": "用户名与该邮箱不匹配",
            },
        )

    USERS[username] = {"qq": qq, "instance_id": body.instance_id}
    return {
        "ok": True,
        "username": username,
        "email": actual_email,
        "verified": True,
        "associated": True,
    }


@app.get("/v1/models")
def models():
    # 按 OpenAI 兼容格式返回；真实环境请校验 Bearer
    return {"object": "list", "data": [{"id": "official-default", "object": "model"}]}
```

Flask 等价路径：`@app.post("/v1/plugin/register")`，`request.get_json(silent=True)` 后读 `api_key` 或 `apiKey`。

## 插件侧行为

1. 主人用自己的 QQ 发 `#ai网页管理`，直链登录会话绑定该 QQ
2. 网页后台 → 多 API 平台 →「添加官方 API」→「注册获取密钥」
3. 插件 `POST /api/official/register`，把 Key 落盘；响应含 `username`（若合作方返回）
4. 弹窗关联 → 插件先只带 QQ 调 `POST /api/official/associate` → 合作方按 QQ 反查账号（`USER_NOT_FOUND` 时插件再让管理员手填用户名，此时才走 `verified: true` / 匹配 `email` 校验）
5. 之后「拉取模型列表」才带 Key 打 `/v1/models`

失败时后台只显示脱敏后的 `message`，不会出现官方域名。
