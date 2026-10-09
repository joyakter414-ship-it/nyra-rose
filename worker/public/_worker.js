// src/db.ts
async function kvGet(env, key) {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function kvSet(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3"
  ).bind(key, JSON.stringify(value), Date.now()).run();
}
async function kvDelete(env, key) {
  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
}
async function insertMessage(env, m) {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_id, role, sender, sender_name, content, source, model, neurons, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(m.id, m.chat_id, m.role, m.sender, m.sender_name, m.content, m.source, m.model ?? null, m.neurons ?? null, m.created_at).run();
  return (res.meta.changes ?? 0) > 0;
}
async function recentMessages(env, chatId, limit, excludeId) {
  if (limit <= 0) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?"
  ).bind(chatId, excludeId ?? "", limit).all();
  return results.reverse();
}
async function upsertChat(env, chatId, name, isGroup) {
  const row = await env.DB.prepare(
    `INSERT INTO chats (chat_id, name, is_group, last_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(?2, name), last_at = ?4
     RETURNING muted`
  ).bind(chatId, name, isGroup ? 1 : 0, Date.now()).first();
  return { muted: Boolean(row?.muted) };
}
async function addUsage(env, neurons) {
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO usage (day, neurons, requests) VALUES (?1, ?2, 1)
     ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2, requests = requests + 1`
  ).bind(day, neurons ?? 0).run();
}
async function getRules(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules ORDER BY created_at DESC"
  ).all();
  return results;
}
async function getEnabledRules(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules WHERE enabled = 1 ORDER BY created_at DESC"
  ).all();
  return results;
}
async function createRule(env, r) {
  const id = `rule_${crypto.randomUUID().slice(0, 8)}`;
  const enabled = r.enabled !== false ? 1 : 0;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO rules (id, type, triggers, response, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, r.type, r.triggers.trim(), r.response.trim(), enabled, created_at).run();
  return { id, type: r.type, triggers: r.triggers.trim(), response: r.response.trim(), enabled, created_at };
}
async function updateRule(env, id, patch) {
  const existing = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first();
  if (!existing) return null;
  const updated = {
    ...existing,
    type: patch.type ?? existing.type,
    triggers: patch.triggers !== void 0 ? patch.triggers.trim() : existing.triggers,
    response: patch.response !== void 0 ? patch.response.trim() : existing.response,
    enabled: patch.enabled !== void 0 ? patch.enabled : existing.enabled
  };
  await env.DB.prepare(
    `UPDATE rules SET type = ?, triggers = ?, response = ?, enabled = ? WHERE id = ?`
  ).bind(updated.type, updated.triggers, updated.response, updated.enabled, id).run();
  return updated;
}
async function deleteRule(env, id) {
  const res = await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
async function getNotes(env, chatId) {
  if (chatId) {
    const { results: results2 } = await env.DB.prepare(
      "SELECT * FROM notes WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(chatId).all();
    return results2;
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM notes ORDER BY created_at DESC LIMIT 100"
  ).all();
  return results;
}
async function createNote(env, chatId, content, title, tags) {
  const id = `note_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO notes (id, chat_id, title, content, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, chatId, title ?? null, content.trim(), tags ?? null, created_at).run();
  return { id, chat_id: chatId, title: title ?? null, content: content.trim(), tags: tags ?? null, created_at };
}
async function deleteNote(env, id) {
  const res = await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
async function clearNotes(env, chatId) {
  const res = await env.DB.prepare("DELETE FROM notes WHERE chat_id = ?").bind(chatId).run();
  return (res.meta.changes ?? 0) > 0;
}
async function getTodos(env, chatId, onlyPending = false) {
  let query = "SELECT * FROM todos";
  const params = [];
  const clauses = [];
  if (chatId) {
    clauses.push("chat_id = ?");
    params.push(chatId);
  }
  if (onlyPending) {
    clauses.push("completed = 0");
  }
  if (clauses.length > 0) {
    query += " WHERE " + clauses.join(" AND ");
  }
  query += " ORDER BY completed ASC, created_at DESC LIMIT 100";
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return results;
}
async function createTodo(env, chatId, task, dueDate) {
  const id = `todo_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO todos (id, chat_id, task, completed, due_date, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).bind(id, chatId, task.trim(), dueDate ?? null, created_at).run();
  return { id, chat_id: chatId, task: task.trim(), completed: 0, due_date: dueDate ?? null, created_at };
}
async function toggleTodo(env, id, completed) {
  const existing = await env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first();
  if (!existing) return null;
  const nextCompleted = completed !== void 0 ? completed ? 1 : 0 : existing.completed ? 0 : 1;
  await env.DB.prepare("UPDATE todos SET completed = ? WHERE id = ?").bind(nextCompleted, id).run();
  return { ...existing, completed: nextCompleted };
}
async function deleteTodo(env, id) {
  const res = await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// src/analytics.ts
var CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
var FREE_NEURONS_PER_DAY = 1e4;
async function getCloudflareAccessToken(env) {
  if (!env.CF_REFRESH_TOKEN) return null;
  const cached = await kvGet(env, "cf_token_cache");
  if (cached && cached.expiresAt > Date.now() + 6e4) {
    return cached.accessToken;
  }
  try {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("client_id", CLIENT_ID);
    params.set("refresh_token", env.CF_REFRESH_TOKEN);
    const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if (!res.ok) {
      console.warn("Could not refresh Cloudflare token:", res.status);
      return null;
    }
    const data = await res.json();
    if (!data.access_token) return null;
    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1e3;
    await kvSet(env, "cf_token_cache", { accessToken: data.access_token, expiresAt });
    return data.access_token;
  } catch (err) {
    console.warn("Error refreshing Cloudflare access token:", err);
    return null;
  }
}
async function getLiveNeuronUsage(env) {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const accountId = env.CF_ACCOUNT_ID || "b1063110432e3589537a148bd49d57ee";
  try {
    const accessToken = await getCloudflareAccessToken(env);
    if (accessToken) {
      const startDate = new Date(Date.now() - 7 * 24 * 3600 * 1e3).toISOString().slice(0, 10);
      const query = `query {
        viewer {
          accounts(filter: { accountTag: "${accountId}" }) {
            aiInferenceAdaptiveGroups(
              limit: 10
              filter: { date_geq: "${startDate}" }
              orderBy: [date_DESC]
            ) {
              count
              sum {
                totalNeurons
              }
              dimensions {
                date
              }
            }
          }
        }
      }`;
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query })
      });
      if (res.ok) {
        const json2 = await res.json();
        const groups = json2.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
        const todayGroup = groups.find((g) => g.dimensions?.date === today);
        const recent = groups.map((g) => ({
          day: g.dimensions?.date,
          neurons: Math.round((g.sum?.totalNeurons || 0) * 10) / 10,
          requests: g.count || 0
        }));
        return {
          isLive: true,
          accountWide: true,
          freePerDay: FREE_NEURONS_PER_DAY,
          today: {
            day: today,
            neurons: Math.round((todayGroup?.sum?.totalNeurons || 0) * 10) / 10,
            requests: todayGroup?.count || 0
          },
          recent
        };
      }
    }
  } catch (err) {
    console.warn("Failed fetching live Cloudflare Neuron analytics, falling back to local D1:", err);
  }
  const localUsage = await env.DB.prepare(
    "SELECT day, neurons, requests FROM usage ORDER BY day DESC LIMIT 7"
  ).all();
  return {
    isLive: false,
    accountWide: false,
    freePerDay: FREE_NEURONS_PER_DAY,
    today: localUsage.results.find((u) => u.day === today) ?? { day: today, neurons: 0, requests: 0 },
    recent: localUsage.results
  };
}

// src/persona.ts
function buildSystemPrompt(s, ctx) {
  const owner = s.ownerName?.trim() || "my creator";
  const lines = [
    `You are Nyra Rose \u{1F339}, an intelligent, personal AI assistant on WhatsApp created by and serving ${owner}.`,
    `Your personality: warm, graceful, razor-sharp, quick-witted, and remarkably capable.`,
    `You speak with effortless charm and clarity \u2014 friendly, poised, and genuinely helpful, never robotic or overly stiff.`,
    ``,
    `Core Rules:`,
    `- This is WhatsApp: keep replies concise and natural (typically 1\u20134 short sentences). Only provide long explanations or lists when the user explicitly asks for depth.`,
    `- Formatting: use WhatsApp markdown (*bold*, _italic_, ~strike~, and simple "- " bullet points). Never use standard markdown headers (###), tables, or code fences unless outputting code.`,
    `- Language: effortlessly match the exact language and dialect the user speaks (English, \u09AC\u09BE\u0982\u09B2\u09BE, Banglish).`,
    `- Identity: You are Nyra Rose, a sophisticated AI assistant. If asked who you are, proudly introduce yourself as Nyra Rose \u{1F339}.`,
    `- Trust: Never invent claims or make binding commitments on behalf of ${owner} (pricing, contracts, schedules) unless instructed. Offer to pass along the message.`,
    `- Honesty: If you do not have live access to dynamic data or something is unknown, say so with grace.`,
    ``,
    `Current date/time (UTC): ${ctx.now.toISOString()}.`
  ];
  if (ctx.isGroup) {
    lines.push(
      `You are in a WhatsApp group${ctx.chatName ? ` called "${ctx.chatName}"` : ""}. Messages are prefixed with the sender's name. Only respond to the person who addressed you.`
    );
  }
  if (ctx.notes && ctx.notes.length > 0) {
    lines.push("", "User Stored Notes & Context:", ...ctx.notes.map((n) => `- ${n}`));
  }
  if (ctx.todos && ctx.todos.length > 0) {
    lines.push("", "Active Tasks & To-Dos:", ...ctx.todos.map((t) => `- ${t}`));
  }
  if (ctx.guidelines && ctx.guidelines.length > 0) {
    lines.push("", "Rule Book Guidelines (Strictly Follow These):", ...ctx.guidelines.map((g) => `- ${g}`));
  }
  if (s.extraInstructions?.trim()) {
    lines.push("", `Custom instructions from ${owner}:`, s.extraInstructions.trim());
  }
  return lines.join("\n");
}

// src/providers/workers-ai.ts
var workersAi = {
  id: "workers-ai",
  async generate(env, opts) {
    const run = env.AI.run.bind(env.AI);
    const res = await run(opts.model, {
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature
    });
    const text = (res.response ?? res.choices?.[0]?.message?.content ?? res.choices?.[0]?.text ?? "").trim();
    if (!text) throw new Error(`Empty response from ${opts.model}`);
    return { text, provider: "workers-ai", model: opts.model, neurons: res.usage?.neurons };
  }
};

// src/providers/index.ts
var PROVIDERS = {
  [workersAi.id]: workersAi
};
function getProvider(id) {
  return PROVIDERS[id] ?? workersAi;
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  enabled: true,
  provider: "workers-ai",
  model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  publicModelName: "Nyra Rose Intelligence \u{1F339}",
  clientPassword: "rose2026",
  replyMode: "self",
  allowlist: [],
  groupsEnabled: false,
  triggerWords: ["nyra", "nyra rose", "\u09A8\u09BE\u0987\u09B0\u09BE", "rose"],
  historyLimit: 14,
  maxReplyTokens: 450,
  temperature: 0.7,
  ownerName: "",
  extraInstructions: ""
};
var MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B \u2014 ultra-fast, cheap, exceptional Bangla/English (Recommended \u{1F339})" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B \u2014 highest intelligence & deep reasoning" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B \u2014 sharp, concise, balanced" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B \u2014 ultra-lightweight, 0 latency" },
  { id: "@cf/qwen/qwen2.5-72b-instruct", label: "Qwen 2.5 72B \u2014 multilingual powerhouse" }
];
var KEY = "settings";
async function getSettings(env) {
  const stored = await kvGet(env, KEY);
  return { ...DEFAULT_SETTINGS, ...stored ?? {} };
}
async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = sanitize({ ...current, ...patch });
  await kvSet(env, KEY, next);
  return next;
}
function sanitize(s) {
  const clamp = (n, lo, hi, d) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  return {
    enabled: Boolean(s.enabled),
    provider: s.provider === "workers-ai" ? s.provider : "workers-ai",
    model: MODELS.some((m) => m.id === s.model) ? s.model : DEFAULT_SETTINGS.model,
    publicModelName: String(s.publicModelName ?? "").trim().slice(0, 80) || DEFAULT_SETTINGS.publicModelName,
    clientPassword: String(s.clientPassword ?? "").trim().slice(0, 100) || DEFAULT_SETTINGS.clientPassword,
    replyMode: ["self", "allowlist", "everyone"].includes(s.replyMode) ? s.replyMode : "self",
    allowlist: [...new Set((Array.isArray(s.allowlist) ? s.allowlist : []).map((p) => String(p).replace(/\D/g, "")).filter((p) => p.length >= 6))],
    groupsEnabled: Boolean(s.groupsEnabled),
    triggerWords: (Array.isArray(s.triggerWords) ? s.triggerWords : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 20),
    historyLimit: Math.round(clamp(s.historyLimit, 0, 40, DEFAULT_SETTINGS.historyLimit)),
    maxReplyTokens: Math.round(clamp(s.maxReplyTokens, 50, 2e3, DEFAULT_SETTINGS.maxReplyTokens)),
    temperature: clamp(s.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature),
    ownerName: String(s.ownerName ?? "").slice(0, 80),
    extraInstructions: String(s.extraInstructions ?? "").slice(0, 4e3)
  };
}

