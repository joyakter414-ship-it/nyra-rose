// Nyra Rose 🌹 Dashboard. Plain JS, no build step.
// All user/WhatsApp content is inserted with textContent (never innerHTML).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
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
  loadTodos().catch(() => {});
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  clearInterval(pollTimer);
  let tick = 0;
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    tick++;
    if (!$("#tab-home").classList.contains("hidden")) {
      refreshOverview().catch(() => {});
      if (tick % 2 === 0) {
        loadTodos().catch(() => {});
      } else if (typeof renderHomeTodayTasks === "function") {
        renderHomeTodayTasks();
      }
    } else if (!$("#tab-todos").classList.contains("hidden")) {
      const activeTag = document.activeElement?.tagName;
      const modalOpen = !$("#todo-edit-modal")?.classList.contains("hidden");
      const composerOpen = !$("#ai-todo-composer")?.classList.contains("hidden");
      if (!modalOpen && !composerOpen && activeTag !== "SELECT" && activeTag !== "INPUT" && activeTag !== "TEXTAREA") {
        if (tick % 2 === 0) {
          loadTodos().catch(() => {});
        } else {
          updateTodoStats();
          renderTodos();
        }
      }
    } else if (!$("#tab-bookings").classList.contains("hidden")) {
      const activeTag = document.activeElement?.tagName;
      const modalOpen = !$("#followup-modal")?.classList.contains("hidden");
      const formOpen = !$("#new-booking-form")?.classList.contains("hidden");
      if (!modalOpen && !formOpen && activeTag !== "SELECT" && activeTag !== "INPUT" && activeTag !== "TEXTAREA") {
        if (tick % 2 === 0) {
          loadBookings().catch(() => {});
        } else {
          renderBookings();
        }
      }
    } else if (!$("#tab-chats").classList.contains("hidden") && tick % 2 === 0) {
      loadChats().catch(() => {});
    }
  }, 4000);
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
    $(`#tab-${btn.dataset.tab}`).classList.remove("hidden");
    if (btn.dataset.tab === "home") {
      refreshOverview();
      loadTodos().catch(() => {});
    }
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

  // Role Badge in Topbar — always displays 👑 Admin so Management feels full ownership
  const roleBadge = $("#role-badge");
  if (roleBadge) {
    roleBadge.textContent = "👑 Admin";
    roleBadge.style.background = "#eab30822";
    roleBadge.style.color = "#facc15";
    roleBadge.style.border = "1px solid #ca8a04";
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

  renderInstantReplyControls();
  if (typeof updateStudioPulse === "function") updateStudioPulse();
}

function cleanPhoneDigits(raw) {
  return String(raw || "")
    .split("@")[0]
    .replace(/\D/g, "");
}

function isChatInstantPaused(phoneOrChatId) {
  const digits = cleanPhoneDigits(phoneOrChatId);
  if (!digits) return false;
  const list = overview?.settings?.pausedInstantChats || [];
  return list.some((p) => {
    const cleanP = cleanPhoneDigits(p);
    return cleanP && (digits === cleanP || digits.endsWith(cleanP) || cleanP.endsWith(digits));
  });
}

function renderInstantReplyControls() {
  const s = overview?.settings || {};
  const paused = Boolean(s.instantReplyPaused);
  const pausedChats = Array.isArray(s.pausedInstantChats) ? s.pausedInstantChats : [];

  const quickPaused = $("#quick-instant-paused");
  if (quickPaused) quickPaused.checked = paused;

  const quickPill = $("#quick-instant-status-pill");
  if (quickPill) {
    if (paused) {
      quickPill.textContent = "⏸️ PAUSED (Follow-Ups Active)";
      quickPill.style.background = "rgba(245, 158, 11, 0.14)";
      quickPill.style.color = "#f59e0b";
      quickPill.style.border = "1px solid rgba(245, 158, 11, 0.38)";
    } else {
      quickPill.textContent = `⚡ Instant AI Active${pausedChats.length ? ` (${pausedChats.length} chat${pausedChats.length > 1 ? "s" : ""} paused)` : ""}`;
      quickPill.style.background = "rgba(16, 185, 129, 0.12)";
      quickPill.style.color = "var(--green)";
      quickPill.style.border = "1px solid rgba(16, 185, 129, 0.34)";
    }
  }

  const topbarBtn = $("#topbar-instant-pause-btn");
  if (topbarBtn) {
    topbarBtn.classList.remove("hidden");
    topbarBtn.classList.toggle("btn-tone-amber", paused);
    topbarBtn.textContent = paused
      ? "▶️ Instant Reply: PAUSED"
      : `⏸️ Pause Instant Reply${pausedChats.length ? ` (${pausedChats.length})` : ""}`;
  }

  const homeState = $("#home-instant-reply-state");
  if (homeState) {
    homeState.textContent = paused
      ? "⏸️ Global Instant AI Reply is PAUSED — Nyra will NOT send instant replies so you can chat manually, while Scheduled Follow-Ups & 30m Call Reminders remain 100% ACTIVE."
      : "⚡ Global Instant AI Reply is ACTIVE — Nyra replies immediately to incoming chats AND sends scheduled follow-ups.";
    homeState.style.color = paused ? "#f59e0b" : "var(--green)";
  }

  const homeBtn = $("#home-toggle-instant-pause-btn");
  if (homeBtn) {
    homeBtn.textContent = paused ? "▶️ Resume Global Instant AI Reply" : "⏸️ Pause All Instant AI Replies";
    homeBtn.className = `small ${paused ? "btn-tone-emerald" : "btn-tone-amber"}`;
  }

  const crmTitle = $("#crm-instant-reply-banner-title");
  if (crmTitle) {
    crmTitle.textContent = paused
      ? "⏸️ Instant AI Reply Control — GLOBAL PAUSE ACTIVE (Follow-Ups Still Running)"
      : "⏸️ Instant AI Reply Control (Human Takeover Mode)";
  }

  const crmBtn = $("#crm-toggle-instant-pause-btn");
  if (crmBtn) {
    crmBtn.textContent = paused ? "▶️ Resume All Instant Replies" : "⏸️ Pause All Instant Replies";
    crmBtn.className = `small ${paused ? "btn-tone-emerald" : "btn-tone-amber"}`;
  }

  const listEl = $("#home-paused-chats-list");
  if (listEl) {
    if (pausedChats.length === 0) {
      listEl.replaceChildren(
        el(
          "span",
          "muted small-text",
          "No individual client chats paused. Add a WhatsApp number above or click '⏸️ Pause Instant Chat' on any client in Booked Calls CRM."
        )
      );
    } else {
      listEl.replaceChildren(
        ...pausedChats.map((num) => {
          const matchedBooking = (typeof bookings !== "undefined" ? bookings : []).find((b) => {
            const bDigits = cleanPhoneDigits(b.phone || b.chat_id);
            return bDigits && (bDigits === num || bDigits.endsWith(num) || num.endsWith(bDigits));
          });
          const label = matchedBooking?.client_name ? `${matchedBooking.client_name} (+${num})` : `+${num}`;
          const pill = el("span", "badge badge-booked");
          pill.style.display = "inline-flex";
          pill.style.alignItems = "center";
          pill.style.gap = "8px";
          pill.style.padding = "5px 10px";
          pill.append(el("span", null, `⏸️ ${label} (Follow-Ups ON)`));
          const resumeBtn = el("button", "small btn-tone-emerald", "▶️ Resume");
          resumeBtn.style.padding = "2px 8px";
          resumeBtn.style.fontSize = "11px";
          resumeBtn.addEventListener("click", () => toggleChatInstantPause(num));
          pill.appendChild(resumeBtn);
          return pill;
        })
      );
    }
  }
}

async function setGlobalInstantPause(nextPaused) {
  const res = await api("PUT", "/api/settings", { instantReplyPaused: Boolean(nextPaused) });
  if (overview?.settings) {
    overview.settings.instantReplyPaused = Boolean(res.settings?.instantReplyPaused ?? nextPaused);
  }
  renderInstantReplyControls();
  if (typeof fillSettings === "function") fillSettings();
  if (typeof renderBookings === "function") renderBookings();
}

async function toggleChatInstantPause(phoneOrChatId) {
  const digits = cleanPhoneDigits(phoneOrChatId);
  if (!digits || digits.length < 6) {
    alert("Please provide a valid WhatsApp phone number (at least 6 digits) to pause or resume instant AI replies.");
    return;
  }
  const current = Array.isArray(overview?.settings?.pausedInstantChats) ? [...overview.settings.pausedInstantChats] : [];
  const existsIdx = current.findIndex((p) => {
    const cleanP = cleanPhoneDigits(p);
    return cleanP && (digits === cleanP || digits.endsWith(cleanP) || cleanP.endsWith(digits));
  });
  let nextList;
  if (existsIdx >= 0) {
    nextList = current.filter((_, i) => i !== existsIdx);
  } else {
    nextList = [...current, digits];
  }
  const res = await api("PUT", "/api/settings", { pausedInstantChats: nextList });
  if (overview?.settings) {
    overview.settings.pausedInstantChats = res.settings?.pausedInstantChats || nextList;
  }
  renderInstantReplyControls();
  if (typeof fillSettings === "function") fillSettings();
  if (typeof renderBookings === "function") renderBookings();
}

$("#quick-enabled").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await api("PUT", "/api/settings", { enabled });
  overview.settings.enabled = enabled;
});

$("#quick-instant-paused")?.addEventListener("change", async (e) => {
  await setGlobalInstantPause(e.target.checked);
});

$("#topbar-instant-pause-btn")?.addEventListener("click", async () => {
  await setGlobalInstantPause(!overview?.settings?.instantReplyPaused);
});

$("#home-toggle-instant-pause-btn")?.addEventListener("click", async () => {
  await setGlobalInstantPause(!overview?.settings?.instantReplyPaused);
});

$("#crm-toggle-instant-pause-btn")?.addEventListener("click", async () => {
  await setGlobalInstantPause(!overview?.settings?.instantReplyPaused);
});

$("#home-add-paused-chat-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#home-paused-chat-input");
  const digits = cleanPhoneDigits(input?.value || "");
  if (!digits || digits.length < 6) {
    alert("Enter a valid WhatsApp phone number with country code (e.g. 8801873877905).");
    return;
  }
  if (!isChatInstantPaused(digits)) {
    await toggleChatInstantPause(digits);
  }
  if (input) input.value = "";
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

function getMonogram(label) {
  const str = String(label || "").replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  if (!str) return "💬";
  const parts = str.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return str.slice(0, 2).toUpperCase();
}

async function loadChats() {
  const { chats } = await api("GET", "/api/chats");
  const list = $("#chat-list");
  if (!chats || chats.length === 0) {
    list.replaceChildren(el("div", "empty-state-box", "No WhatsApp conversations logged yet."));
    return;
  }
  list.replaceChildren(
    ...chats.map((c) => {
      const item = el("div", `chat-item ${currentChat === c.chat_id ? "active" : ""}`);
      const avatar = el("div", "chat-avatar", getMonogram(c.name || c.chat_id));
      const info = el("div");
      info.style.flex = "1";
      info.style.minWidth = "0";
      const paused = isChatInstantPaused(c.chat_id) || Boolean(overview?.settings?.instantReplyPaused);
      info.append(
        el("div", "title", `${c.name || c.chat_id}${paused ? " ⏸️" : ""}`),
        el("div", "sub", `${c.message_count} msgs · ${fmtTime(c.last_at)}${paused ? " · Paused" : ""}`)
      );
      const countBadge = el("span", "badge badge-source", String(c.message_count || 0));
      item.append(avatar, info, countBadge);
      item.addEventListener("click", () => selectChat(c));
      return item;
    }),
  );
  if (!currentChat && chats[0]) selectChat(chats[0]);
}

