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
| `operator_id` / `operatorId` | 否 | 后台操作者 QQ；未绑定则省略 |

## 成功响应

HTTP `200` 或 `201`。必须给出非空 `api_key`（或 `apiKey` / `data.api_key`）。

```json
{
  "ok": true,
  "api_key": "sk-合作方签发的密钥",
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


class RegisterIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    plugin: str
    plugin_version: str = Field(default="", alias="pluginVersion")
    instance_id: str = Field(alias="instanceId")
    provider_key: str = Field(alias="providerKey")
    display_name: Optional[str] = Field(default=None, alias="displayName")
    operator_id: Optional[str] = Field(default=None, alias="operatorId")


class RegisterOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ok: bool = True
    api_key: str = Field(serialization_alias="api_key")
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

    return {
        "ok": True,
        "api_key": api_key,
        "key_id": f"{body.instance_id}:{body.provider_key}",
        "expires_at": None,
    }


@app.get("/v1/models")
def models():
    # 按 OpenAI 兼容格式返回；真实环境请校验 Bearer
    return {"object": "list", "data": [{"id": "official-default", "object": "model"}]}
```

Flask 等价路径：`@app.post("/v1/plugin/register")`，`request.get_json(silent=True)` 后读 `api_key` 或 `apiKey`。

## 插件侧行为（合作方无需改）

1. 管理员登录网页后台 → 多 API 平台 →「添加官方 API」→「注册获取密钥」
2. 插件 `POST /api/official/register`（需登录 + CSRF）
3. 插件服务端请求本约定的合作方接口
4. 成功则把 Key 写入本地配置，接口只回 `{ ok, providerKey, keyReady, msg }`
5. 之后「拉取模型列表」才带 Key 打 `/v1/models`

失败时后台只显示脱敏后的 `message`，不会出现官方域名。
