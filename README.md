# zero2api-proxy

用 Node.js 把 ZeroTwo 的聊天接口转换成 **OpenAI Chat Completions** 兼容的本地代理，并提供多账号 Token 轮询、自动续期、网页导入与手动强制刷新。

## 启动

```bash
API_KEY='你的自定义Key' \
HOST=127.0.0.1 \
PORT=8787 \
node server.js
```

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
  - 当 `provider` 为 `anthropic` 时，会把 `reasoning_effort` 转成上游需要的数字预算（`1024/4096/10000/16000`，或 `off`），并同步写入顶层与 `contextData.reasoning_effort`
  - 路由规则：当 `provider` 为 `gemini` 或 `anthropic` 时，只会选用 `label` 严格等于 `Pro` 的账号；否则按默认轮询选择

### 图片/附件（ZeroTwo RAG Upload）

当 `messages[].content` 使用 OpenAI 常见的多模态数组格式时（`type: "image_url"` / `"input_image"`），代理会先调用 ZeroTwo 的 `POST /api/rag/upload` 上传文件，再把返回的文件元数据写入 ZeroTwo 请求体的 `attachments` 字段。

注意：ZeroTwo 的 RAG 上传需要一个已存在的 `threadId` 来解析向量库。代理在检测到有附件且未提供 `metadata.threadId` 时，会先发送一次极轻量的“thread 初始化请求”以创建 thread，然后再执行上传。
注意（更新）：代理会直接通过 Supabase REST/RPC 创建 `threads` 记录与 `vector_store`（`create_vector_store`），并把 `vector_store_id` 绑定回 `threads`，再调用 `/api/rag/upload` 上传文件。

示例（data URL）：

```json
{
  "model": "openai/gpt-5.2",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "请描述这张图" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ]
}
```

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
