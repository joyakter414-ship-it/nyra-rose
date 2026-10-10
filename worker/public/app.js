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
    if (btn.dataset.tab === "bookings") loadBookings();
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
  const { gateway, usage, settings, models, role } = overview;
  const isClient = role === "client";

  // Role Badge in Topbar
  const roleBadge = $("#role-badge");
  if (roleBadge) {
    if (isClient) {
      roleBadge.textContent = "🌹 Manager Panel";
      roleBadge.style.background = "#be185d22";
      roleBadge.style.color = "#fb7185";
      roleBadge.style.border = "1px solid #be185d";
    } else {
      roleBadge.textContent = "👑 Admin";
      roleBadge.style.background = "#eab30822";
      roleBadge.style.color = "#facc15";
      roleBadge.style.border = "1px solid #ca8a04";
    }
  }

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

  // Neurons / AI Activity Card
  const neuronsTitle = $("#neurons-card-title");
  const neuronsBadge = $("#neurons-badge");
  const quotaWrap = $("#neurons-quota-wrap");
  const barWrap = $("#neurons-bar-wrap");
  const usageTable = $("#usage-table");
  const source = $("#neurons-source");
  const reqCaption = $("#requests-caption");

  if (isClient) {
    if (neuronsTitle) neuronsTitle.textContent = "AI Activity Today";
    if (neuronsBadge) neuronsBadge.classList.add("hidden");
    if (quotaWrap) quotaWrap.classList.add("hidden");
    if (barWrap) barWrap.classList.add("hidden");
    if (usageTable) usageTable.classList.add("hidden");

    const reqCount = fmtNum(usage?.today?.requests ?? 0);
    $("#neurons-today").textContent = reqCount;
    if (reqCaption) {
      reqCaption.innerHTML = `<span id="requests-today">${reqCount}</span> AI replies generated today · Always active 🌹`;
    }
    if (source) {
      source.textContent = "Powered by Nyra Rose Brain";
    }
  } else {
    if (neuronsTitle) neuronsTitle.textContent = "Neurons today";
    if (neuronsBadge) neuronsBadge.classList.remove("hidden");
    if (quotaWrap) quotaWrap.classList.remove("hidden");
    if (barWrap) barWrap.classList.remove("hidden");
    if (usageTable) usageTable.classList.remove("hidden");

    const todayUsed = usage?.today?.neurons ?? 0;
    const free = usage?.freePerDay ?? 10000;
    $("#neurons-today").textContent = fmtNum(todayUsed);
    $("#neurons-free").textContent = fmtNum(free);
    $("#neurons-bar").style.width = `${Math.min(100, (todayUsed / free) * 100)}%`;
    const reqCount = fmtNum(usage?.today?.requests ?? 0);
    if (reqCaption) {
      reqCaption.innerHTML = `<span id="requests-today">${reqCount}</span> inferences today · resets 00:00 UTC (6:00 AM Dhaka)`;
    }

    if (neuronsBadge) {
      if (usage?.isLive) {
        neuronsBadge.textContent = "🟢 Live Cloudflare";
        neuronsBadge.style.background = "#10b98122";
        neuronsBadge.style.color = "#34d399";
        neuronsBadge.style.border = "1px solid #059669";
      } else {
        neuronsBadge.textContent = "Local D1";
        neuronsBadge.style.background = "var(--panel-2)";
        neuronsBadge.style.color = "var(--muted)";
        neuronsBadge.style.border = "1px solid var(--line)";
      }
    }
    if (source) {
      source.textContent = usage?.accountWide
        ? "⚡ Live account total (Shared across Lady Jane, Nyra Rose & all Workers AI)"
        : "Local estimate from Nyra Rose";
    }

    const rows = $("#usage-rows");
    rows.replaceChildren(
      ...(usage?.recent || []).map((u) => {
        const tr = el("tr");
        tr.append(el("td", null, u.day), el("td", null, `${fmtNum(u.neurons)} neurons · ${fmtNum(u.requests)} inferences`));
        return tr;
      }),
    );
  }

  // Quick switches
  $("#quick-enabled").checked = Boolean(settings.enabled);
  $("#quick-mode").textContent = settings.replyMode;
  if (isClient) {
    $("#quick-model").textContent = settings.modelLabel || settings.model || "Nyra Rose Intelligence 🌹";
  } else {
    const m = (models || []).find((x) => x.id === settings.model);
    $("#quick-model").textContent = m ? m.label.split("—")[0].trim() : settings.model;
  }
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
  const showNeurons = overview?.role !== "client" && Boolean(m.neurons);
  const meta = el("div", "meta", `${m.sender_name || (m.role === "user" ? "You" : "Nyra Rose")} · ${fmtTime(m.created_at)}${showNeurons ? ` · ${m.neurons.toFixed(1)} neurons` : ""}`);
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
    ? 'Instant Reply Message <span class="muted">(Sent word-for-word instantly)</span>'
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

// ─── Booked Calls CRM ────────────────────────────────────────────────────────

let bookings = [];
let bookingStatusFilter = "all";
let bookingFollowupFilter = "all";
let bookingSearch = "";
let currentFollowupBookingId = null;

async function loadBookings() {
  const params = new URLSearchParams();
  if (bookingStatusFilter !== "all") params.set("status", bookingStatusFilter);
  if (bookingFollowupFilter !== "all") params.set("followup_type", bookingFollowupFilter);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await api("GET", `/api/bookings${qs}`);
  bookings = res.bookings || [];
  updateBookingStats();
  renderBookings();
}

