const apiKeyEl = document.getElementById("apiKey");
const statusEl = document.getElementById("status");
const appSessionEl = document.getElementById("appSession");
const isProEl = document.getElementById("isPro");
const countEl = document.getElementById("accountCount");
const proCountEl = document.getElementById("proCount");
const tbody = document.getElementById("tbody");
const toastEl = document.getElementById("toast");
const toastTitleEl = document.getElementById("toastTitle");
const toastMessageEl = document.getElementById("toastMessage");
const toastCloseEl = document.getElementById("toastClose");

apiKeyEl.value = localStorage.getItem("zt_api_key") || "";

function setStatus(message, state) {
  statusEl.textContent = message;
  if (state) {
    statusEl.dataset.state = state;
  } else {
    delete statusEl.dataset.state;
  }
}

let toastTimer = null;
function showToast({ title, message, ms = 8000 } = {}) {
  if (!toastEl) return;
  if (toastTimer) clearTimeout(toastTimer);
  toastTitleEl.textContent = title || "操作失败";
  toastMessageEl.textContent = message || "";
  toastEl.hidden = false;
  toastEl.classList.add("is-open");
  toastTimer = setTimeout(() => hideToast(), ms);
}

function hideToast() {
  if (!toastEl) return;
  toastEl.classList.remove("is-open");
  setTimeout(() => {
    toastEl.hidden = true;
  }, 260);
}

toastCloseEl?.addEventListener("click", () => hideToast());

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

document.getElementById("saveKey").onclick = () => {
  localStorage.setItem("zt_api_key", apiKeyEl.value.trim());
  setStatus("已保存 API Key。", "ok");
};

document.getElementById("reload").onclick = () => load();

document.getElementById("import").onclick = async () => {
  setStatus("导入中...", "");
  try {
    const raw = appSessionEl.value.trim();
    await api("/admin/api/accounts/import", {
      method: "POST",
      body: JSON.stringify({ appSession: raw, isPro: Boolean(isProEl.checked) })
    });
    setStatus("导入成功。", "ok");
    await load();
  } catch (e) {
    setStatus(`导入失败：${e.message}`, "error");
    showToast({ title: "导入失败", message: e.message });
  }
};

function headers() {
  const k = (apiKeyEl.value || "").trim();
  return k ? { "x-api-key": k } : {};
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
  if (m < 120) return `（剩余 ${m} 分钟）`;
  const h = (left / 3600000).toFixed(1);
  return `（剩余 ${h} 小时）`;
}

function fmtCooldownLeft(ms) {
  if (!ms) return "";
  const left = Math.max(0, ms - Date.now());
  const totalSec = Math.ceil(left / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `剩余 ${sec} 秒`;
  return `剩余 ${min} 分 ${sec} 秒`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...headers(), ...(opts.headers || {}) }
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(json?.error?.message || text || res.statusText);
  return json;
}

function renderTable(accounts) {
  tbody.innerHTML = "";
  accounts.forEach((a, index) => {
    const tr = document.createElement("tr");
    if (a.disabled) tr.classList.add("is-disabled");
    const idEnc = encodeURIComponent(String(a.id || ""));
    const inCircuit = Boolean(a.circuitUntilMs && a.circuitUntilMs > Date.now());
    const inCooldown = Boolean(a.authSecurityCooldownUntilMs && a.authSecurityCooldownUntilMs > Date.now());
    const proBadge = a.isPro ? "<span class='pill pro'>Pro</span>" : "<span class='pill basic'>Standard</span>";
    const circuitBadge = inCircuit
      ? "<span class='pill bad'>熔断中</span>"
      : inCooldown
        ? "<span class='pill cooldown'>冷却中</span>"
        : "<span class='pill ok'>正常</span>";
    const email = a.email || "-";
    const circuitReason = inCircuit && a.lastError ? escapeHtml(a.lastError) : "";
    const cooldownReason = inCooldown ? `认证限流冷却（${fmtCooldownLeft(a.authSecurityCooldownUntilMs)}）` : "";
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><code>${escapeHtml(a.id)}</code></td>
      <td class="col-email">${escapeHtml(email)}</td>
      <td>${proBadge}</td>
      <td>${a.inflight}/${a.maxInflight}</td>
      <td>${fmtTime(a.accessExpiresAtMs)} <span class="muted">${fmtLeft(a.accessExpiresAtMs)}</span></td>
      <td>${fmtTime(a.signedExpiresAtMs)} <span class="muted">${fmtLeft(a.signedExpiresAtMs)}</span></td>
      <td>${fmtTime(a.csrfExpiresAtMs)} <span class="muted">${fmtLeft(a.csrfExpiresAtMs)}</span></td>
      <td>${circuitBadge}<div class="muted col-error">${circuitReason || escapeHtml(cooldownReason)}</div></td>
      <td>
        <div class="action-grid">
          <button class="btn ghost" data-act="togglePro" data-id="${idEnc}">
            ${a.isPro ? "取消 Pro" : "设为 Pro"}
          </button>
          <button class="btn ghost" data-act="forceAccess" data-id="${idEnc}">刷新 Access</button>
          <button class="btn ghost" data-act="forceSecurity" data-id="${idEnc}">刷新 Security</button>
          <button class="btn warn" data-act="toggle" data-id="${idEnc}">${a.disabled ? "启用" : "禁用"}</button>
          <button class="btn danger" data-act="del" data-id="${idEnc}">删除</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

tbody.addEventListener("click", async (event) => {
  const btn = event.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const act = btn.getAttribute("data-act");
  try {
    if (act === "forceAccess") await api(`/admin/api/accounts/${id}/refresh-access`, { method: "POST" });
    if (act === "forceSecurity") await api(`/admin/api/accounts/${id}/refresh-security`, { method: "POST" });
    if (act === "toggle") await api(`/admin/api/accounts/${id}/toggle`, { method: "POST" });
    if (act === "togglePro") await api(`/admin/api/accounts/${id}/toggle-pro`, { method: "POST" });
    if (act === "del") {
      const ok = window.confirm("确定删除该账号？此操作无法撤销。");
      if (!ok) return;
      await api(`/admin/api/accounts/${id}`, { method: "DELETE" });
    }
    await load();
  } catch (e) {
    setStatus(`操作失败：${e.message}`, "error");
    const title =
      act === "forceAccess"
        ? "Access 刷新失败"
        : act === "forceSecurity"
          ? "Security 刷新失败"
          : act === "togglePro"
            ? "Pro 设置失败"
            : act === "toggle"
              ? "禁用/启用失败"
              : act === "del"
                ? "删除失败"
                : "操作失败";
    showToast({ title, message: e.message });
  }
});

async function load() {
  setStatus("加载中...", "");
  try {
    const data = await api("/admin/api/accounts", { method: "GET" });
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const proCount = accounts.filter((a) => a.isPro).length;
    countEl.textContent = String(accounts.length);
    proCountEl.textContent = String(proCount);
    renderTable(accounts);
    setStatus("就绪。", "ok");
  } catch (e) {
    setStatus(`加载失败：${e.message}（请先填写正确的 API Key）`, "error");
    showToast({ title: "加载失败", message: e.message });
  }
}

load();