async function selectChat(c) {
  currentChat = c.chat_id;
  const chatPaused = isChatInstantPaused(c.chat_id);
  $("#conv-title").textContent = `${c.name || c.chat_id}${chatPaused ? " (⏸️ Instant AI Paused · Follow-Ups Active)" : ""}`;
  const pauseInstantBtn = $("#conv-pause-instant");
  if (pauseInstantBtn) {
    pauseInstantBtn.classList.remove("hidden");
    pauseInstantBtn.textContent = chatPaused ? "▶️ Resume Instant Reply" : "⏸️ Pause Instant Reply (Keep Follow-Ups)";
    pauseInstantBtn.className = `small ${chatPaused ? "btn-tone-emerald" : "btn-tone-amber"}`;
    pauseInstantBtn.onclick = async () => {
      await toggleChatInstantPause(c.chat_id);
      await loadChats();
      selectChat(c);
    };
  }
  const muteBtn = $("#conv-mute");
  muteBtn.classList.remove("hidden");
  muteBtn.textContent = c.muted ? "Unmute All (Stop Everything)" : "Mute All";
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
    container.replaceChildren(el("div", "empty-state-box", "No rules created yet. Click '+ Add New Rule' above to create one."));
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
    container.replaceChildren(el("div", "empty-state-box", "No notes stored yet. Use /note <text> on WhatsApp or add one above."));
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

// ─── Tasks & AI Follow-Up Timeline ──────────────────────────────────────────

let todos = [];
let todoBookingsCache = [];
let todoFilter = "active";
let todoSearch = "";
let currentEditingTodoId = null;
let editModalScheduledMs = null;
let composerScheduledMs = null;

function isSameBdtDay(ms1, ms2) {
  if (!ms1 || !ms2) return false;
  const bdtOffset = 6 * 3600000;
  return Math.floor((ms1 + bdtOffset) / 86400000) === Math.floor((ms2 + bdtOffset) / 86400000);
}

function isTomorrowBdtDay(ms, nowMs = Date.now()) {
  if (!ms) return false;
  const bdtOffset = 6 * 3600000;
  return Math.floor((ms + bdtOffset) / 86400000) === Math.floor((nowMs + bdtOffset) / 86400000) + 1;
}

const PHONE_PREFIX_TZ_CLIENT = [
  { prefix: "880", code: "BDT", offset: 6, flag: "🇧🇩", country: "Bangladesh", label: "🇧🇩 Bangladesh (+880 · BDT GMT+6)" },
  { prefix: "971", code: "GST", offset: 4, flag: "🇦🇪", country: "UAE / Dubai", label: "🇦🇪 UAE / Dubai (+971 · GST GMT+4)" },
  { prefix: "966", code: "AST", offset: 3, flag: "🇸🇦", country: "Saudi Arabia", label: "🇸🇦 Saudi Arabia (+966 · AST GMT+3)" },
  { prefix: "974", code: "AST", offset: 3, flag: "🇶🇦", country: "Qatar", label: "🇶🇦 Qatar (+974 · AST GMT+3)" },
  { prefix: "965", code: "AST", offset: 3, flag: "🇰🇼", country: "Kuwait", label: "🇰🇼 Kuwait (+965 · AST GMT+3)" },
  { prefix: "968", code: "GST", offset: 4, flag: "🇴🇲", country: "Oman", label: "🇴🇲 Oman (+968 · GST GMT+4)" },
  { prefix: "973", code: "AST", offset: 3, flag: "🇧🇭", country: "Bahrain", label: "🇧🇭 Bahrain (+973 · AST GMT+3)" },
  { prefix: "353", code: "GMT", offset: 0, flag: "🇮🇪", country: "Ireland", label: "🇮🇪 Ireland (+353 · GMT)" },
  { prefix: "351", code: "WET", offset: 0, flag: "🇵🇹", country: "Portugal", label: "🇵🇹 Portugal (+351 · WET)" },
  { prefix: "234", code: "WAT", offset: 1, flag: "🇳🇬", country: "Nigeria", label: "🇳🇬 Nigeria (+234 · WAT GMT+1)" },
  { prefix: "254", code: "EAT", offset: 3, flag: "🇰🇪", country: "Kenya", label: "🇰🇪 Kenya (+254 · EAT GMT+3)" },
  { prefix: "852", code: "HKT", offset: 8, flag: "🇭🇰", country: "Hong Kong", label: "🇭🇰 Hong Kong (+852 · HKT GMT+8)" },
  { prefix: "91", code: "IST", offset: 5.5, flag: "🇮🇳", country: "India", label: "🇮🇳 India (+91 · IST GMT+5:30)" },
  { prefix: "92", code: "PKT", offset: 5, flag: "🇵🇰", country: "Pakistan", label: "🇵🇰 Pakistan (+92 · PKT GMT+5)" },
  { prefix: "94", code: "IST", offset: 5.5, flag: "🇱🇰", country: "Sri Lanka", label: "🇱🇰 Sri Lanka (+94 · IST GMT+5:30)" },
  { prefix: "65", code: "SGT", offset: 8, flag: "🇸🇬", country: "Singapore", label: "🇸🇬 Singapore (+65 · SGT GMT+8)" },
  { prefix: "60", code: "MYT", offset: 8, flag: "🇲🇾", country: "Malaysia", label: "🇲🇾 Malaysia (+60 · MYT GMT+8)" },
  { prefix: "61", code: "AEST", offset: 10, flag: "🇦🇺", country: "Australia", label: "🇦🇺 Australia (+61 · AEST GMT+10)" },
  { prefix: "64", code: "NZST", offset: 12, flag: "🇳🇿", country: "New Zealand", label: "🇳🇿 New Zealand (+64 · NZST GMT+12)" },
  { prefix: "62", code: "WIB", offset: 7, flag: "🇮🇩", country: "Indonesia", label: "🇮🇩 Indonesia (+62 · WIB GMT+7)" },
  { prefix: "63", code: "PHT", offset: 8, flag: "🇵🇭", country: "Philippines", label: "🇵🇭 Philippines (+63 · PHT GMT+8)" },
  { prefix: "66", code: "ICT", offset: 7, flag: "🇹🇭", country: "Thailand", label: "🇹🇭 Thailand (+66 · ICT GMT+7)" },
  { prefix: "81", code: "JST", offset: 9, flag: "🇯🇵", country: "Japan", label: "🇯🇵 Japan (+81 · JST GMT+9)" },
  { prefix: "82", code: "KST", offset: 9, flag: "🇰🇷", country: "South Korea", label: "🇰🇷 South Korea (+82 · KST GMT+9)" },
  { prefix: "86", code: "CST", offset: 8, flag: "🇨🇳", country: "China", label: "🇨🇳 China (+86 · CST GMT+8)" },
  { prefix: "44", code: "GMT", offset: 0, flag: "🇬🇧", country: "UK", label: "🇬🇧 UK (+44 · GMT+0)" },
  { prefix: "49", code: "CET", offset: 1, flag: "🇩🇪", country: "Germany", label: "🇩🇪 Germany (+49 · CET GMT+1)" },
  { prefix: "33", code: "CET", offset: 1, flag: "🇫🇷", country: "France", label: "🇫🇷 France (+33 · CET GMT+1)" },
  { prefix: "39", code: "CET", offset: 1, flag: "🇮🇹", country: "Italy", label: "🇮🇹 Italy (+39 · CET GMT+1)" },
  { prefix: "34", code: "CET", offset: 1, flag: "🇪🇸", country: "Spain", label: "🇪🇸 Spain (+34 · CET GMT+1)" },
  { prefix: "31", code: "CET", offset: 1, flag: "🇳🇱", country: "Netherlands", label: "🇳🇱 Netherlands (+31 · CET GMT+1)" },
  { prefix: "41", code: "CET", offset: 1, flag: "🇨🇭", country: "Switzerland", label: "🇨🇭 Switzerland (+41 · CET GMT+1)" },
  { prefix: "46", code: "CET", offset: 1, flag: "🇸🇪", country: "Sweden", label: "🇸🇪 Sweden (+46 · CET GMT+1)" },
  { prefix: "47", code: "CET", offset: 1, flag: "🇳🇴", country: "Norway", label: "🇳🇴 Norway (+47 · CET GMT+1)" },
  { prefix: "45", code: "CET", offset: 1, flag: "🇩🇰", country: "Denmark", label: "🇩🇰 Denmark (+45 · CET GMT+1)" },
  { prefix: "48", code: "CET", offset: 1, flag: "🇵🇱", country: "Poland", label: "🇵🇱 Poland (+48 · CET GMT+1)" },
  { prefix: "32", code: "CET", offset: 1, flag: "🇧🇪", country: "Belgium", label: "🇧🇪 Belgium (+32 · CET GMT+1)" },
  { prefix: "43", code: "CET", offset: 1, flag: "🇦🇹", country: "Austria", label: "🇦🇹 Austria (+43 · CET GMT+1)" },
  { prefix: "90", code: "TRT", offset: 3, flag: "🇹🇷", country: "Turkey", label: "🇹🇷 Turkey (+90 · TRT GMT+3)" },
  { prefix: "20", code: "EET", offset: 2, flag: "🇪🇬", country: "Egypt", label: "🇪🇬 Egypt (+20 · EET GMT+2)" },
  { prefix: "27", code: "SAST", offset: 2, flag: "🇿🇦", country: "South Africa", label: "🇿🇦 South Africa (+27 · SAST GMT+2)" },
  { prefix: "55", code: "BRT", offset: -3, flag: "🇧🇷", country: "Brazil", label: "🇧🇷 Brazil (+55 · BRT GMT-3)" },
  { prefix: "52", code: "CST", offset: -6, flag: "🇲🇽", country: "Mexico", label: "🇲🇽 Mexico (+52 · CST GMT-6)" },
  { prefix: "54", code: "ART", offset: -3, flag: "🇦🇷", country: "Argentina", label: "🇦🇷 Argentina (+54 · ART GMT-3)" },
  { prefix: "57", code: "COT", offset: -5, flag: "🇨🇴", country: "Colombia", label: "🇨🇴 Colombia (+57 · COT GMT-5)" },
  { prefix: "1", code: "EST", offset: -5, flag: "🇺🇸", country: "US/Canada", label: "🇺🇸 US/Canada (+1 · EST GMT-5)" },
];

function detectClientTzFromPhone(phoneOrChatId) {
  if (!phoneOrChatId) return null;
  let digits = String(phoneOrChatId).replace(/@.*$/, "").replace(/[^\d]/g, "");
  if (!digits || digits.length < 7) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("01") && digits.length === 11) {
    digits = `88${digits}`;
  }
  for (const entry of PHONE_PREFIX_TZ_CLIENT) {
    if (digits.startsWith(entry.prefix)) {
      return entry;
    }
  }
  return null;
}

function formatGmtOffsetLabel(offsetHours) {
  if (offsetHours === 0) return "GMT+0";
  const sign = offsetHours > 0 ? "+" : "-";
  const abs = Math.abs(offsetHours);
  const whole = Math.floor(abs);
  const mins = Math.round((abs - whole) * 60);
  return mins > 0 ? `GMT${sign}${whole}:${String(mins).padStart(2, "0")}` : `GMT${sign}${whole}`;
}

function resolveRecordTimezoneInfo(record) {
  if (!record) return null;
  const phoneTz = detectClientTzFromPhone(record.phone || record.chat_id);
  const rawTz = (record.timezone || "").trim().toUpperCase();
  if (rawTz && rawTz !== "BDT") {
    const offset = getTzOffsetHours(rawTz);
    const gmt = formatGmtOffsetLabel(offset);
    return {
      code: rawTz,
      offset,
      gmtLabel: gmt,
      country: phoneTz ? phoneTz.country : rawTz,
      flag: phoneTz ? phoneTz.flag : "🌍",
      prefix: phoneTz ? `+${phoneTz.prefix}` : "",
      shortCountry: phoneTz ? `${phoneTz.flag} ${phoneTz.country} (+${phoneTz.prefix})` : `🌍 ${rawTz}`,
      fullBadge: phoneTz
        ? `${phoneTz.flag} ${phoneTz.country} (+${phoneTz.prefix}) · ${rawTz} (${gmt})`
        : `🌍 ${rawTz} (${gmt})`,
      isForeign: offset !== 6 || rawTz !== "BDT",
    };
  }
  if (phoneTz) {
    const gmt = formatGmtOffsetLabel(phoneTz.offset);
    return {
      code: phoneTz.code,
      offset: phoneTz.offset,
      gmtLabel: gmt,
      country: phoneTz.country,
      flag: phoneTz.flag,
      prefix: `+${phoneTz.prefix}`,
      shortCountry: `${phoneTz.flag} ${phoneTz.country} (+${phoneTz.prefix})`,
      fullBadge: `${phoneTz.flag} ${phoneTz.country} (+${phoneTz.prefix}) · ${phoneTz.code} (${gmt})`,
      isForeign: phoneTz.offset !== 6 || phoneTz.code !== "BDT",
    };
  }
  if (rawTz === "BDT") {
    return {
      code: "BDT",
      offset: 6,
      gmtLabel: "GMT+6",
      country: "Bangladesh",
      flag: "🇧🇩",
      prefix: "+880",
      shortCountry: "🇧🇩 Bangladesh (BDT)",
      fullBadge: "🇧🇩 Bangladesh · BDT (GMT+6)",
      isForeign: false,
    };
  }
  return null;
}

function formatSingleTzClock(ms, offsetHours, tzCode, nowMs = Date.now()) {
  const offsetMs = offsetHours * 3600000;
  const d = new Date(ms + offsetMs);
  let hours = d.getUTCHours();
  const mins = d.getUTCMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const timeStr = `${hours}:${String(mins).padStart(2, "0")} ${ampm} ${tzCode}`;
  const dayDiff = Math.floor((ms + offsetMs) / 86400000) - Math.floor((nowMs + offsetMs) / 86400000);
  if (dayDiff === 0) return `Today, ${timeStr}`;
  if (dayDiff === 1) return `Tomorrow, ${timeStr}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${timeStr}`;
}

// Primary Task Bar clock: ALWAYS displays calculated Local Time (BDT) first!
function formatBdtClock(ms, fallbackText = "", taskOrTz = null) {
  if (!ms || !Number.isFinite(ms)) return fallbackText || "No fixed time";
  const now = Date.now();
  const bdtStr = formatSingleTzClock(ms, 6, "BDT", now);

  if (taskOrTz && typeof taskOrTz === "object") {
    const tzInfo = resolveRecordTimezoneInfo(taskOrTz);
    if (tzInfo && tzInfo.isForeign) {
      return `Local: ${bdtStr}`;
    }
  }
  return bdtStr;
}

