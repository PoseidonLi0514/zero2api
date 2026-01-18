const http = require("node:http");
const { URL } = require("node:url");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  apiKey: process.env.API_KEY || "change-me",
  dataDir: process.env.DATA_DIR || path.join(__dirname, "data"),
  accountsFile: process.env.ACCOUNTS_FILE || path.join(__dirname, "data", "accounts.json"),
  maxRequestBodyBytes: Number(process.env.MAX_REQUEST_BODY_BYTES || 20 * 1024 * 1024),

  supabaseBase: "https://db.zerotwo.ai",
  // 你确认这是“公开 anon key”，可写死；如需替换，可用环境变量覆盖。
  supabaseAnonKey:
    process.env.SUPABASE_ANON_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpkYmNldmpicWFveHJ4eHdxd3V4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgyNDcyMzUsImV4cCI6MjA3MzgyMzIzNX0.UcUJUjMocwijFTtYFKYuTgIODYWc4uxDByu2tI6XGQg",

  zerotwoApiBase: process.env.ZEROTWO_API_BASE || "https://zerotwoapi-wajz.onrender.com",
  zerotwoOrigin: "https://zerotwo.ai",

  // 高并发下抖动控制：提前刷新 + 单飞互斥 + 熔断退避
  accessRefreshLeewayMs: 20 * 60 * 1000,
  signedRefreshLeewayMs: 5 * 60 * 1000,
  csrfRefreshLeewayMs: 60 * 60 * 1000,
  backgroundTickMs: 5 * 1000,
  backgroundMaxConcurrent: 4,

  // 账号级并发上限（可在网页里对单账号覆盖）
  defaultMaxInflightPerAccount: 8,

  // 请求超时
  httpTimeoutMs: 60 * 1000
};

const ANTHROPIC_THINKING_BUDGETS = [1024, 4096, 10000, 16000];

function nowMs() {
  return Date.now();
}

function sha256Base64Url(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function normalizeProviderName(provider) {
  const p = String(provider || "").trim();
  if (!p) return "openai";
  const lower = p.toLowerCase();
  // 兼容用户口误
  if (lower === "authropic") return "anthropic";
  return lower;
}

function parseProviderModelFromOpenAIRequest(openaiReq) {
  const requestedModelRaw = typeof openaiReq?.model === "string" ? openaiReq.model.trim() : "";
  let provider = typeof openaiReq?.provider === "string" ? openaiReq.provider.trim() : "openai";
  let model = requestedModelRaw || "gpt-5.2";
  if (requestedModelRaw.includes("/")) {
    const [p, ...rest] = requestedModelRaw.split("/");
    // 只取第一个分段作为 provider，其余原样拼回作为 model
    if (p) provider = p;
    if (rest.length) model = rest.join("/");
  }
  provider = normalizeProviderName(provider);
  return { provider, model };
}

function extractTextFromMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const type = String(part.type || "").toLowerCase();

    if (type === "text" || type === "input_text") {
      const t = typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : "";
      if (t) text += (text ? "\n" : "") + t;
      continue;
    }
  }

  return text;
}

function nearestAllowedNumber(value, allowed) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  let best = allowed[0];
  let bestDiff = Math.abs(v - best);
  for (const a of allowed) {
    const diff = Math.abs(v - a);
    if (diff < bestDiff) {
      best = a;
      bestDiff = diff;
    }
  }
  return best;
}

function budgetFromReasoningEffort(effort) {
  const e = String(effort ?? "").toLowerCase();
  if (e === "none" || e === "off" || e === "disabled") return null;
  if (e === "low" || e === "minimal") return 1024;
  if (e === "medium") return 4096;
  return 16000; // high / 默认
}

function normalizeAnthropicReasoningEffort(value) {
  if (value === null || value === undefined) return 16000;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return "off";
    return nearestAllowedNumber(value, ANTHROPIC_THINKING_BUDGETS) || 16000;
  }

  if (typeof value === "string") {
    const s = value.trim();
    const lower = s.toLowerCase();
    if (!lower) return 16000;
    if (lower === "off" || lower === "none" || lower === "disabled") return "off";

    // 允许用户用字符串直接写预算数字：例如 "4096"
    if (/^\d+$/.test(lower)) {
      const n = Number(lower);
      if (!Number.isFinite(n) || n <= 0) return "off";
      return nearestAllowedNumber(n, ANTHROPIC_THINKING_BUDGETS) || 16000;
    }

    const mapped = budgetFromReasoningEffort(lower);
    if (!mapped) return "off";
    return nearestAllowedNumber(mapped, ANTHROPIC_THINKING_BUDGETS) || 16000;
  }

  return 16000;
}

function normalizeAnthropicThinkingToReasoningEffort(inputThinking, fallbackEffort) {
  const raw = inputThinking && typeof inputThinking === "object" ? inputThinking : null;
  const rawType = raw?.type;
  const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
  if (type === "off" || type === "disabled" || type === "none") {
    return "off";
  }

  const requestedBudget = raw?.budget_tokens ?? raw?.budgetTokens;
  return normalizeAnthropicReasoningEffort(requestedBudget ?? fallbackEffort);
}

function requireApiKey(req) {
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey === CONFIG.apiKey) return true;

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token === CONFIG.apiKey) return true;
  }

  return false;
}