function updateBookingStats() {
  const total = bookings.length;
  const activeLeads = bookings.filter(
    (b) =>
      b.status === "lead" ||
      ["auto_day1", "no_reply_3d", "long_term_30d", "client_date", "custom_timer"].includes(b.followup_type)
  ).length;
  const booked = bookings.filter((b) => b.status === "booked").length;
  const confirmed = bookings.filter((b) => b.status === "confirmed").length;
  const notAttended = bookings.filter((b) => b.status === "not_attended" || b.followup_type === "not_attended").length;
  const buySoon = bookings.filter((b) => b.status === "buy_soon" || b.followup_type === "buy_soon").length;
  const fakeLeads = bookings.filter((b) => b.status === "fake_lead").length;
  const notInterested = bookings.filter((b) => b.status === "not_interested" || b.followup_type === "rejected").length;

  const totalEl = $("#stat-bookings-total");
  const leadsEl = $("#stat-bookings-leads");
  const bookedEl = $("#stat-bookings-booked");
  const confirmedEl = $("#stat-bookings-confirmed");
  const notAttendedEl = $("#stat-bookings-not-attended");
  const buySoonEl = $("#stat-bookings-buy-soon");
  const fakeEl = $("#stat-bookings-fake");
  const notInterestedEl = $("#stat-bookings-not-interested");

  if (totalEl) totalEl.textContent = total;
  if (leadsEl) leadsEl.textContent = activeLeads;
  if (bookedEl) bookedEl.textContent = booked;
  if (confirmedEl) confirmedEl.textContent = confirmed;
  if (notAttendedEl) notAttendedEl.textContent = notAttended;
  if (buySoonEl) buySoonEl.textContent = buySoon;
  if (fakeEl) fakeEl.textContent = fakeLeads;
  if (notInterestedEl) notInterestedEl.textContent = notInterested;
}

const STATUS_LABELS = {
  lead: "🌱 New Lead",
  booked: "📅 Booked Call",
  confirmed: "✅ Confirmed",
  not_attended: "⚠️ Not Attended (Missed Call)",
  buy_soon: "⏳ Buy in Few Days",
  fake_lead: "🕵️ Fake Lead (30d No Reply)",
  not_interested: "🛑 Not Interested",
  completed: "🏆 Completed",
  cancelled: "❌ Cancelled",
};

const FOLLOWUP_LABELS = {
  auto_day1: "⚡ Day 1 Auto (3–4h)",
  no_reply_3d: "⏳ Next 3 Days (8h)",
  long_term_30d: "📆 3–30 Days (Daily → Fake)",
  client_date: "📅 Client Choice Date",
  custom_timer: "⏱️ Custom Timer",
  call_reminder: "🔔 30m Call Reminder",
  auto: "🤖 Smart AI Auto",
  rejected: "🛑 Rejected (No Follow-Up)",
  on_hold: "⏸️ On Hold",
  not_attended: "⚠️ Missed Call Reschedule",
  buy_soon: "⏳ Buying in Few Days",
  nurture: "💡 Value Nurture",
  custom: "🎯 Custom Strategy",
};

function getTzOffsetHours(tz) {
  const u = (tz || "").toUpperCase().trim();
  if (!u) return 6;
  const m = u.match(/(?:GMT|UTC)\s*([+-]\d{1,2})(?::(\d{2}))?/i);
  if (m) {
    const hrs = parseInt(m[1], 10);
    const mins = m[2] ? parseInt(m[2], 10) / 60 : 0;
    return hrs >= 0 ? hrs + mins : hrs - mins;
  }
  if (u.includes("AEDT")) return 11;
  if (u.includes("AEST") || u.includes("AUSTRAL")) return 10;
  if (u.includes("ACST")) return 9.5;
  if (u.includes("AWST")) return 8;
  if (u.includes("NZST")) return 12;
  if (u.includes("JST") || u.includes("KST")) return 9;
  if (u.includes("SGT") || u.includes("MYT") || u.includes("PHT") || u.includes("HKT")) return 8;
  if (u.includes("ICT") || u.includes("WIB")) return 7;
  if (u.includes("BDT") || u === "BD" || u.includes("DHAKA") || u.includes("BANGLADESH")) return 6;
  if (u.includes("IST") || u.includes("INDIA")) return 5.5;
  if (u.includes("PKT")) return 5;
  if (u.includes("GST") || u.includes("UAE") || u.includes("DUBAI")) return 4;
  if (u.includes("AST") || u.includes("TRT") || u.includes("EAT")) return 3;
  if (u.includes("EET") || u.includes("SAST")) return 2;
  if (u.includes("CET") || u.includes("WAT")) return 1;
  if (u === "GMT" || u === "UTC" || u.includes("UK") || u.includes("WET")) return 0;
  if (u.includes("BRT") || u.includes("ART")) return -3;
  if (u === "EDT") return -4;
  if (u === "EST" || u === "CDT" || u.includes("COT")) return -5;
  if (u === "CST" || u === "MDT") return -6;
  if (u === "MST" || u === "PDT") return -7;
  if (u === "PST") return -8;
  return 6;
}