// Formats the Client's Original Time in their country-code timezone (when outside Bangladesh)
function formatClientOriginalClock(ms, record, nowMs = Date.now()) {
  if (!ms || !Number.isFinite(ms) || !record) return null;
  const tzInfo = resolveRecordTimezoneInfo(record);
  if (!tzInfo || !tzInfo.isForeign) return null;
  const clientClock = formatSingleTzClock(ms, tzInfo.offset, tzInfo.code, nowMs);
  return {
    clock: clientClock,
    tzInfo,
    badgeText: `🌍 Client Time: ${clientClock} (${tzInfo.shortCountry})`,
  };
}

// Convert UTC epoch ms -> "YYYY-MM-DDTHH:mm" in BDT (GMT+6) for <input type="datetime-local">
function msToBdtDatetimeLocal(ms) {
  if (!ms || !Number.isFinite(ms)) return "";
  const bdtDate = new Date(ms + 6 * 3600000);
  const yr = bdtDate.getUTCFullYear();
  const mo = String(bdtDate.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(bdtDate.getUTCDate()).padStart(2, "0");
  const hr = String(bdtDate.getUTCHours()).padStart(2, "0");
  const mn = String(bdtDate.getUTCMinutes()).padStart(2, "0");
  return `${yr}-${mo}-${dy}T${hr}:${mn}`;
}

// Convert "YYYY-MM-DDTHH:mm" from <input type="datetime-local"> -> UTC epoch ms in BDT (GMT+6)
function bdtDatetimeLocalToMs(dtVal) {
  if (!dtVal || typeof dtVal !== "string") return null;
  const m = dtVal.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const yr = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const dy = parseInt(m[3], 10);
    const hr = parseInt(m[4], 10);
    const mn = parseInt(m[5], 10);
    const sc = m[6] ? parseInt(m[6], 10) : 0;
    return Date.UTC(yr, mo, dy, hr, mn, sc) - 6 * 3600000;
  }
  const parsed = new Date(dtVal).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// Client-side natural time parser (mirrors backend parseScheduledTimeToMs; supports explicit timezones like EST/GMT/AEST or defaults to BDT)
function parseClientNaturalTimeToMs(phrase, nowMs = Date.now(), fallbackTzOffsetHours = 6) {
  if (!phrase || !phrase.trim()) return null;
  const raw = phrase.trim();

  // 1. Check YYYY-MM-DDTHH:mm
  const isoLocal = bdtDatetimeLocalToMs(raw);
  if (isoLocal && /^\d{4}-\d{2}-\d{2}/.test(raw)) return isoLocal;

  const p = raw
    .toLowerCase()
    .replace(/^(?:follow-up:|local:)\s*/i, "")
    .replace(/\blatter\b/g, "later")
    .replace(/(\d{1,2})\s*:\s*(\d{2})/g, "$1:$2")
    .trim();

  // 2. Relative expressions ("in 30 minutes", "+1h", "2 hours later", "in 3 days")
  const relMatch = p.match(/(?:in|after|\+)?\s*(\d+(?:\.\d+)?)\s*(hour|hr|h|minute|min|m|day|d|week|w)s?(?:\s+later)?\b/i);
  if (relMatch && !/\b(?:am|pm)\b/i.test(p.slice(relMatch.index, relMatch.index + relMatch[0].length + 4))) {
    const isShortUnit = /^(?:h|m|d|w)$/i.test(relMatch[2]);
    if (!isShortUnit || /^[+]|^(?:in|after)\b|\blater\b/i.test(p)) {
      const val = parseFloat(relMatch[1]);
      const u = relMatch[2].toLowerCase();
      if (u.startsWith("m")) return Math.round(nowMs + val * 60 * 1000);
      if (u.startsWith("h")) return Math.round(nowMs + val * 3600 * 1000);
      if (u.startsWith("d")) return Math.round(nowMs + val * 24 * 3600 * 1000);
      if (u.startsWith("w")) return Math.round(nowMs + val * 7 * 24 * 3600 * 1000);
    }
  }

  // Detect explicit timezone mention in phrase (e.g. "today 2 pm est", "tomorrow 4pm gmt")
  const tzMatch = p.match(/\b((?:gmt|utc)\s*[+-]\d{1,2}(?::\d{2})?|est|edt|pst|pdt|cst|cdt|mst|mdt|gmt|utc|bdt|ist|pkt|gst|ast|sgt|myt|pht|hkt|jst|kst|aest|aedt|nzst|cet|wat|eat|trt|brt)\b/i);
  const effOffsetHours = tzMatch ? getTzOffsetHours(tzMatch[1]) : fallbackTzOffsetHours;
  const tzOffsetMs = effOffsetHours * 3600 * 1000;
  const localNowMs = nowMs + tzOffsetMs;
  const localDate = new Date(localNowMs);

  let explicitMonth = null;
  let explicitDay = null;
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthMatch = p.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i,
  );
  const reverseMonthMatch = !monthMatch
    ? p.match(
        /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
      )
    : null;
  const bareDateMatch =
    !monthMatch && !reverseMonthMatch
      ? p.match(/\b(?:on\s+(?:the\s+)?)?(\d{1,2})(?:\s*(?:st|nd|rd|th)?\s+date\b|\s*(?:tarik|tarikh)\b|\s*(?:st|nd|rd|th)\b)/i)
      : null;

  if (monthMatch) {
    explicitMonth = monthNames.indexOf(monthMatch[1].slice(0, 3).toLowerCase());
    explicitDay = parseInt(monthMatch[2], 10);
  } else if (reverseMonthMatch) {
    explicitDay = parseInt(reverseMonthMatch[1], 10);
    explicitMonth = monthNames.indexOf(reverseMonthMatch[2].slice(0, 3).toLowerCase());
  } else if (bareDateMatch) {
    const dayNum = parseInt(bareDateMatch[1], 10);
    if (dayNum >= 1 && dayNum <= 31) {
      explicitDay = dayNum;
      explicitMonth = localDate.getUTCMonth();
      if (dayNum < localDate.getUTCDate()) {
        explicitMonth = (explicitMonth + 1) % 12;
      }
    }
  }

  let dayOffset = null;
  if (p.includes("day after tomorrow")) {
    dayOffset = 2;
  } else if (p.includes("tomorrow")) {
    dayOffset = 1;
  } else if (p.includes("today") || p.includes("tonight")) {
    dayOffset = 0;
  } else if (p.includes("next week")) {
    dayOffset = 7;
  } else if (explicitMonth === null) {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (let i = 0; i < 7; i++) {
      if (p.includes(days[i])) {
        const curDay = localDate.getUTCDay();
        dayOffset = (i - curDay + 7) % 7;
        if (dayOffset === 0 && (p.includes("next") || localDate.getUTCHours() >= 18)) {
          dayOffset = 7;
        }
        break;
      }
    }
  }

  const ampmMatch = p.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const colonMatch = p.match(/\b(\d{1,2}):(\d{2})\b/);
  const prepMatch = p.match(/(?:at|on|for|in|around|by|today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?\b/i);

  const hasTimeCue =
    Boolean(ampmMatch || colonMatch || prepMatch) ||
    /\b(morning|noon|afternoon|evening|night|tonight)\b/i.test(p);

  if (explicitMonth === null && dayOffset === null && !hasTimeCue) {
    return null;
  }

  let hour = 15;
  let minute = 0;
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const mer = ampmMatch[3].toLowerCase();
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hour = h;
      minute = m;
    }
  } else if (colonMatch) {
    let h = parseInt(colonMatch[1], 10);
    const m = parseInt(colonMatch[2], 10);
    if (h >= 1 && h <= 8) h += 12;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hour = h;
      minute = m;
    }
  } else if (prepMatch) {
    let h = parseInt(prepMatch[1], 10);
    const m = prepMatch[2] ? parseInt(prepMatch[2], 10) : 0;
    if (h >= 1 && h <= 8) h += 12;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hour = h;
      minute = m;
    }
  } else if (p.includes("morning")) {
    hour = 10;
  } else if (p.includes("noon") || p.includes("afternoon")) {
    hour = 15;
  } else if (p.includes("evening")) {
    hour = 19;
  } else if (p.includes("night") || p.includes("tonight")) {
    hour = 20;
  }

  const targetLocal = new Date(localNowMs);
  if (explicitMonth !== null && explicitDay !== null) {
    targetLocal.setUTCMonth(explicitMonth, explicitDay);
  } else {
    targetLocal.setUTCDate(targetLocal.getUTCDate() + (dayOffset ?? 0));
  }
  targetLocal.setUTCHours(hour, minute, 0, 0);

  let targetUtcMs = targetLocal.getTime() - tzOffsetMs;
  if (
    explicitMonth === null &&
    (dayOffset === null || dayOffset === 0) &&
    targetUtcMs <= nowMs - 15 * 60 * 1000 &&
    !p.includes("today") &&
    !p.includes("yesterday")
  ) {
    targetUtcMs += 24 * 3600 * 1000;
  }
  return targetUtcMs;
}

function formatTodoCountdown(t) {
  const now = Date.now();
  if (t.completed) {
    return {
      label: t.sent_at ? `✓ Sent by Nyra (${fmtTime(t.sent_at)})` : "✓ Completed",
      color: "#34d399",
      bg: "rgba(16, 185, 129, 0.14)",
      border: "rgba(16, 185, 129, 0.35)",
      urgent: false,
    };
  }
  const ms = t.scheduled_at_ms;
  if (!ms) {
    return {
      label: t.due_date ? `🗓️ ${t.due_date}` : "📌 Open Task",
      color: "#cbd5e1",
      bg: "rgba(148, 163, 184, 0.12)",
      border: "rgba(148, 163, 184, 0.28)",
      urgent: false,
    };
  }
  const diff = ms - now;
  if (diff <= 0) {
    return {
      label: t.auto_send && t.phone ? "⚡ Due Now — Nyra Sending..." : "⚡ Due Now!",
      color: "#fda4af",
      bg: "rgba(244, 63, 94, 0.2)",
      border: "rgba(244, 63, 94, 0.5)",
      urgent: true,
    };
  }
  if (diff < 3600000) {
    const mins = Math.max(1, Math.ceil(diff / 60000));
    return {
      label: `⏳ in ${mins}m`,
      color: "#fcd34d",
      bg: "rgba(245, 158, 11, 0.16)",
      border: "rgba(245, 158, 11, 0.42)",
      urgent: true,
    };
  }
  if (diff < 86400000) {
    const hrs = Math.floor(diff / 3600000);
    const mins = Math.round((diff % 3600000) / 60000);
    return {
      label: `⏱ in ${hrs}h ${mins}m`,
      color: "#93c5fd",
      bg: "rgba(59, 130, 246, 0.15)",
      border: "rgba(59, 130, 246, 0.38)",
      urgent: false,
    };
  }
  const days = Math.floor(diff / 86400000);
  const hrs = Math.round((diff % 86400000) / 3600000);
  return {
    label: `📅 in ${days}d ${hrs}h`,
    color: "#c4b5fd",
    bg: "rgba(139, 92, 246, 0.15)",
    border: "rgba(139, 92, 246, 0.38)",
    urgent: false,
  };
}

function updateLiveTimerBadgeEl(badgeEl, ms, recordContext = null) {
  if (!badgeEl) return;
  if (!ms || !Number.isFinite(ms)) {
    badgeEl.textContent = "⏱️ Next Follow-Up: No timer set";
    return;
  }
  const localClockStr = formatSingleTzClock(ms, 6, "BDT");
  const clientOrig = recordContext ? formatClientOriginalClock(ms, recordContext) : null;
  const cd = formatTodoCountdown({ scheduled_at_ms: ms, completed: 0, auto_send: 1, phone: "1" });
  if (clientOrig) {
    badgeEl.textContent = `⏱️ Local: ${localClockStr} · 🌍 Client: ${clientOrig.clock} (${cd.label})`;
  } else {
    badgeEl.textContent = `⏱️ Next Follow-Up (Local): ${localClockStr} (${cd.label})`;
  }
  badgeEl.style.background = cd.bg;
  badgeEl.style.color = cd.color;
  badgeEl.style.border = `1px solid ${cd.border}`;
}

function getTaskTypeMeta(taskType) {
  switch (taskType) {
    case "client_date":
      return { badge: "🗓️ Auto-Added (Client Time)", cls: "badge-client_date", accent: "#f59e0b" };
    case "call_reminder":
      return { badge: "⏰ Call Reminder", cls: "badge-call_reminder", accent: "#a855f7" };
    case "ai_followup":
    case "client_followup":
      return { badge: "🤖 Nyra AI Follow-Up", cls: "badge-auto_day1", accent: "#fb7185" };
    case "manual_ai":
    case "ai_scheduled":
      return { badge: "✍️ Custom AI Schedule", cls: "badge-custom_timer", accent: "#38bdf8" };
    default:
      return { badge: "📌 Manual Task", cls: "badge-source", accent: "#94a3b8" };
  }
}

function generateSmartAiDraft(clientName, taskType, timeLabel) {
  const name = (clientName || "there").trim().split(/\s+/)[0] || "there";
  if (taskType === "call_reminder") {
    return `Hey ${name}! Quick heads-up — our strategy call with Arnob is coming up (${timeLabel || "soon"}). Let me know once you're ready to hop on!`;
  }
  if (taskType === "client_date") {
    return `Hey ${name}! Knocking you right on time as you asked 😊 Are you free for a quick 2-minute chat now?`;
  }
  return `Hey ${name}! Hope your day is going well. Just following up on our earlier chat — do you have 2 minutes to connect right now?`;
}