async function supabaseRestJson(account, pathAndQuery, { method, body, headers } = {}) {
  const url = `${CONFIG.supabaseBase}${pathAndQuery}`;
  const doOnce = async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), CONFIG.httpTimeoutMs);
    try {
      const res = await fetch(url, {
        method: method || "GET",
        headers: {
          accept: "application/json",
          apikey: CONFIG.supabaseAnonKey,
          authorization: `Bearer ${account.accessToken}`,
          "content-type": "application/json",
          ...(headers || {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal
      });
      const text = await res.text();
      const parsed = safeJsonParse(text);
      return { ok: res.ok, status: res.status, json: parsed.ok ? parsed.value : null, text };
    } finally {
      clearTimeout(t);
    }
  };

  let r = await doOnce();
  if (r.status === 401 || r.status === 403) {
    await refreshSupabaseSession(account);
    r = await doOnce();
  }
  if (!r.ok) throw new Error(`Supabase REST 失败: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendText(res, statusCode, text, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...headers
  });
  res.end(text);
}

async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function createMutex() {
  let last = Promise.resolve();
  return {
    async run(fn) {
      const prev = last;
      let release;
      last = new Promise((r) => (release = r));
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    }
  };
}

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.accounts = new Map();
    this.runtime = new Map();
    this._saveMutex = createMutex();
  }

  async init() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await this._load();
    for (const id of this.accounts.keys()) this._ensureRuntime(id);
  }

  _ensureRuntime(id) {
    if (this.runtime.has(id)) return;
    this.runtime.set(id, {
      refreshMutex: createMutex(),
      securityMutex: createMutex(),
      inflight: 0,
      circuitUntilMs: 0,
      lastError: null,
      consecutiveFailures: 0
    });
  }

  async _load() {
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      const parsed = safeJsonParse(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      const list = Array.isArray(parsed.value?.accounts) ? parsed.value.accounts : [];
      for (const a of list) {
        if (!a?.id || typeof a?.refreshToken !== "string") continue;
        this.accounts.set(a.id, a);
      }
    } catch (e) {
      if (String(e).includes("ENOENT")) return;
      throw e;
    }
  }

  async save() {
    await this._saveMutex.run(async () => {
      const accounts = [...this.accounts.values()].map((a) => ({
        id: a.id,
        label: a.label || "",
        disabled: Boolean(a.disabled),
        userId: a.userId || "",
        refreshToken: a.refreshToken,
        accessToken: a.accessToken || "",
        accessExpiresAtMs: Number(a.accessExpiresAtMs || 0),
        security: a.security || null,
        maxInflight: Number(a.maxInflight || 0)
      }));
      const payload = JSON.stringify({ accounts }, null, 2);
      await fsp.writeFile(this.filePath, payload, "utf8");
    });
  }

  list() {
    const out = [];
    for (const a of this.accounts.values()) {
      const rt = this.runtime.get(a.id) || {};
      out.push({
        id: a.id,
        label: a.label || "",
        disabled: Boolean(a.disabled),
        userId: a.userId || "",
        accessExpiresAtMs: Number(a.accessExpiresAtMs || 0),
        signedExpiresAtMs: Number(a.security?.signedExpiresAtMs || 0),
        csrfExpiresAtMs: Number(a.security?.csrfExpiresAtMs || 0),
        inflight: Number(rt.inflight || 0),
        circuitUntilMs: Number(rt.circuitUntilMs || 0),
        lastError: rt.lastError || null,
        consecutiveFailures: Number(rt.consecutiveFailures || 0),
        maxInflight: Number(a.maxInflight || 0) || CONFIG.defaultMaxInflightPerAccount
      });
    }
    out.sort((x, y) => x.id.localeCompare(y.id));
    return out;
  }

  upsertFromAppSession(appSession) {
    const refreshToken = appSession?.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) {
      throw new Error("app-session 缺少 refresh_token");
    }
    const id = appSession?.user?.id || randomId("acct");
    const userId = appSession?.user?.id || "";
    const accessToken = appSession?.access_token || "";
    const accessExpiresAtSec = Number(appSession?.expires_at || 0);
    const accessExpiresAtMs = accessExpiresAtSec > 0 ? accessExpiresAtSec * 1000 : 0;

    const existing = this.accounts.get(id);
    const account = {
      id,
      label: existing?.label || "",
      disabled: false,
      userId,
      refreshToken,
      accessToken: accessToken || existing?.accessToken || "",
      accessExpiresAtMs: accessExpiresAtMs || existing?.accessExpiresAtMs || 0,
      security: existing?.security || null,
      maxInflight: existing?.maxInflight || 0
    };
    this.accounts.set(id, account);
    this._ensureRuntime(id);
    return account;
  }

  get(id) {
    const a = this.accounts.get(id);
    if (!a) return null;
    this._ensureRuntime(id);
    return a;
  }

  setDisabled(id, disabled) {
    const a = this.get(id);
    if (!a) throw new Error("账号不存在");
    a.disabled = Boolean(disabled);
  }

  setMaxInflight(id, maxInflight) {
    const a = this.get(id);
    if (!a) throw new Error("账号不存在");
    const v = Number(maxInflight);
    if (!Number.isFinite(v) || v <= 0) throw new Error("maxInflight 必须是正数");
    a.maxInflight = v;
  }

  delete(id) {
    this.accounts.delete(id);
    this.runtime.delete(id);
  }

  runtimeState(id) {
    this._ensureRuntime(id);
    return this.runtime.get(id);
  }
}

const store = new TokenStore(CONFIG.accountsFile);

function classifyAuthFailure(status) {
  return status === 401 || status === 403;
}

async function fetchJson(url, { method, headers, body, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || CONFIG.httpTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    const text = await res.text();
    const parsed = safeJsonParse(text);
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text,
      json: parsed.ok ? parsed.value : null
    };
  } finally {
    clearTimeout(t);
  }
}

async function refreshSupabaseSession(account) {
  return await store.runtimeState(account.id).refreshMutex.run(async () => {
    const now = nowMs();
    if (account.accessToken && account.accessExpiresAtMs - now > CONFIG.accessRefreshLeewayMs) {
      return { refreshed: false };
    }

    const url = `${CONFIG.supabaseBase}/auth/v1/token?grant_type=refresh_token`;
    const res = await fetchJson(url, {
      method: "POST",
      headers: {
        apikey: CONFIG.supabaseAnonKey,
        authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
        "content-type": "application/json"
      },
      body: { refresh_token: account.refreshToken }
    });
    if (!res.ok) {
      throw new Error(`Supabase 刷新失败: ${res.status} ${res.text.slice(0, 200)}`);
    }
    const accessToken = res.json?.access_token;
    const refreshToken = res.json?.refresh_token;
    const expiresAtSec = Number(res.json?.expires_at || 0);
    if (typeof accessToken !== "string" || !accessToken) throw new Error("Supabase 返回缺少 access_token");
    if (typeof refreshToken !== "string" || !refreshToken) throw new Error("Supabase 返回缺少 refresh_token");
    if (!expiresAtSec) throw new Error("Supabase 返回缺少 expires_at");

    account.accessToken = accessToken;
    account.refreshToken = refreshToken; // 轮换：务必覆盖
    account.accessExpiresAtMs = expiresAtSec * 1000;
    await store.save();
    return { refreshed: true };
  });
}

async function refreshSecurityTokens(account) {
  return await store.runtimeState(account.id).securityMutex.run(async () => {
    const now = nowMs();
    const sec = account.security || null;
    if (sec?.signedToken && Number(sec.signedExpiresAtMs || 0) - now > CONFIG.signedRefreshLeewayMs) {
      return { refreshed: false };
    }

    if (!account.accessToken || account.accessExpiresAtMs - now <= CONFIG.accessRefreshLeewayMs) {
      await refreshSupabaseSession(account);
    }

    const url = `${CONFIG.zerotwoApiBase}/api/auth/security-tokens`;
    const res = await fetchJson(url, {
      method: "POST",
      headers: {
        accept: "*/*",
        authorization: `Bearer ${account.accessToken}`,
        "content-type": "application/json",
        origin: CONFIG.zerotwoOrigin,
        referer: `${CONFIG.zerotwoOrigin}/`
      },
      body: null
    });
    if (!res.ok || !res.json?.success) {
      throw new Error(`security-tokens 失败: ${res.status} ${res.text.slice(0, 200)}`);
    }

    const signedToken = res.json?.signedToken;
    const csrfToken = res.json?.csrfToken;
    const signedTokenExpiresIn = Number(res.json?.signedTokenExpiresIn || 0);
    const csrfTokenExpiresIn = Number(res.json?.csrfTokenExpiresIn || 0);
    if (typeof signedToken !== "string" || !signedToken) throw new Error("security-tokens 返回缺少 signedToken");
    if (typeof csrfToken !== "string" || !csrfToken) throw new Error("security-tokens 返回缺少 csrfToken");
    if (!signedTokenExpiresIn) throw new Error("security-tokens 返回缺少 signedTokenExpiresIn");
    if (!csrfTokenExpiresIn) throw new Error("security-tokens 返回缺少 csrfTokenExpiresIn");

    account.security = {
      signedToken,
      csrfToken,
      signedExpiresAtMs: now + signedTokenExpiresIn * 1000,
      csrfExpiresAtMs: now + csrfTokenExpiresIn * 1000,
      fetchedAtMs: now
    };
    await store.save();
    return { refreshed: true };
  });
}

async function ensureAccountReady(account) {
  const now = nowMs();
  if (account.disabled) throw new Error("账号已禁用");
  if (account.accessToken && account.accessExpiresAtMs - now <= CONFIG.accessRefreshLeewayMs) {
    await refreshSupabaseSession(account);
  }
  if (!account.accessToken) await refreshSupabaseSession(account);

  const sec = account.security || null;
  const signedExpired = !sec?.signedToken || Number(sec.signedExpiresAtMs || 0) - now <= CONFIG.signedRefreshLeewayMs;
  const csrfExpired = !sec?.csrfToken || Number(sec.csrfExpiresAtMs || 0) - now <= CONFIG.csrfRefreshLeewayMs;
  if (signedExpired || csrfExpired) {
    await refreshSecurityTokens(account);
  }
}

function requiredLabelForProvider(provider) {
  const p = normalizeProviderName(provider);
  // 你要求：标签严格匹配 "Pro"，并把 gemini/anthropic 自动引导到该 token
  if (p === "gemini" || p === "anthropic") return "Pro";
  return null;
}

function pickAccount({ requiredLabel } = {}) {
  const now = nowMs();
  const candidates = [];
  for (const a of store.accounts.values()) {
    const rt = store.runtimeState(a.id);
    if (a.disabled) continue;
    if (requiredLabel && a.label !== requiredLabel) continue;
    if (rt.circuitUntilMs && rt.circuitUntilMs > now) continue;
    const maxInflight = Number(a.maxInflight || 0) || CONFIG.defaultMaxInflightPerAccount;
    if (rt.inflight >= maxInflight) continue;
    candidates.push({ a, inflight: rt.inflight, maxInflight });
  }
  candidates.sort((x, y) => x.inflight - y.inflight);
  return candidates[0]?.a || null;
}

async function withAccount({ requiredLabel } = {}, fn) {
  const account = pickAccount({ requiredLabel });
  if (!account) {
    const suffix = requiredLabel ? `（需要标签严格匹配: ${requiredLabel}）` : "";
    const err = new Error(`暂无可用账号（可能全部熔断/并发已满/未导入）${suffix}`);
    err.code = "NO_ACCOUNT";
    throw err;
  }
  const rt = store.runtimeState(account.id);
  rt.inflight += 1;
  try {
    return await fn(account);
  } finally {
    rt.inflight -= 1;
  }
}

function markFailure(account, error, baseBackoffMs = 1000) {
  const rt = store.runtimeState(account.id);
  rt.consecutiveFailures += 1;
  rt.lastError = String(error);
  const jitter = Math.floor(Math.random() * 250);
  const backoff = Math.min(30_000, baseBackoffMs * Math.pow(2, Math.min(6, rt.consecutiveFailures - 1)));
  rt.circuitUntilMs = nowMs() + backoff + jitter;
}

function markSuccess(account) {
  const rt = store.runtimeState(account.id);
  rt.consecutiveFailures = 0;
  rt.lastError = null;
  rt.circuitUntilMs = 0;
}

function buildZeroTwoPlanFromOpenAI(openaiReq, account, requestMeta, threadId) {
  const { provider, model } = parseProviderModelFromOpenAIRequest(openaiReq);

  const messages = Array.isArray(openaiReq?.messages) ? openaiReq.messages : [];
  const systemParts = [];
  const zMessages = [];
  let lastNonSystemRole = "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    const content = extractTextFromMessageContent(m.content);
    if (role === "system") {
      if (content) systemParts.push(content);
      continue;
    }
    if (!role) continue;
    lastNonSystemRole = String(role);
    zMessages.push({ role, content, id: normalizeMessageId(m.id) });
  }

  // ZeroTwo 的前端会在最后附加一个空 assistant（用于承载流式输出的 messageId）。
  // 为了兼容 OpenAI 风格（通常最后一条是 user），这里自动补齐。
  if (zMessages.length === 0 || String(lastNonSystemRole).toLowerCase() !== "assistant") {
    zMessages.push({ role: "assistant", content: "", id: crypto.randomUUID ? crypto.randomUUID() : randomId("msg") });
  }

  const systemInstructions = systemParts.join("\n\n").trim();
  const topLevelInstructions = typeof openaiReq?.instructions === "string" ? openaiReq.instructions.trim() : "";
  // 你的代理主要接收 OpenAI 的 system messages：统一抽取并注入到 ZeroTwo 顶层 instructions。
  // 不支持/忽略 metadata.instructions（无此入参约定）。
  const instructions = systemInstructions || topLevelInstructions || "You are a helpful assistant.";
  const requestedEffort =
    openaiReq?.reasoning_effort ??
    openaiReq?.contextData?.reasoning_effort ??
    requestMeta?.reasoning_effort ??
    requestMeta?.contextData?.reasoning_effort ??
    "high";
  const normalizedProvider = normalizeProviderName(provider);

  // 上游只使用 reasoning_effort：payload/contextData 两处保持一致。
  // OpenAI/Gemini 上游支持字符串 high/medium/low；Anthropic(Claude) 上游支持数字预算或 off。
  let reasoningEffortValue = typeof requestedEffort === "string" ? requestedEffort : "high";

  if (normalizedProvider === "anthropic") {
    // Claude: thinking 仅作为入参兼容，用于推导 reasoning_effort；不透传给上游。
    const providedThinking = openaiReq?.thinking && typeof openaiReq.thinking === "object" ? openaiReq.thinking : null;
    if (providedThinking) {
      reasoningEffortValue = normalizeAnthropicThinkingToReasoningEffort(providedThinking, requestedEffort);
    } else {
      reasoningEffortValue = normalizeAnthropicReasoningEffort(requestedEffort);
    }
  }

  const baseContextData = {
    mode: { type: "thread", retrieval: null },
    active_app_id: null,
    active_mcp_server: null,
    is_hybrid_reasoning: true
  };

  const contextData = {
    ...baseContextData,
    ...(requestMeta?.contextData && typeof requestMeta.contextData === "object" ? requestMeta.contextData : {})
  };
  // 上游同时读取 payload/contextData：强制对齐，防止 requestMeta 覆盖。
  contextData.reasoning_effort = reasoningEffortValue;

  return {
    payload: {
      // 注意：某些上游会对请求体做严格校验（甚至包含字段顺序）。
      // 因此避免通过 spread 产生重复 key，确保 instructions 等关键字段位置稳定。
      provider,
      model,
      messages: zMessages,
      instructions,
      tool_choice: openaiReq?.tool_choice || "auto",
      reasoning_effort: reasoningEffortValue,
      contextData,
      featureId: "chat_stream",
      tracking: {
        userId: account.userId || account.id,
        ...(threadId ? { threadId } : {}),
        requestId: randomId("req"),
        timestamp: new Date().toISOString()
      }
    }
  };
}

function getProvidedThreadIdFromRequest(openaiReq) {
  const m = openaiReq?.metadata;
  const candidates = [
    typeof openaiReq?.zerotwo_thread_id === "string" ? openaiReq.zerotwo_thread_id : "",
    typeof openaiReq?.thread_id === "string" ? openaiReq.thread_id : "",
    typeof m?.threadId === "string" ? m.threadId : "",
    typeof m?.thread_id === "string" ? m.thread_id : ""
  ].map((s) => (typeof s === "string" ? s.trim() : ""));
  const found = candidates.find((s) => s);
  return found || null;
}

function buildThreadIdFromRequest(openaiReq) {
  return getProvidedThreadIdFromRequest(openaiReq) || (crypto.randomUUID ? crypto.randomUUID() : randomId("thread"));
}

async function getExistingThreadVectorStoreId(account, threadId) {
  if (!threadId) return "";
  const threadSel = encodeURIComponent("id,vector_store_id,rag_enabled");
  const arr = await supabaseRestJson(account, `/rest/v1/threads?id=eq.${threadId}&select=${threadSel}`, { method: "GET" });
  const row = Array.isArray(arr) ? arr[0] : null;
  const vs = row?.vector_store_id;
  return typeof vs === "string" ? vs : "";
}

function normalizeMessageId(maybeId) {
  if (typeof maybeId === "string" && maybeId.trim()) return maybeId.trim();
  return crypto.randomUUID ? crypto.randomUUID() : randomId("msg");
}

function parseSseEventsFromTextChunk(state, chunkText, onEvent) {
  state.buffer += chunkText;
  for (;;) {
    const idxLf = state.buffer.indexOf("\n\n");
    const idxCrlf = state.buffer.indexOf("\r\n\r\n");
    let idx = -1;
    let delimLen = 0;
    if (idxLf !== -1 && (idxCrlf === -1 || idxLf < idxCrlf)) {
      idx = idxLf;
      delimLen = 2;
    } else if (idxCrlf !== -1) {
      idx = idxCrlf;
      delimLen = 4;
    }
    if (idx === -1) break;

    const raw = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + delimLen);
    const lines = raw.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    if (!dataLines.length) continue;
    const data = dataLines.join("\n");
    onEvent(data);
  }
}

function buildOpenAIUsageFromZeroTwoUsage(u) {
  // ZeroTwo(OpenAI) 形态：prompt_tokens/completion_tokens/total_tokens/reasoning_tokens
  // ZeroTwo(Anthropic) 形态：input_tokens/output_tokens (+ cache_* 等扩展字段)
  const prompt_tokens = Number(u?.prompt_tokens ?? u?.input_tokens ?? 0);
  const completion_tokens = Number(u?.completion_tokens ?? u?.output_tokens ?? 0);
  const total_tokens = Number(u?.total_tokens || 0) || prompt_tokens + completion_tokens;
  const reasoning_tokens = Number(u?.reasoning_tokens || 0);
  const usage = { prompt_tokens, completion_tokens, total_tokens };
  if (reasoning_tokens) usage.reasoning_tokens = reasoning_tokens;
  return usage;
}

async function handleChatCompletions(req, res) {
  const bodyBuf = await readBody(req, CONFIG.maxRequestBodyBytes);
  const parsed = safeJsonParse(bodyBuf.toString("utf8"));
  if (!parsed.ok) return sendJson(res, 400, { error: { message: "JSON 解析失败", type: "invalid_request_error" } });
  const openaiReq = parsed.value;
  const stream = Boolean(openaiReq?.stream);
  const includeUsage = stream ? true : Boolean(openaiReq?.stream_options?.include_usage);

  const { provider } = parseProviderModelFromOpenAIRequest(openaiReq);
  const requiredLabel = requiredLabelForProvider(provider);

  return await withAccount({ requiredLabel }, async (account) => {
    try {
      await ensureAccountReady(account);

      const providedThreadId = getProvidedThreadIdFromRequest(openaiReq);
      const threadId = providedThreadId || (crypto.randomUUID ? crypto.randomUUID() : randomId("thread"));
      const plan = buildZeroTwoPlanFromOpenAI(
        openaiReq,
        account,
        {
          // 统一从 OpenAI 请求推导 reasoning_effort（最终只发送 payload.reasoning_effort）
          reasoning_effort: openaiReq?.reasoning_effort ?? "high"
        },
        threadId
      );
      const payload = plan.payload;

      let vectorStoreIdHint =
        typeof openaiReq?.metadata?.vectorStoreId === "string"
          ? openaiReq.metadata.vectorStoreId
          : typeof openaiReq?.metadata?.vector_store_id === "string"
            ? openaiReq.metadata.vector_store_id
            : "";

      // 若用户指定了 vector store 或使用已有 thread，则开启 thread 检索。
      let effectiveVs = vectorStoreIdHint || "";
      if (!effectiveVs && providedThreadId) {
        // 仅“读取”现有 thread 的向量库；不在没有上传的情况下自动创建，避免无意写库。
        effectiveVs = await getExistingThreadVectorStoreId(account, threadId);
      }
      if (effectiveVs) {
        payload.contextData.thread_vector_store_id = effectiveVs;
        payload.contextData.vector_store_id = effectiveVs;
        payload.contextData.mode = payload.contextData.mode || { type: "thread", retrieval: null };
        payload.contextData.mode.retrieval = ["thread"];
      }

      const url = `${CONFIG.zerotwoApiBase}/api/ai/chat/stream`;
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      const timeout = setTimeout(() => ac.abort(), CONFIG.httpTimeoutMs);

      const zRes = await fetch(url, {
        method: "POST",
        headers: {
          accept: "*/*",
          authorization: `Bearer ${account.accessToken}`,
          "content-type": "application/json",
          origin: CONFIG.zerotwoOrigin,
          referer: `${CONFIG.zerotwoOrigin}/`,
          "x-csrf-token": account.security.csrfToken,
          "x-signed-token": account.security.signedToken
        },
        body: JSON.stringify(payload),
        signal: ac.signal
      }).finally(() => clearTimeout(timeout));

      // 认证类失败：做一次“自愈重试”（避免高并发抖动导致的短暂过期）
      if (classifyAuthFailure(zRes.status)) {
        await refreshSupabaseSession(account);
        await refreshSecurityTokens(account);
        const retryRes = await fetch(url, {
          method: "POST",
          headers: {
            accept: "*/*",
            authorization: `Bearer ${account.accessToken}`,
            "content-type": "application/json",
            origin: CONFIG.zerotwoOrigin,
            referer: `${CONFIG.zerotwoOrigin}/`,
            "x-csrf-token": account.security.csrfToken,
            "x-signed-token": account.security.signedToken
          },
          body: JSON.stringify(payload),
          signal: ac.signal
        });
        if (!retryRes.ok) {
          const text = await retryRes.text();
          throw new Error(`ZeroTwo 请求失败(重试): ${retryRes.status} ${text.slice(0, 200)}`);
        }
        return await streamZeroTwoToOpenAI(retryRes, openaiReq, res, { stream, includeUsage });
      }

      if (!zRes.ok) {
        const text = await zRes.text();
        throw new Error(`ZeroTwo 请求失败: ${zRes.status} ${text.slice(0, 200)}`);
      }

      const result = await streamZeroTwoToOpenAI(zRes, openaiReq, res, { stream, includeUsage });
      markSuccess(account);
      return result;
    } catch (e) {
      markFailure(account, e);
      throw e;
    }
  });
}

async function streamZeroTwoToOpenAI(zRes, openaiReq, res, { stream, includeUsage }) {
  const created = Math.floor(Date.now() / 1000);
  const model = openaiReq?.model || "gpt-5.2";
  const id = randomId("chatcmpl");

  let content = "";
  let reasoning = "";
  let usage = null;
  let finished = false;

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
  }

  const state = { buffer: "" };
  const nodeStream = Readable.fromWeb(zRes.body);
  const decoder = new TextDecoder("utf-8");

  for await (const chunk of nodeStream) {
    // 重要：用流式 UTF-8 解码，避免多字节字符跨 chunk 导致 JSON 解析失败（Claude 中文/emoji 更容易触发）
    const text = decoder.decode(chunk, { stream: true });
    parseSseEventsFromTextChunk(state, text, (data) => {
      const parsed = safeJsonParse(data);
      if (!parsed.ok) return;
      const msg = parsed.value;
      const entity = msg?.entity;
      const status = msg?.status;

      if (entity === "message.content" && status === "delta") {
        const t = msg?.v?.delta?.text;
        if (typeof t === "string" && t) {
          content += t;
          if (stream) {
            const chunkPayload = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: t }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
          }
        }
      }

      if (entity === "message.thinking" && status === "delta") {
        const r = msg?.v?.delta?.reasoning;
        if (typeof r === "string" && r) {
          reasoning += r;
          if (stream) {
            // 兼容“reasoning delta”习惯：不影响只认 content 的客户端
            const chunkPayload = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { reasoning: r }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
          }
        }
      }

      if (entity === "message" && status === "completed") {
        usage = buildOpenAIUsageFromZeroTwoUsage(msg?.v?.usage);
      }

      if (entity === "stream" && status === "completed") {
        finished = true;
      }
    });
  }
  // flush decoder
  const tail = decoder.decode();
  if (tail) {
    parseSseEventsFromTextChunk(state, tail, (data) => {
      const parsed = safeJsonParse(data);
      if (!parsed.ok) return;
      const msg = parsed.value;
      const entity = msg?.entity;
      const status = msg?.status;
      if (entity === "message.content" && status === "delta") {
        const t = msg?.v?.delta?.text;
        if (typeof t === "string" && t) {
          content += t;
          if (stream) {
            const chunkPayload = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: t }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
          }
        }
      }
    });
  }

  if (stream) {
    const finalChunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    if (includeUsage && usage) {
      const usageChunk = { id, object: "chat.completion.chunk", created, model, choices: [], usage };
      res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (!finished) {
    // 非严格：即便缺少 stream completed，也尽量返回聚合结果
  }

  const response = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content, ...(reasoning ? { reasoning } : {}) }, finish_reason: "stop" }],
    ...(usage ? { usage } : {})
  };
  sendJson(res, 200, response);
}

function serveAdminHtml(res) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ZeroTwo Token 管理</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 24px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    input, textarea, button { font: inherit; padding: 8px 10px; }
    textarea { width: 100%; min-height: 140px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border-bottom: 1px solid rgba(127,127,127,0.35); padding: 10px 8px; text-align: left; vertical-align: top; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .muted { opacity: 0.8; }
    .bad { color: #d33; }
    .ok { color: #2a8; }
  </style>
</head>
<body>
  <h1>ZeroTwo Token 管理</h1>
  <p class="muted">所有管理 API 与代理接口都需要 <code>x-api-key</code>（或 <code>Authorization: Bearer</code>）鉴权。</p>

  <div class="row">
    <label>API Key：<input id="apiKey" placeholder="x-api-key" size="36" /></label>
    <button id="saveKey">保存</button>
    <button id="reload">刷新列表</button>
  </div>

  <h2>导入 app-session</h2>
  <p class="muted">把浏览器 LocalStorage 里的 <code>app-session</code> JSON 整段粘贴进来即可（机器人账号场景）。</p>
  <textarea id="appSession" placeholder='{"access_token":"...","refresh_token":"...","expires_at":...,"user":{"id":"..."}}'></textarea>
  <div class="row">
    <input id="label" placeholder="可选：标签（比如 bot-1）" />
    <button id="import">导入</button>
  </div>

  <h2>账号列表</h2>
  <div id="status" class="muted"></div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>标签</th>
        <th>并发</th>
        <th>Access 过期</th>
        <th>Signed 过期</th>
        <th>CSRF 过期</th>
        <th>熔断</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>

  <script>
    const apiKeyEl = document.getElementById("apiKey");
    const statusEl = document.getElementById("status");
    apiKeyEl.value = localStorage.getItem("zt_api_key") || "";
    document.getElementById("saveKey").onclick = () => {
      localStorage.setItem("zt_api_key", apiKeyEl.value.trim());
      statusEl.textContent = "已保存 API Key。";
    };
    document.getElementById("reload").onclick = () => load();

    function headers() {
      const k = (apiKeyEl.value || "").trim();
      return k ? {"x-api-key": k} : {};
    }
    function fmtTime(ms) {
      if (!ms) return "-";
      const d = new Date(ms);
      return d.toLocaleString();
    }
    function fmtLeft(ms) {
      if (!ms) return "";
      const left = ms - Date.now();
      const m = Math.floor(left / 60000);
      if (m < 0) return "（已过期）";
      if (m < 120) return \`（剩余 \${m} 分钟）\`;
      const h = (left / 3600000).toFixed(1);
      return \`（剩余 \${h} 小时）\`;
    }

    async function api(path, opts = {}) {
      const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...headers(), ...(opts.headers||{}) }});
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(json?.error?.message || text || res.statusText);
      return json;
    }

    document.getElementById("import").onclick = async () => {
      statusEl.textContent = "导入中...";
      try {
        const raw = document.getElementById("appSession").value.trim();
        const label = document.getElementById("label").value.trim();
        await api("/admin/api/accounts/import", { method: "POST", body: JSON.stringify({ appSession: raw, label }) });
        statusEl.textContent = "导入成功。";
        await load();
      } catch (e) {
        statusEl.textContent = "导入失败：" + e.message;
      }
    };

    async function load() {
      statusEl.textContent = "加载中...";
      try {
        const data = await api("/admin/api/accounts", { method: "GET", headers: headers() });
        const tbody = document.getElementById("tbody");
        tbody.innerHTML = "";
        for (const a of data.accounts) {
          const tr = document.createElement("tr");
          tr.innerHTML = \`
            <td><code>\${a.id}</code></td>
            <td>\${a.label || ""}</td>
            <td>\${a.inflight}/\${a.maxInflight}</td>
            <td>\${fmtTime(a.accessExpiresAtMs)} <span class="muted">\${fmtLeft(a.accessExpiresAtMs)}</span></td>
            <td>\${fmtTime(a.signedExpiresAtMs)} <span class="muted">\${fmtLeft(a.signedExpiresAtMs)}</span></td>
            <td>\${fmtTime(a.csrfExpiresAtMs)} <span class="muted">\${fmtLeft(a.csrfExpiresAtMs)}</span></td>
            <td>\${a.circuitUntilMs && a.circuitUntilMs > Date.now() ? "<span class='bad'>熔断中</span>" : "<span class='ok'>正常</span>"}<div class="muted">\${a.lastError ? a.lastError : ""}</div></td>
            <td>
              <div class="row">
                <button data-act="forceAccess" data-id="\${a.id}">强制刷新 Access</button>
                <button data-act="forceSecurity" data-id="\${a.id}">强制刷新 Security</button>
                <button data-act="toggle" data-id="\${a.id}">\${a.disabled ? "启用" : "禁用"}</button>
                <button data-act="del" data-id="\${a.id}">删除</button>
              </div>
            </td>
          \`;
          tbody.appendChild(tr);
        }
        tbody.querySelectorAll("button").forEach(btn => {
          btn.onclick = async () => {
            const id = btn.getAttribute("data-id");
            const act = btn.getAttribute("data-act");
            try {
              if (act === "forceAccess") await api(\`/admin/api/accounts/\${id}/refresh-access\`, { method: "POST" });
              if (act === "forceSecurity") await api(\`/admin/api/accounts/\${id}/refresh-security\`, { method: "POST" });
              if (act === "toggle") await api(\`/admin/api/accounts/\${id}/toggle\`, { method: "POST" });
              if (act === "del") await api(\`/admin/api/accounts/\${id}\`, { method: "DELETE" });
              await load();
            } catch (e) {
              statusEl.textContent = "操作失败：" + e.message;
            }
          };
        });
        statusEl.textContent = "就绪。";
      } catch (e) {
        statusEl.textContent = "加载失败：" + e.message + "（请先填写正确的 API Key）";
      }
    }
    load();
  </script>
</body>
</html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleAdminApi(req, res, url) {
  if (!requireApiKey(req)) return sendJson(res, 401, { error: { message: "缺少或错误的 API Key" } });

  if (req.method === "GET" && url.pathname === "/admin/api/accounts") {
    return sendJson(res, 200, { accounts: store.list() });
  }

  if (req.method === "POST" && url.pathname === "/admin/api/accounts/import") {
    const body = await readBody(req);
    const parsed = safeJsonParse(body.toString("utf8"));
    if (!parsed.ok) return sendJson(res, 400, { error: { message: "JSON 解析失败" } });

    const appSessionRaw = parsed.value?.appSession;
    const label = parsed.value?.label;
    if (typeof appSessionRaw !== "string" || !appSessionRaw.trim()) {
      return sendJson(res, 400, { error: { message: "缺少 appSession" } });
    }
    const appSessionParsed = safeJsonParse(appSessionRaw);
    if (!appSessionParsed.ok) return sendJson(res, 400, { error: { message: "app-session JSON 解析失败" } });

    const account = store.upsertFromAppSession(appSessionParsed.value);
    if (typeof label === "string" && label.trim()) account.label = label.trim();
    await store.save();
    return sendJson(res, 200, { ok: true, account: { id: account.id } });
  }

  const mToggle = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)\/toggle$/);
  if (req.method === "POST" && mToggle) {
    const id = mToggle[1];
    const a = store.get(id);
    if (!a) return sendJson(res, 404, { error: { message: "账号不存在" } });
    a.disabled = !a.disabled;
    await store.save();
    return sendJson(res, 200, { ok: true, disabled: a.disabled });
  }

  const mRefreshAccess = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)\/refresh-access$/);
  if (req.method === "POST" && mRefreshAccess) {
    const id = mRefreshAccess[1];
    const a = store.get(id);
    if (!a) return sendJson(res, 404, { error: { message: "账号不存在" } });
    await store.runtimeState(id).refreshMutex.run(async () => {
      a.accessExpiresAtMs = 0;
      a.accessToken = "";
    });
    await refreshSupabaseSession(a);
    return sendJson(res, 200, { ok: true });
  }

  const mRefreshSecurity = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)\/refresh-security$/);
  if (req.method === "POST" && mRefreshSecurity) {
    const id = mRefreshSecurity[1];
    const a = store.get(id);
    if (!a) return sendJson(res, 404, { error: { message: "账号不存在" } });
    a.security = null;
    await store.save();
    await refreshSecurityTokens(a);
    return sendJson(res, 200, { ok: true });
  }

  const mDelete = url.pathname.match(/^\/admin\/api\/accounts\/([^/]+)$/);
  if (req.method === "DELETE" && mDelete) {
    const id = mDelete[1];
    store.delete(id);
    await store.save();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: { message: "未找到" } });
}

async function backgroundTick() {
  const now = nowMs();
  const list = [...store.accounts.values()].filter((a) => !a.disabled);
  // 简单的并发限制队列
  const queue = list.slice();
  let active = 0;
  return await new Promise((resolve) => {
    const pump = () => {
      while (active < CONFIG.backgroundMaxConcurrent && queue.length) {
        const a = queue.shift();
        active += 1;
        (async () => {
          const rt = store.runtimeState(a.id);
          if (rt.circuitUntilMs && rt.circuitUntilMs > now) return;
          const needAccess = !a.accessToken || a.accessExpiresAtMs - now <= CONFIG.accessRefreshLeewayMs;
          const needSigned = !a.security?.signedToken || Number(a.security?.signedExpiresAtMs || 0) - now <= CONFIG.signedRefreshLeewayMs;
          const needCsrf = !a.security?.csrfToken || Number(a.security?.csrfExpiresAtMs || 0) - now <= CONFIG.csrfRefreshLeewayMs;
          if (!needAccess && !needSigned && !needCsrf) return;
          try {
            await ensureAccountReady(a);
            markSuccess(a);
          } catch (e) {
            markFailure(a, e);
          }
        })()
          .finally(() => {
            active -= 1;
            pump();
          });
      }
      if (!queue.length && active === 0) resolve();
    };
    pump();
  });
}

async function main() {
  await store.init();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") return sendText(res, 200, "ok\n");

      if (req.method === "GET" && url.pathname === "/admin") return serveAdminHtml(res);
      if (url.pathname.startsWith("/admin/api/")) return await handleAdminApi(req, res, url);

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        if (!requireApiKey(req)) return sendJson(res, 401, { error: { message: "缺少或错误的 API Key" } });
        return await handleChatCompletions(req, res);
      }

      return sendJson(res, 404, { error: { message: "未找到" } });
    } catch (e) {
      if (e?.code === "BAD_ATTACHMENTS") {
        return sendJson(res, 400, { error: { message: String(e?.message || e), type: "invalid_request_error" } });
      }
      if (e?.code === "NO_ACCOUNT") {
        return sendJson(res, 503, { error: { message: String(e?.message || e), type: "server_error" } });
      }
      return sendJson(res, 500, { error: { message: String(e?.message || e) } });
    }
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[server] listening on http://${CONFIG.host}:${CONFIG.port}`);
    if (CONFIG.apiKey === "change-me") console.log("[server] 警告：请设置环境变量 API_KEY");
  });

  setInterval(() => {
    backgroundTick().catch(() => {});
  }, CONFIG.backgroundTickMs).unref();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
