// Nyra Rose 🌹 Dashboard. Plain JS, no build step.
// All user/WhatsApp content is inserted with textContent (never innerHTML).

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const fmtTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const fmtNum = (n) => Math.round(n).toLocaleString();

let password = localStorage.getItem("nr_password") || localStorage.getItem("lj_password") || "";
let overview = null;
let pollTimer = null;
let currentChat = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${password}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    signOut();
    throw new Error("Unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function signOut() {
  password = "";
  localStorage.removeItem("nr_password");
  localStorage.removeItem("lj_password");
  clearInterval(pollTimer);
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  password = $("#password").value.trim();
  $("#login-error").textContent = "";
  try {
    await enterApp();
    localStorage.setItem("nr_password", password);
  } catch {
    $("#login-error").textContent = "That password is not recognised.";
  }
});
$("#logout").addEventListener("click", signOut);

async function enterApp() {
  await refreshOverview();
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden && !$("#tab-home").classList.contains("hidden")) refreshOverview().catch(() => {});
  }, 4000);
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
    $(`#tab-${btn.dataset.tab}`).classList.remove("hidden");
    if (btn.dataset.tab === "home") refreshOverview();
    if (btn.dataset.tab === "chat") loadDashboardChat();
    if (btn.dataset.tab === "chats") loadChats();
    if (btn.dataset.tab === "rules") loadRules();
    if (btn.dataset.tab === "notes") loadNotes();
    if (btn.dataset.tab === "todos") loadTodos();
    if (btn.dataset.tab === "settings") fillSettings();
  }),
);

// ─── Home ────────────────────────────────────────────────────────────────────

const STATES = {
  open: ["on", "Connected"],
  qr: ["warn", "Waiting for you to scan the QR code"],
  connecting: ["warn", "Connecting…"],
  starting: ["warn", "Starting…"],
  closed: ["off", "Disconnected"],
  logged_out: ["off", "Logged out — fresh QR coming"],
  never_connected: ["off", "Gateway has not connected yet"],
};

async function refreshOverview() {
  overview = await api("GET", "/api/overview");
  const { gateway, usage, settings, models } = overview;

  const isOnline = Boolean(gateway.online);
  const isOpen = isOnline && gateway.state === "open";
  const isQr = isOnline && gateway.state === "qr" && Boolean(gateway.qr);

  const [cls, label] = STATES[gateway.state] || ["off", gateway.state];
  const me = gateway.me?.phone ? `+${gateway.me.phone}` : gateway.me?.name || "";

  $("#wa-status").replaceChildren(
    el("div", `dot ${isOnline ? cls : "off"}`),
    el("span", null, isOnline ? `${label}${me ? ` (${me})` : ""}` : "Cloud Gateway is offline"),
  );

  const qrBox = $("#wa-qr");
  if (isQr) {
    qrBox.classList.remove("hidden");
    $("#wa-qr-img").src = gateway.qr;
  } else {
    qrBox.classList.add("hidden");
  }

  const help = $("#wa-help");
  const wakeBtn = $("#wa-wake");
  const wakeHead = $("#wa-wake-head");
  const logoutBtn = $("#wa-logout");
  const resetBtn = $("#wa-reset");

  if (isOpen) {
    help.textContent = `Nyra Rose is actively linked to WhatsApp. She answers automatically.`;
    logoutBtn.classList.remove("hidden");
    resetBtn.classList.remove("hidden");
    wakeBtn.classList.add("hidden");
    wakeHead.classList.add("hidden");
  } else if (isQr) {
    help.textContent = "Open WhatsApp on your phone → Linked Devices → Link a Device and scan the QR code.";
    logoutBtn.classList.add("hidden");
    resetBtn.classList.add("hidden");
    wakeBtn.classList.add("hidden");
    wakeHead.classList.add("hidden");
  } else if (!isOnline) {
    help.textContent = "Gateway runner is sleeping. Click below to wake her up.";
    logoutBtn.classList.add("hidden");
    resetBtn.classList.add("hidden");
    wakeBtn.classList.remove("hidden");
    wakeHead.classList.remove("hidden");
  } else {
    help.textContent = gateway.detail || "Connecting…";
    logoutBtn.classList.add("hidden");
    resetBtn.classList.add("hidden");
    wakeBtn.classList.add("hidden");
    wakeHead.classList.add("hidden");
  }

  // Neurons
  const todayUsed = usage.today?.neurons ?? 0;
  const free = usage.freePerDay ?? 10000;
  $("#neurons-today").textContent = fmtNum(todayUsed);
  $("#neurons-free").textContent = fmtNum(free);
  $("#neurons-bar").style.width = `${Math.min(100, (todayUsed / free) * 100)}%`;
  $("#requests-today").textContent = fmtNum(usage.today?.requests ?? 0);

  const rows = $("#usage-rows");
  rows.replaceChildren(
    ...(usage.recent || []).map((u) => {
      const tr = el("tr");
      tr.append(el("td", null, u.day), el("td", null, `${fmtNum(u.neurons)} neurons · ${fmtNum(u.requests)} replies`));
      return tr;
    }),
  );

  // Quick switches
  $("#quick-enabled").checked = settings.enabled;
  $("#quick-mode").textContent = settings.replyMode;
  const m = models.find((x) => x.id === settings.model);
  $("#quick-model").textContent = m ? m.label.split("—")[0].trim() : settings.model;
}