async function loadTodos() {
  const res = await api("GET", "/api/todos");
  todos = res.todos || [];
  if (Array.isArray(res.bookings)) {
    todoBookingsCache = res.bookings;
    if (bookings.length > 0) {
      bookings = res.bookings;
      updateBookingStats();
      renderBookings();
    }
  }
  populateTodoClientSelect();
  updateTodoStats();
  renderTodos();
  renderHomeTodayTasks();
}

function populateTodoClientSelect() {
  const sel = $("#todo-client-select");
  if (!sel) return;
  const currentVal = sel.value;
  const list = todoBookingsCache.length > 0 ? todoBookingsCache : bookings;
  const opts = [Object.assign(el("option", null, "— Type new client / phone or select existing lead —"), { value: "" })];
  for (const b of list) {
    const label = `${b.client_name || "Lead"} (${b.phone || b.email || "No phone"}) · [${(b.status || "lead").toUpperCase()}]`;
    opts.push(Object.assign(el("option", null, label), { value: b.id }));
  }
  sel.replaceChildren(...opts);
  if (currentVal) sel.value = currentVal;
}

function updateTodoStats() {
  const now = Date.now();
  const active = todos.filter((t) => !t.completed);
  const todayTasks = active.filter(
    (t) => t.scheduled_at_ms && (isSameBdtDay(t.scheduled_at_ms, now) || (t.scheduled_at_ms > now && t.scheduled_at_ms - now <= 86400000)),
  );
  const scheduledActive = active
    .filter((t) => t.scheduled_at_ms)
    .sort((a, b) => (a.scheduled_at_ms || 0) - (b.scheduled_at_ms || 0));
  const nextTask = scheduledActive[0] || null;
  const clientDateCount = active.filter((t) => t.task_type === "client_date" || t.task_type === "call_reminder").length;
  const completedCount = todos.filter((t) => t.completed).length;

  const statToday = $("#stat-todos-today");
  if (statToday) statToday.textContent = String(todayTasks.length);

  const statNext = $("#stat-todos-next");
  const statNextSub = $("#stat-todos-next-sub");
  if (statNext && statNextSub) {
    if (nextTask) {
      const cd = formatTodoCountdown(nextTask);
      statNext.textContent = formatBdtClock(nextTask.scheduled_at_ms, nextTask.due_date).replace(/^(Today,\s*)/i, "");
      statNextSub.textContent = `${cd.label} · ${nextTask.client_name || nextTask.task}`;
    } else {
      statNext.textContent = "—";
      statNextSub.textContent = "No active timers queued";
    }
  }

  const statClientDate = $("#stat-todos-client-date");
  if (statClientDate) statClientDate.textContent = String(clientDateCount);

  const statCompleted = $("#stat-todos-completed");
  if (statCompleted) statCompleted.textContent = String(completedCount);

  // Update topbar tab badge count
  const tabBtn = document.querySelector('.tab[data-tab="todos"]');
  if (tabBtn) {
    tabBtn.textContent = active.length > 0 ? `Tasks ✅ (${active.length})` : "Tasks ✅";
  }
}

function renderHomeTodayTasks() {
  const container = $("#home-today-tasks-list");
  if (!container) return;

  const active = todos
    .filter((t) => !t.completed)
    .sort((a, b) => (a.scheduled_at_ms || 9999999999999) - (b.scheduled_at_ms || 9999999999999));

  if (active.length === 0) {
    container.replaceChildren(
      el(
        "div",
        "muted small-text",
        "No upcoming AI follow-ups or tasks queued right now. Add a task in Tasks ✅ or let Nyra auto-schedule when a client replies with a time.",
      ),
    );
    return;
  }

  const topItems = active.slice(0, 5);
  container.replaceChildren(
    ...topItems.map((t) => {
      const cd = formatTodoCountdown(t);
      const meta = getTaskTypeMeta(t.task_type);
      const clockText = t.scheduled_at_ms ? formatBdtClock(t.scheduled_at_ms, t.due_date, t) : t.due_date || "Anytime";
      const clientOrig = t.scheduled_at_ms ? formatClientOriginalClock(t.scheduled_at_ms, t) : null;

      const row = el("div", "todo-home-row");
      row.style.cssText = `display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:11px 14px; border-radius:12px; background:var(--panel-2); border:1px solid var(--line); border-left:3px solid ${meta.accent}; flex-wrap:wrap;`;

      const left = el("div");
      left.style.cssText = "flex:1; min-width:220px;";

      const topLine = el("div");
      topLine.style.cssText = "display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:4px;";

      const timePill = el("span", "badge", `🕐 ${clockText}`);
      timePill.style.cssText = "background:rgba(244,63,94,0.14); color:var(--rose-light); border:1px solid rgba(244,63,94,0.35); font-weight:700;";

      const cdPill = el("span", "badge", cd.label);
      cdPill.style.cssText = `background:${cd.bg}; color:${cd.color}; border:1px solid ${cd.border}; font-weight:600;`;

      const typeBadge = el("span", `badge ${meta.cls}`, meta.badge);
      topLine.append(timePill);
      if (clientOrig) {
        const clientTzPill = el("span", "badge", `🌍 Client: ${clientOrig.clock} (${clientOrig.tzInfo.shortCountry})`);
        clientTzPill.style.cssText = "background:rgba(14,165,233,0.14); color:#0ea5e9; border:1px solid rgba(14,165,233,0.35); font-weight:600;";
        topLine.append(clientTzPill);
      }
      topLine.append(cdPill, typeBadge);

      const titleLine = el("div", null, t.task);
      titleLine.style.cssText = "font-weight:600; font-size:13.5px; color:var(--text); margin-bottom:3px;";
      left.append(topLine, titleLine);

      if (t.ai_message) {
        const msgPreview = el("div", "small-text", `💬 "${t.ai_message}"`);
        msgPreview.style.cssText =
          "color:var(--muted); background:var(--surface-inset); padding:5px 9px; border-radius:7px; border:1px dashed var(--line); margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:680px;";
        left.append(msgPreview);
      }

      const right = el("div");
      right.style.cssText = "display:flex; gap:6px; align-items:center; flex-shrink:0;";

      const editBtn = el("button", "ghost small", "✏️ Edit / Msg");
      editBtn.type = "button";
      editBtn.addEventListener("click", () => {
        openTodoEditModal(t);
      });

      right.append(editBtn);
      row.append(left, right);
      return row;
    }),
  );
}

$("#home-open-tasks-btn")?.addEventListener("click", () => {
  document.querySelector('.tab[data-tab="todos"]')?.click();
});

function getFilteredTodos() {
  const now = Date.now();
  const q = todoSearch.trim().toLowerCase();
  return todos.filter((t) => {
    if (todoFilter === "active" && t.completed) return false;
    if (todoFilter === "completed" && !t.completed) return false;
    if (todoFilter === "today") {
      if (t.completed) return false;
      if (!t.scheduled_at_ms) return false;
      if (!isSameBdtDay(t.scheduled_at_ms, now) && !(t.scheduled_at_ms > now && t.scheduled_at_ms - now <= 86400000)) {
        return false;
      }
    }
    if (todoFilter === "client_date") {
      if (t.completed || t.task_type !== "client_date") return false;
    }
    if (todoFilter === "call_reminder") {
      if (t.completed || t.task_type !== "call_reminder") return false;
    }
    if (q) {
      const hay = `${t.task || ""} ${t.client_name || ""} ${t.phone || ""} ${t.ai_message || ""} ${t.due_date || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTodos() {
  const container = $("#todos-list");
  if (!container) return;

  const filtered = getFilteredTodos();
  const countLabel = $("#todos-count-label");
  if (countLabel) {
    countLabel.textContent = `${filtered.length} task${filtered.length === 1 ? "" : "s"} shown (${todos.filter((x) => !x.completed).length} active total)`;
  }

  const headingEl = $("#todos-section-heading");
  if (headingEl) {
    const titles = {
      active: "🕐 Chronological Follow-Up & Task Timeline",
      today: "📅 Today's Scheduled Follow-Ups & Tasks (Next 24h)",
      client_date: "🗓️ Auto-Added Client Requested Dates & Times",
      call_reminder: "⏰ Upcoming Booked Call Reminders",
      completed: "✅ Sent & Completed Follow-Ups / Tasks",
      all: "📋 All Tasks & Follow-Up History",
    };
    headingEl.textContent = titles[todoFilter] || titles.active;
  }

  if (filtered.length === 0) {
    container.replaceChildren(
      el(
        "div",
        "muted",
        "No matching tasks in this view. Type a schedule above (e.g. 'Today 1pm follow up Akter — Hey bro...') or click '+ Schedule AI Follow-Up / Task'.",
      ),
    );
    return;
  }

  const allLeads = todoBookingsCache.length > 0 ? todoBookingsCache : bookings;

  container.replaceChildren(
    ...filtered.map((t) => {
      const linkedBooking = t.booking_id ? allLeads.find((b) => b.id === t.booking_id) : null;
      const effectiveRecord = {
        ...t,
        phone: t.phone || linkedBooking?.phone || t.chat_id || linkedBooking?.chat_id,
        timezone: t.timezone || linkedBooking?.timezone,
      };
      const tzInfo = resolveRecordTimezoneInfo(effectiveRecord);
      const cd = formatTodoCountdown(t);
      const meta = getTaskTypeMeta(t.task_type);
      const clockStr = t.scheduled_at_ms ? formatBdtClock(t.scheduled_at_ms, t.due_date, effectiveRecord) : t.due_date || "No fixed time";
      const clientOrig = t.scheduled_at_ms ? formatClientOriginalClock(t.scheduled_at_ms, effectiveRecord) : null;

      const card = el("div", `todo-timeline-card ${t.completed ? "disabled" : ""}`);
      card.style.cssText = `border-left:4px solid ${
        t.completed ? "#10b981" : meta.accent
      } !important; opacity:${t.completed ? "0.74" : "1"};`;

      // Top metadata row: Local Clock Pill + Client Original Clock Pill + Countdown + Task Type + Auto-Send status
      const topRow = el("div");
      topRow.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;";

      const badgesLeft = el("div");
      badgesLeft.style.cssText = "display:flex; align-items:center; gap:6px; flex-wrap:wrap;";

      const clockBadge = el("span", "badge todo-time-pill", `🕐 ${clockStr}`);
      clockBadge.style.cssText =
        "background:rgba(244, 63, 94, 0.14); color:var(--rose-light); border:1px solid rgba(244, 63, 94, 0.38); font-weight:700; font-size:12.5px; padding:4px 10px;";
      badgesLeft.append(clockBadge);

      if (clientOrig) {
        const clientOrigBadge = el("span", "badge", `🌍 Client Time: ${clientOrig.clock}`);
        clientOrigBadge.style.cssText =
          "background:rgba(14, 165, 233, 0.14); color:#0ea5e9; border:1px solid rgba(14, 165, 233, 0.38); font-weight:700; font-size:12px; padding:4px 10px;";
        badgesLeft.append(clientOrigBadge);
      }

      const cdBadge = el("span", "badge", cd.label);
      cdBadge.style.cssText = `background:${cd.bg}; color:${cd.color}; border:1px solid ${cd.border}; font-weight:700; font-size:12px; padding:4px 10px;`;

      const typeBadge = el("span", `badge ${meta.cls}`, meta.badge);
      badgesLeft.append(cdBadge, typeBadge);

      if (t.phone) {
        const autoBadge = el(
          "span",
          "badge",
          t.auto_send ? "🚀 Auto-Send on WhatsApp" : "⏸️ Auto-Send Paused",
        );
        autoBadge.style.cssText = t.auto_send
          ? "background:rgba(16,185,129,0.12); color:var(--green); border:1px solid rgba(16,185,129,0.32);"
          : "background:var(--surface-inset); color:var(--muted); border:1px solid var(--line);";
        badgesLeft.append(autoBadge);
      }

      const metaRight = el("div", "small-text muted");
      metaRight.textContent = t.booking_id ? "🔗 Synced with CRM Lead" : `Added ${fmtTime(t.created_at)}`;
      topRow.append(badgesLeft, metaRight);

      // Middle row: Task title + Client, Phone & Original Timezone chips
      const titleRow = el("div");
      titleRow.style.cssText = "display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px;";

      const titleText = el("div", null, `${t.completed ? "✓ " : ""}${t.task}`);
      titleText.style.cssText = `font-size:15px; font-weight:700; color:var(--text); ${t.completed ? "text-decoration:line-through; color:var(--muted);" : ""}`;
      titleRow.append(titleText);

      if (t.client_name) {
        const clientChip = el("span", "badge", `👤 ${t.client_name}`);
        clientChip.style.cssText = "background:var(--surface-inset); color:var(--text); border:1px solid var(--line);";
        titleRow.append(clientChip);
      }
      if (t.phone) {
        const cleanPh = String(t.phone).replace(/[^\d]/g, "");
        const phoneLink = el("a", "booking-link-pill", `📱 +${cleanPh}`);
        phoneLink.href = `https://wa.me/${cleanPh}`;
        phoneLink.target = "_blank";
        phoneLink.rel = "noopener";
        titleRow.append(phoneLink);
      }
      if (tzInfo) {
        const tzChip = el("span", "badge", `🌐 Client TZ: ${tzInfo.fullBadge}`);
        tzChip.style.cssText = tzInfo.isForeign
          ? "background:rgba(14,165,233,0.12); color:#0ea5e9; border:1px solid rgba(14,165,233,0.3); font-size:11.5px; font-weight:600;"
          : "background:rgba(16,185,129,0.1); color:var(--green); border:1px solid rgba(16,185,129,0.28); font-size:11.5px;";
        titleRow.append(tzChip);
      }

      card.append(topRow, titleRow);

      // If this task is a Call Reminder for a booked meeting with a known call_time_ms, display a dedicated Local vs Client Meeting Time bar
      if (linkedBooking && linkedBooking.call_time_ms) {
        const localCallClock = formatSingleTzClock(linkedBooking.call_time_ms, 6, "BDT");
        const clientCallClock = tzInfo && tzInfo.isForeign
          ? formatSingleTzClock(linkedBooking.call_time_ms, tzInfo.offset, tzInfo.code)
          : null;
        const callBanner = el(
          "div",
          "small-text",
          clientCallClock
            ? `📅 Booked Meeting Time — 🇧🇩 Local (Calculated): ${localCallClock}   ⇄   🌍 Client Original: ${clientCallClock} (${tzInfo.shortCountry})`
            : `📅 Booked Meeting Time (Local BDT): ${localCallClock}`,
        );
        callBanner.style.cssText =
          "background:rgba(139,92,246,0.12); border:1px solid rgba(139,92,246,0.32); color:var(--text); padding:7px 11px; border-radius:8px; margin-bottom:8px; font-weight:600;";
        card.append(callBanner);
      }

      // Exact WhatsApp AI Message Box (clickable to edit)
      if (t.ai_message || t.phone || t.booking_id) {
        const msgBox = el("div", "todo-msg-box");
        msgBox.title = "Click to edit this WhatsApp message or reschedule time";
        msgBox.addEventListener("click", () => openTodoEditModal(t));

        const msgHeader = el("div");
        msgHeader.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;";
        const msgLabel = el(
          "span",
          "small-text",
          t.completed && t.sent_at
            ? "💬 WhatsApp Message Dispatched by Nyra Rose:"
            : "💬 Exact WhatsApp Message Nyra Rose Will Send at Scheduled Time:",
        );
        msgLabel.style.cssText = "color:var(--rose-light); font-weight:600; font-size:11.5px;";
        const editHint = el("span", "small-text muted", "✏️ Click to rewrite message or change time");
        editHint.style.fontSize = "11px";
        msgHeader.append(msgLabel, editHint);

        const msgBody = el(
          "div",
          null,
          t.ai_message || "(No message drafted yet — click here to write the WhatsApp message Nyra will send)",
        );
        msgBody.style.cssText = "color:var(--text); font-size:13.5px; line-height:1.45; white-space:pre-wrap;";
        msgBox.append(msgHeader, msgBody);
        card.append(msgBox);
      }

      // Action controls row
      const actions = el("div", "todo-actions-dock");

      const leftBtns = el("div");
      leftBtns.style.cssText = "display:flex; gap:6px; flex-wrap:wrap; align-items:center;";

      const editBtn = el("button", "ghost small", "✏️ Edit Time / Message");
      editBtn.type = "button";
      editBtn.style.borderColor = "rgba(244, 63, 94, 0.38)";
      editBtn.style.color = "var(--rose-light)";
      editBtn.addEventListener("click", () => openTodoEditModal(t));
      leftBtns.append(editBtn);

      if (!t.completed && (t.phone || (t.chat_id && t.chat_id !== "dashboard"))) {
        const sendNowBtn = el("button", "small btn-tone-emerald", "🚀 Send Now via Nyra");
        sendNowBtn.type = "button";
        sendNowBtn.addEventListener("click", async () => {
          sendNowBtn.disabled = true;
          sendNowBtn.textContent = "⏳ Sending...";
          try {
            await api("POST", "/api/todos/send", { id: t.id, customText: t.ai_message });
            await loadTodos();
          } catch (err) {
            alert(`Failed to send via WhatsApp: ${err.message}`);
            sendNowBtn.disabled = false;
            sendNowBtn.textContent = "🚀 Send Now via Nyra";
          }
        });
        leftBtns.append(sendNowBtn);
      }

      if (!t.completed) {
        const plus1hBtn = el("button", "ghost small", "⏱ +1h");
        plus1hBtn.type = "button";
        plus1hBtn.title = "Push scheduled time forward by 1 hour";
        plus1hBtn.addEventListener("click", async () => {
          const base = t.scheduled_at_ms && t.scheduled_at_ms > Date.now() ? t.scheduled_at_ms : Date.now();
          const nextMs = base + 3600000;
          await api("PATCH", "/api/todos", { id: t.id, scheduledAtMs: nextMs, dueDate: formatBdtClock(nextMs) });
          await loadTodos();
        });

        const tmrwBtn = el("button", "ghost small", "🌅 Tomorrow 11 AM");
        tmrwBtn.type = "button";
        tmrwBtn.title = "Reschedule to Tomorrow 11:00 AM BDT";
        tmrwBtn.addEventListener("click", async () => {
          const nextMs = parseClientNaturalTimeToMs("Tomorrow 11:00 AM");
          await api("PATCH", "/api/todos", {
            id: t.id,
            scheduledAtMs: nextMs,
            timePhrase: "Tomorrow 11:00 AM",
            dueDate: formatBdtClock(nextMs),
          });
          await loadTodos();
        });

        leftBtns.append(plus1hBtn, tmrwBtn);
      }

      const rightBtns = el("div");
      rightBtns.style.cssText = "display:flex; gap:6px; align-items:center;";

      const togBtn = el("button", "ghost small", t.completed ? "↺ Reopen Task" : "✓ Mark Done");
      togBtn.type = "button";
      togBtn.addEventListener("click", async () => {
        const next = !t.completed;
        await api("PATCH", "/api/todos", { id: t.id, completed: next });
        await loadTodos();
      });

      const delBtn = el("button", "danger small", "🗑️ Delete");
      delBtn.type = "button";
      delBtn.addEventListener("click", async () => {
        if (!confirm("Delete this scheduled task?")) return;
        await api("DELETE", `/api/todos?id=${t.id}`);
        todos = todos.filter((x) => x.id !== t.id);
        updateTodoStats();
        renderTodos();
        renderHomeTodayTasks();
      });

      rightBtns.append(togBtn, delBtn);
      actions.append(leftBtns, rightBtns);
      card.append(actions);
      return card;
    }),
  );
}