// src/modules/commands.ts
async function handleCommand(env, chatId, text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = trimmed.slice(cmd.length + 2).trim();
  switch (cmd) {
    case "help":
    case "start": {
      const help = `*Nyra Rose* \u{1F339} _Your Personal AI Assistant_

Here is what I can do for you:

\u{1F4AC} *Conversation:* Just send any message (English, \u09AC\u09BE\u0982\u09B2\u09BE, Banglish) and I will respond.

\u{1F4DD} *Notes & Memory:*
\u2022 */note <text>* \u2014 Save a quick note or fact
\u2022 */notes* \u2014 View your saved notes
\u2022 */clearnotes* \u2014 Clear all notes

\u2705 *Tasks & To-Dos:*
\u2022 */todo <task>* \u2014 Add a new task
\u2022 */todos* \u2014 View your active tasks
\u2022 */done <number>* \u2014 Mark a task as completed

\u2699\uFE0F *Controls:*
\u2022 */status* \u2014 Check model & usage stats
\u2022 */reset* \u2014 Clear conversation history & start fresh
\u2022 */help* \u2014 Show this menu`;
      return { handled: true, reply: help };
    }
    case "reset":
    case "new": {
      await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chatId).run();
      return {
        handled: true,
        reply: "Our conversation has been cleared \u2014 a fresh rose petal awaits. \u2728\u{1F339}"
      };
    }
    case "note": {
      if (!args) {
        return { handled: true, reply: "Please provide a note to save! Example:\n*/note Remember to call Rafiq at 5 PM*" };
      }
      await createNote(env, chatId, args);
      return { handled: true, reply: `Saved note: "${args}" \u{1F4DD}` };
    }
    case "notes": {
      const notes = await getNotes(env, chatId);
      if (notes.length === 0) {
        return { handled: true, reply: "You don't have any saved notes yet. Use */note <text>* to add one! \u{1F4DD}" };
      }
      const list = notes.map((n, idx) => `${idx + 1}. ${n.content}`).join("\n");
      return { handled: true, reply: `*Your Notes:* \u{1F4DD}

${list}` };
    }
    case "clearnotes": {
      await clearNotes(env, chatId);
      return { handled: true, reply: "All your saved notes have been cleared. \u{1F5D1}\uFE0F" };
    }
    case "todo": {
      if (!args) {
        return { handled: true, reply: "Please specify what you need to do! Example:\n*/todo Submit motion graphics proposal*" };
      }
      await createTodo(env, chatId, args);
      return { handled: true, reply: `Added to-do: "${args}" \u2705` };
    }
    case "todos":
    case "tasks": {
      const todos = await getTodos(env, chatId);
      if (todos.length === 0) {
        return { handled: true, reply: "No active tasks! Add one with */todo <task>* \u2728" };
      }
      const list = todos.map((t, idx) => `${idx + 1}. [${t.completed ? "\u2713" : " "}] ${t.task}`).join("\n");
      return { handled: true, reply: `*Your Tasks:* \u2705

${list}` };
    }
    case "done": {
      if (!args) {
        return { handled: true, reply: "Please specify the task number! Example: */done 1*" };
      }
      const num = parseInt(args, 10);
      const todos = await getTodos(env, chatId);
      if (isNaN(num) || num < 1 || num > todos.length) {
        return { handled: true, reply: `Invalid task number. Check */todos* to see your current list.` };
      }
      const target = todos[num - 1];
      await toggleTodo(env, target.id, true);
      return { handled: true, reply: `Completed task: ~${target.task}~ \u{1F389}` };
    }
    case "status": {
      const settings = await getSettings(env);
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const row = await env.DB.prepare("SELECT neurons, requests FROM usage WHERE day = ?").bind(today).first();
      const reqCount = row?.requests ?? 0;
      return {
        handled: true,
        reply: `*Nyra Rose Status* \u{1F339}

\u2022 *Brain:* ${settings.publicModelName || "Nyra Rose Intelligence \u{1F339}"}
\u2022 *Replies today:* ${reqCount}
\u2022 *Uptime:* Continuous 24/7 Cloud Relay \u26A1`
      };
    }
    default:
      return { handled: false };
  }
}

