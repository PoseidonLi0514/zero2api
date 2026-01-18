# zero2api-proxy

用 Node.js 把 ZeroTwo 的聊天接口转换成 **OpenAI Chat Completions** 兼容的本地代理，并提供多账号 Token 轮询、自动续期、网页导入与手动强制刷新。

## 启动

```bash
API_KEY='你的自定义Key' \
HOST=127.0.0.1 \
PORT=8787 \
node server.js
```

## 调试（排查 fetch failed）

开启详细出站请求日志（会自动对 `authorization/apikey/x-signed-token/x-csrf-token` 等做掩码）：

```bash
DEBUG_HTTP=1 node server.js
```

如需同时打印请求/响应体片段（仍会做字段级掩码，但建议仅在本地排查时开启）：

```bash
DEBUG_HTTP=1 DEBUG_HTTP_BODY=1 node server.js
```

如果你看到类似 `UND_ERR_CONNECT_TIMEOUT`，常见是 IPv6 “可解析但不可达”导致连接一直卡住。可以用以下方式排查/修复：

- 让 Node 优先走 IPv4（本项目默认已设置；可用 `DNS_RESULT_ORDER=verbatim` 关闭）：`DNS_RESULT_ORDER=ipv4first node server.js`
- 拉长连接建立超时（默认 20s）：`HTTP_CONNECT_TIMEOUT_MS=30000 node server.js`

## Docker / Docker Compose 部署

在服务器上执行：

```bash
cp .env.example .env
# 编辑 .env：至少把 API_KEY 改掉
docker compose build
docker compose up -d
```

访问：

- 管理页：`http://<服务器IP>:<PORT>/admin`
- 代理：`http://<服务器IP>:<PORT>/v1/chat/completions`（带 `x-api-key: <API_KEY>`）

## 代理接口

- `POST /v1/chat/completions`
  - 需要 `x-api-key: <API_KEY>` 或 `Authorization: Bearer <API_KEY>`
  - 支持 `stream: true`（SSE）与非流式
  - 支持 `reasoning_effort`，会同时透传到 ZeroTwo 的顶层 `reasoning_effort` 与 `contextData.reasoning_effort`
  - 支持 `model` 写成 `openai/gpt-5.2`：会自动拆分为 `provider=openai`、`model=gpt-5.2` 转发给 ZeroTwo（也支持直接传 `provider` 字段）
  - `reasoning_effort` 默认值为 `high`
  - 流式模式默认返回 `usage`（无需额外设置 `stream_options.include_usage`）
  - 当 `provider` 为 `anthropic`（或 `model` 形如 `anthropic/claude-...`）时，支持 Claude 风格 `thinking`：
    - `{"thinking":{"type":"off"}}` 关闭
    - `{"thinking":{"type":"enabled","budget_tokens":1024}}` 开启（budget 仅允许 `1024/4096/10000/16000`，其他数值会自动取最近）
  - 当 `provider` 为 `anthropic` 时，会把 `reasoning_effort`（支持字符串或数字）转成上游需要的数字预算（`1024/4096/10000/16000`，`0` 表示关闭），并同步写入顶层与 `contextData.reasoning_effort`
  - 路由规则：当 `provider` 为 `gemini` 或 `anthropic` 时，只会选用 `label` 严格等于 `Pro` 的账号；否则按默认轮询选择
  - 当 `messages[].content` 为数组时，仅提取 `text/input_text` 作为文本内容转发（忽略非文本段）

## 网页管理

- `GET /admin`：管理页（页面本身不鉴权，但所有管理 API 都需要 API Key）
- 管理 API：
  - `GET /admin/api/accounts`
  - `POST /admin/api/accounts/import`
  - `POST /admin/api/accounts/:id/refresh-access`
  - `POST /admin/api/accounts/:id/refresh-security`
  - `POST /admin/api/accounts/:id/toggle`
  - `DELETE /admin/api/accounts/:id`

### 导入方式

从浏览器 LocalStorage 拿到 `app-session` 的 JSON（整段），粘贴到管理页导入。

## 数据文件

默认会把账号信息写到 `data/accounts.json`（已在 `.gitignore` 忽略）。