// Smart Natural-Language Quick-Add Parser
function parseQuickTodoInput(raw) {
  let text = raw.trim();
  let aiMessage = "";

  // 1. Check for message separator: " — ", " -- ", " | ", " with msg ", " with message ", " msg: "
  const msgSplitRegex = /\s+(?:—|--|\||with\s+msg|with\s+message|msg:)\s+/i;
  const splitMatch = text.match(msgSplitRegex);
  if (splitMatch && splitMatch.index !== undefined) {
    aiMessage = text.slice(splitMatch.index + splitMatch[0].length).trim();
    text = text.slice(0, splitMatch.index).trim();
  }

  // 2. Match existing client from todoBookingsCache or bookings
  const allLeads = todoBookingsCache.length > 0 ? todoBookingsCache : bookings;
  let matchedLead = null;
  const lowerText = text.toLowerCase();
  for (const b of allLeads) {
    const cName = (b.client_name || "").trim();
    if (cName && cName.length >= 2 && lowerText.includes(cName.toLowerCase())) {
      matchedLead = b;
      break;
    }
    const cPhone = String(b.phone || "").replace(/[^\d]/g, "");
    if (cPhone && cPhone.length >= 7 && lowerText.includes(cPhone)) {
      matchedLead = b;
      break;
    }
  }

  // Also check if raw text contains a phone number directly
  let extractedPhone = matchedLead?.phone || "";
  if (!extractedPhone) {
    const phoneMatch = text.match(/(?:\+?\d[\d\s-]{7,15}\d)/);
    if (phoneMatch) {
      extractedPhone = phoneMatch[0].replace(/[^\d]/g, "");
    }
  }

  const clientName = matchedLead?.client_name || "";
  const bookingId = matchedLead?.id || undefined;
  const timePhrase = text;
  const scheduledAtMs = parseClientNaturalTimeToMs(text) || undefined;

  if (!aiMessage && (clientName || extractedPhone || /follow\s*up|knock|msg|message|call/i.test(text))) {
    aiMessage = matchedLead?.custom_followup_msg || generateSmartAiDraft(clientName, "manual_ai", "");
  }

  const taskType = clientName || extractedPhone ? "manual_ai" : "general";

  return {
    task: text,
    timePhrase,
    scheduledAtMs,
    clientName: clientName || undefined,
    phone: extractedPhone || undefined,
    bookingId,
    aiMessage: aiMessage || undefined,
    taskType,
    autoSend: Boolean(extractedPhone),
  };
}

$("#new-todo-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#todo-input");
  const raw = input?.value?.trim() || "";
  if (!raw) return;
  const parsed = parseQuickTodoInput(raw);
  const res = await api("POST", "/api/todos", {
    ...parsed,
    chatId: "dashboard",
  });
  if (res.todo) {
    await loadTodos();
  }
  input.value = "";
});

// Filter tabs & Search in #tab-todos
document.querySelectorAll(".todo-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".todo-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
    todoFilter = btn.dataset.filter || "active";
    renderTodos();
  });
});

$("#todos-search")?.addEventListener("input", (e) => {
  todoSearch = e.target.value || "";
  renderTodos();
});

$("#refresh-todos-btn")?.addEventListener("click", () => {
  loadTodos();
});

// ─── Full AI Follow-Up & Task Composer (#ai-todo-composer) with 2-Way Sync ──

function getComposerRecordContext() {
  const bId = $("#todo-client-select")?.value;
  const list = todoBookingsCache.length > 0 ? todoBookingsCache : bookings;
  const found = bId ? list.find((x) => x.id === bId) : null;
  const phone = $("#todo-phone")?.value?.trim() || found?.phone || found?.chat_id || "";
  return { phone, timezone: found?.timezone || null };
}

function getEditModalRecordContext() {
  const t = todos.find((x) => x.id === currentEditingTodoId) || null;
  const list = todoBookingsCache.length > 0 ? todoBookingsCache : bookings;
  const linked = t?.booking_id ? list.find((x) => x.id === t.booking_id) : null;
  const phone = $("#edit-todo-phone")?.value?.trim() || t?.phone || linked?.phone || t?.chat_id || "";
  return { phone, timezone: t?.timezone || linked?.timezone || null };
}

function syncComposerTimeFromMs(ms, updateNatural = true, updateExact = true) {
  composerScheduledMs = ms;
  if (updateNatural && $("#todo-time-phrase")) {
    $("#todo-time-phrase").value = ms ? formatSingleTzClock(ms, 6, "BDT") : "";
  }
  if (updateExact && $("#todo-datetime-picker")) {
    $("#todo-datetime-picker").value = ms ? msToBdtDatetimeLocal(ms) : "";
  }
  updateLiveTimerBadgeEl($("#composer-todo-live-timer"), ms, getComposerRecordContext());
}

$("#todo-phone")?.addEventListener("input", () => {
  if (composerScheduledMs) {
    updateLiveTimerBadgeEl($("#composer-todo-live-timer"), composerScheduledMs, getComposerRecordContext());
  }
});

$("#toggle-ai-todo-composer-btn")?.addEventListener("click", () => {
  const comp = $("#ai-todo-composer");
  if (!comp) return;
  comp.classList.toggle("hidden");
  populateTodoClientSelect();
  if (!comp.classList.contains("hidden") && !composerScheduledMs) {
    syncComposerTimeFromMs(Date.now() + 3600000, true, true);
  }
});

$("#cancel-ai-todo-composer-btn")?.addEventListener("click", () => {
  $("#ai-todo-composer")?.classList.add("hidden");
  if ($("#todo-composer-error")) $("#todo-composer-error").textContent = "";
});

$("#todo-client-select")?.addEventListener("change", (e) => {
  const bId = e.target.value;
  const list = todoBookingsCache.length > 0 ? todoBookingsCache : bookings;
  const found = list.find((x) => x.id === bId);
  if (!found) return;
  if ($("#todo-client-name")) $("#todo-client-name").value = found.client_name || "";
  if ($("#todo-phone")) $("#todo-phone").value = found.phone || "";
  if ($("#todo-title-input") && !$("#todo-title-input").value.trim()) {
    $("#todo-title-input").value = `Follow up ${found.client_name || found.phone || "Client"}`;
  }
  if (found.next_followup_at) {
    syncComposerTimeFromMs(found.next_followup_at, true, true);
  } else if (composerScheduledMs) {
    updateLiveTimerBadgeEl($("#composer-todo-live-timer"), composerScheduledMs, getComposerRecordContext());
  }
  if ($("#todo-ai-message") && !$("#todo-ai-message").value.trim()) {
    $("#todo-ai-message").value =
      found.custom_followup_msg || generateSmartAiDraft(found.client_name, $("#todo-task-type")?.value || "manual_ai", "");
  }
});