function fmtTimeInBookingTz(ms, tz) {
  if (!tz) return fmtTime(ms);
  const offsetHours = getTzOffsetHours(tz);
  const localMs = ms + offsetHours * 3600 * 1000;
  const d = new Date(localMs);
  let h = d.getUTCHours();
  const min = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${h}:${String(min).padStart(2, "0")} ${ampm} ${tz.toUpperCase()}`;
}

function formatNextFollowupTimer(b) {
  const fType = b.followup_type || "auto";
  if (fType === "rejected" || b.status === "not_interested" || b.status === "cancelled" || b.status === "completed") {
    return "🛑 Follow-Up Stopped";
  }
  if (b.status === "fake_lead") {
    return "🕵️ Fake Lead (30d No Reply — Stopped)";
  }
  const now = Date.now();
  const isCallReminder = fType === "call_reminder" || b.status === "booked" || b.status === "confirmed";
  if (isCallReminder && b.call_time_ms && b.call_time_ms <= now) {
    return `⏰ Call Time Passed (${fmtTimeInBookingTz(b.call_time_ms, b.timezone)})`;
  }
  if (!b.next_followup_at) {
    if (isCallReminder) {
      if (b.call_time_ms && b.call_time_ms > now) {
        return `🔔 Call at ${fmtTimeInBookingTz(b.call_time_ms, b.timezone)}`;
      }
      return "🔔 Call Booked (Sales Follow-Up Stopped)";
    }
    return "⏱️ No Timer Set";
  }
  const diffMs = b.next_followup_at - now;
  const prefix = isCallReminder ? "🔔 30m Call Reminder" : "⏱️ Next Follow-Up";
  const tzTimeStr = fmtTimeInBookingTz(b.next_followup_at, b.timezone);
  if (diffMs <= 0) {
    return `${prefix}: Due Now (${tzTimeStr})`;
  }
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) {
    return `${prefix}: ${tzTimeStr} (in ${mins}m)`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 48) {
    return `${prefix}: ${tzTimeStr} (in ${hours}h${remMins > 0 ? ` ${remMins}m` : ""})`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${prefix}: ${tzTimeStr} (in ${days}d${remHours > 0 ? ` ${remHours}h` : ""})`;
}

