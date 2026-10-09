import type { AppEnv } from "./env";
import { addUsage, getEnabledRules, getNotes, getTodos, insertMessage, recentMessages, upsertChat, type Rule } from "./db";
import { buildSystemPrompt } from "./persona";
import { getProvider, type ChatMessage } from "./providers";
import { getSettings, type Settings } from "./settings";
import { handleCommand } from "./modules/commands";

/** A WhatsApp message as forwarded by the gateway. */
export interface IncomingMessage {
  id: string;
  chatId: string;
  chatName?: string | null;
  isGroup: boolean;
  /** The owner's own "Message yourself" chat. */
  isSelfChat: boolean;
  fromMe: boolean;
  senderPhone?: string | null;
  senderName?: string | null;
  text: string;
  /** Nyra Rose's number was @mentioned, or the message replies to her. */
  mentioned?: boolean;
  timestamp?: number;
}

export type Decision =
  | { action: "reply"; reply: string; model?: string; neurons?: number }
  | { action: "ignore"; reason: string };

function matchesTriggers(text: string, triggers: string): boolean {
  const words = triggers.split(/[,;\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

/** Decide whether Nyra Rose should answer, without touching the DB or AI. */
export function shouldAnswer(s: Settings, m: IncomingMessage): { ok: true } | { ok: false; reason: string } {
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

export async function handleIncoming(env: AppEnv, m: IncomingMessage): Promise<Decision> {
  const s = await getSettings(env);
  const verdict = shouldAnswer(s, m);
  if (!verdict.ok) return { action: "ignore", reason: verdict.reason };

  const { muted } = await upsertChat(env, m.chatId, m.chatName ?? m.senderName ?? null, m.isGroup);
  if (muted) return { action: "ignore", reason: "chat muted" };

  // 1. Built-in command dispatcher (/help, /note, /todo, /status, /reset)
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
    created_at: m.timestamp ?? Date.now(),
  });
  if (!isNew) return { action: "ignore", reason: "duplicate delivery" };

  // 2. Rule Book check: instant reply triggers (free, 0 Neurons)
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
      created_at: Date.now(),
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }

  return generateReply(env, s, rules, {
    chatId: m.chatId,
    chatName: m.chatName ?? undefined,
    isGroup: m.isGroup,
    excludeId: msgId,
    userContent: m.isGroup && m.senderName ? `${m.senderName}: ${m.text}` : m.text,
    source: "whatsapp",
  });
}

/** Chat from the dashboard's "Talk to Nyra Rose" box. Skips WhatsApp delivery filters. */
export async function handleDashboardChat(env: AppEnv, text: string): Promise<Decision> {
  const s = await getSettings(env);
  const chatId = "dashboard";
  await upsertChat(env, chatId, "Dashboard", false);

  // Command dispatcher
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
    created_at: Date.now(),
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
      created_at: Date.now(),
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }

  return generateReply(env, s, rules, { chatId, isGroup: false, excludeId: msgId, userContent: text, source: "dashboard" });
}

async function generateReply(
  env: AppEnv,
  s: Settings,
  rules: Rule[],
  c: { chatId: string; chatName?: string; isGroup: boolean; excludeId: string; userContent: string; source: string },
): Promise<Decision> {
  const [history, userNotes, userTodos] = await Promise.all([
    recentMessages(env, c.chatId, s.historyLimit, c.excludeId),
    getNotes(env, c.chatId).catch(() => []),
    getTodos(env, c.chatId, true).catch(() => []),
  ]);

  const guidelines = rules.filter((r) => r.type === "ai_guideline").map((r) => r.response);
  const notesText = userNotes.slice(0, 10).map((n) => n.content);
  const todosText = userTodos.slice(0, 10).map((t) => t.task);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(s, {
        isGroup: c.isGroup,
        chatName: c.chatName,
        now: new Date(),
        guidelines,
        notes: notesText,
        todos: todosText,
      }),
    },
    ...history.map((h): ChatMessage => ({
      role: h.role,
      content: c.isGroup && h.role === "user" && h.sender_name ? `${h.sender_name}: ${h.content}` : h.content,
    })),
    { role: "user", content: c.userContent },
  ];

  try {
    const out = await getProvider(s.provider).generate(env, {
      model: s.model,
      messages,
      maxTokens: s.maxReplyTokens,
      temperature: s.temperature,
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
        created_at: Date.now(),
      }),
      addUsage(env, out.neurons),
    ]);
    return { action: "reply", reply: out.text, model: out.model, neurons: out.neurons };
  } catch (err) {
    console.error("AI generation failed", { model: s.model, error: String(err) });
    return { action: "reply", reply: "Forgive me, my thoughts fluttered for a second. Please send that once more. 🌹✨" };
  }
}