// 2-Way Sync in Composer: Quick Slots -> Natural + Exact + Live Timer
document.querySelectorAll(".todo-quick-slot").forEach((btn) => {
  btn.addEventListener("click", () => {
    const phrase = btn.dataset.phrase || "";
    const ms = parseClientNaturalTimeToMs(phrase);
    if (ms) {
      syncComposerTimeFromMs(ms, true, true);
    } else if ($("#todo-time-phrase")) {
      $("#todo-time-phrase").value = phrase;
    }
  });
});

// 2-Way Sync in Composer: Exact Date/Time Picker -> Natural Time + Live Timer
["input", "change"].forEach((evt) => {
  $("#todo-datetime-picker")?.addEventListener(evt, (e) => {
    const ms = bdtDatetimeLocalToMs(e.target.value);
    if (ms) {
      syncComposerTimeFromMs(ms, true, false);
    }
  });
});

// 2-Way Sync in Composer: Natural Time Input -> Exact Date/Time Picker + Live Timer
["input", "change"].forEach((evt) => {
  $("#todo-time-phrase")?.addEventListener(evt, (e) => {
    const ms = parseClientNaturalTimeToMs(e.target.value);
    if (ms) {
      syncComposerTimeFromMs(ms, false, true);
    }
  });
});

$("#todo-generate-msg-btn")?.addEventListener("click", () => {
  const cName = $("#todo-client-name")?.value?.trim() || "";
  const tType = $("#todo-task-type")?.value || "manual_ai";
  const tPhrase = $("#todo-time-phrase")?.value?.trim() || "";
  if ($("#todo-ai-message")) {
    $("#todo-ai-message").value = generateSmartAiDraft(cName, tType, tPhrase);
  }
});

$("#ai-todo-composer")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#todo-composer-error");
  if (errEl) errEl.textContent = "";

  const bookingId = $("#todo-client-select")?.value || undefined;
  const clientName = $("#todo-client-name")?.value?.trim() || "";
  const phone = $("#todo-phone")?.value?.trim() || "";
  const taskType = $("#todo-task-type")?.value || "manual_ai";
  const timePhrase = $("#todo-time-phrase")?.value?.trim() || "";
  const dtVal = $("#todo-datetime-picker")?.value || "";
  const resolvedMs =
    composerScheduledMs ||
    (dtVal ? bdtDatetimeLocalToMs(dtVal) : null) ||
    (timePhrase ? parseClientNaturalTimeToMs(timePhrase) : null) ||
    undefined;
  const rawTitle = $("#todo-title-input")?.value?.trim() || "";
  const aiMessage = $("#todo-ai-message")?.value?.trim() || "";
  const autoSend = $("#todo-auto-send") ? $("#todo-auto-send").checked : true;

  const task = rawTitle || (clientName ? `Follow up ${clientName}` : "Scheduled AI Follow-Up");
  if (!timePhrase && !resolvedMs && !rawTitle) {
    if (errEl) errEl.textContent = "Please enter a time (e.g. 'Today 1pm') or task title.";
    return;
  }

  try {
    await api("POST", "/api/todos", {
      task,
      bookingId,
      clientName: clientName || undefined,
      phone: phone || undefined,
      taskType,
      timePhrase: resolvedMs ? formatSingleTzClock(resolvedMs, 6, "BDT") : timePhrase || undefined,
      dueDate: resolvedMs ? formatSingleTzClock(resolvedMs, 6, "BDT") : timePhrase || undefined,
      scheduledAtMs: resolvedMs,
      aiMessage: aiMessage || generateSmartAiDraft(clientName, taskType, timePhrase),
      autoSend,
      chatId: phone ? `${phone.replace(/[^\d]/g, "")}@s.whatsapp.net` : "dashboard",
    });
    $("#ai-todo-composer").reset();
    composerScheduledMs = null;
    $("#ai-todo-composer").classList.add("hidden");
    await loadTodos();
  } catch (err) {
    if (errEl) errEl.textContent = err.message || "Failed to save scheduled task";
  }
});

// ─── Re-Edit Task & AI Message Modal (#todo-edit-modal) with 2-Way Sync ──────

function syncEditModalTimeFromMs(ms, updateNatural = true, updateExact = true) {
  editModalScheduledMs = ms;
  if (updateNatural && $("#edit-todo-time-phrase")) {
    $("#edit-todo-time-phrase").value = ms ? formatSingleTzClock(ms, 6, "BDT") : "";
  }
  if (updateExact && $("#edit-todo-datetime")) {
    $("#edit-todo-datetime").value = ms ? msToBdtDatetimeLocal(ms) : "";
  }
  updateLiveTimerBadgeEl($("#edit-todo-live-timer"), ms, getEditModalRecordContext());
}

$("#edit-todo-phone")?.addEventListener("input", () => {
  if (editModalScheduledMs) {
    updateLiveTimerBadgeEl($("#edit-todo-live-timer"), editModalScheduledMs, getEditModalRecordContext());
  }
});

function openTodoEditModal(t) {
  currentEditingTodoId = t.id;
  const modal = $("#todo-edit-modal");
  if (!modal) return;

  if ($("#todo-edit-modal-title")) {
    $("#todo-edit-modal-title").textContent = `✏️ Edit Scheduled Task & AI Message — ${t.client_name || t.task}`;
  }
  if ($("#edit-todo-task")) $("#edit-todo-task").value = t.task || "";
  if ($("#edit-todo-type")) $("#edit-todo-type").value = t.task_type || "client_followup";
  if ($("#edit-todo-client-name")) $("#edit-todo-client-name").value = t.client_name || "";
  if ($("#edit-todo-phone")) $("#edit-todo-phone").value = t.phone || "";

  // Populate BOTH Natural Time AND Exact Date & Time Picker in sync!
  const initialMs = t.scheduled_at_ms || parseClientNaturalTimeToMs(t.due_date || "") || Date.now() + 3600000;
  syncEditModalTimeFromMs(initialMs, true, true);

  if ($("#edit-todo-ai-message")) {
    $("#edit-todo-ai-message").value =
      t.ai_message || generateSmartAiDraft(t.client_name, t.task_type || "client_followup", t.due_date || "");
  }
  if ($("#edit-todo-auto-send")) {
    $("#edit-todo-auto-send").checked = t.auto_send !== undefined ? Boolean(t.auto_send) : true;
  }
  if ($("#todo-edit-feedback")) $("#todo-edit-feedback").textContent = "";

  modal.classList.remove("hidden");
  modal.style.display = "flex";
}

function closeTodoEditModal() {
  const modal = $("#todo-edit-modal");
  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
  currentEditingTodoId = null;
  editModalScheduledMs = null;
}

$("#close-todo-edit-modal")?.addEventListener("click", closeTodoEditModal);
$("#cancel-todo-edit-btn")?.addEventListener("click", closeTodoEditModal);

// 1. Quick Slot Buttons inside Edit Modal -> Sync Natural Time + Exact Picker + Live Timer
document.querySelectorAll(".edit-todo-slot").forEach((btn) => {
  btn.addEventListener("click", () => {
    const phrase = btn.dataset.phrase || "";
    const ms = parseClientNaturalTimeToMs(phrase);
    if (ms) {
      syncEditModalTimeFromMs(ms, true, true);
    } else if ($("#edit-todo-time-phrase")) {
      $("#edit-todo-time-phrase").value = phrase;
    }
  });
});

// 2. Exact Date & Time Picker inside Edit Modal -> Immediately syncs Natural Time + Live Timer!
["input", "change"].forEach((evt) => {
  $("#edit-todo-datetime")?.addEventListener(evt, (e) => {
    const ms = bdtDatetimeLocalToMs(e.target.value);
    if (ms) {
      syncEditModalTimeFromMs(ms, true, false);
    }
  });
});

// 3. Natural Time Input inside Edit Modal -> Immediately syncs Exact Date & Time Picker + Live Timer!
["input", "change"].forEach((evt) => {
  $("#edit-todo-time-phrase")?.addEventListener(evt, (e) => {
    const ms = parseClientNaturalTimeToMs(e.target.value);
    if (ms) {
      syncEditModalTimeFromMs(ms, false, true);
    }
  });
});

async function saveCurrentTodoEdits() {
  if (!currentEditingTodoId) return null;
  const task = $("#edit-todo-task")?.value?.trim() || "";
  const taskType = $("#edit-todo-type")?.value || "client_followup";
  const clientName = $("#edit-todo-client-name")?.value?.trim() || "";
  const phone = $("#edit-todo-phone")?.value?.trim() || "";
  const rawTimePhrase = $("#edit-todo-time-phrase")?.value?.trim() || "";
  const dtVal = $("#edit-todo-datetime")?.value || "";
  const aiMessage = $("#edit-todo-ai-message")?.value?.trim() || "";
  const autoSend = $("#edit-todo-auto-send") ? $("#edit-todo-auto-send").checked : true;

  // Resolve the final timestamp from the 2-way synced state
  const finalMs =
    editModalScheduledMs ||
    (dtVal ? bdtDatetimeLocalToMs(dtVal) : null) ||
    (rawTimePhrase ? parseClientNaturalTimeToMs(rawTimePhrase) : null);

  const formattedNatural = finalMs ? formatBdtClock(finalMs) : rawTimePhrase || undefined;

  const payload = {
    id: currentEditingTodoId,
    task,
    taskType,
    clientName,
    phone,
    aiMessage,
    autoSend,
    scheduledAtMs: finalMs || undefined,
    dueDate: formattedNatural,
    timePhrase: formattedNatural,
  };

  const res = await api("PATCH", "/api/todos", payload);
  if (res.booking && bookings.length > 0) {
    const idx = bookings.findIndex((b) => b.id === res.booking.id);
    if (idx !== -1) {
      bookings[idx] = res.booking;
      updateBookingStats();
      renderBookings();
    }
  }
  return res.todo;
}

