import type { AppEnv } from "./env";
import {
  addUsage,
  createBooking,
  findLatestBookingForChat,
  getEnabledRules,
  getNotes,
  getTodos,
  insertMessage,
  recentMessages,
  updateBooking,
  upsertChat,
  type Rule,
  type StoredMessage,
} from "./db";
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
    senderPhone: m.senderPhone ?? undefined,
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

  return generateReply(env, s, rules, {
    chatId,
    chatName: "Dashboard Lead",
    senderPhone: undefined,
    isGroup: false,
    excludeId: msgId,
    userContent: text,
    source: "dashboard",
  });
}

function extractBookingDetails(text: string, history: StoredMessage[]): {
  email: string | null;
  phone: string | null;
  time: string | null;
  requirements: string | null;
  clientName: string | null;
} {
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const emailMatch = text.match(emailRegex);
  let email = emailMatch ? emailMatch[0] : null;

  if (!email) {
    for (const h of history.slice(-4)) {
      if (h.role === "user") {
        const m = h.content.match(emailRegex);
        if (m) {
          email = m[0];
          break;
        }
      }
    }
  }

  // Detect phone mentions in text (e.g. +1 415 889 2200, +8801889755665, 01889755665)
  const phoneRegex = /(?:\+?\d{1,4}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/;
  const phoneMatch = text.match(phoneRegex);
  const phone = phoneMatch && phoneMatch[0].replace(/\D/g, "").length >= 7 ? phoneMatch[0].trim() : null;

  // Detect client name mentions (e.g. "I'm Alex", "My name is David", "Name: Sarah")
  const nameRegex = /(?:my name is|i'm|i am|name[:\s]+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i;
  const nameMatch = text.match(nameRegex);
  const clientName = nameMatch ? nameMatch[1].trim() : null;

  // Detect time/date mentions and extract the specific phrase
  const timePhraseRegex = /(?:(?:next\s+)?(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|morning|evening|afternoon|noon|night))?|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b(?:\s*[A-Z]{2,4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i;
  const timePhraseMatch = text.match(timePhraseRegex);
  let time: string | null = null;
  if (timePhraseMatch) {
    time = timePhraseMatch[0].trim();
  } else {
    const looseTime = /(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b\d{1,2}\s*(am|pm)\b|evening|morning)/i;
    const looseMatch = text.match(looseTime);
    if (looseMatch) {
      const sentence = text.split(/[.?!,\n]/).find((s) => looseTime.test(s));
      time = sentence ? sentence.trim() : looseMatch[0].trim();
    }
  }

  // Extract requirements from user text and recent conversation history
  const allUserText = [...history.filter((h) => h.role === "user").map((h) => h.content), text].join(" ").toLowerCase();
  const reqsList: string[] = [];
  if (allUserText.includes("short") || allUserText.includes("reel") || allUserText.includes("tiktok") || allUserText.includes("shorts")) {
    reqsList.push("Short-form (Reels/TikTok/Shorts)");
  }
  if (allUserText.includes("youtube") || allUserText.includes("long") || allUserText.includes("podcast") || allUserText.includes("vsl")) {
    reqsList.push("Long-form (YouTube/Podcasts)");
  }
  if (allUserText.includes("motion") || allUserText.includes("vfx") || allUserText.includes("graphic")) {
    reqsList.push("Motion Graphics & FX");
  }
  if (allUserText.includes("intake") || allUserText.includes("brief")) {
    reqsList.push("Project Brief Intake");
  }
  if (allUserText.includes("trial") || allUserText.includes("kickstart") || allUserText.includes("29")) {
    reqsList.push("Kickstart Trial ($29)");
  }
  if (allUserText.includes("growth") || allUserText.includes("490")) {
    reqsList.push("Growth Plan ($490/mo)");
  }
  if (allUserText.includes("scale") || allUserText.includes("890")) {
    reqsList.push("Scale Plan ($890/mo)");
  }
  if (allUserText.includes("advance") || allUserText.includes("1490") || allUserText.includes("1,490")) {
    reqsList.push("Advance Plan ($1,490/mo)");
  }
  if (allUserText.includes("premium") || allUserText.includes("1590") || allUserText.includes("1,590")) {
    reqsList.push("Premium Tier ($1,590/mo)");
  }

  const requirements = reqsList.length > 0 ? reqsList.join(", ") : "Video Editing Consultation";
  return { email, phone, time, requirements, clientName };
}

async function generateReply(
  env: AppEnv,
  s: Settings,
  rules: Rule[],
  c: { chatId: string; chatName?: string; senderPhone?: string; isGroup: boolean; excludeId: string; userContent: string; source: string },
): Promise<Decision> {
  const [history, userNotes, userTodos] = await Promise.all([
    recentMessages(env, c.chatId, s.historyLimit, c.excludeId),
    getNotes(env, c.chatId).catch(() => []),
    getTodos(env, c.chatId, true).catch(() => []),
  ]);

  const guidelines = rules.filter((r) => r.type === "ai_guideline").map((r) => r.response);
  const notesText = userNotes.slice(0, 10).map((n) => n.content);
  const todosText = userTodos.slice(0, 10).map((t) => t.task);

  // Automatic Call Booking / Lead Capture
  let bookingContext = "";
  const bookingInfo = extractBookingDetails(c.userContent, history);
  if (
    bookingInfo.email ||
    (bookingInfo.time && (c.userContent.toLowerCase().includes("call") || c.userContent.toLowerCase().includes("meet") || c.userContent.toLowerCase().includes("book") || c.userContent.toLowerCase().includes("schedule")))
  ) {
    try {
      const existing = await findLatestBookingForChat(env, c.chatId);
      const computedName =
        bookingInfo.clientName ||
        (c.chatName && c.chatName !== "Dashboard" ? c.chatName : null) ||
        (c.senderPhone ? `+${c.senderPhone}` : null) ||
        (bookingInfo.email ? bookingInfo.email.split("@")[0] : "New Lead");
      const computedPhone = bookingInfo.phone || c.senderPhone || null;

      if (existing) {
        await updateBooking(env, existing.id, {
          client_name: bookingInfo.clientName || (existing.client_name === "New Lead" || existing.client_name === "Dashboard Lead" ? computedName : existing.client_name),
          phone: computedPhone || existing.phone,
          email: bookingInfo.email || existing.email,
          scheduled_at: bookingInfo.time || existing.scheduled_at,
          requirements: bookingInfo.requirements || existing.requirements,
          status: (bookingInfo.email || existing.email) && (bookingInfo.time || existing.scheduled_at) ? "booked" : existing.status,
        });

        const effEmail = bookingInfo.email || existing.email;
        const effTime = bookingInfo.time || existing.scheduled_at;
        if (effEmail && effTime) {
          bookingContext = `The client has provided their name (${computedName}), email (${effEmail}), and preferred time (${effTime}). Acknowledge these details naturally as a human sales representative: let them know you've noted it down and our sales manager will review our schedule and send over the invite shortly. NEVER say "CRM", "app", "database", "sheet", or that you are an AI.`;
        } else if (effTime && !effEmail) {
          bookingContext = `The client mentioned a preferred time (${effTime}), but hasn't shared their email yet. Acknowledge the time naturally and ask for their email address so our manager can send the calendar invite.`;
        } else if (effEmail && !effTime) {
          bookingContext = `The client shared their email (${effEmail}), but hasn't given a preferred day/time. Acknowledge the email and ask what day and time works best for a quick 15-minute call.`;
        }
      } else {
        await createBooking(env, {
          chat_id: c.chatId,
          client_name: computedName,
          phone: computedPhone,
          email: bookingInfo.email,
          scheduled_at: bookingInfo.time,
          requirements: bookingInfo.requirements,
          status: "booked",
          source: c.source,
        });

        if (bookingInfo.email && bookingInfo.time) {
          bookingContext = `The client provided their name (${computedName}), email (${bookingInfo.email}), and preferred time (${bookingInfo.time}). Acknowledge these details naturally as a human sales representative: let them know you've noted down their time and email, and our sales manager will review our calendar and send over the invite shortly. NEVER say "CRM", "app", "database", "sheet", or that you are an AI.`;
        } else if (bookingInfo.time && !bookingInfo.email) {
          bookingContext = `The client mentioned a preferred time (${bookingInfo.time}), but hasn't given their email. Acknowledge the time warmly and ask what email address our manager should send the invite to.`;
        } else if (bookingInfo.email && !bookingInfo.time) {
          bookingContext = `The client provided their email (${bookingInfo.email}), but hasn't mentioned a time. Acknowledge their email and ask what day and time works best for a quick 15-minute call.`;
        } else {
          bookingContext = `The client is interested in discussing their project. Suggest arranging a quick 15-minute discovery call with our sales manager and ask for their preferred day/time and email address.`;
        }
      }
    } catch (err) {
      console.warn("Failed recording call booking lead:", err);
    }
  }

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
        bookingContext,
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