function renderBookings() {
  const container = $("#bookings-list");
  if (!container) return;
  let filtered = bookings;

  if (bookingSearch.trim()) {
    const q = bookingSearch.toLowerCase().trim();
    filtered = filtered.filter((b) =>
      (b.client_name && b.client_name.toLowerCase().includes(q)) ||
      (b.email && b.email.toLowerCase().includes(q)) ||
      (b.phone && b.phone.toLowerCase().includes(q)) ||
      (b.scheduled_at && b.scheduled_at.toLowerCase().includes(q)) ||
      (b.timezone && b.timezone.toLowerCase().includes(q)) ||
      (b.company_or_website && b.company_or_website.toLowerCase().includes(q)) ||
      (b.requirements && b.requirements.toLowerCase().includes(q)) ||
      (b.notes && b.notes.toLowerCase().includes(q)) ||
      (b.followup_type && b.followup_type.toLowerCase().includes(q))
    );
  }

  const countLabel = $("#bookings-count-label");
  if (countLabel) {
    countLabel.textContent = `Showing ${filtered.length} of ${bookings.length} lead${bookings.length === 1 ? "" : "s"}`;
  }

  if (filtered.length === 0) {
    container.replaceChildren(
      el(
        "div",
        "muted",
        bookings.length === 0
          ? "No leads recorded yet. Nyra will automatically gather lead details from WhatsApp or Web Chat!"
          : "No leads match your search query."
      )
    );
    return;
  }

  container.replaceChildren(
    ...filtered.map((b) => {
      const item = el("div", "booking-item");
      const fType = b.followup_type || "auto";
      const isRejected = fType === "rejected" || b.status === "not_interested" || b.status === "fake_lead";

      // Top row: Title + badges + live timer badge
      const top = el("div", "booking-top");
      const clientTitle = el("div", "booking-client-title");
      clientTitle.style.flexWrap = "wrap";
      clientTitle.append(
        el("span", null, "👤 " + (b.client_name || "Lead Client")),
        el("span", `badge badge-${b.status || "booked"}`, STATUS_LABELS[b.status] || b.status),
        el("span", `badge badge-${fType}`, FOLLOWUP_LABELS[fType] || fType),
        el("span", "badge badge-timer", formatNextFollowupTimer(b)),
        el("span", "badge badge-source", b.source === "dashboard" ? "MANUAL" : "WHATSAPP")
      );
      top.appendChild(clientTitle);

      // Contact row (Email, WhatsApp, Timezone, Website)
      const contactRow = el("div", "booking-contact-row");
      if (b.email) {
        const emailLink = document.createElement("a");
        emailLink.className = "booking-link-pill";
        emailLink.href = `mailto:${b.email}`;
        emailLink.textContent = `✉️ ${b.email}`;
        contactRow.appendChild(emailLink);
      }
      if (b.phone || (b.chat_id && b.chat_id.includes("@"))) {
        const cleanPhone = (b.phone || b.chat_id.split("@")[0]).replace(/[^0-9]/g, "");
        if (cleanPhone) {
          const waLink = document.createElement("a");
          waLink.className = "booking-link-pill";
          waLink.href = `https://wa.me/${cleanPhone}`;
          waLink.target = "_blank";
          waLink.rel = "noopener noreferrer";
          waLink.textContent = `💬 WhatsApp (+${cleanPhone})`;
          contactRow.appendChild(waLink);
        }
      }
      if (b.timezone) {
        contactRow.appendChild(el("span", "booking-link-pill", `🌐 Timezone: ${b.timezone}`));
      }
      if (b.company_or_website) {
        const webLink = document.createElement("a");
        webLink.className = "booking-link-pill";
        webLink.href = b.company_or_website.startsWith("http") ? b.company_or_website : `https://${b.company_or_website}`;
        webLink.target = "_blank";
        webLink.rel = "noopener noreferrer";
        webLink.textContent = `🔗 ${b.company_or_website}`;
        contactRow.appendChild(webLink);
      }

      // Scheduled time banner
      let schedBox = null;
      if (b.scheduled_at) {
        const isCall = b.status === "booked" || b.status === "confirmed" || fType === "call_reminder";
        const isPastCall = isCall && b.call_time_ms && b.call_time_ms <= Date.now();
        const tzSuffix = b.timezone && !b.scheduled_at.toUpperCase().includes(b.timezone.toUpperCase()) ? ` (${b.timezone})` : "";
        schedBox = el(
          "div",
          "booking-scheduled-box",
          `${isCall ? "📅 Booked Call Time" : "📅 Client Follow-Up Date"}: ${b.scheduled_at}${tzSuffix}${
            isPastCall
              ? " · ⏰ Call Time Passed (Update status or reschedule if needed)"
              : isCall
              ? " · 🔔 Auto 30m Pre-Call Reminder Active (Sales Follow-Ups Paused)"
              : ""
          }`
        );
      }

      // Status & 4-Stage Guidance Banner
      let statusGuidance = null;
      if (b.status === "fake_lead") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          "🕵️ FAKE LEAD (30 Days No Reply): Client did not reply for 30 days across all follow-up stages. Automatically marked as Fake Lead and all follow-ups stopped."
        );
        statusGuidance.style.borderLeftColor = "#e11d48";
        statusGuidance.style.background = "#2a151b";
      } else if (fType === "rejected" || b.status === "not_interested") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          "🛑 Lead marked as REJECTED / NO FOLLOW-UP. All sales follow-ups and automated messages are strictly stopped."
        );
        statusGuidance.style.borderLeftColor = "#ef4444";
        statusGuidance.style.background = "#2a151b";
      } else if (fType === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          "🔔 CALL BOOKED: Nyra will NOT send sales follow-ups. She only sends a 30-minute meeting reminder before the call (and auto-updates the timer if the client reschedules)."
        );
        statusGuidance.style.borderLeftColor = "#eab308";
      } else if (fType === "auto_day1") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          "⚡ Stage 1 (Day 1 Auto Follow-Up): Following up every 3–4 hours during the first 24 hours until a call is booked. Advances to 3-Day (8h) stage if no reply after 24h."
        );
        statusGuidance.style.borderLeftColor = "#a855f7";
      } else if (fType === "no_reply_3d") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          "⏳ Stage 2 (Next 3 Days No-Reply): Client did not book on Day 1. Following up every 8 hours for 3 days. Advances to 30-Day stage if still no reply."
        );
        statusGuidance.style.borderLeftColor = "#f59e0b";
      } else if (fType === "long_term_30d") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          "📆 Stage 3 (3 to 30 Days No-Reply): Following up once every 24 hours up to Day 30. If no reply after 30 days, automatically converts to 🕵️ Fake Lead."
        );
        statusGuidance.style.borderLeftColor = "#ec4899";
      } else if (fType === "client_date") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          `📅 Type 4 (Client Choice Date): Client asked to be contacted on ${b.scheduled_at || "their chosen date"}. Nyra will follow up on that day.`
        );
        statusGuidance.style.borderLeftColor = "#06b6d4";
      } else if (fType === "custom_timer") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          `⏱️ Custom Management Timer: Scheduled to send follow-up ${b.followup_interval_hours ? `every ${b.followup_interval_hours}h` : "at custom time"}.`
        );
        statusGuidance.style.borderLeftColor = "#10b981";
      } else if (fType === "on_hold") {
        statusGuidance = el("div", "booking-notes-box", "⏸️ Lead is on hold. Gentle periodic check-in when ready to unpause video editing.");
        statusGuidance.style.borderLeftColor = "#f59e0b";
      } else if (fType === "not_attended" || b.status === "not_attended") {
        statusGuidance = el("div", "booking-notes-box", "⚠️ Client missed scheduled call. Empathetic follow-up every 24h to reschedule without pressure.");
        statusGuidance.style.borderLeftColor = "#f87171";
      } else if (fType === "buy_soon" || b.status === "buy_soon") {
        statusGuidance = el("div", "booking-notes-box", "⏳ Client is deciding / buying in a few days. Closing follow-up on packages and decision timeline.");
        statusGuidance.style.borderLeftColor = "#38bdf8";
      } else if (fType === "nurture") {
        statusGuidance = el("div", "booking-notes-box", "💡 Value nurture. Sharing portfolio examples (https://vidmox.pages.dev/portfolio) and video samples.");
        statusGuidance.style.borderLeftColor = "#c084fc";
      }

      // Requirements
      let reqsBox = null;
      if (b.requirements) {
        reqsBox = el("div", "rule-content");
        reqsBox.append(
          el("span", "rule-triggers", "🎬 Video Scope / Goals: "),
          el("span", "muted", b.requirements)
        );
      }

      // Notes
      let notesBox = null;
      if (b.notes) {
        notesBox = el("div", "booking-notes-box", `📝 Notes: ${b.notes}`);
      }

      // Bottom actions
      const actions = el("div", "booking-actions");
      const loggedInfo = el(
        "div",
        "muted small-text",
        `Logged: ${fmtTime(b.created_at)} · Follow-ups sent: ${b.followup_count || 0}${b.last_followup_at ? ` (Last: ${fmtTime(b.last_followup_at)})` : ""}`
      );

      const rightControls = el("div", "rule-ctrls");
      rightControls.style.flexWrap = "wrap";
      rightControls.style.gap = "8px";

      // Quick Timer Dropdown ("Set how much time later follow-up sent")
      const timerSelect = document.createElement("select");
      timerSelect.className = "small";
      timerSelect.style.width = "auto";
      timerSelect.style.margin = "0";
      [
        { val: "", label: "⏱️ Set Follow-Up Timer…" },
        { val: "0.5", label: "⏱️ Send 30 Min Later" },
        { val: "2", label: "⏱️ Send 2 Hours Later" },
        { val: "3.5", label: "⚡ Send 3.5h Later (Day 1 Auto)" },
        { val: "8", label: "⏳ Send 8h Later (3-Day Auto)" },
        { val: "24", label: "📆 Send 1 Day Later (24h)" },
        { val: "48", label: "📆 Send 2 Days Later (48h)" },
        { val: "72", label: "📆 Send 3 Days Later (72h)" },
      ].forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.val;
        o.textContent = opt.label;
        timerSelect.appendChild(o);
      });

      timerSelect.addEventListener("change", async () => {
        const hours = Number(timerSelect.value);
        if (!hours) return;
        const nextType = hours === 3.5 ? "auto_day1" : hours === 8 ? "no_reply_3d" : "custom_timer";
        const res = await api("PATCH", "/api/bookings", {
          id: b.id,
          delayHours: hours,
          followup_type: nextType,
        });
        if (res.booking) {
          Object.assign(b, res.booking);
        }
        updateBookingStats();
        renderBookings();
      });

      // Follow-up Strategy Dropdown Selector
      const followupSelect = document.createElement("select");
      followupSelect.className = "small";
      followupSelect.style.width = "auto";
      followupSelect.style.margin = "0";
      [
        { val: "auto_day1", label: "Stage: ⚡ Day 1 Auto (3–4h)" },
        { val: "no_reply_3d", label: "Stage: ⏳ Next 3 Days (8h)" },
        { val: "long_term_30d", label: "Stage: 📆 3–30 Days (Daily)" },
        { val: "client_date", label: "Stage: 📅 Client Choice Date" },
        { val: "custom_timer", label: "Stage: ⏱️ Custom Timer" },
        { val: "call_reminder", label: "Stage: 🔔 30m Call Reminder" },
        { val: "rejected", label: "Stage: 🛑 Rejected (Stop)" },
        { val: "on_hold", label: "Stage: ⏸️ On Hold" },
        { val: "not_attended", label: "Stage: ⚠️ Missed Call" },
        { val: "buy_soon", label: "Stage: ⏳ Buy in Few Days" },
        { val: "nurture", label: "Stage: 💡 Nurture (Portfolio)" },
        { val: "auto", label: "Stage: 🤖 Smart AI Auto" },
      ].forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.val;
        o.textContent = opt.label;
        if (opt.val === fType) o.selected = true;
        followupSelect.appendChild(o);
      });

      followupSelect.addEventListener("change", async () => {
        const nextStrategy = followupSelect.value;
        const res = await api("PATCH", "/api/bookings", { id: b.id, followup_type: nextStrategy });
        if (res.booking) Object.assign(b, res.booking);
        else b.followup_type = nextStrategy;
        updateBookingStats();
        renderBookings();
      });

      // Lead Status Dropdown Selector
      const statusSelect = document.createElement("select");
      statusSelect.className = "small";
      statusSelect.style.width = "auto";
      statusSelect.style.margin = "0";
      [
        { val: "lead", label: "Status: 🌱 New Lead" },
        { val: "booked", label: "Status: 📅 Booked Call" },
        { val: "confirmed", label: "Status: ✅ Confirmed" },
        { val: "not_attended", label: "Status: ⚠️ Not Attended" },
        { val: "buy_soon", label: "Status: ⏳ Buy in Few Days" },
        { val: "fake_lead", label: "Status: 🕵️ Fake Lead (30d)" },
        { val: "not_interested", label: "Status: 🛑 Not Interested" },
        { val: "completed", label: "Status: 🏆 Completed" },
        { val: "cancelled", label: "Status: ❌ Cancelled" },
      ].forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.val;
        o.textContent = opt.label;
        if (opt.val === b.status) o.selected = true;
        statusSelect.appendChild(o);
      });

      statusSelect.addEventListener("change", async () => {
        const newStatus = statusSelect.value;
        const res = await api("PATCH", "/api/bookings", { id: b.id, status: newStatus });
        if (res.booking) Object.assign(b, res.booking);
        else b.status = newStatus;
        updateBookingStats();
        renderBookings();
      });

      // Follow-up button
      const followupBtn = el("button", "small");
      if (isRejected) {
        followupBtn.textContent = b.status === "fake_lead" ? "🕵️ Fake Lead" : "🛑 Stopped";
        followupBtn.style.background = "#2a151b";
        followupBtn.style.color = "#f87171";
        followupBtn.style.border = "1px solid #ef444455";
      } else if (fType === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
        followupBtn.textContent = "🔔 30m Reminder / Timer";
        followupBtn.style.background = "#ca8a04";
        followupBtn.style.color = "#fff";
      } else {
        followupBtn.textContent = "⚡ Follow Up & Timer";
        followupBtn.style.background = fType === "not_attended" || b.status === "not_attended"
          ? "#ef4444"
          : fType === "buy_soon" || b.status === "buy_soon"
          ? "#0284c7"
          : fType === "on_hold"
          ? "#d97706"
          : fType === "nurture"
          ? "#7c3aed"
          : "var(--rose-dark)";
        followupBtn.style.color = "#fff";
        followupBtn.style.border = "1px solid var(--line)";
      }
      followupBtn.addEventListener("click", () => openFollowupModal(b));

      const delBtn = el("button", "danger small", "Delete");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete booking record for ${b.client_name || b.email || "this client"}?`)) return;
        await api("DELETE", `/api/bookings?id=${b.id}`);
        bookings = bookings.filter((x) => x.id !== b.id);
        updateBookingStats();
        renderBookings();
      });

      rightControls.append(followupBtn, timerSelect, followupSelect, statusSelect, delBtn);
      actions.append(loggedInfo, rightControls);

      item.append(top, contactRow);
      if (schedBox) item.appendChild(schedBox);
      if (statusGuidance) item.appendChild(statusGuidance);
      if (reqsBox) item.appendChild(reqsBox);
      if (notesBox) item.appendChild(notesBox);
      item.appendChild(actions);

      return item;
    })
  );
}

// Follow-up Composer Modal
async function openFollowupModal(b) {
  currentFollowupBookingId = b.id;
  const modal = $("#followup-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.style.display = "grid";

  const fType = b.followup_type || "auto";
  const modalStrategySelect = $("#modal-followup-type");
  if (modalStrategySelect) {
    modalStrategySelect.value = fType;
  }

  const timerBadge = $("#modal-next-followup-badge");
  if (timerBadge) {
    timerBadge.textContent = formatNextFollowupTimer(b);
  }

  $("#followup-modal-title").textContent = `⚡ Follow-Up & Timer: ${b.client_name || "Lead"}`;
  $("#followup-modal-subtitle").textContent = `Phone: ${b.phone || "Not set"} · Status: ${STATUS_LABELS[b.status] || b.status} · Stage: ${FOLLOWUP_LABELS[fType] || fType}`;
  $("#followup-text").value = "Generating tailored message...";
  $("#followup-feedback").textContent = "";

  updateModalAlert(b);

  try {
    const res = await api("POST", "/api/bookings/followup", { id: b.id });
    $("#followup-text").value = res.message;
    const sendBtn = $("#followup-send-wa-btn");
    if (res.waLink) {
      sendBtn.href = res.waLink;
      sendBtn.style.display = "inline-flex";
    } else {
      sendBtn.style.display = "none";
    }
  } catch (err) {
    $("#followup-text").value = err.message.includes("disabled")
      ? `[Follow-up Stopped]: ${err.message}`
      : `Failed to generate message: ${err.message}`;
    $("#followup-send-wa-btn").style.display = "none";
  }
}

function updateModalAlert(b) {
  const alertBox = $("#followup-status-alert");
  if (!alertBox) return;
  const fType = b.followup_type || "auto";
  if (b.status === "fake_lead") {
    alertBox.textContent = "🕵️ Fake Lead (30 days no reply). Automated follow-ups are stopped.";
    alertBox.style.background = "#e11d4822";
    alertBox.style.color = "#fda4af";
  } else if (fType === "rejected" || b.status === "not_interested") {
    alertBox.textContent = "🛑 Lead marked as Rejected / Not Interested. All sales outreach is stopped.";
    alertBox.style.background = "#ef444422";
    alertBox.style.color = "#f87171";
  } else if (fType === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
    alertBox.textContent = "🔔 Call is Booked! Sales follow-ups are OFF. Nyra only sends a 30-minute meeting reminder before the call (auto-updates if rescheduled).";
    alertBox.style.background = "#eab30822";
    alertBox.style.color = "#facc15";
  } else if (fType === "auto_day1") {
    alertBox.textContent = "⚡ Stage 1 (Day 1 Auto): Sends follow-up every 3–4 hours until a call is booked.";
    alertBox.style.background = "#8b5cf622";
    alertBox.style.color = "#c4b5fd";
  } else if (fType === "no_reply_3d") {
    alertBox.textContent = "⏳ Stage 2 (Next 3 Days No-Reply): Sends follow-up every 8 hours for 3 days.";
    alertBox.style.background = "#f59e0b22";
    alertBox.style.color = "#fbbf24";
  } else if (fType === "long_term_30d") {
    alertBox.textContent = "📆 Stage 3 (3–30 Days No-Reply): Sends follow-up every 24h until Day 30, then marks Fake Lead.";
    alertBox.style.background = "#ec489922";
    alertBox.style.color = "#f472b6";
  } else if (fType === "client_date") {
    alertBox.textContent = `📅 Type 4 (Client Choice Date): Scheduled for client's requested date (${b.scheduled_at || "set date"}).`;
    alertBox.style.background = "#06b6d422";
    alertBox.style.color = "#22d3ee";
  } else if (fType === "custom_timer") {
    alertBox.textContent = "⏱️ Custom Management Timer active.";
    alertBox.style.background = "#10b98122";
    alertBox.style.color = "#34d399";
  } else if (fType === "on_hold") {
    alertBox.textContent = "⏸️ Lead is on hold. This message gently checks in if they are ready to unpause.";
    alertBox.style.background = "#f59e0b22";
    alertBox.style.color = "#fbbf24";
  } else if (fType === "not_attended" || b.status === "not_attended") {
    alertBox.textContent = "⚠️ Lead missed scheduled call. This message offers a warm, guilt-free reschedule.";
    alertBox.style.background = "#ef444422";
    alertBox.style.color = "#f87171";
  } else if (fType === "buy_soon" || b.status === "buy_soon") {
    alertBox.textContent = "⏳ Lead is deciding / buying soon. This message checks in on their decision timeline.";
    alertBox.style.background = "#0284c722";
    alertBox.style.color = "#38bdf8";
  } else if (fType === "nurture") {
    alertBox.textContent = "💡 Lead is exploring. This message shares portfolio samples from vidmox.pages.dev/portfolio.";
    alertBox.style.background = "#8b5cf622";
    alertBox.style.color = "#c084fc";
  } else {
    alertBox.textContent = "📅 Dynamic lead follow-up message based on current status.";
    alertBox.style.background = "#120c15";
    alertBox.style.color = "var(--text)";
  }
}