$("#save-todo-edit-btn")?.addEventListener("click", async () => {
  const btn = $("#save-todo-edit-btn");
  const fb = $("#todo-edit-feedback");
  if (btn) btn.disabled = true;
  if (fb) {
    fb.style.color = "#93c5fd";
    fb.textContent = "Saving task & syncing with Nyra's follow-up timer...";
  }
  try {
    await saveCurrentTodoEdits();
    await loadTodos();
    if (typeof loadBookings === "function") {
      loadBookings().catch(() => {});
    }
    if (fb) {
      fb.style.color = "#34d399";
      fb.textContent = "✅ Saved & synced! Natural time, exact time & next follow-up timer updated ✓";
    }
    setTimeout(() => closeTodoEditModal(), 650);
  } catch (err) {
    if (fb) {
      fb.style.color = "var(--red)";
      fb.textContent = `⚠️ ${err.message}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

$("#send-todo-now-btn")?.addEventListener("click", async () => {
  if (!currentEditingTodoId) return;
  const btn = $("#send-todo-now-btn");
  const fb = $("#todo-edit-feedback");
  if (btn) btn.disabled = true;
  if (fb) {
    fb.style.color = "#93c5fd";
    fb.textContent = "Saving changes & queuing message to Nyra's WhatsApp Gateway...";
  }
  try {
    await saveCurrentTodoEdits();
    const customText = $("#edit-todo-ai-message")?.value?.trim() || "";
    await api("POST", "/api/todos/send", {
      id: currentEditingTodoId,
      customText,
    });
    await loadTodos();
    if (fb) {
      fb.style.color = "#34d399";
      fb.textContent = "🚀 Queued to Nyra's WhatsApp! Will deliver on next gateway heartbeat (≤30s) ✓";
    }
    setTimeout(() => closeTodoEditModal(), 1000);
  } catch (err) {
    if (fb) {
      fb.style.color = "var(--red)";
      fb.textContent = `⚠️ ${err.message}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
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
  const tzInfo = resolveRecordTimezoneInfo(b);
  const isCallReminder = fType === "call_reminder" || (fType === "auto" && (b.status === "booked" || b.status === "confirmed"));
  if (isCallReminder && b.call_time_ms && b.call_time_ms <= now && (!b.next_followup_at || b.next_followup_at <= now)) {
    const localCall = formatSingleTzClock(b.call_time_ms, 6, "BDT", now);
    const clientCall = tzInfo && tzInfo.isForeign ? ` · Client: ${formatSingleTzClock(b.call_time_ms, tzInfo.offset, tzInfo.code, now)}` : "";
    return `⏰ Call Time Passed (Local: ${localCall}${clientCall})`;
  }
  if (!b.next_followup_at) {
    if (isCallReminder) {
      if (b.call_time_ms && b.call_time_ms > now) {
        const localCall = formatSingleTzClock(b.call_time_ms, 6, "BDT", now);
        const clientCall = tzInfo && tzInfo.isForeign ? ` · Client: ${formatSingleTzClock(b.call_time_ms, tzInfo.offset, tzInfo.code, now)}` : "";
        return `🔔 Call — Local: ${localCall}${clientCall}`;
      }
      return "🔔 Call Booked (Sales Follow-Up Stopped)";
    }
    return "⏱️ No Timer Set";
  }
  const diffMs = b.next_followup_at - now;
  const prefix = isCallReminder ? "🔔 30m Call Reminder" : "⏱️ Next Follow-Up";
  const localTimeStr = formatSingleTzClock(b.next_followup_at, 6, "BDT", now);
  const clientTimeSuffix =
    tzInfo && tzInfo.isForeign
      ? ` · 🌍 Client: ${formatSingleTzClock(b.next_followup_at, tzInfo.offset, tzInfo.code, now)}`
      : "";
  if (diffMs <= 0) {
    return `${prefix}: Due Now (Local: ${localTimeStr}${clientTimeSuffix})`;
  }
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) {
    return `${prefix}: Local ${localTimeStr}${clientTimeSuffix} (in ${mins}m)`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 48) {
    return `${prefix}: Local ${localTimeStr}${clientTimeSuffix} (in ${hours}h${remMins > 0 ? ` ${remMins}m` : ""})`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${prefix}: Local ${localTimeStr}${clientTimeSuffix} (in ${days}d${remHours > 0 ? ` ${remHours}h` : ""})`;
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
        "empty-state-box",
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
      const tzInfo = resolveRecordTimezoneInfo(b);

      // Top row: Title + badges + live timer badge
      const top = el("div", "booking-top");
      const clientTitle = el("div", "booking-client-title");
      clientTitle.style.flexWrap = "wrap";
      const clientDigits = cleanPhoneDigits(b.phone || b.chat_id);
      const isClientChatPaused = isChatInstantPaused(clientDigits);
      const isGlobalInstantPaused = Boolean(overview?.settings?.instantReplyPaused);
      clientTitle.append(
        el("span", "lead-avatar", getMonogram(b.client_name || "Lead")),
        el("span", null, b.client_name || "Lead Client"),
        el("span", `badge badge-${b.status || "booked"}`, STATUS_LABELS[b.status] || b.status),
        el("span", `badge badge-${fType}`, FOLLOWUP_LABELS[fType] || fType),
        el("span", "badge badge-timer", formatNextFollowupTimer(b)),
        el("span", "badge badge-source", b.source === "dashboard" ? "MANUAL" : "WHATSAPP")
      );
      if (isClientChatPaused || isGlobalInstantPaused) {
        const pausedBadge = el(
          "span",
          "badge badge-booked",
          isClientChatPaused ? "⏸️ Instant Chat Paused (Follow-Ups ON)" : "⏸️ Global Instant Pause (Follow-Ups ON)"
        );
        clientTitle.appendChild(pausedBadge);
      }
      top.appendChild(clientTitle);

      // Contact row (Email, WhatsApp, Client Original Timezone from Country Code, Website)
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
      if (tzInfo) {
        const tzPill = el("span", "booking-link-pill", `🌐 Client Original TZ: ${tzInfo.fullBadge}`);
        if (tzInfo.isForeign) {
          tzPill.style.background = "rgba(56, 189, 248, 0.14)";
          tzPill.style.color = "#7dd3fc";
          tzPill.style.borderColor = "rgba(56, 189, 248, 0.35)";
        }
        contactRow.appendChild(tzPill);
      } else if (b.timezone) {
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

      // Scheduled time banner — shows BOTH Calculated Local Time (BDT) and Client Original Timezone
      let schedBox = null;
      const isCall = fType === "call_reminder" || (fType === "auto" && (b.status === "booked" || b.status === "confirmed"));
      const refMs = isCall ? b.call_time_ms || b.next_followup_at : b.next_followup_at;
      if (b.scheduled_at || refMs) {
        const isPastCall = isCall && b.call_time_ms && b.call_time_ms <= Date.now();
        let timeBreakdown = b.scheduled_at || "";
        if (refMs) {
          const localBdtClock = formatSingleTzClock(refMs, 6, "BDT");
          if (tzInfo && tzInfo.isForeign) {
            const clientOrigClock = formatSingleTzClock(refMs, tzInfo.offset, tzInfo.code);
            timeBreakdown = `🇧🇩 Local Time (Calculated): ${localBdtClock}   ⇄   🌍 Client Original: ${clientOrigClock} (${tzInfo.shortCountry})`;
          } else {
            timeBreakdown = `🇧🇩 Local Time (BDT): ${localBdtClock}${b.scheduled_at ? ` · (${b.scheduled_at})` : ""}`;
          }
        }
        schedBox = el(
          "div",
          "booking-scheduled-box",
          `${isCall ? "📅 Booked Call Time" : "📅 Client Follow-Up Schedule"} — ${timeBreakdown}${
            isPastCall
              ? " · ⏰ Call Time Passed (Update status or reschedule if needed)"
              : isCall
              ? " · 🔔 Auto 30m Pre-Call Reminder Active"
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
        statusGuidance.style.background = "rgba(225, 29, 72, 0.08)";
      } else if (fType === "rejected" || b.status === "not_interested") {
        statusGuidance = el(
          "div",
          "booking-notes-box",
          "🛑 Lead marked as REJECTED / NO FOLLOW-UP. All sales follow-ups and automated messages are strictly stopped."
        );
        statusGuidance.style.borderLeftColor = "#ef4444";
        statusGuidance.style.background = "rgba(239, 68, 68, 0.08)";
      } else if (isCall) {
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
        followupBtn.classList.add("danger");
      } else if (isCall) {
        followupBtn.textContent = "🔔 30m Reminder / Timer";
        followupBtn.classList.add("btn-tone-amber");
      } else {
        followupBtn.textContent = "⚡ Follow Up & Timer";
        if (fType === "not_attended" || b.status === "not_attended") {
          followupBtn.classList.add("danger");
        } else if (fType === "buy_soon" || b.status === "buy_soon") {
          followupBtn.classList.add("btn-tone-sky");
        } else if (fType === "on_hold") {
          followupBtn.classList.add("btn-tone-amber");
        } else if (fType === "nurture") {
          followupBtn.classList.add("btn-tone-violet");
        }
      }
      followupBtn.addEventListener("click", () => openFollowupModal(b));

      // Per-client Pause Instant Chat button (keeps follow-ups active)
      let pauseChatBtn = null;
      if (clientDigits && clientDigits.length >= 6) {
        pauseChatBtn = el(
          "button",
          `small ${isClientChatPaused ? "btn-tone-emerald" : "btn-tone-amber"}`,
          isClientChatPaused ? "▶️ Resume Instant Chat" : "⏸️ Pause Instant Chat"
        );
        pauseChatBtn.title = "Pause instant AI replies for this client so a human can chat manually, while keeping scheduled follow-ups active";
        pauseChatBtn.addEventListener("click", async () => {
          await toggleChatInstantPause(clientDigits);
        });
      }

      const delBtn = el("button", "danger small", "Delete");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete booking record for ${b.client_name || b.email || "this client"}?`)) return;
        await api("DELETE", `/api/bookings?id=${b.id}`);
        bookings = bookings.filter((x) => x.id !== b.id);
        updateBookingStats();
        renderBookings();
      });

      if (pauseChatBtn) {
        rightControls.append(followupBtn, pauseChatBtn, timerSelect, followupSelect, statusSelect, delBtn);
      } else {
        rightControls.append(followupBtn, timerSelect, followupSelect, statusSelect, delBtn);
      }
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

  const customDtInput = $("#modal-custom-datetime");
  if (customDtInput) {
    customDtInput.value = msToBdtDatetimeLocal(b.next_followup_at || Date.now() + 3600000);
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
  const isCall = fType === "call_reminder" || (fType === "auto" && (b.status === "booked" || b.status === "confirmed"));
  if (b.status === "fake_lead") {
    alertBox.textContent = "🕵️ Fake Lead (30 days no reply). Automated follow-ups are stopped.";
    alertBox.style.background = "#e11d4822";
    alertBox.style.color = "#fda4af";
  } else if (fType === "rejected" || b.status === "not_interested") {
    alertBox.textContent = "🛑 Lead marked as Rejected / Not Interested. All sales outreach is stopped.";
    alertBox.style.background = "#ef444422";
    alertBox.style.color = "#f87171";
  } else if (isCall) {
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
    alertBox.style.background = "var(--surface-inset)";
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
        const customDtInput = $("#modal-custom-datetime");
        if (customDtInput && found.next_followup_at) {
          customDtInput.value = msToBdtDatetimeLocal(found.next_followup_at);
        }
        updateModalAlert(found);
        updateBookingStats();
        renderBookings();
        loadTodos().catch(() => {});
      }
      $("#followup-feedback").textContent = `⏱️ Timer set! Next auto follow-up will send in ${hours} hour(s) ✓`;
    } catch (err) {
      $("#followup-feedback").textContent = `Error setting timer: ${err.message}`;
    }
  });
});

// Live preview when picking Exact Date/Time inside CRM Modal
["input", "change"].forEach((evt) => {
  $("#modal-custom-datetime")?.addEventListener(evt, (e) => {
    const ts = bdtDatetimeLocalToMs(e.target.value);
    if (ts && currentFollowupBookingId) {
      const found = bookings.find((x) => x.id === currentFollowupBookingId);
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) {
        timerBadge.textContent = formatNextFollowupTimer({
          ...(found || {}),
          followup_type: "client_date",
          next_followup_at: ts,
        });
      }
    }
  });
});

// Exact Date/Time Picker Save inside CRM Modal
$("#modal-save-datetime-btn")?.addEventListener("click", async () => {
  if (!currentFollowupBookingId) return;
  const val = $("#modal-custom-datetime")?.value;
  if (!val) {
    $("#followup-feedback").textContent = "Please pick a date and time first.";
    return;
  }
  const ts = bdtDatetimeLocalToMs(val);
  if (!ts || Number.isNaN(ts)) {
    $("#followup-feedback").textContent = "Invalid date/time.";
    return;
  }
  try {
    const naturalFormatted = formatBdtClock(ts);
    const res = await api("PATCH", "/api/bookings", {
      id: currentFollowupBookingId,
      customFollowupAt: ts,
      followup_type: "client_date",
      scheduled_at: `Follow-up: ${naturalFormatted}`,
    });
    const found = bookings.find((x) => x.id === currentFollowupBookingId);
    if (found && res.booking) {
      Object.assign(found, res.booking);
      const modalStrategySelect = $("#modal-followup-type");
      if (modalStrategySelect) modalStrategySelect.value = found.followup_type;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
      updateModalAlert(found);
      updateBookingStats();
      renderBookings();
      loadTodos().catch(() => {});
    }
    $("#followup-feedback").textContent = `📅 Scheduled follow-up for ${naturalFormatted} ✓`;
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
    if (found) {
      if (res.status) found.status = res.status;
      if (res.followupType) found.followup_type = res.followupType;
      if (res.nextFollowupAt !== undefined) found.next_followup_at = res.nextFollowupAt;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
      updateModalAlert(found);
    }
    const sendBtn = $("#followup-send-wa-btn");
    if (res.waLink) {
      sendBtn.href = res.waLink;
      sendBtn.style.display = "inline-flex";
    } else {
      sendBtn.style.display = "none";
    }
    updateBookingStats();
    renderBookings();
  } catch (err) {
    $("#followup-text").value = `[Follow-up Stopped]: ${err.message}`;
    $("#followup-send-wa-btn").style.display = "none";
    updateBookingStats();
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
    const customText = $("#followup-text")?.value?.trim();
    const res = await api("POST", "/api/bookings/followup", {
      id: currentFollowupBookingId,
      markSent: true,
      sendViaGateway: true,
      customText: customText && !customText.startsWith("[Follow-up Stopped]") ? customText : undefined,
    });
    const found = bookings.find((x) => x.id === currentFollowupBookingId);
    if (found) {
      found.followup_count = res.followupCount;
      found.last_followup_at = res.lastFollowupAt;
      found.next_followup_at = res.nextFollowupAt;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
      updateBookingStats();
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
    const customText = $("#followup-text")?.value?.trim();
    const res = await api("POST", "/api/bookings/followup", {
      id: currentFollowupBookingId,
      markSent: true,
      customText: customText && !customText.startsWith("[Follow-up Stopped]") ? customText : undefined,
    });
    const found = bookings.find((x) => x.id === currentFollowupBookingId);
    if (found) {
      found.followup_count = res.followupCount;
      found.last_followup_at = res.lastFollowupAt;
      found.next_followup_at = res.nextFollowupAt;
      const timerBadge = $("#modal-next-followup-badge");
      if (timerBadge) timerBadge.textContent = formatNextFollowupTimer(found);
      updateBookingStats();
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
    if (clientModelDisplay) {
      const labelText = s.modelLabel || s.model || "Nyra Rose Intelligence 🌹";
      clientModelDisplay.replaceChildren(
        Object.assign(el("option", null, `${labelText} — Flagship Neural Engine (Active)`), { value: labelText })
      );
    }
    if (adminOnlyFieldset) adminOnlyFieldset.classList.add("hidden");
  } else {
    if (adminModelGroup) adminModelGroup.classList.remove("hidden");
    if (clientModelGroup) clientModelGroup.classList.add("hidden");
    if (adminOnlyFieldset) adminOnlyFieldset.classList.remove("hidden");

    $("#model-select").replaceChildren(...(models || []).map((m) => Object.assign(el("option", null, m.label), { value: m.id })));
    if (f.model) f.model.value = s.model;
    if (f.publicModelName) f.publicModelName.value = s.publicModelName || "";
  }

  const passInput = $("#mgmt-password-input");
  if (passInput) {
    passInput.value = s.clientPassword || "";
  }

  f.enabled.checked = Boolean(s.enabled);
  if (f.instantReplyPaused) f.instantReplyPaused.checked = Boolean(s.instantReplyPaused);
  if (f.pausedInstantChats) f.pausedInstantChats.value = (s.pausedInstantChats || []).join("\n");
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

$("#mgmt-toggle-pass-btn")?.addEventListener("click", () => {
  const input = $("#mgmt-password-input");
  const btn = $("#mgmt-toggle-pass-btn");
  if (!input || !btn) return;
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "🙈 Hide";
  } else {
    input.type = "password";
    btn.textContent = "👁️ Show";
  }
});

$("#mgmt-save-pass-btn")?.addEventListener("click", async () => {
  const input = $("#mgmt-password-input");
  const feedback = $("#mgmt-pass-feedback");
  const btn = $("#mgmt-save-pass-btn");
  const newPass = input?.value?.trim() || "";
  if (newPass.length < 4) {
    if (feedback) {
      feedback.textContent = "⚠️ Password must be at least 4 characters.";
      feedback.style.color = "var(--red)";
    }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const isClient = overview?.role === "client";
    const { settings } = await api("PUT", "/api/settings", { clientPassword: newPass });
    if (overview?.settings) {
      overview.settings.clientPassword = settings?.clientPassword || newPass;
    }
    if (isClient) {
      password = newPass;
      localStorage.setItem("nr_password", newPass);
    }
    if (feedback) {
      feedback.textContent = "🔑 Password updated! Your new login password is now active ✓";
      feedback.style.color = "#34d399";
    }
  } catch (err) {
    if (feedback) {
      feedback.textContent = `⚠️ ${err.message}`;
      feedback.style.color = "var(--red)";
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

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
    const newPass = $("#mgmt-password-input")?.value?.trim();
    const payload = {
      enabled: f.enabled.checked,
      instantReplyPaused: f.instantReplyPaused ? f.instantReplyPaused.checked : Boolean(overview?.settings?.instantReplyPaused),
      pausedInstantChats: f.pausedInstantChats
        ? f.pausedInstantChats.value
            .split(/[\n,]/)
            .map((x) => cleanPhoneDigits(x))
            .filter((x) => x.length >= 6)
        : overview?.settings?.pausedInstantChats || [],
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

    if (newPass && newPass.length >= 4) {
      payload.clientPassword = newPass;
    }

    if (!isClient) {
      if (f.model) payload.model = f.model.value;
      if (f.publicModelName) payload.publicModelName = f.publicModelName.value;
    }

    const { settings } = await api("PUT", "/api/settings", payload);
    overview.settings = { ...overview.settings, ...settings };
    if (isClient && newPass && newPass.length >= 4) {
      password = newPass;
      localStorage.setItem("nr_password", newPass);
    }
    fillSettings();
    renderInstantReplyControls();
    if (typeof renderBookings === "function") renderBookings();
    $("#settings-saved").textContent = "Saved ✓";
    setTimeout(() => ($("#settings-saved").textContent = ""), 2500);
  } catch (err) {
    $("#settings-saved").textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ─── Studio UX Controller (Theme, Hero Pulse, Card Spotlight & ⌘K Palette) ──

function syncThemeIcon() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const iconEl = $("#theme-toggle-icon");
  if (iconEl) iconEl.textContent = current === "light" ? "🌙" : "☀️";
}
syncThemeIcon();

$("#theme-toggle-btn")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("nyra-studio-theme", next);
  } catch {}
  syncThemeIcon();
});

// Hero Quick Actions & Metric Card Navigation
$("#hero-schedule-task-btn")?.addEventListener("click", () => {
  document.querySelector('.tab[data-tab="todos"]')?.click();
  const composer = $("#ai-todo-composer");
  if (composer && composer.classList.contains("hidden")) {
    $("#toggle-ai-todo-composer-btn")?.click();
  }
  $("#todo-client-name")?.focus();
});

$("#hero-open-crm-btn")?.addEventListener("click", () => {
  document.querySelector('.tab[data-tab="bookings"]')?.click();
});

$("#hero-test-chat-btn")?.addEventListener("click", () => {
  document.querySelector('.tab[data-tab="chat"]')?.click();
  $("#chat-input")?.focus();
});

$$(".hero-metric-card[data-jump-tab]").forEach((card) => {
  card.addEventListener("click", () => {
    const targetTab = card.dataset.jumpTab;
    if (targetTab) document.querySelector(`.tab[data-tab="${targetTab}"]`)?.click();
  });
});

// Live Studio Clock, Hero Metrics & Nav Count Badges
function updateStudioPulse() {
  const now = Date.now();
  const bdtDate = new Date(now + 6 * 3600000);
  let hr = bdtDate.getUTCHours();
  const mn = String(bdtDate.getUTCMinutes()).padStart(2, "0");
  const sc = String(bdtDate.getUTCSeconds()).padStart(2, "0");
  const ampm = hr >= 12 ? "PM" : "AM";
  hr = hr % 12 || 12;

  const clockEl = $("#topbar-clock-text");
  if (clockEl) clockEl.textContent = `${hr}:${mn}:${sc} ${ampm} BDT`;

  const gw = overview?.gateway;
  const gwDot = $("#topbar-gw-dot");
  const heroGw = $("#hero-metric-gw");
  const heroGwSub = $("#hero-metric-gw-sub");

  if (gw) {
    if (gw.online && gw.state === "open") {
      if (gwDot) gwDot.className = "dot on";
      if (heroGw) {
        heroGw.textContent = "🟢 Connected";
        heroGw.style.color = "var(--green)";
      }
      if (heroGwSub) {
        heroGwSub.textContent = gw.me?.name ? `${gw.me.name} · 24/7 Live` : "WhatsApp Linked 24/7";
      }
    } else if (gw.online && gw.state === "qr") {
      if (gwDot) gwDot.className = "dot warn";
      if (heroGw) {
        heroGw.textContent = "🟡 Awaiting QR";
        heroGw.style.color = "#f59e0b";
      }
      if (heroGwSub) heroGwSub.textContent = "Scan QR below to link";
    } else if (gw.online) {
      if (gwDot) gwDot.className = "dot warn";
      if (heroGw) {
        heroGw.textContent = "🟡 Connecting…";
        heroGw.style.color = "#f59e0b";
      }
      if (heroGwSub) heroGwSub.textContent = "Auto-healing session";
    } else {
      if (gwDot) gwDot.className = "dot off";
      if (heroGw) {
        heroGw.textContent = "🔴 Standby";
        heroGw.style.color = "var(--red)";
      }
      if (heroGwSub) heroGwSub.textContent = "Click Wake Runner";
    }
  }

  // Sync Today's Tasks & Active Leads counts
  const activeTodos = Array.isArray(todos) ? todos.filter((t) => !t.completed) : [];
  const todayCountEl = $("#stat-todos-today");
  const heroToday = $("#hero-metric-today");
  if (heroToday) {
    heroToday.textContent = todayCountEl?.textContent || String(activeTodos.length);
  }

  const navTodosBadge = $("#nav-badge-todos");
  if (navTodosBadge) {
    const cnt = activeTodos.length;
    navTodosBadge.textContent = String(cnt);
    navTodosBadge.classList.toggle("hidden", cnt === 0);
  }

  const allLeads = Array.isArray(bookings) && bookings.length > 0 ? bookings : todoBookingsCache || [];
  const activeLeadsCount = allLeads.filter(
    (b) => !["completed", "cancelled", "not_interested", "fake_lead"].includes(b.status),
  ).length;
  const heroLeads = $("#hero-metric-leads");
  if (heroLeads) {
    heroLeads.textContent = String(allLeads.length || 0);
  }
  const navBookingsBadge = $("#nav-badge-bookings");
  if (navBookingsBadge) {
    const badgeCount = activeLeadsCount || allLeads.length;
    navBookingsBadge.textContent = String(badgeCount);
    navBookingsBadge.classList.toggle("hidden", badgeCount === 0);
  }

  const nextVal = $("#stat-todos-next")?.textContent || "—";
  const nextSub = $("#stat-todos-next-sub")?.textContent || "Live countdown";
  const heroNext = $("#hero-metric-next");
  const heroNextSub = $("#hero-metric-next-sub");
  if (heroNext) heroNext.textContent = nextVal;
  if (heroNextSub) heroNextSub.textContent = nextSub;
}
setInterval(updateStudioPulse, 1000);

// MotionHero Interactive Radial Spotlight on Cards
document.addEventListener(
  "pointermove",
  (e) => {
    const target = e.target?.closest?.(".card, .booking-item, .todo-timeline-card");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    target.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
    target.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
  },
  { passive: true },
);

// ⌘K / Ctrl+K Studio Command Palette
const STUDIO_COMMANDS = [
  { label: "✦ Go to Studio Overview (Home)", hint: "Tab", run: () => document.querySelector('.tab[data-tab="home"]')?.click() },
  { label: "✅ Open AI Follow-Up & Daily Task Bar", hint: "Tasks", run: () => document.querySelector('.tab[data-tab="todos"]')?.click() },
  {
    label: "➕ Schedule New AI Client Follow-Up",
    hint: "Action",
    run: () => $("#hero-schedule-task-btn")?.click(),
  },
  { label: "📅 Open Vidmox Booked Calls & Lead CRM", hint: "CRM", run: () => document.querySelector('.tab[data-tab="bookings"]')?.click() },
  {
    label: "➕ Log a New Lead / Booked Call",
    hint: "CRM",
    run: () => {
      document.querySelector('.tab[data-tab="bookings"]')?.click();
      const f = $("#new-booking-form");
      if (f && f.classList.contains("hidden")) $("#toggle-add-booking-btn")?.click();
    },
  },
  { label: "💬 Talk to Nyra Rose (AI Sandbox)", hint: "Chat", run: () => document.querySelector('.tab[data-tab="chat"]')?.click() },
  { label: "⚡ View WhatsApp Inbox Conversations", hint: "Inbox", run: () => document.querySelector('.tab[data-tab="chats"]')?.click() },
  { label: "📜 Open AI Rule Book & Instant Triggers", hint: "Rules", run: () => document.querySelector('.tab[data-tab="rules"]')?.click() },
  { label: "📝 Open Quick Notes & Memory", hint: "Memory", run: () => document.querySelector('.tab[data-tab="notes"]')?.click() },
  { label: "⚙️ Open Studio & Brain Settings", hint: "Settings", run: () => document.querySelector('.tab[data-tab="settings"]')?.click() },
  {
    label: "⏸️ Toggle Pause / Resume Instant AI Reply",
    hint: "Switch",
    run: () => $("#topbar-instant-pause-btn")?.click(),
  },
  {
    label: "🌗 Switch Dark / Light Studio Theme",
    hint: "Theme",
    run: () => $("#theme-toggle-btn")?.click(),
  },
];

let cmdActiveIndex = 0;

function renderCommandPalette(query = "") {
  const listEl = $("#cmd-palette-list");
  if (!listEl) return;
  const q = query.trim().toLowerCase();
  const items = STUDIO_COMMANDS.filter(
    (c) => !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q),
  );
  if (cmdActiveIndex >= items.length) cmdActiveIndex = 0;

  listEl.replaceChildren(
    ...items.map((cmd, idx) => {
      const btn = el("button", `cmd-palette-item ${idx === cmdActiveIndex ? "active" : ""}`);
      btn.type = "button";
      const span = el("span", null, cmd.label);
      const small = el("small", null, cmd.hint);
      btn.append(span, small);
      btn.addEventListener("click", () => {
        closeCommandPalette();
        cmd.run();
      });
      return btn;
    }),
  );
}

function openCommandPalette() {
  const modal = $("#cmd-palette-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  cmdActiveIndex = 0;
  const input = $("#cmd-palette-input");
  if (input) {
    input.value = "";
    renderCommandPalette("");
    setTimeout(() => input.focus(), 20);
  }
}

function closeCommandPalette() {
  $("#cmd-palette-modal")?.classList.add("hidden");
}

$("#cmd-palette-trigger")?.addEventListener("click", openCommandPalette);
$("#cmd-palette-close")?.addEventListener("click", closeCommandPalette);
$("#cmd-palette-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "cmd-palette-modal") closeCommandPalette();
});
$("#cmd-palette-input")?.addEventListener("input", (e) => {
  cmdActiveIndex = 0;
  renderCommandPalette(e.target.value);
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const modal = $("#cmd-palette-modal");
    if (modal?.classList.contains("hidden")) openCommandPalette();
    else closeCommandPalette();
    return;
  }
  const modal = $("#cmd-palette-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeCommandPalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    const buttons = $$("#cmd-palette-list .cmd-palette-item");
    if (buttons.length) {
      cmdActiveIndex = (cmdActiveIndex + 1) % buttons.length;
      renderCommandPalette($("#cmd-palette-input")?.value || "");
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const buttons = $$("#cmd-palette-list .cmd-palette-item");
    if (buttons.length) {
      cmdActiveIndex = (cmdActiveIndex - 1 + buttons.length) % buttons.length;
      renderCommandPalette($("#cmd-palette-input")?.value || "");
    }
  } else if (e.key === "Enter") {
    const activeBtn = $("#cmd-palette-list .cmd-palette-item.active");
    if (activeBtn) {
      e.preventDefault();
      activeBtn.click();
    }
  }
});

// ─── Boot ────────────────────────────────────────────────────────────────────

if (password) enterApp().catch(() => signOut());
else signOut();