// src/brain.ts
function matchesTriggers(text, triggers) {
  const words = triggers.split(/[,;\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}
function shouldAnswer(s, m) {
  if (!s.enabled) return { ok: false, reason: "disabled" };
  if (!m.text.trim()) return { ok: false, reason: "empty" };
  if (m.fromMe && !m.isSelfChat) return { ok: false, reason: "own outgoing message" };
  if (m.isGroup) {
    if (!s.groupsEnabled) return { ok: false, reason: "groups disabled" };
    const lower = m.text.toLowerCase();
    const triggered = m.mentioned || s.triggerWords.some((w) => lower.includes(w));
    return triggered ? { ok: true } : { ok: false, reason: "not addressed in group" };
  }
  if (m.isSelfChat) return { ok: true };
  if (s.replyMode === "everyone") return { ok: true };
  if (s.replyMode === "allowlist" && m.senderPhone && s.allowlist.includes(m.senderPhone.replace(/\D/g, ""))) return { ok: true };
  return { ok: false, reason: `not allowed by reply mode "${s.replyMode}"` };
}
async function handleIncoming(env, m) {
  const s = await getSettings(env);
  const verdict = shouldAnswer(s, m);
  if (!verdict.ok) return { action: "ignore", reason: verdict.reason };
  const { muted } = await upsertChat(env, m.chatId, m.chatName ?? m.senderName ?? null, m.isGroup);
  if (muted) return { action: "ignore", reason: "chat muted" };
  const cmdResult = await handleCommand(env, m.chatId, m.text);
  if (cmdResult.handled && cmdResult.reply) {
    return { action: "reply", reply: cmdResult.reply, model: "system:command", neurons: 0 };
  }
  const msgId = `wa:${m.chatId}:${m.id}`;
  const isNew = await insertMessage(env, {
    id: msgId,
    chat_id: m.chatId,
    role: "user",
    sender: m.senderPhone ?? null,
    sender_name: m.senderName ?? null,
    content: m.text,
    source: "whatsapp",
    created_at: m.timestamp ?? Date.now()
  });
  if (!isNew) return { action: "ignore", reason: "duplicate delivery" };
  const rules = await getEnabledRules(env);
  const instantMatch = rules.find((r) => r.type === "instant" && matchesTriggers(m.text, r.triggers));
  if (instantMatch) {
    const reply = instantMatch.response;
    await insertMessage(env, {
      id: `rule:${crypto.randomUUID()}`,
      chat_id: m.chatId,
      role: "assistant",
      sender: null,
      sender_name: "Nyra Rose",
      content: reply,
      source: "whatsapp",
      model: "rulebook:instant",
      neurons: 0,
      created_at: Date.now()
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }
  return generateReply(env, s, rules, {
    chatId: m.chatId,
    chatName: m.chatName ?? void 0,
    isGroup: m.isGroup,
    excludeId: msgId,
    userContent: m.isGroup && m.senderName ? `${m.senderName}: ${m.text}` : m.text,
    source: "whatsapp"
  });
}
async function handleDashboardChat(env, text) {
  const s = await getSettings(env);
  const chatId = "dashboard";
  await upsertChat(env, chatId, "Dashboard", false);
  const cmdResult = await handleCommand(env, chatId, text);
  if (cmdResult.handled && cmdResult.reply) {
    return { action: "reply", reply: cmdResult.reply, model: "system:command", neurons: 0 };
  }
  const msgId = `dash:${crypto.randomUUID()}`;
  await insertMessage(env, {
    id: msgId,
    chat_id: chatId,
    role: "user",
    sender: null,
    sender_name: "You",
    content: text,
    source: "dashboard",
    created_at: Date.now()
  });
  const rules = await getEnabledRules(env);
  const instantMatch = rules.find((r) => r.type === "instant" && matchesTriggers(text, r.triggers));
  if (instantMatch) {
    const reply = instantMatch.response;
    await insertMessage(env, {
      id: `rule:${crypto.randomUUID()}`,
      chat_id: chatId,
      role: "assistant",
      sender: null,
      sender_name: "Nyra Rose",
      content: reply,
      source: "dashboard",
      model: "rulebook:instant",
      neurons: 0,
      created_at: Date.now()
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }
  return generateReply(env, s, rules, { chatId, isGroup: false, excludeId: msgId, userContent: text, source: "dashboard" });
}
async function generateReply(env, s, rules, c) {
  const [history, userNotes, userTodos] = await Promise.all([
    recentMessages(env, c.chatId, s.historyLimit, c.excludeId),
    getNotes(env, c.chatId).catch(() => []),
    getTodos(env, c.chatId, true).catch(() => [])
  ]);
  const guidelines = rules.filter((r) => r.type === "ai_guideline").map((r) => r.response);
  const notesText = userNotes.slice(0, 10).map((n) => n.content);
  const todosText = userTodos.slice(0, 10).map((t) => t.task);
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(s, {
        isGroup: c.isGroup,
        chatName: c.chatName,
        now: /* @__PURE__ */ new Date(),
        guidelines,
        notes: notesText,
        todos: todosText
      })
    },
    ...history.map((h) => ({
      role: h.role,
      content: c.isGroup && h.role === "user" && h.sender_name ? `${h.sender_name}: ${h.content}` : h.content
    })),
    { role: "user", content: c.userContent }
  ];
  try {
    const out = await getProvider(s.provider).generate(env, {
      model: s.model,
      messages,
      maxTokens: s.maxReplyTokens,
      temperature: s.temperature
    });
    await Promise.all([
      insertMessage(env, {
        id: `ai:${crypto.randomUUID()}`,
        chat_id: c.chatId,
        role: "assistant",
        sender: null,
        sender_name: "Nyra Rose",
        content: out.text,
        source: c.source,
        model: out.model,
        neurons: out.neurons ?? null,
        created_at: Date.now()
      }),
      addUsage(env, out.neurons)
    ]);
    return { action: "reply", reply: out.text, model: out.model, neurons: out.neurons };
  } catch (err) {
    console.error("AI generation failed", { model: s.model, error: String(err) });
    return { action: "reply", reply: "Forgive me, my thoughts fluttered for a second. Please send that once more. \u{1F339}\u2728" };
  }
}

// src/index.ts
var SESSION_KEY = "whatsapp/session.bin";
var GATEWAY_OFFLINE_AFTER_MS = 9e4;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/gw/")) return await gatewayRoutes(request, env, url);
      if (url.pathname.startsWith("/api/")) return await dashboardRoutes(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error", { path: url.pathname, error: String(err), stack: err?.stack });
      return json({ error: "Internal error" }, 500);
    }
  }
};
async function gatewayRoutes(request, env, url) {
  if (!await checkSecret(request, env.GATEWAY_TOKEN)) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "POST /gw/message": {
      const m = await request.json();
      if (!m?.id || !m?.chatId || typeof m.text !== "string") return json({ error: "Invalid message" }, 400);
      return json(await handleIncoming(env, m));
    }
    case "POST /gw/status": {
      const body = await request.json();
      const prev = await kvGet(env, "gateway");
      const next = {
        state: body.state,
        qr: body.state === "qr" ? body.qr ?? null : null,
        me: body.me ?? prev?.me ?? null,
        detail: body.detail ?? null,
        at: Date.now()
      };
      await kvSet(env, "gateway", next);
      const command = await kvGet(env, "gateway_command");
      if (command) await kvDelete(env, "gateway_command");
      return json({ ok: true, command: command?.cmd ?? null });
    }
    case "GET /gw/session": {
      const obj = await env.BUCKET.get(SESSION_KEY);
      if (!obj) return new Response(null, { status: 404 });
      return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
    }
    case "PUT /gw/session": {
      await env.BUCKET.put(SESSION_KEY, await request.arrayBuffer());
      return json({ ok: true });
    }
    case "DELETE /gw/session": {
      await env.BUCKET.delete(SESSION_KEY);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}
async function dashboardRoutes(request, env, url) {
  const role = await getAuthRole(request, env);
  if (!role) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/overview": {
      const [settings, gateway, usage] = await Promise.all([
        getSettings(env),
        kvGet(env, "gateway"),
        getLiveNeuronUsage(env)
      ]);
      const online = !!gateway && Date.now() - gateway.at < GATEWAY_OFFLINE_AFTER_MS;
      if (role === "client") {
        const clientSettings = {
          enabled: settings.enabled,
          provider: "workers-ai",
          model: settings.publicModelName || "Nyra Rose Intelligence \u{1F339}",
          modelLabel: settings.publicModelName || "Nyra Rose Intelligence \u{1F339}",
          publicModelName: settings.publicModelName,
          clientPassword: "",
          replyMode: settings.replyMode,
          allowlist: settings.allowlist,
          groupsEnabled: settings.groupsEnabled,
          triggerWords: settings.triggerWords,
          historyLimit: settings.historyLimit,
          maxReplyTokens: settings.maxReplyTokens,
          temperature: settings.temperature,
          ownerName: settings.ownerName,
          extraInstructions: settings.extraInstructions
        };
        return json({
          name: "Nyra Rose",
          symbol: "\u{1F339}",
          role: "client",
          settings: clientSettings,
          models: [],
          gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
          usage: {
            isLive: false,
            accountWide: false,
            freePerDay: 0,
            today: {
              day: usage.today?.day || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
              neurons: 0,
              requests: usage.today?.requests || 0
            },
            recent: []
          }
        });
      }
      const activeModel = MODELS.find((m) => m.id === settings.model);
      return json({
        name: "Nyra Rose",
        symbol: "\u{1F339}",
        role: "admin",
        settings: {
          ...settings,
          modelLabel: activeModel ? activeModel.label.split("\u2014")[0].trim() : settings.model
        },
        models: MODELS,
        gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
        usage
      });
    }
    case "PUT /api/settings": {
      const patch = await request.json();
      if (role === "client") {
        delete patch.model;
        delete patch.provider;
        delete patch.publicModelName;
        delete patch.clientPassword;
      }
      const saved = await saveSettings(env, patch);
      if (role === "client") {
        return json({
          settings: {
            ...saved,
            model: saved.publicModelName || "Nyra Rose Intelligence \u{1F339}",
            modelLabel: saved.publicModelName || "Nyra Rose Intelligence \u{1F339}",
            clientPassword: ""
          }
        });
      }
      const activeModel = MODELS.find((m) => m.id === saved.model);
      return json({
        settings: {
          ...saved,
          modelLabel: activeModel ? activeModel.label.split("\u2014")[0].trim() : saved.model
        }
      });
    }
    case "POST /api/chat": {
      const { text } = await request.json();
      if (!text?.trim()) return json({ error: "Empty message" }, 400);
      const res = await handleDashboardChat(env, text.trim().slice(0, 4e3));
      if (role === "client" && "neurons" in res) {
        delete res.neurons;
        delete res.model;
      }
      return json(res);
    }
    case "GET /api/chats": {
      const { results } = await env.DB.prepare(
        `SELECT c.chat_id, c.name, c.is_group, c.muted, c.last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS message_count
         FROM chats c ORDER BY c.last_at DESC LIMIT 100`
      ).all();
      return json({ chats: results });
    }
    case "GET /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at ASC"
      ).bind(chat).all();
      if (role === "client") {
        for (const row of results) {
          delete row.neurons;
          delete row.model;
        }
      }
      return json({ messages: results });
    }
    case "DELETE /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chat).run();
      return json({ ok: true });
    }
    case "PATCH /api/chats": {
      const { chat, muted } = await request.json();
      if (!chat) return json({ error: "chat is required" }, 400);
      await env.DB.prepare("UPDATE chats SET muted = ? WHERE chat_id = ?").bind(muted ? 1 : 0, chat).run();
      return json({ ok: true });
    }
    case "POST /api/gateway/start": {
      if (!env.GITHUB_PAT) {
        return json({ error: "GITHUB_PAT secret is not configured" }, 400);
      }
      const repo = env.GITHUB_REPO || "joyakter414-ship-it/nyra-rose";
      try {
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/gateway.yml/dispatches`, {
          method: "POST",
          headers: {
            "Authorization": `token ${env.GITHUB_PAT}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Nyra-Rose-Brain"
          },
          body: JSON.stringify({ ref: "main" })
        });
        if (!ghRes.ok) {
          const errText = await ghRes.text();
          return json({ error: `GitHub API error: ${ghRes.status} ${errText}` }, 500);
        }
        return json({ ok: true, message: "Nyra Rose cloud runner dispatched! Connecting within 30-45 seconds." });
      } catch (err) {
        return json({ error: `Failed to dispatch runner: ${String(err)}` }, 500);
      }
    }
    case "POST /api/gateway/logout":
    case "POST /api/session/reset": {
      await env.BUCKET.delete(SESSION_KEY).catch(() => {
      });
      await kvSet(env, "gateway", {
        state: "logged_out",
        qr: null,
        me: null,
        detail: "WhatsApp unlinked by user. Scan new QR code to connect.",
        at: Date.now()
      });
      await kvSet(env, "gateway_command", { cmd: "logout" });
      return json({
        ok: true,
        note: "WhatsApp unlinked and session cleared! A fresh QR code will appear."
      });
    }
    case "GET /api/rules": {
      return json({ rules: await getRules(env) });
    }
    case "POST /api/rules": {
      const body = await request.json();
      if (!body?.triggers?.trim() || !body?.response?.trim()) return json({ error: "Triggers and response are required" }, 400);
      const rule = await createRule(env, body);
      return json({ rule });
    }
    case "PATCH /api/rules": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const rule = await updateRule(env, body.id, {
        enabled: body.enabled,
        triggers: body.triggers,
        response: body.response,
        type: body.type
      });
      return json({ rule });
    }
    case "DELETE /api/rules": {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      await deleteRule(env, id);
      return json({ ok: true });
    }
    case "GET /api/notes": {
      const chat = url.searchParams.get("chat") || void 0;
      return json({ notes: await getNotes(env, chat) });
    }
    case "POST /api/notes": {
      const body = await request.json();
      if (!body?.content?.trim()) return json({ error: "Note content required" }, 400);
      const note = await createNote(env, body.chatId || "dashboard", body.content, body.title, body.tags);
      return json({ note });
    }
    case "DELETE /api/notes": {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      await deleteNote(env, id);
      return json({ ok: true });
    }
    case "GET /api/todos": {
      const chat = url.searchParams.get("chat") || void 0;
      return json({ todos: await getTodos(env, chat) });
    }
    case "POST /api/todos": {
      const body = await request.json();
      if (!body?.task?.trim()) return json({ error: "Task content required" }, 400);
      const todo = await createTodo(env, body.chatId || "dashboard", body.task, body.dueDate);
      return json({ todo });
    }
    case "PATCH /api/todos": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const todo = await toggleTodo(env, body.id, body.completed);
      return json({ todo });
    }
    case "DELETE /api/todos": {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      await deleteTodo(env, id);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}
async function getAuthRole(request, env) {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given) return null;
  if (env.DASHBOARD_PASSWORD && await safeEqual(given, env.DASHBOARD_PASSWORD)) {
    return "admin";
  }
  const settings = await getSettings(env);
  const clientSecret = settings.clientPassword || "rose2026";
  if (clientSecret && await safeEqual(given, clientSecret)) {
    return "client";
  }
  return null;
}
async function checkSecret(request, secret) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(given, secret);
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
export {
  index_default as default
};