// Preset Timer Buttons inside Modal (30m, 2h, 3.5h, 8h, 1d, 2d, 3d)
document.querySelectorAll(".timer-preset-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!currentFollowupBookingId) return;
    const hours = Number(btn.dataset.hours);
    if (!hours) return;
    const nextType = hours === 3.5 ? "auto_day1" : hours === 8 ? "no_reply_3d" : "custom_timer";
    try {
      const res = await api("PATCH", "/api/bookings", {
        id: currentFollowupBookingId,
        delayHours: hours,
        followup_type: nextType,
      });
      const found = bookings.find((x) => x.id === currentFollowupBookingId);
      if (found && res.booking) {
        Object.assign(found, res.booking);
        const modalStrategySelect = $("#modal-followup-type");
        if (modalStrategySelect) modalStrategySelect.value = found.followup_type;
        const timerBadge = $("#modal-next-followup-badge");
        if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
        updateModalAlert(found);
        renderBookings();
      }
      $("#followup-feedback").textContent = `⏱️ Timer set! Next auto follow-up will send in ${hours} hour(s) ✓`;
    } catch (err) {
      $("#followup-feedback").textContent = `Error setting timer: ${err.message}`;
    }
  });
});

// Exact Date/Time Picker inside Modal
$("#modal-save-datetime-btn")?.addEventListener("click", async () => {
  if (!currentFollowupBookingId) return;
  const val = $("#modal-custom-datetime")?.value;
  if (!val) {
    $("#followup-feedback").textContent = "Please pick a date and time first.";
    return;
  }
  const ts = Date.parse(val);
  if (Number.isNaN(ts)) {
    $("#followup-feedback").textContent = "Invalid date/time.";
    return;
  }
  try {
    const res = await api("PATCH", "/api/bookings", {
      id: currentFollowupBookingId,
      customFollowupAt: ts,
      followup_type: "client_date",
      scheduled_at: new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
    });
    const found = bookings.find((x) => x.id === currentFollowupBookingId);
    if (found && res.booking) {
      Object.assign(found, res.booking);
      const modalStrategySelect = $("#modal-followup-type");
      if (modalStrategySelect) modalStrategySelect.value = found.followup_type;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
      updateModalAlert(found);
      renderBookings();
    }
    $("#followup-feedback").textContent = `📅 Scheduled follow-up for ${fmtTime(ts)} ✓`;
  } catch (err) {
    $("#followup-feedback").textContent = `Error: ${err.message}`;
  }
});