$("#quick-enabled").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await api("PUT", "/api/settings", { enabled });
  overview.settings.enabled = enabled;
});

async function wakeGateway(btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Waking cloud runner…";
  try {
    const res = await api("POST", "/api/gateway/start");
    alert(res.message || "Cloud runner dispatched!");
    setTimeout(refreshOverview, 3000);
  } catch (err) {
    alert(`Could not start runner: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}
$("#wa-wake").addEventListener("click", (e) => wakeGateway(e.target));
$("#wa-wake-head").addEventListener("click", (e) => wakeGateway(e.target));

$("#wa-logout").addEventListener("click", async () => {
  if (!confirm("Sign out Nyra Rose from WhatsApp? The session will be unlinked.")) return;
  await api("POST", "/api/gateway/logout");
  await refreshOverview();
});

$("#wa-reset").addEventListener("click", async () => {
  if (!confirm("Permanently wipe stored session from Cloudflare storage and reset QR code?")) return;
  await api("POST", "/api/session/reset");
  await refreshOverview();
});

// ─── Talk to Nyra Rose ───────────────────────────────────────────────────────

async function loadDashboardChat() {
  const { messages } = await api("GET", "/api/messages?chat=dashboard");
  const log = $("#chat-log");
  log.replaceChildren(...messages.map(renderBubble));
  log.scrollTop = log.scrollHeight;
}

function renderBubble(m) {
  const b = el("div", `bubble ${m.role}`);
  b.append(el("div", "text", m.content));
  const meta = el("div", "meta", `${m.sender_name || (m.role === "user" ? "You" : "Nyra Rose")} · ${fmtTime(m.created_at)}${m.neurons ? ` · ${m.neurons.toFixed(1)} neurons` : ""}`);
  b.append(meta);
  return b;
}

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const log = $("#chat-log");
  log.append(renderBubble({ role: "user", content: text, created_at: Date.now(), sender_name: "You" }));
  log.scrollTop = log.scrollHeight;

  const thinking = el("div", "bubble assistant", "Thinking…");
  log.append(thinking);
  log.scrollTop = log.scrollHeight;

  try {
    const res = await api("POST", "/api/chat", { text });
    thinking.remove();
    if (res.reply) {
      log.append(renderBubble({ role: "assistant", content: res.reply, created_at: Date.now(), sender_name: "Nyra Rose", neurons: res.neurons }));
    }
  } catch (err) {
    thinking.textContent = `Error: ${err.message}`;
  }
  log.scrollTop = log.scrollHeight;
});

$("#chat-reset").addEventListener("click", async () => {
  if (!confirm("Clear your test chat with Nyra Rose?")) return;
  await api("DELETE", "/api/messages?chat=dashboard");
  $("#chat-log").replaceChildren();
});

// ─── Conversations ───────────────────────────────────────────────────────────

async function loadChats() {
  const { chats } = await api("GET", "/api/chats");
  const list = $("#chat-list");
  list.replaceChildren(
    ...chats.map((c) => {
      const item = el("div", `chat-item ${currentChat === c.chat_id ? "active" : ""}`);
      const info = el("div");
      info.append(el("div", "title", c.name || c.chat_id), el("div", "sub", `${c.message_count} messages · ${fmtTime(c.last_at)}`));
      item.append(info);
      item.addEventListener("click", () => selectChat(c));
      return item;
    }),
  );
  if (!currentChat && chats[0]) selectChat(chats[0]);
}

async function selectChat(c) {
  currentChat = c.chat_id;
  $("#conv-title").textContent = c.name || c.chat_id;
  const muteBtn = $("#conv-mute");
  muteBtn.classList.remove("hidden");
  muteBtn.textContent = c.muted ? "Unmute" : "Mute";
  muteBtn.onclick = async () => {
    await api("PATCH", "/api/chats", { chat: c.chat_id, muted: !c.muted });
    c.muted = !c.muted;
    selectChat(c);
  };
  const clearBtn = $("#conv-clear");
  clearBtn.classList.remove("hidden");
  clearBtn.onclick = async () => {
    if (!confirm(`Delete all stored messages for ${c.name || c.chat_id}?`)) return;
    await api("DELETE", `/api/messages?chat=${encodeURIComponent(c.chat_id)}`);
    selectChat(c);
  };

  const { messages } = await api("GET", `/api/messages?chat=${encodeURIComponent(c.chat_id)}`);
  const log = $("#conv-log");
  log.replaceChildren(...messages.map(renderBubble));
  log.scrollTop = log.scrollHeight;
  document.querySelectorAll(".chat-item").forEach((it, i) => it.classList.toggle("active", overview?.chats?.[i]?.chat_id === c.chat_id));
}

// ─── Rule Book ───────────────────────────────────────────────────────────────

let rules = [];
async function loadRules() {
  const res = await api("GET", "/api/rules");
  rules = res.rules || [];
  renderRules();
}

function renderRules() {
  const container = $("#rules-list");
  if (rules.length === 0) {
    container.replaceChildren(el("div", "muted", "No rules created yet. Add one above!"));
    return;
  }

  container.replaceChildren(
    ...rules.map((r) => {
      const card = el("div", `rule-item ${r.enabled ? "" : "disabled"}`);
      const info = el("div", "rule-content");
      const meta = el("div", "rule-meta");
      const badge = el("span", `badge ${r.type === "instant" ? "badge-instant" : "badge-ai"}`, r.type === "instant" ? "⚡ Instant Auto-Reply" : "🧠 AI Guideline");
      meta.append(badge);

      const triggers = el("div", "rule-triggers", r.triggers);
      const resp = el("div", "rule-resp", r.response);
      info.append(meta, triggers, resp);

      const ctrls = el("div", "rule-ctrls");
      const tog = el("button", "ghost small", r.enabled ? "Disable" : "Enable");
      tog.addEventListener("click", async () => {
        const next = r.enabled ? 0 : 1;
        await api("PATCH", "/api/rules", { id: r.id, enabled: next });
        r.enabled = next;
        renderRules();
      });
      const del = el("button", "danger small", "Delete");
      del.addEventListener("click", async () => {
        if (!confirm("Delete this rule?")) return;
        await api("DELETE", `/api/rules?id=${r.id}`);
        rules = rules.filter((x) => x.id !== r.id);
        renderRules();
      });
      ctrls.append(tog, del);
      card.append(info, ctrls);
      return card;
    }),
  );
}

$("#add-rule-toggle").addEventListener("click", () => {
  $("#new-rule-form").classList.toggle("hidden");
  $("#rule-triggers").focus();
});

$("#cancel-rule-btn").addEventListener("click", () => {
  $("#new-rule-form").classList.add("hidden");
  $("#rule-error").textContent = "";
});

$("#rule-type").addEventListener("change", (e) => {
  const isInstant = e.target.value === "instant";
  $("#rule-trigger-label").innerHTML = isInstant
    ? 'Trigger Keywords <span class="muted">(comma-separated, e.g. price, cost, দাম, রেট)</span>'
    : 'Topic / Guideline Label <span class="muted">(e.g. Tone, Pricing, Discounts, Policies)</span>';
  $("#rule-response-label").innerHTML = isInstant
    ? 'Instant Reply Message <span class="muted">(Sent word-for-word, 0 Neurons)</span>'
    : 'AI Instruction <span class="muted">(How Nyra Rose should behave)</span>';
});

$("#new-rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const type = $("#rule-type").value;
  const triggers = $("#rule-triggers").value.trim();
  const response = $("#rule-response").value.trim();
  $("#rule-error").textContent = "";

  if (!triggers || !response) {
    $("#rule-error").textContent = "Please fill in both fields.";
    return;
  }

  try {
    const res = await api("POST", "/api/rules", { type, triggers, response, enabled: true });
    rules.unshift(res.rule);
    renderRules();
    form.reset();
    form.classList.add("hidden");
  } catch (err) {
    $("#rule-error").textContent = err.message;
  }
});

// ─── Notes & Memory ─────────────────────────────────────────────────────────

let notes = [];
async function loadNotes() {
  const res = await api("GET", "/api/notes");
  notes = res.notes || [];
  renderNotes();
}

function renderNotes() {
  const container = $("#notes-list");
  if (notes.length === 0) {
    container.replaceChildren(el("div", "muted", "No notes stored yet. Use /note <text> on WhatsApp or add one above."));
    return;
  }
  container.replaceChildren(
    ...notes.map((n) => {
      const item = el("div", "rule-item");
      const info = el("div", "rule-content");
      info.append(el("div", "rule-triggers", n.content), el("div", "rule-resp", `${fmtTime(n.created_at)} · Chat: ${n.chat_id}`));
      const del = el("button", "danger small", "Delete");
      del.addEventListener("click", async () => {
        if (!confirm("Delete this note?")) return;
        await api("DELETE", `/api/notes?id=${n.id}`);
        notes = notes.filter((x) => x.id !== n.id);
        renderNotes();
      });
      item.append(info, del);
      return item;
    }),
  );
}

$("#new-note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#note-input");
  const content = input.value.trim();
  if (!content) return;
  const res = await api("POST", "/api/notes", { content, chatId: "dashboard" });
  notes.unshift(res.note);
  renderNotes();
  input.value = "";
});

// ─── Tasks & To-Dos ────────────────────────────────────────────────────────

let todos = [];
async function loadTodos() {
  const res = await api("GET", "/api/todos");
  todos = res.todos || [];
  renderTodos();
}

function renderTodos() {
  const container = $("#todos-list");
  if (todos.length === 0) {
    container.replaceChildren(el("div", "muted", "No tasks in your list. Use /todo <task> on WhatsApp or add one above."));
    return;
  }
  container.replaceChildren(
    ...todos.map((t) => {
      const item = el("div", `rule-item ${t.completed ? "disabled" : ""}`);
      const info = el("div", "rule-content");
      const title = el("div", "rule-triggers", `${t.completed ? "✓ " : "○ "} ${t.task}`);
      if (t.completed) title.style.textDecoration = "line-through";
      info.append(title, el("div", "rule-resp", `${fmtTime(t.created_at)} · Chat: ${t.chat_id}`));

      const ctrls = el("div", "rule-ctrls");
      const tog = el("button", "ghost small", t.completed ? "Mark Pending" : "Mark Done");
      tog.addEventListener("click", async () => {
        const next = !t.completed;
        await api("PATCH", "/api/todos", { id: t.id, completed: next });
        t.completed = next ? 1 : 0;
        renderTodos();
      });
      const del = el("button", "danger small", "Delete");
      del.addEventListener("click", async () => {
        if (!confirm("Delete this task?")) return;
        await api("DELETE", `/api/todos?id=${t.id}`);
        todos = todos.filter((x) => x.id !== t.id);
        renderTodos();
      });
      ctrls.append(tog, del);
      item.append(info, ctrls);
      return item;
    }),
  );
}

$("#new-todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#todo-input");
  const task = input.value.trim();
  if (!task) return;
  const res = await api("POST", "/api/todos", { task, chatId: "dashboard" });
  todos.unshift(res.todo);
  renderTodos();
  input.value = "";
});

// ─── Settings ────────────────────────────────────────────────────────────────

async function fillSettings() {
  if (!overview) await refreshOverview();
  const { settings: s, models } = overview;
  const f = $("#settings-form");
  $("#model-select").replaceChildren(...models.map((m) => Object.assign(el("option", null, m.label), { value: m.id })));
  f.enabled.checked = s.enabled;
  f.ownerName.value = s.ownerName;
  f.replyMode.value = s.replyMode;
  f.allowlist.value = s.allowlist.join("\n");
  f.groupsEnabled.checked = s.groupsEnabled;
  f.triggerWords.value = s.triggerWords.join(", ");
  f.model.value = s.model;
  f.historyLimit.value = s.historyLimit;
  f.maxReplyTokens.value = s.maxReplyTokens;
  f.temperature.value = s.temperature;
  f.extraInstructions.value = s.extraInstructions;
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (
    f.replyMode.value === "everyone" &&
    overview.settings.replyMode !== "everyone" &&
    !confirm("Nyra Rose will answer EVERYONE who messages you privately. Are you sure?")
  )
    return;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const { settings } = await api("PUT", "/api/settings", {
      enabled: f.enabled.checked,
      ownerName: f.ownerName.value,
      replyMode: f.replyMode.value,
      allowlist: f.allowlist.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
      groupsEnabled: f.groupsEnabled.checked,
      triggerWords: f.triggerWords.value.split(",").map((x) => x.trim()).filter(Boolean),
      model: f.model.value,
      historyLimit: Number(f.historyLimit.value),
      maxReplyTokens: Number(f.maxReplyTokens.value),
      temperature: Number(f.temperature.value),
      extraInstructions: f.extraInstructions.value,
    });
    overview.settings = settings;
    fillSettings();
    $("#settings-saved").textContent = "Saved ✓";
    setTimeout(() => ($("#settings-saved").textContent = ""), 2500);
  } catch (err) {
    $("#settings-saved").textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────

if (password) enterApp().catch(() => signOut());
else signOut();
