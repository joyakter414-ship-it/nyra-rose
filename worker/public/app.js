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
let bookingSearch = "";

async function loadBookings() {
  const statusParam = bookingStatusFilter !== "all" ? `?status=${encodeURIComponent(bookingStatusFilter)}` : "";
  const res = await api("GET", `/api/bookings${statusParam}`);
  bookings = res.bookings || [];
  updateBookingStats();
  renderBookings();
}

function updateBookingStats() {
  const total = bookings.length;
  const pending = bookings.filter((b) => b.status === "booked" || b.status === "pending").length;
  const confirmed = bookings.filter((b) => b.status === "confirmed").length;
  const completed = bookings.filter((b) => b.status === "completed").length;

  const totalEl = $("#stat-bookings-total");
  const pendingEl = $("#stat-bookings-pending");
  const confirmedEl = $("#stat-bookings-confirmed");
  const completedEl = $("#stat-bookings-completed");

  if (totalEl) totalEl.textContent = total;
  if (pendingEl) pendingEl.textContent = pending;
  if (confirmedEl) confirmedEl.textContent = confirmed;
  if (completedEl) completedEl.textContent = completed;
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
      (b.requirements && b.requirements.toLowerCase().includes(q)) ||
      (b.notes && b.notes.toLowerCase().includes(q))
    );
  }

  const countLabel = $("#bookings-count-label");
  if (countLabel) {
    countLabel.textContent = `Showing ${filtered.length} of ${bookings.length} call${bookings.length === 1 ? "" : "s"}`;
  }

  if (filtered.length === 0) {
    container.replaceChildren(
      el(
        "div",
        "muted",
        bookings.length === 0
          ? "No calls recorded yet. Nyra Rose will automatically record leads whenever someone shares their email or call time on WhatsApp or Web Chat!"
          : "No bookings match your search query."
      )
    );
    return;
  }

  container.replaceChildren(
    ...filtered.map((b) => {
      const item = el("div", "booking-item");

      // Top row: Title + badges
      const top = el("div", "booking-top");
      const clientTitle = el("div", "booking-client-title");
      clientTitle.append(
        el("span", null, "👤 " + (b.client_name || "Lead Prospect")),
        el("span", `badge badge-${b.status || "booked"}`, (b.status || "booked").toUpperCase()),
        el("span", "badge badge-source", b.source === "dashboard" ? "MANUAL" : "WHATSAPP")
      );
      top.appendChild(clientTitle);

      // Contact row (Email + WhatsApp)
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
      if (b.chat_id && b.chat_id !== "dashboard" && b.chat_id !== "manual_crm") {
        const chatPill = el("span", "booking-link-pill", `Chat: ${b.chat_id.split("@")[0]}`);
        contactRow.appendChild(chatPill);
      }

      // Scheduled time banner
      let schedBox = null;
      if (b.scheduled_at) {
        schedBox = el("div", "booking-scheduled-box", `📅 Scheduled Call: ${b.scheduled_at}`);
      }

      // Requirements
      let reqsBox = null;
      if (b.requirements) {
        reqsBox = el("div", "rule-content");
        reqsBox.append(
          el("span", "rule-triggers", "🎬 Video Scope / Plan: "),
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
      const loggedInfo = el("div", "muted small-text", `Logged: ${fmtTime(b.created_at)}`);

      const rightControls = el("div", "rule-ctrls");
      const statusSelect = document.createElement("select");
      statusSelect.className = "small";
      statusSelect.style.width = "auto";
      statusSelect.style.margin = "0";
      [
        { val: "booked", label: "Status: Booked" },
        { val: "confirmed", label: "Status: Confirmed" },
        { val: "completed", label: "Status: Completed" },
        { val: "cancelled", label: "Status: Cancelled" },
      ].forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.val;
        o.textContent = opt.label;
        if (opt.val === b.status) o.selected = true;
        statusSelect.appendChild(o);
      });

      statusSelect.addEventListener("change", async () => {
        const newStatus = statusSelect.value;
        await api("PATCH", "/api/bookings", { id: b.id, status: newStatus });
        b.status = newStatus;
        updateBookingStats();
        renderBookings();
      });

      const delBtn = el("button", "danger small", "Delete");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete booking record for ${b.client_name || b.email || "this client"}?`)) return;
        await api("DELETE", `/api/bookings?id=${b.id}`);
        bookings = bookings.filter((x) => x.id !== b.id);
        updateBookingStats();
        renderBookings();
      });

      rightControls.append(statusSelect, delBtn);
      actions.append(loggedInfo, rightControls);

      item.append(top, contactRow);
      if (schedBox) item.appendChild(schedBox);
      if (reqsBox) item.appendChild(reqsBox);
      if (notesBox) item.appendChild(notesBox);
      item.appendChild(actions);

      return item;
    })
  );
}

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

$("#new-booking-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const clientName = $("#booking-client-name").value.trim();
  const email = $("#booking-email").value.trim();
  const phone = $("#booking-phone").value.trim();
  const scheduledAt = $("#booking-scheduled").value.trim();
  const requirements = $("#booking-reqs").value.trim();
  const status = $("#booking-status").value;
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
      requirements,
      status,
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