// Modal Strategy Switcher listener
$("#modal-followup-type")?.addEventListener("change", async (e) => {
  if (!currentFollowupBookingId) return;
  const newType = e.target.value;
  const found = bookings.find((x) => x.id === currentFollowupBookingId);
  if (found) {
    found.followup_type = newType;
    updateModalAlert(found);
  }
  $("#followup-text").value = "Regenerating message for selected strategy...";
  try {
    const res = await api("POST", "/api/bookings/followup", {
      id: currentFollowupBookingId,
      followupType: newType,
    });
    $("#followup-text").value = res.message;
    if (found && res.nextFollowupAt !== undefined) {
      found.next_followup_at = res.nextFollowupAt;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
    }
    const sendBtn = $("#followup-send-wa-btn");
    if (res.waLink) {
      sendBtn.href = res.waLink;
      sendBtn.style.display = "inline-flex";
    } else {
      sendBtn.style.display = "none";
    }
    renderBookings();
  } catch (err) {
    $("#followup-text").value = `[Follow-up Stopped]: ${err.message}`;
    $("#followup-send-wa-btn").style.display = "none";
    renderBookings();
  }
});

$("#close-followup-modal")?.addEventListener("click", () => {
  const modal = $("#followup-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
  currentFollowupBookingId = null;
});

$("#followup-copy-btn")?.addEventListener("click", () => {
  const text = $("#followup-text").value;
  navigator.clipboard.writeText(text);
  $("#followup-feedback").textContent = "Copied to clipboard ✓";
  setTimeout(() => ($("#followup-feedback").textContent = ""), 2500);
});

// Send Now via Nyra WhatsApp Gateway
$("#followup-send-gateway-btn")?.addEventListener("click", async () => {
  if (!currentFollowupBookingId) return;
  const btn = $("#followup-send-gateway-btn");
  if (btn) btn.disabled = true;
  $("#followup-feedback").textContent = "Queuing message to Nyra's WhatsApp Gateway…";
  try {
    const res = await api("POST", "/api/bookings/followup", {
      id: currentFollowupBookingId,
      markSent: true,
      sendViaGateway: true,
    });
    const found = bookings.find((x) => x.id === currentFollowupBookingId);
    if (found) {
      found.followup_count = res.followupCount;
      found.last_followup_at = res.lastFollowupAt;
      found.next_followup_at = res.nextFollowupAt;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
      renderBookings();
    }
    $("#followup-feedback").textContent = `🚀 Queued to Nyra WhatsApp! Will deliver on next gateway heartbeat (≤30s). Total sent: ${res.followupCount} ✓`;
  } catch (err) {
    $("#followup-feedback").textContent = `Error: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

$("#followup-mark-sent-btn")?.addEventListener("click", async () => {
  if (!currentFollowupBookingId) return;
  try {
    const res = await api("POST", "/api/bookings/followup", {
      id: currentFollowupBookingId,
      markSent: true,
    });
    const found = bookings.find((x) => x.id === currentFollowupBookingId);
    if (found) {
      found.followup_count = res.followupCount;
      found.last_followup_at = res.lastFollowupAt;
      found.next_followup_at = res.nextFollowupAt;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
      renderBookings();
    }
    $("#followup-feedback").textContent = `Marked as sent & advanced timer! Total follow-ups: ${res.followupCount} ✓`;
  } catch (err) {
    $("#followup-feedback").textContent = `Error: ${err.message}`;
  }
});

// Bookings form & control bindings
$("#toggle-add-booking-btn")?.addEventListener("click", () => {
  $("#new-booking-form")?.classList.toggle("hidden");
});

$("#cancel-booking-btn")?.addEventListener("click", () => {
  $("#new-booking-form")?.classList.add("hidden");
});

$("#refresh-bookings-btn")?.addEventListener("click", () => {
  loadBookings();
});

$("#bookings-search")?.addEventListener("input", (e) => {
  bookingSearch = e.target.value;
  renderBookings();
});

$("#bookings-filter-status")?.addEventListener("change", (e) => {
  bookingStatusFilter = e.target.value;
  loadBookings();
});

$("#bookings-filter-followup")?.addEventListener("change", (e) => {
  bookingFollowupFilter = e.target.value;
  loadBookings();
});

$("#new-booking-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const clientName = $("#booking-client-name").value.trim();
  const email = $("#booking-email").value.trim();
  const phone = $("#booking-phone").value.trim();
  const scheduledAt = $("#booking-scheduled").value.trim();
  const timezone = $("#booking-timezone").value.trim();
  const companyOrWebsite = $("#booking-website").value.trim();
  const requirements = $("#booking-reqs").value.trim();
  const status = $("#booking-status").value;
  const followupType = $("#booking-followup-type")?.value || "auto_day1";
  const delayVal = $("#booking-delay-hours")?.value;
  const delayHours = delayVal ? Number(delayVal) : undefined;
  const notes = $("#booking-notes").value.trim();

  if (!email && !phone && !clientName) {
    $("#booking-error").textContent = "Please provide at least a name, email, or phone.";
    return;
  }
  $("#booking-error").textContent = "";

  try {
    const res = await api("POST", "/api/bookings", {
      clientName,
      email,
      phone,
      scheduledAt,
      timezone,
      companyOrWebsite,
      requirements,
      status,
      followupType,
      delayHours,
      notes,
      source: "dashboard",
    });
    bookings.unshift(res.booking);
    updateBookingStats();
    renderBookings();
    $("#new-booking-form").reset();
    $("#new-booking-form").classList.add("hidden");
  } catch (err) {
    $("#booking-error").textContent = err.message || "Failed to save booking";
  }
});

// ─── Settings ────────────────────────────────────────────────────────────────

async function fillSettings() {
  if (!overview) await refreshOverview();
  const { settings: s, models, role } = overview;
  const isClient = role === "client";
  const f = $("#settings-form");

  const adminModelGroup = $("#admin-model-group");
  const clientModelGroup = $("#client-model-group");
  const clientModelDisplay = $("#client-model-display");
  const adminOnlyFieldset = $("#admin-only-fieldset");

  if (isClient) {
    if (adminModelGroup) adminModelGroup.classList.add("hidden");
    if (clientModelGroup) clientModelGroup.classList.remove("hidden");
    if (clientModelDisplay) clientModelDisplay.value = s.modelLabel || s.model || "Nyra Rose Intelligence 🌹";
    if (adminOnlyFieldset) adminOnlyFieldset.classList.add("hidden");
  } else {
    if (adminModelGroup) adminModelGroup.classList.remove("hidden");
    if (clientModelGroup) clientModelGroup.classList.add("hidden");
    if (adminOnlyFieldset) adminOnlyFieldset.classList.remove("hidden");

    $("#model-select").replaceChildren(...(models || []).map((m) => Object.assign(el("option", null, m.label), { value: m.id })));
    if (f.model) f.model.value = s.model;
    if (f.publicModelName) f.publicModelName.value = s.publicModelName || "";
    if (f.clientPassword) f.clientPassword.value = s.clientPassword || "";
  }

  f.enabled.checked = Boolean(s.enabled);
  f.ownerName.value = s.ownerName || "";
  f.replyMode.value = s.replyMode || "self";
  f.allowlist.value = (s.allowlist || []).join("\n");
  f.groupsEnabled.checked = Boolean(s.groupsEnabled);
  f.triggerWords.value = (s.triggerWords || []).join(", ");
  f.historyLimit.value = s.historyLimit ?? 10;
  f.maxReplyTokens.value = s.maxReplyTokens ?? 350;
  f.temperature.value = s.temperature ?? 0.7;
  f.extraInstructions.value = s.extraInstructions || "";
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (
    f.replyMode.value === "everyone" &&
    overview?.settings?.replyMode !== "everyone" &&
    !confirm("Nyra Rose will answer EVERYONE who messages you privately. Are you sure?")
  )
    return;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const isClient = overview?.role === "client";
    const payload = {
      enabled: f.enabled.checked,
      ownerName: f.ownerName.value,
      replyMode: f.replyMode.value,
      allowlist: f.allowlist.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
      groupsEnabled: f.groupsEnabled.checked,
      triggerWords: f.triggerWords.value.split(",").map((x) => x.trim()).filter(Boolean),
      historyLimit: Number(f.historyLimit.value),
      maxReplyTokens: Number(f.maxReplyTokens.value),
      temperature: Number(f.temperature.value),
      extraInstructions: f.extraInstructions.value,
    };

    if (!isClient) {
      if (f.model) payload.model = f.model.value;
      if (f.publicModelName) payload.publicModelName = f.publicModelName.value;
      if (f.clientPassword) payload.clientPassword = f.clientPassword.value;
    }

    const { settings } = await api("PUT", "/api/settings", payload);
    overview.settings = { ...overview.settings, ...settings };
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
