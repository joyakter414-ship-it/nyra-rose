import type { AppEnv } from "./env";
import {
  addUsage,
  createBooking,
  findLatestBookingForChat,
  getDueFollowups,
  getEnabledRules,
  getNotes,
  getTodos,
  insertMessage,
  recentMessages,
  updateBooking,
  upsertChat,
  type Booking,
  type BookingStatus,
  type FollowupType,
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

export function isInstantReplyPaused(s: Settings, chatId?: string | null, senderPhone?: string | null): boolean {
  if (s.instantReplyPaused) return true;
  if (!Array.isArray(s.pausedInstantChats) || s.pausedInstantChats.length === 0) return false;
  const cleanChatPhone = (chatId?.includes("@") ? chatId.split("@")[0] : chatId || "").replace(/\D/g, "");
  const cleanSender = (senderPhone || "").replace(/\D/g, "");
  return s.pausedInstantChats.some(
    (p) => (cleanChatPhone && p === cleanChatPhone) || (cleanSender && p === cleanSender),
  );
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

  const instantPaused = isInstantReplyPaused(s, m.chatId, m.senderPhone);

  // 1. Built-in command dispatcher (/help, /note, /todo, /status, /reset)
  if (!instantPaused) {
    const cmdResult = await handleCommand(env, m.chatId, m.text);
    if (cmdResult.handled && cmdResult.reply) {
      return { action: "reply", reply: cmdResult.reply, model: "system:command", neurons: 0 };
    }
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

  // 2. Rule Book check: instant reply triggers (free, 0 Neurons) — skipped if instant reply is paused
  const rules = await getEnabledRules(env);
  if (!instantPaused) {
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

// ─── Time Parsing, Phone Timezone Detection & Follow-Up Scheduling Engine ─────

export interface DetectedTimezone {
  code: string;        // e.g. "AEST", "BDT", "EST", "GMT", "IST"
  label: string;       // e.g. "Australian Time (AEST, GMT+10)"
  country: string;     // e.g. "Australia"
  offsetHours: number; // e.g. 10, 6, -5, 0, 5.5
}

const PHONE_PREFIX_TIMEZONES: Array<{ prefix: string; tz: DetectedTimezone }> = [
  // 3-digit country codes first
  { prefix: "880", tz: { code: "BDT", label: "Bangladesh Time (GMT+6)", country: "Bangladesh", offsetHours: 6 } },
  { prefix: "971", tz: { code: "GST", label: "UAE / Dubai Time (GMT+4)", country: "UAE", offsetHours: 4 } },
  { prefix: "966", tz: { code: "AST", label: "Saudi Arabia Time (GMT+3)", country: "Saudi Arabia", offsetHours: 3 } },
  { prefix: "974", tz: { code: "AST", label: "Qatar Time (GMT+3)", country: "Qatar", offsetHours: 3 } },
  { prefix: "965", tz: { code: "AST", label: "Kuwait Time (GMT+3)", country: "Kuwait", offsetHours: 3 } },
  { prefix: "968", tz: { code: "GST", label: "Oman Time (GMT+4)", country: "Oman", offsetHours: 4 } },
  { prefix: "973", tz: { code: "AST", label: "Bahrain Time (GMT+3)", country: "Bahrain", offsetHours: 3 } },
  { prefix: "234", tz: { code: "WAT", label: "Nigeria Time (WAT, GMT+1)", country: "Nigeria", offsetHours: 1 } },
  { prefix: "254", tz: { code: "EAT", label: "Kenya Time (EAT, GMT+3)", country: "Kenya", offsetHours: 3 } },
  { prefix: "353", tz: { code: "GMT", label: "Ireland Time (GMT)", country: "Ireland", offsetHours: 0 } },
  { prefix: "351", tz: { code: "WET", label: "Portugal Time (GMT)", country: "Portugal", offsetHours: 0 } },
  { prefix: "358", tz: { code: "EET", label: "Finland Time (EET, GMT+2)", country: "Finland", offsetHours: 2 } },
  { prefix: "852", tz: { code: "HKT", label: "Hong Kong Time (HKT, GMT+8)", country: "Hong Kong", offsetHours: 8 } },
  { prefix: "886", tz: { code: "CST", label: "Taiwan Time (GMT+8)", country: "Taiwan", offsetHours: 8 } },
  // 2-digit country codes
  { prefix: "61", tz: { code: "AEST", label: "Australian Time (AEST, GMT+10)", country: "Australia", offsetHours: 10 } },
  { prefix: "64", tz: { code: "NZST", label: "New Zealand Time (NZST, GMT+12)", country: "New Zealand", offsetHours: 12 } },
  { prefix: "44", tz: { code: "GMT", label: "UK Time (GMT)", country: "United Kingdom", offsetHours: 0 } },
  { prefix: "91", tz: { code: "IST", label: "India Time (IST, GMT+5:30)", country: "India", offsetHours: 5.5 } },
  { prefix: "92", tz: { code: "PKT", label: "Pakistan Time (PKT, GMT+5)", country: "Pakistan", offsetHours: 5 } },
  { prefix: "65", tz: { code: "SGT", label: "Singapore Time (SGT, GMT+8)", country: "Singapore", offsetHours: 8 } },
  { prefix: "60", tz: { code: "MYT", label: "Malaysia Time (MYT, GMT+8)", country: "Malaysia", offsetHours: 8 } },
  { prefix: "63", tz: { code: "PHT", label: "Philippines Time (PHT, GMT+8)", country: "Philippines", offsetHours: 8 } },
  { prefix: "62", tz: { code: "WIB", label: "Indonesia Time (WIB, GMT+7)", country: "Indonesia", offsetHours: 7 } },
  { prefix: "66", tz: { code: "ICT", label: "Thailand Time (ICT, GMT+7)", country: "Thailand", offsetHours: 7 } },
  { prefix: "84", tz: { code: "ICT", label: "Vietnam Time (ICT, GMT+7)", country: "Vietnam", offsetHours: 7 } },
  { prefix: "81", tz: { code: "JST", label: "Japan Time (JST, GMT+9)", country: "Japan", offsetHours: 9 } },
  { prefix: "82", tz: { code: "KST", label: "South Korea Time (KST, GMT+9)", country: "South Korea", offsetHours: 9 } },
  { prefix: "86", tz: { code: "CST", label: "China Time (CST, GMT+8)", country: "China", offsetHours: 8 } },
  { prefix: "49", tz: { code: "CET", label: "German / Central European Time (CET, GMT+1)", country: "Germany", offsetHours: 1 } },
  { prefix: "33", tz: { code: "CET", label: "French / Central European Time (CET, GMT+1)", country: "France", offsetHours: 1 } },
  { prefix: "39", tz: { code: "CET", label: "Italian / Central European Time (CET, GMT+1)", country: "Italy", offsetHours: 1 } },
  { prefix: "34", tz: { code: "CET", label: "Spanish / Central European Time (CET, GMT+1)", country: "Spain", offsetHours: 1 } },
  { prefix: "31", tz: { code: "CET", label: "Netherlands Time (CET, GMT+1)", country: "Netherlands", offsetHours: 1 } },
  { prefix: "32", tz: { code: "CET", label: "Belgium Time (CET, GMT+1)", country: "Belgium", offsetHours: 1 } },
  { prefix: "41", tz: { code: "CET", label: "Switzerland Time (CET, GMT+1)", country: "Switzerland", offsetHours: 1 } },
  { prefix: "43", tz: { code: "CET", label: "Austria Time (CET, GMT+1)", country: "Austria", offsetHours: 1 } },
  { prefix: "46", tz: { code: "CET", label: "Sweden Time (CET, GMT+1)", country: "Sweden", offsetHours: 1 } },
  { prefix: "47", tz: { code: "CET", label: "Norway Time (CET, GMT+1)", country: "Norway", offsetHours: 1 } },
  { prefix: "45", tz: { code: "CET", label: "Denmark Time (CET, GMT+1)", country: "Denmark", offsetHours: 1 } },
  { prefix: "48", tz: { code: "CET", label: "Poland Time (CET, GMT+1)", country: "Poland", offsetHours: 1 } },
  { prefix: "90", tz: { code: "TRT", label: "Turkey Time (TRT, GMT+3)", country: "Turkey", offsetHours: 3 } },
  { prefix: "20", tz: { code: "EET", label: "Egypt Time (EET, GMT+2)", country: "Egypt", offsetHours: 2 } },
  { prefix: "27", tz: { code: "SAST", label: "South Africa Time (SAST, GMT+2)", country: "South Africa", offsetHours: 2 } },
  { prefix: "55", tz: { code: "BRT", label: "Brazil Time (BRT, GMT-3)", country: "Brazil", offsetHours: -3 } },
  { prefix: "52", tz: { code: "CST", label: "Mexico Time (CST, GMT-6)", country: "Mexico", offsetHours: -6 } },
  { prefix: "54", tz: { code: "ART", label: "Argentina Time (ART, GMT-3)", country: "Argentina", offsetHours: -3 } },
  { prefix: "57", tz: { code: "COT", label: "Colombia Time (COT, GMT-5)", country: "Colombia", offsetHours: -5 } },
  // 1-digit country codes
  { prefix: "1", tz: { code: "EST", label: "US/Canada Eastern Time (EST, GMT-5)", country: "USA/Canada", offsetHours: -5 } },
];

/**
 * Automatically detects the client's timezone from their WhatsApp phone number or JID.
 */
export function detectTimezoneFromPhone(phoneOrChatId?: string | null): DetectedTimezone | null {
  if (!phoneOrChatId) return null;
  const raw = phoneOrChatId.split("@")[0].replace(/\D/g, "");
  if (raw.length < 7) return null;
  const digits = raw.startsWith("00") ? raw.slice(2) : raw;
  for (const item of PHONE_PREFIX_TIMEZONES) {
    if (digits.startsWith(item.prefix)) {
      return item.tz;
    }
  }
  return null;
}

export function getTimezoneOffsetHours(tz?: string | null, phoneFallback?: string | null): number {
  const u = (tz || "").toUpperCase().trim();
  if (u) {
    // Check explicit GMT+X / UTC-X offset first
    const offsetMatch = u.match(/(?:GMT|UTC)\s*([+-]\d{1,2})(?::(\d{2}))?/i);
    if (offsetMatch) {
      const hrs = parseInt(offsetMatch[1], 10);
      const mins = offsetMatch[2] ? parseInt(offsetMatch[2], 10) / 60 : 0;
      return hrs >= 0 ? hrs + mins : hrs - mins;
    }
    if (u.includes("AEDT")) return 11;
    if (u.includes("AEST") || u.includes("AUSTRAL") || u.includes("SYDNEY") || u.includes("MELBOURNE")) return 10;
    if (u.includes("ACST")) return 9.5;
    if (u.includes("AWST") || u.includes("PERTH")) return 8;
    if (u.includes("NZST") || u.includes("NEW ZEALAND")) return 12;
    if (u.includes("JST") || u.includes("JAPAN") || u.includes("KST") || u.includes("KOREA")) return 9;
    if (u.includes("SGT") || u.includes("SINGAPORE") || u.includes("MYT") || u.includes("MALAYSIA") || u.includes("PHT") || u.includes("HKT")) return 8;
    if (u.includes("ICT") || u.includes("WIB") || u.includes("THAI") || u.includes("INDONESIA")) return 7;
    if (u.includes("BDT") || u === "BD" || u.includes("BANGLADESH") || u.includes("DHAKA")) return 6;
    if (u.includes("IST") || u.includes("INDIA")) return 5.5;
    if (u.includes("PKT") || u.includes("PAKISTAN")) return 5;
    if (u.includes("GST") || u.includes("UAE") || u.includes("DUBAI")) return 4;
    if (u.includes("AST") || u.includes("SAUDI") || u.includes("QATAR") || u.includes("KUWAIT") || u.includes("TRT") || u.includes("EAT")) return 3;
    if (u.includes("EET") || u.includes("SAST")) return 2;
    if (u.includes("CET") || u.includes("EUROPE") || u.includes("GERMAN") || u.includes("FRANCE") || u.includes("WAT")) return 1;
    if (u === "GMT" || u === "UTC" || u.includes("UK") || u.includes("LONDON") || u.includes("WET")) return 0;
    if (u.includes("BRT") || u.includes("BRAZIL") || u.includes("ART")) return -3;
    if (u === "EDT") return -4;
    if (u === "EST" || u.includes("EASTERN") || u === "US" || u === "USA" || u === "CDT" || u.includes("COT")) return -5;
    if (u === "CST" || u.includes("CENTRAL") || u === "MDT") return -6;
    if (u === "MST" || u.includes("MOUNTAIN") || u === "PDT") return -7;
    if (u === "PST" || u.includes("PACIFIC")) return -8;
  }

  const fromPhone = detectTimezoneFromPhone(phoneFallback);
  if (fromPhone) return fromPhone.offsetHours;

  // Default: Bangladesh / Dhaka time (UTC+6)
  return 6;
}

/**
 * Formats a UTC millisecond timestamp into a clean human-readable date/time in the target timezone.
 * Example: "Today 1:30 PM GMT" or "Tomorrow 4:00 PM AEST"
 */
export function formatTimeInTimezone(
  utcMs: number,
  tz?: string | null,
  phoneFallback?: string | null,
  nowMs: number = Date.now(),
): string {
  const offsetHours = getTimezoneOffsetHours(tz, phoneFallback);
  const localMs = utcMs + offsetHours * 3600 * 1000;
  const localNowMs = nowMs + offsetHours * 3600 * 1000;
  const d = new Date(localMs);
  const nowD = new Date(localNowMs);

  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const timeStr = `${h}:${m.toString().padStart(2, "0")} ${ampm}`;

  const sameDay =
    d.getUTCFullYear() === nowD.getUTCFullYear() &&
    d.getUTCMonth() === nowD.getUTCMonth() &&
    d.getUTCDate() === nowD.getUTCDate();

  const tmrwD = new Date(localNowMs + 24 * 3600 * 1000);
  const isTomorrow =
    d.getUTCFullYear() === tmrwD.getUTCFullYear() &&
    d.getUTCMonth() === tmrwD.getUTCMonth() &&
    d.getUTCDate() === tmrwD.getUTCDate();

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayPrefix = sameDay ? "Today" : isTomorrow ? "Tomorrow" : `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const tzLabel = (tz || detectTimezoneFromPhone(phoneFallback)?.code || "BDT").toUpperCase();
  return `${dayPrefix} ${timeStr} ${tzLabel}`;
}

/**
 * Parses natural date/time expressions ("today 1: 30 pm gmt", "in 1: 30 gmt",
 * "tomorrow at 4pm", "21 min latter", "after 3 days") into Unix ms.
 */
export function parseScheduledTimeToMs(
  phrase: string | null | undefined,
  timezone?: string | null,
  nowMs: number = Date.now(),
  phoneFallback?: string | null,
): number | null {
  if (!phrase || !phrase.trim()) return null;
  // Normalize common typos ("latter" -> "later") and spaces around colons ("1: 30" -> "1:30")
  const p = phrase
    .toLowerCase()
    .replace(/\blatter\b/g, "later")
    .replace(/(\d{1,2})\s*:\s*(\d{2})/g, "$1:$2")
    .trim();

  // 1. Direct ISO / Date.parse check if it looks like a full YYYY-MM-DD date string
  if (/^\d{4}-\d{2}-\d{2}/.test(p)) {
    const parsed = Date.parse(phrase);
    if (!Number.isNaN(parsed) && parsed > nowMs - 86400_000) return parsed;
  }

  // 2. Relative expressions ("in 2 hours", "after 3 days", "21 min later", "2 min latter")
  const relMatch = p.match(/(?:in|after)?\s*(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day|week)s?(?:\s+later)?/i);
  if (relMatch) {
    const val = parseFloat(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    if (unit.startsWith("min")) return Math.round(nowMs + val * 60 * 1000);
    if (unit.startsWith("hour") || unit.startsWith("hr")) return Math.round(nowMs + val * 3600 * 1000);
    if (unit.startsWith("day")) return Math.round(nowMs + val * 24 * 3600 * 1000);
    if (unit.startsWith("week")) return Math.round(nowMs + val * 7 * 24 * 3600 * 1000);
  }

  // 3. Calculate in client's target timezone (explicit timezone or phone-number timezone)
  const tzOffsetHours = getTimezoneOffsetHours(timezone, phoneFallback);
  const localNowMs = nowMs + tzOffsetHours * 3600 * 1000;
  const localDate = new Date(localNowMs);

  let dayOffset = 0;
  if (p.includes("day after tomorrow")) {
    dayOffset = 2;
  } else if (p.includes("tomorrow")) {
    dayOffset = 1;
  } else if (p.includes("next week")) {
    dayOffset = 7;
  } else {
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

  // Extract time of day ("1:30 pm", "1:30", "at 4", "today 1")
  let hour = 15; // fallback 3:00 PM if only a day like "tomorrow" is given
  let minute = 0;
  const ampmMatch = p.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const colonMatch = p.match(/\b(\d{1,2}):(\d{2})\b/);
  const prepMatch = p.match(/(?:at|on|for|in|around|by|today|tomorrow)\s+(\d{1,2})(?::(\d{2}))?\b/i);

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
    // Business calls between 1:00 and 8:59 without AM/PM are afternoon/evening (PM)
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
  targetLocal.setUTCDate(targetLocal.getUTCDate() + dayOffset);
  targetLocal.setUTCHours(hour, minute, 0, 0);

  let targetUtcMs = targetLocal.getTime() - tzOffsetHours * 3600 * 1000;
  // If same day and the time has already passed by more than 15 minutes (and user didn't explicitly say "today"), assume tomorrow
  if (dayOffset === 0 && targetUtcMs <= nowMs - 15 * 60 * 1000 && !p.includes("today")) {
    targetUtcMs += 24 * 3600 * 1000;
  }

  return targetUtcMs;
}

/**
 * Computes the next follow-up state for a lead based on the 4-stage rules:
 * 1. Auto Day 1 (0–24h): follow up every 3–4 hours (3.5h) until call is booked.
 *    If call is booked -> NO sales follow-up, only 30-min pre-call reminder!
 * 2. No-Reply Next 3 Days (24h–96h): follow up every 8 hours.
 * 3. Long-Term 3-to-30 Days (96h–720h): follow up every 24 hours until 30 days.
 *    After 30 days with no reply -> mark as `fake_lead` and stop follow-ups!
 * 4. Client Choice Date (`client_date`) & Custom Management Timer (`custom_timer`).
 */
export function computeNextFollowupState(
  b: Partial<Booking>,
  nowMs: number = Date.now(),
): {
  status: BookingStatus;
  followup_type: FollowupType;
  next_followup_at: number | null;
  followup_interval_hours: number;
} {
  const curStatus: BookingStatus = b.status || "lead";
  const curType: FollowupType = b.followup_type || "auto_day1";

  // 1. Rejected / Not Interested / Fake Lead / Completed / Cancelled -> Stop all follow-ups
  if (
    curType === "rejected" ||
    curStatus === "not_interested" ||
    curStatus === "fake_lead" ||
    curStatus === "completed" ||
    curStatus === "cancelled"
  ) {
    return {
      status: curStatus,
      followup_type: curType === "rejected" ? "rejected" : curType,
      next_followup_at: null,
      followup_interval_hours: 0,
    };
  }

  // 2. Booked or Confirmed Call -> Stop sales follow-ups; schedule ONLY 30-minute pre-call reminder
  if (curStatus === "booked" || curStatus === "confirmed") {
    const callMs = b.call_time_ms || parseScheduledTimeToMs(b.scheduled_at, b.timezone, nowMs, b.phone || b.chat_id);
    let reminderAt: number | null = null;
    if (callMs) {
      const thirtyMinBefore = callMs - 30 * 60 * 1000;
      if (thirtyMinBefore > nowMs) {
        reminderAt = thirtyMinBefore;
      } else if (callMs > nowMs - 10 * 60 * 1000 && (!b.last_followup_at || b.last_followup_at < thirtyMinBefore)) {
        // Call is less than 30 mins away (or just starting) and reminder hasn't been sent yet -> send immediately on next gateway tick!
        reminderAt = nowMs + 5_000;
      }
    }
    return {
      status: curStatus,
      followup_type: "call_reminder",
      next_followup_at: reminderAt,
      followup_interval_hours: 0,
    };
  }

  // 3. Client Choice Date (if scheduled in the future)
  if (curType === "client_date" && b.next_followup_at && b.next_followup_at > nowMs) {
    return {
      status: curStatus,
      followup_type: "client_date",
      next_followup_at: b.next_followup_at,
      followup_interval_hours: b.followup_interval_hours ?? 24,
    };
  }

  // 4. Custom Management Timer (if scheduled in the future)
  if (curType === "custom_timer" && b.next_followup_at && b.next_followup_at > nowMs) {
    return {
      status: curStatus,
      followup_type: "custom_timer",
      next_followup_at: b.next_followup_at,
      followup_interval_hours: b.followup_interval_hours ?? 2,
    };
  }

  // 5. Dynamic Unanswered Lead Progression (Day 1 -> Next 3 Days -> Up to 30 Days -> Fake Lead)
  const lastReplyMs = b.last_client_reply_at || b.created_at || nowMs;
  const elapsedHours = (nowMs - lastReplyMs) / (3600 * 1000);

  // Over 30 days (720 hours) with no reply -> Mark as Fake Lead and stop follow-ups
  if (elapsedHours >= 24 * 30) {
    return {
      status: "fake_lead",
      followup_type: "rejected",
      next_followup_at: null,
      followup_interval_hours: 0,
    };
  }

  // After 3+1 days (96h to 720h / up to 30 days) -> Follow up every 24h
  if (elapsedHours >= 24 * 4) {
    return {
      status: curStatus,
      followup_type: "long_term_30d",
      next_followup_at: nowMs + 24 * 3600 * 1000,
      followup_interval_hours: 24,
    };
  }

  // Next 3 days after Day 1 (24h to 96h) -> Follow up every 8 hours
  if (elapsedHours >= 24) {
    return {
      status: curStatus,
      followup_type: "no_reply_3d",
      next_followup_at: nowMs + 8 * 3600 * 1000,
      followup_interval_hours: 8,
    };
  }

  // First 1 Day (0h to 24h) -> Follow up every 3.5 hours (3–4 hours)
  return {
    status: curStatus,
    followup_type: "auto_day1",
    next_followup_at: nowMs + 3.5 * 3600 * 1000,
    followup_interval_hours: 3.5,
  };
}

function normalizeTimezoneMention(rawTz: string): string {
  const u = rawTz.toUpperCase().trim();
  if (/^(?:GMT|UTC)\s*[+-]\d{1,2}/.test(u)) return u.replace(/\s+/g, "");
  if (u.includes("AUSTRAL") || u.includes("SYDNEY") || u.includes("MELBOURNE") || u === "AEST") return "AEST";
  if (u === "AEDT") return "AEDT";
  if (u === "AWST" || u.includes("PERTH")) return "AWST";
  if (u.includes("NEW ZEALAND") || u === "NZST") return "NZST";
  if (u.includes("BANGLADESH") || u.includes("DHAKA") || u.startsWith("BD")) return "BDT";
  if (u.includes("INDIA") || u === "IST") return "IST";
  if (u.includes("PAKISTAN") || u === "PKT") return "PKT";
  if (u.includes("DUBAI") || u.includes("UAE") || u === "GST") return "GST";
  if (u.includes("SAUDI") || u === "AST") return "AST";
  if (u.includes("SINGAPORE") || u === "SGT") return "SGT";
  if (u.includes("MALAYSIA") || u === "MYT") return "MYT";
  if (u.includes("UK") || u.includes("LONDON") || u === "GMT") return "GMT";
  if (u === "UTC") return "UTC";
  if (u.includes("EUROPE") || u.includes("GERMAN") || u.includes("FRANCE") || u === "CET") return "CET";
  if (u.includes("EASTERN") || u === "EST" || u === "US" || u === "USA") return "EST";
  if (u === "EDT") return "EDT";
  if (u.includes("PACIFIC") || u === "PST") return "PST";
  if (u === "PDT") return "PDT";
  if (u.includes("CENTRAL") || u === "CST") return "CST";
  if (u === "CDT") return "CDT";
  if (u.includes("MOUNTAIN") || u === "MST") return "MST";
  return u;
}

function extractBookingDetails(text: string, history: StoredMessage[]): {
  email: string | null;
  phone: string | null;
  time: string | null;
  timezone: string | null;
  companyOrWebsite: string | null;
  requirements: string | null;
  clientName: string | null;
  isClientChoiceFollowup: boolean;
  isRescheduleRequest: boolean;
  inferredStatus: BookingStatus | null;
  inferredFollowupType: FollowupType | null;
} {
  // Normalize spaces around time colons ("1: 30 pm" -> "1:30 pm") and "latter" -> "later"
  const normalizedText = text
    .replace(/\blatter\b/gi, "later")
    .replace(/(\d{1,2})\s*:\s*(\d{2})/g, "$1:$2");

  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const emailMatch = normalizedText.match(emailRegex);
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

  // Detect phone mentions in text
  const phoneRegex = /(?:\+?\d{1,4}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/;
  const phoneMatch = normalizedText.match(phoneRegex);
  const phone = phoneMatch && phoneMatch[0].replace(/\D/g, "").length >= 7 ? phoneMatch[0].trim() : null;

  // Detect client name mentions
  const nameRegex = /(?:my name is|i'm|i am|name[:\s]+)\s+([A-Z][a-z]+(?:\s+(?!from|at|with|the|and|here|of\b)[A-Z][a-z]+)?)/i;
  const nameMatch = normalizedText.match(nameRegex);
  const clientName = nameMatch ? nameMatch[1].trim() : null;

  // Detect time/date mentions and relative phrases ("today 1:30 pm", "in 1:30", "2 hour later", "tomorrow at 4pm", "at 2 pm")
  const timePhraseRegex =
    /(?:(?:in|after)?\s*\d+(?:\.\d+)?\s*(?:hour|hr|minute|min|day|week)s?(?:\s+later)?|(?:next\s+)?(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:at\s+)?(?:\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|morning|evening|afternoon|noon|night))?|\b\d{1,2}:\d{2}\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i;
  const timePhraseMatch = normalizedText.match(timePhraseRegex);
  let time: string | null = null;
  if (timePhraseMatch) {
    // Avoid matching package numbers like "30 days" unless accompanied by in/after/later
    const rawMatched = timePhraseMatch[0].trim();
    const isBareUnitWithoutCue =
      /^\d+(?:\.\d+)?\s*(?:hour|hr|minute|min|day|week)s?$/i.test(rawMatched) &&
      !/\b(in|after|later|free|msg|message|text|talk|call|ping|remind|back)\b/i.test(normalizedText);
    if (!isBareUnitWithoutCue) {
      const dayPrefixMatch = normalizedText.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
      if (dayPrefixMatch && !rawMatched.toLowerCase().includes(dayPrefixMatch[1].toLowerCase())) {
        time = `${dayPrefixMatch[1]} ${rawMatched}`;
      } else {
        time = rawMatched;
      }
    }
  }
  if (!time) {
    const looseTime = /(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b\d{1,2}\s*(am|pm)\b|evening|morning|next week)/i;
    const looseMatch = normalizedText.match(looseTime);
    if (looseMatch) {
      const sentence = normalizedText.split(/[.?!,\n]/).find((s) => looseTime.test(s));
      time = sentence ? sentence.trim() : looseMatch[0].trim();
    }
  }

  // Detect explicit timezone mentions (including GMT+6, Australian time, UK time, India time, etc.)
  const tzRegex =
    /\b((?:GMT|UTC)\s*[+-]\d{1,2}(?::\d{2})?|EST|PST|CST|MST|EDT|PDT|CDT|MDT|GMT|BST|BDT|UTC|CET|AEST|AEDT|AWST|ACST|NZST|IST|PKT|GST|AST|SGT|MYT|PHT|HKT|JST|KST|Australi(?:an|a)(?:\s+time(?:\s*zone)?)?|Sydney(?:\s+time)?|Melbourne(?:\s+time)?|Dhaka(?:\s+time)?|Bangladesh(?:\s+time)?|BD(?:\s+time)?|UK(?:\s+time)?|London(?:\s+time)?|India(?:\s+time)?|Pakistan(?:\s+time)?|Dubai(?:\s+time)?|UAE(?:\s+time)?|Eastern(?:\s+time)?|Pacific(?:\s+time)?|Central(?:\s+time)?)\b/i;
  const tzMatch = normalizedText.match(tzRegex);
  const timezone = tzMatch ? normalizeTimezoneMention(tzMatch[1]) : null;

  // Detect website / channel URL mentions (excluding gmail/yahoo/outlook/hotmail domains from email)
  const textWithoutEmails = normalizedText.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "");
  const siteRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.(?:com|org|io|net|co|app|agency|tv|dev)|youtube\.com\/@[a-zA-Z0-9_.-]+|instagram\.com\/[a-zA-Z0-9_.-]+)/i;
  const siteMatch = textWithoutEmails.match(siteRegex);
  const companyOrWebsite = siteMatch ? siteMatch[0] : null;

  const lower = normalizedText.toLowerCase();
  const isRescheduleRequest =
    (Boolean(time) || Boolean(timezone)) &&
    (lower.includes("change") ||
      lower.includes("reschedule") ||
      lower.includes("move") ||
      lower.includes("shift") ||
      lower.includes("instead") ||
      lower.includes("postpone") ||
      lower.includes("another time") ||
      lower.includes("new time") ||
      lower.startsWith("no ") ||
      lower.startsWith("no,"));

  const hasExplicitCallWord =
    lower.includes("book") ||
    lower.includes("call") ||
    lower.includes("meet") ||
    lower.includes("zoom") ||
    lower.includes("schedule") ||
    lower.includes("slot");

  // Client says when they are free or will message later ("i msg you 2 hour later", "i am free at 2 pm", "busy now talk in 2 hours")
  const isClientChoiceFollowup =
    Boolean(time) &&
    !isRescheduleRequest &&
    !hasExplicitCallWord &&
    !email &&
    (lower.includes("msg") ||
      lower.includes("message") ||
      lower.includes("text") ||
      lower.includes("free") ||
      lower.includes("available") ||
      lower.includes("follow up") ||
      lower.includes("followup") ||
      lower.includes("contact") ||
      lower.includes("reach out") ||
      lower.includes("ping") ||
      lower.includes("remind") ||
      lower.includes("busy") ||
      lower.includes("talk") ||
      lower.includes("chat") ||
      lower.includes("later") ||
      lower.includes("after") ||
      lower.includes("check back"));

  // Automatically infer lead status updates from client's message
  let inferredStatus: BookingStatus | null = null;
  let inferredFollowupType: FollowupType | null = null;

  if (
    /\b(not interested|no interest|stop messaging|don't message|dont message|remove me|unsubscribe|don't need|dont need|no need|already hired|already have an editor)\b/i.test(lower)
  ) {
    inferredStatus = "not_interested";
    inferredFollowupType = "rejected";
  } else if (
    /\b(missed the call|missed our call|sorry i missed|couldn't join|couldnt join|wasn't able to join)\b/i.test(lower)
  ) {
    inferredStatus = "not_attended";
    inferredFollowupType = "not_attended";
  } else if (
    /\b(buy in a few days|start in a few days|start next week|buy next week|still deciding|thinking about the package|will order soon|buy soon)\b/i.test(lower)
  ) {
    inferredStatus = "buy_soon";
    inferredFollowupType = "buy_soon";
  } else if (/\b(on hold|pause for now|maybe next month|not right now)\b/i.test(lower)) {
    inferredFollowupType = "on_hold";
  }

  // Extract requirements, niche, and volume from user text and recent conversation history
  const allUserText = [...history.filter((h) => h.role === "user").map((h) => h.content), normalizedText].join(" ").toLowerCase();
  const reqsList: string[] = [];
  if (allUserText.includes("short") || allUserText.includes("reel") || allUserText.includes("tiktok") || allUserText.includes("shorts")) {
    reqsList.push("Short-form (Reels/TikTok/Shorts)");
  }
  if (allUserText.includes("youtube") || allUserText.includes("long") || allUserText.includes("podcast") || allUserText.includes("vsl")) {
    reqsList.push("Long-form (YouTube/Podcasts)");
  }
  if (allUserText.includes("talking head") || allUserText.includes("coach") || allUserText.includes("course")) {
    reqsList.push("Talking-Head / Coaching");
  }
  if (allUserText.includes("agency") || allUserText.includes("white label") || allUserText.includes("whitelabel") || allUserText.includes("clients")) {
    reqsList.push("Agency White-Label");
  }
  if (allUserText.includes("motion") || allUserText.includes("vfx") || allUserText.includes("graphic") || allUserText.includes("cinematic")) {
    reqsList.push("Motion Graphics & FX");
  }
  if (allUserText.includes("real estate") || allUserText.includes("property")) {
    reqsList.push("Real Estate Niche");
  }
  if (allUserText.includes("ecom") || allUserText.includes("ad") || allUserText.includes("ugc")) {
    reqsList.push("Ad Creatives / E-com");
  }
  const volMatch = allUserText.match(/\b(\d{1,3})\s*(?:-\s*\d{1,3}\s*)?(?:videos?|reels?|shorts?|edits?)\s*(?:a|per|\/)?\s*(?:month|mo|week|wk|day)?\b/i);
  if (volMatch) {
    reqsList.push(`Volume: ~${volMatch[0].trim()}`);
  }
  const budgetDollarMatch = allUserText.match(/(?:\$\s*(\d{2,4})|(\d{2,4})\s*(?:dollars?|usd|\$))/i);
  if (budgetDollarMatch) {
    const amt = budgetDollarMatch[1] || budgetDollarMatch[2];
    if (!["29", "490", "890", "1490", "2499"].includes(amt)) {
      reqsList.push(`Client Budget: ~$${amt} (Negotiable)`);
    }
  } else if (/\b(low budget|small budget|tight budget|negotiate|negotiable|discount)\b/i.test(allUserText)) {
    reqsList.push("Custom / Negotiable Budget");
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
  if (allUserText.includes("premium") || allUserText.includes("2499") || allUserText.includes("2,499") || allUserText.includes("1590")) {
    reqsList.push("Premium Tier ($2,499/mo)");
  }

  const requirements = reqsList.length > 0 ? reqsList.join(", ") : "Video Editing Consultation";
  return {
    email,
    phone,
    time,
    timezone,
    companyOrWebsite,
    requirements,
    clientName,
    isClientChoiceFollowup,
    isRescheduleRequest,
    inferredStatus,
    inferredFollowupType,
  };
}

/**
 * Deeply analyzes the client's past conversation, remembered profile, and current message intent
 * so Nyra talks like an elite human salesperson who remembers everything and knows what to say next.
 */
function analyzeConversationMemory(params: {
  userContent: string;
  history: StoredMessage[];
  existing: Booking | null;
  bookingInfo: ReturnType<typeof extractBookingDetails>;
  phoneTz: { code: string; offsetHours: number; label: string; country: string } | null;
  computedName: string;
}): string {
  const { userContent, history, existing, bookingInfo, phoneTz, computedName } = params;
  const lower = userContent.toLowerCase();
  const userMsgs = history.filter((m) => m.role === "user");
  const assistantMsgs = history.filter((m) => m.role === "assistant");
  const allAssistantText = assistantMsgs.map((m) => m.content.toLowerCase()).join("\n");

  const alreadySharedPricing =
    allAssistantText.includes("$490") || allAssistantText.includes("$890") || allAssistantText.includes("growth plan");
  const alreadySharedPortfolio = allAssistantText.includes("vidmox.pages.dev/portfolio");
  const alreadySharedCalendly = allAssistantText.includes("calendly.com/armaan-gineus");
  const knownScope =
    bookingInfo.requirements !== "Video Editing Consultation"
      ? bookingInfo.requirements
      : existing?.requirements && existing.requirements !== "Video Editing Consultation"
      ? existing.requirements
      : null;
  const knownEmail = bookingInfo.email || existing?.email || null;
  const knownWebsite = bookingInfo.companyOrWebsite || existing?.company_or_website || null;
  const knownScheduledAt = existing?.scheduled_at || null;

  // Detect specific conversational intent in the current message
  let detectedIntent = "GENERAL CONVERSATION / DISCOVERY";
  let nextSalesObjective = "";

  if (bookingInfo.inferredStatus === "not_interested") {
    detectedIntent = "CLIENT DECLINING / NOT INTERESTED";
    nextSalesObjective =
      "Be 100% polite, warm, and zero-pressure ('Totally understand! Thanks for letting me know, and feel free to reach out anytime in the future if your editing needs change.'). Do NOT pitch or push.";
  } else if (bookingInfo.isClientChoiceFollowup && bookingInfo.time) {
    detectedIntent = `CLIENT BUSY / WILL TALK AT SPECIFIED TIME (${bookingInfo.time})`;
    nextSalesObjective =
      "Acknowledge warmly without any pressure. Confirm you've noted their time and will check back in with them then.";
  } else if (/\b(are you a bot|are you ai|is this a bot|automated|chatting with a bot|real person)\b/i.test(lower)) {
    detectedIntent = "ASKING IF YOU ARE HUMAN OR AI";
    nextSalesObjective =
      "Reassure them warmly and naturally like a real human at your desk ('Haha no, I'm Nyra from the Vidmox team! Just at my desk right now so I reply fast.') and continue helping with their videos.";
  } else if (
    /\b(expensive|high|out of budget|budget|cheaper|discount|lower price|too much|cant afford|can't afford|negotiate|negotiable|dollar|\$\s*\d{2,3}\b)\b/i.test(lower)
  ) {
    detectedIntent = "LOW BUDGET / CUSTOM BUDGET OFFER / NEGOTIATION";
    nextSalesObjective =
      "Genuinely reassure the client that our budget is negotiable! Never turn them away even if their budget is low (like '$100 for 20 videos'). Warmly tell them that our Sales Executive or CEO can work out a special custom deal with them based on their editing style and volume, and invite them to book a quick 10–15 minute call with our Sales Executive or CEO right now (ask what day/time and email works best for them).";
  } else if (/\b(free sample|free trial|free test|free edit|sample edit|test edit|try first)\b/i.test(lower)) {
    detectedIntent = "ASKING FOR FREE SAMPLE / TRIAL EDIT";
    nextSalesObjective =
      "Explain warmly that because we assign a dedicated senior editor and PM to every project, we offer a risk-free $29 Kickstart Trial (https://vidmox.pages.dev/29-video) with unlimited revisions — or we can hop on a quick 10–15 minute call with our Sales Executive or CEO first to show live edits in their niche. Ask which they prefer.";
  } else if (/\b(price|pricing|cost|how much|package|plan|rate|charge|per video|monthly)\b/i.test(lower)) {
    detectedIntent = "ASKING ABOUT PRICING / PACKAGES";
    nextSalesObjective = knownScope
      ? `The client is asking about pricing and you already know their interest (${knownScope}). Recommend the matching plan ($490/mo Growth for 25–30 Shorts, $890/mo Scale for 55–60 Shorts or 6–8 YouTube videos, $1,490/mo Advance for agencies, plus $29 Trial) and ask what day/time works for a quick 15-minute call to tailor their workflow.`
      : `Give a clear, concise overview of our main plans ($490/mo Growth for 25–30 short-form videos, $890/mo Scale for 55–60 shorts or 6–8 long-form YouTube videos, and $29 Trial edit) and ask what type of videos they mainly want edited.`;
  } else if (/\b(portfolio|sample|work|previous edit|example|show me|quality|reel|demo)\b/i.test(lower)) {
    detectedIntent = "ASKING FOR PORTFOLIO / PREVIOUS WORK";
    nextSalesObjective =
      "Share https://vidmox.pages.dev/portfolio (and https://vidmox.pages.dev/premium-portfolio if they want high-end motion graphics) and ask what style of videos they are currently creating so you can point out the best match.";
  } else if (/\b(turnaround|how fast|delivery time|revisions|workflow|how does it work|how do i send|footage|slack)\b/i.test(lower)) {
    detectedIntent = "ASKING ABOUT WORKFLOW / TURNAROUND / REVISIONS";
    nextSalesObjective =
      "Explain clearly: 24-hour average turnaround on short-form first drafts (24–48h for long-form), unlimited revisions, dedicated editor + PM on WhatsApp/Slack, and a 60-second intake brief (https://vidmox.pages.dev/intake). Then ask if they'd like to hop on a quick 15-min call to see how we'd plug into their workflow.";
  } else if (existing?.status === "booked" || existing?.status === "confirmed") {
    detectedIntent = "CLIENT HAS A BOOKED CALL";
    nextSalesObjective = knownEmail
      ? `Their call is already scheduled for ${knownScheduledAt || "their chosen slot"} and we have their email (${knownEmail}). Do NOT pitch or ask them to book again — just confirm warmly or answer their question.`
      : `Their call time is set for ${knownScheduledAt || "their chosen slot"}, but we still need their email address for the calendar invite. Politely ask for their best email address.`;
  } else if (!knownScope) {
    detectedIntent = userMsgs.length === 0 ? "FIRST CONTACT / NEW LEAD" : "EARLY DISCOVERY";
    nextSalesObjective =
      "Answer what the client just asked warmly and ask ONE natural discovery question to learn what kind of videos they create (Reels/Shorts vs. YouTube long-form) and roughly how many per month.";
  } else {
    detectedIntent = "QUALIFIED LEAD — READY TO GUIDE TO CALL";
    nextSalesObjective =
      `You already know their video scope (${knownScope}). Build on what they just said without re-asking what videos they make, and smoothly invite them to a quick 15-minute strategy call (ask what day/time and email works best for them).`;
  }

  const recentClientQuotes = userMsgs
    .slice(-3)
    .map((m) => `"${m.content.slice(0, 120)}"`)
    .join(" -> ");

  const antiRepeatRules: string[] = [];
  if (alreadySharedPricing && !/\b(price|pricing|cost|how much|plan|package)\b/i.test(lower)) {
    antiRepeatRules.push("You ALREADY shared pricing earlier in this chat — do NOT repeat the full pricing list again.");
  }
  if (alreadySharedPortfolio && !/\b(portfolio|sample|work|example|link)\b/i.test(lower)) {
    antiRepeatRules.push("You ALREADY shared the portfolio link earlier — do NOT paste the portfolio URL again.");
  }
  if (alreadySharedCalendly && !/\b(link|calendly|where)\b/i.test(lower)) {
    antiRepeatRules.push("You ALREADY sent the Calendly link earlier — instead of pasting the link again, just ask what time works best for them right here.");
  }
  if (knownScope) {
    antiRepeatRules.push(`You ALREADY know their video scope (${knownScope}) — do NOT ask "What kind of videos do you need edited?" again; reference their ${knownScope} naturally.`);
  }

  return [
    `• Client Name: ${computedName !== "New Lead" ? computedName : "Not shared yet (ask naturally when booking)"}`,
    `• Country & Local Timezone (from phone): ${phoneTz ? `${phoneTz.country} — ${phoneTz.label}` : existing?.timezone || "BDT (GMT+6)"}`,
    `• Remembered Video Scope / Niche: ${knownScope || "Not discovered yet — find out if they need Shorts/Reels, YouTube long-form, or Agency White-Label"}`,
    `• Remembered Email: ${knownEmail || "Not collected yet — needed to send calendar invite"}`,
    `• Remembered Website/Channel: ${knownWebsite || "Not shared yet"}`,
    `• Conversation Depth: ${userMsgs.length + 1} client message(s), ${assistantMsgs.length} prior replies from you${existing?.followup_count ? `, ${existing.followup_count} follow-up(s) sent` : ""}.`,
    recentClientQuotes ? `• What Client Said Previously: ${recentClientQuotes}` : "",
    `• Current Client Intent: ${detectedIntent}`,
    antiRepeatRules.length > 0 ? `• Anti-Repetition Memory: ${antiRepeatRules.join(" ")}` : "",
    `• WHAT TO TALK ABOUT RIGHT NOW: ${nextSalesObjective}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function generateFollowupText(b: {
  client_name?: string | null;
  scheduled_at?: string | null;
  call_time_ms?: number | null;
  status: string;
  followup_type?: string | null;
  followup_count?: number;
  requirements?: string | null;
  notes?: string | null;
}): string | null {
  const name = b.client_name && b.client_name !== "New Lead" && b.client_name !== "Dashboard Lead" ? b.client_name.trim() : "there";
  const type = b.followup_type || "auto_day1";
  const count = b.followup_count || 0;
  const hasSpecificReq = Boolean(b.requirements && b.requirements !== "Video Editing Consultation");
  const reqTopic = hasSpecificReq ? b.requirements! : "your video content";

  // If rejected, not interested, or fake lead -> strictly NO follow-up
  if (type === "rejected" || b.status === "not_interested" || b.status === "fake_lead") {
    return null;
  }

  // Booked Call -> 30-Minute Pre-Call Meeting Reminder
  if (type === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
    let minsText = "30 minutes";
    if (b.call_time_ms && b.call_time_ms > Date.now()) {
      const diffMins = Math.max(1, Math.round((b.call_time_ms - Date.now()) / 60000));
      if (diffMins <= 35) minsText = `${diffMins} minute${diffMins === 1 ? "" : "s"}`;
    }
    return `Hi ${name}! Just a quick reminder that you have your video strategy meeting with our team in ${minsText}${b.scheduled_at ? ` (${b.scheduled_at})` : ""}. Looking forward to speaking with you!`;
  }

  // Stage 1: Day 1 Auto Follow-Up (every 3–4 hours) — Personalized with remembered requirements
  if (type === "auto_day1" || type === "auto") {
    const day1Templates = [
      `Hi ${name}! Just checking in to see if you had a chance to look at my previous message regarding ${reqTopic}. Happy to help if you have any questions!`,
      `Hey ${name}! Are you still exploring editing support for ${reqTopic}? Let me know what you're looking for and I'll help you figure out the best next step.`,
      `Hi ${name}! Would you be available for a quick 15-minute call to discuss ${reqTopic}? You can share a convenient time right here or book directly at https://calendly.com/armaan-gineus/30min`,
      `Hey ${name}! Just wanted to make sure my message didn't get buried. Whenever you're ready to chat about scaling ${reqTopic}, let me know!`,
    ];
    return day1Templates[count % day1Templates.length];
  }

  // Stage 2: Next 3 Days No-Reply Follow-Up (every 8 hours)
  if (type === "no_reply_3d") {
    const day3Templates = [
      `Hey ${name}! Hope your week is going well. Just wanted to check if you're still looking for a dedicated editing team for ${reqTopic}? Happy to answer any questions or set up a quick call!`,
      `Hi ${name}! Whenever you're ready to take editing off your plate, we can start with a $29 trial edit or jump on a quick 15-minute call (https://calendly.com/armaan-gineus/30min). Let me know what works best for you!`,
      `Hey ${name}! Just checking in — are you still deciding which editing package would fit your workflow best? Happy to walk you through our Growth and Scale plans whenever you're free.`,
    ];
    return day3Templates[count % day3Templates.length];
  }

  // Stage 3: 3-to-30 Day Long-Term Follow-Up (every 24 hours until 30 days)
  if (type === "long_term_30d") {
    const longTermTemplates = [
      `Hey ${name}! Wanted to share a few recent video edits we produced for creators and agencies in your space: https://vidmox.pages.dev/portfolio. Let me know if you'd like to try a sample edit!`,
      `Hi ${name}! Just checking in to see how your content pipeline is going this month. If you need extra editing capacity for ${reqTopic}, feel free to reach out anytime!`,
      `Hey ${name}! Hope business is booming. If you're still looking to outsource your video editing with a 24-hour turnaround, I'd love to help get you set up!`,
    ];
    return longTermTemplates[count % longTermTemplates.length];
  }

  // Stage 4: Client Choice Time / Date Follow-Up ("i msg you 2 hour later", "i am free at 2 pm")
  if (type === "client_date") {
    const cleanTime = b.scheduled_at ? b.scheduled_at.replace(/^Follow-up:\s*/i, "") : "";
    return `Hi ${name}! Hope you're doing well. You mentioned you'd be free around now${cleanTime ? ` (${cleanTime})` : ""} — would now be a convenient time to chat or arrange a quick call about ${reqTopic}?`;
  }

  // Stage 5: Custom Management Timer Follow-Up
  if (type === "custom_timer" || type === "custom") {
    if (b.notes?.trim()) {
      return `Hey ${name}! Following up regarding ${b.notes.trim()}. Would you like to arrange a quick call or have any questions I can answer for you?`;
    }
    return `Hey ${name}! Following up as promised to see if you had any questions about ${reqTopic} or if you're ready to schedule a quick strategy call? Happy to help!`;
  }

  // Other CRM statuses
  if (type === "on_hold") {
    return `Hey ${name}! Hope you're doing well. Just checking in to see if you're ready to unpause video editing with us or if you have any questions on how our dedicated team works? Happy to help whenever you're ready!`;
  }
  if (type === "not_attended" || b.status === "not_attended") {
    return `Hey ${name}! Hope everything is okay. Sorry we missed each other on our scheduled call earlier today! Would you like to reschedule for tomorrow or later this week? Let me know what day and time works best for you!`;
  }
  if (type === "buy_soon" || b.status === "buy_soon") {
    return `Hey ${name}! Hope you're having a great week. Just wanted to follow up and see if you had any questions on our editing workflow or packages for ${reqTopic} before getting started? Happy to help whenever you're ready to roll!`;
  }
  if (type === "nurture") {
    return `Hey ${name}! Wanted to share a few recent video edits we did for creators in your niche (https://vidmox.pages.dev/portfolio). Let me know if you'd like us to create a sample for your content or jump on a quick 15-minute call!`;
  }
  if (b.status === "completed") {
    return `Hi ${name}! Great speaking with you on the call. Whenever you're ready with your first footage or project brief, you can submit it directly at https://vidmox.pages.dev/intake or send it over right here!`;
  }

  return `Hey ${name}! Just following up to see if you're still looking for video editing support for ${reqTopic}? Happy to help figure out the best next step or arrange a quick call!`;
}

/**
 * Checks all bookings with `next_followup_at <= now` and dispatches due messages.
 * Also transitions stages automatically (Day 1 -> Next 3 Days -> 30 Days -> Fake Lead).
 */
export async function processDueFollowups(
  env: AppEnv,
): Promise<Array<{ jid: string; text: string; bookingId: string }>> {
  const now = Date.now();
  const dueList = await getDueFollowups(env, now).catch(() => []);
  const outbound: Array<{ jid: string; text: string; bookingId: string }> = [];

  for (const b of dueList) {
    const lastReplyMs = b.last_client_reply_at || b.created_at || now;
    const elapsedHours = (now - lastReplyMs) / (3600 * 1000);

    // If 30 days elapsed with no reply and call not booked -> mark as Fake Lead and stop!
    if (
      b.status !== "booked" &&
      b.status !== "confirmed" &&
      b.followup_type !== "call_reminder" &&
      elapsedHours >= 24 * 30
    ) {
      await updateBooking(env, b.id, {
        status: "fake_lead",
        followup_type: "rejected",
        next_followup_at: null,
        followup_interval_hours: 0,
      });
      continue;
    }

    const message = generateFollowupText(b);
    if (!message) {
      await updateBooking(env, b.id, { next_followup_at: null });
      continue;
    }

    // Determine target WhatsApp JID
    const cleanPhone = (b.phone || (b.chat_id?.includes("@") ? b.chat_id.split("@")[0] : "")).replace(/[^0-9]/g, "");
    const jid = b.chat_id?.endsWith("@s.whatsapp.net")
      ? b.chat_id
      : cleanPhone.length >= 7
      ? `${cleanPhone}@s.whatsapp.net`
      : null;

    // Calculate next follow-up schedule after sending this one
    let nextFollowupAt: number | null = null;
    let nextType: FollowupType = b.followup_type;
    let nextInterval = b.followup_interval_hours ?? 3.5;
    let nextStatus: BookingStatus = b.status;

    if (b.followup_type === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
      // 30-min call reminder is one-shot for this meeting time
      nextFollowupAt = null;
      nextType = "call_reminder";
      nextInterval = 0;
    } else if (elapsedHours >= 24 * 30) {
      nextStatus = "fake_lead";
      nextType = "rejected";
      nextFollowupAt = null;
      nextInterval = 0;
    } else if (elapsedHours >= 24 * 4) {
      // Days 4 to 30: every 24h
      nextType = "long_term_30d";
      nextInterval = 24;
      nextFollowupAt = now + 24 * 3600 * 1000;
    } else if (elapsedHours >= 24) {
      // Days 2 to 4 (Next 3 Days): every 8h
      nextType = "no_reply_3d";
      nextInterval = 8;
      nextFollowupAt = now + 8 * 3600 * 1000;
    } else {
      // Day 1 (First 24h): every 3.5h (3-4 hours)
      nextType = "auto_day1";
      nextInterval = 3.5;
      nextFollowupAt = now + 3.5 * 3600 * 1000;
    }

    await updateBooking(env, b.id, {
      status: nextStatus,
      followup_type: nextType,
      followup_interval_hours: nextInterval,
      last_followup_at: now,
      followup_count: (b.followup_count || 0) + 1,
      next_followup_at: nextFollowupAt,
    });

    if (jid) {
      outbound.push({ jid, text: message, bookingId: b.id });
      await insertMessage(env, {
        id: `followup:${crypto.randomUUID()}`,
        chat_id: jid,
        role: "assistant",
        sender: null,
        sender_name: "Nyra Rose",
        content: message,
        source: "whatsapp",
        model: "auto:followup",
        neurons: 0,
        created_at: now,
      }).catch(() => {});
    }
  }

  return outbound;
}

async function generateReply(
  env: AppEnv,
  s: Settings,
  rules: Rule[],
  c: { chatId: string; chatName?: string; senderPhone?: string; isGroup: boolean; excludeId: string; userContent: string; source: string },
): Promise<Decision> {
  const [history, userNotes, userTodos] = await Promise.all([
    recentMessages(env, c.chatId, Math.max(s.historyLimit || 20, 30), c.excludeId),
    getNotes(env, c.chatId).catch(() => []),
    getTodos(env, c.chatId, true).catch(() => []),
  ]);

  const guidelines = rules.filter((r) => r.type === "ai_guideline").map((r) => r.response);
  const notesText = userNotes.slice(0, 10).map((n) => n.content);
  const todosText = userTodos.slice(0, 10).map((t) => t.task);

  const nowMs = Date.now();
  const existing = await findLatestBookingForChat(env, c.chatId).catch(() => null);
  const phoneTz = detectTimezoneFromPhone(c.senderPhone || c.chatId);
  let bookingContext = "";

  if (phoneTz) {
    bookingContext += `[CLIENT PHONE TIMEZONE DETECTED: ${phoneTz.label} (${phoneTz.country})]. `;
  }

  if (existing) {
    if (existing.followup_type === "rejected" || existing.status === "not_interested" || existing.status === "fake_lead") {
      bookingContext += `[LEAD STATUS: REJECTED / NOT INTERESTED]. Client is marked as REJECTED / NOT INTERESTED. Strictly DO NOT send sales pitches, promos, or follow-ups. Keep reply polite, brief, and respectful without trying to sell.`;
    } else if (existing.followup_type === "on_hold") {
      bookingContext += `[LEAD STATUS: ON HOLD]. Client is currently on hold. Be warm, friendly, and helpful. Do not pressure them to book right away.`;
    } else if (existing.followup_type === "not_attended" || existing.status === "not_attended") {
      bookingContext += `[LEAD STATUS: MISSED CALL / NOT ATTENDED]. Client missed our scheduled call earlier (${existing.scheduled_at || "previously"}). Follow up gently and warmly offering to reschedule at their convenience.`;
    } else if (existing.followup_type === "buy_soon" || existing.status === "buy_soon") {
      bookingContext += `[LEAD STATUS: BUYING IN FEW DAYS / CONSIDERING]. Client is considering purchasing soon. Check in warmly on their decision timeline and answer any lingering questions without being pushy.`;
    } else if (existing.followup_type === "nurture") {
      bookingContext += `[LEAD STATUS: NURTURE]. Client wants to see more work. Share our portfolio (https://vidmox.pages.dev/portfolio) and provide helpful creative advice.`;
    } else if (existing.status === "booked" || existing.status === "confirmed") {
      bookingContext += `[LEAD STATUS: CALL SCHEDULED FOR ${existing.scheduled_at}]. The discovery call is already scheduled. Reconfirm and answer any preliminary questions.`;
    } else if (existing.status === "completed") {
      bookingContext += `[LEAD STATUS: CALL COMPLETED / CLIENT ONBOARDED]. The call took place. If they need to submit project footage, guide them to our intake form: https://vidmox.pages.dev/intake.`;
    }
  }

  const lowerContent = c.userContent.toLowerCase();
  const asksForBookingLink =
    (lowerContent.includes("link") && (lowerContent.includes("call") || lowerContent.includes("book") || lowerContent.includes("meet") || lowerContent.includes("schedule") || lowerContent.includes("send"))) ||
    lowerContent.includes("calendly") ||
    lowerContent.includes("where can i book") ||
    lowerContent.includes("where to book");

  if (asksForBookingLink) {
    bookingContext += (bookingContext ? " " : "") +
      `The client is asking for the call booking link. Share the official booking link immediately: https://calendly.com/armaan-gineus/30min, and ask for their email and website so our sales team can review their content before the call.`;
  }

  // Automatic Call Booking, Reschedule, Client-Choice Follow-Up & Lead Capture
  const bookingInfo = extractBookingDetails(c.userContent, history);
  const computedName =
    bookingInfo.clientName ||
    (c.chatName && c.chatName !== "Dashboard" ? c.chatName : null) ||
    (c.senderPhone ? `+${c.senderPhone}` : null) ||
    (bookingInfo.email ? bookingInfo.email.split("@")[0] : "New Lead");
  const computedPhone = bookingInfo.phone || c.senderPhone || null;

  const isBookingCallIntent =
    Boolean(bookingInfo.email) ||
    (existing?.status === "booked" && Boolean(bookingInfo.timezone)) ||
    (Boolean(bookingInfo.time) &&
      !bookingInfo.isClientChoiceFollowup &&
      (lowerContent.includes("call") ||
        lowerContent.includes("meet") ||
        lowerContent.includes("book") ||
        lowerContent.includes("schedule") ||
        lowerContent.includes("slot") ||
        lowerContent.includes("free") ||
        lowerContent.includes("available") ||
        lowerContent.includes("today") ||
        lowerContent.includes("tomorrow") ||
        existing?.status === "booked" ||
        existing?.status === "confirmed"));

  if (!c.isGroup) {
    try {
      // CASE 1: Client is booking a call OR rescheduling/updating timezone of an existing booked call
      if (isBookingCallIntent || bookingInfo.isRescheduleRequest) {
        const wasAlreadyBooked = Boolean(existing && (existing.status === "booked" || existing.status === "confirmed"));
        // Initial booking always uses the phone number's country code timezone (phoneTz) first!
        // Only if the call was already booked and the client replies to change/correct the timezone (or if there is no phoneTz) do we use bookingInfo.timezone.
        const useExplicitTz = Boolean(
          bookingInfo.timezone &&
          (!phoneTz || wasAlreadyBooked || bookingInfo.isRescheduleRequest)
        );
        const effTz = useExplicitTz
          ? bookingInfo.timezone!
          : phoneTz?.code || existing?.timezone || bookingInfo.timezone || "BDT";
        const tzDisplayName = useExplicitTz
          ? bookingInfo.timezone!
          : phoneTz
          ? phoneTz.label
          : existing?.timezone || "Bangladesh Time (GMT+6)";

        const rawTimePhrase = bookingInfo.time || existing?.scheduled_at || null;
        const parsedCallMs = rawTimePhrase
          ? parseScheduledTimeToMs(rawTimePhrase, effTz, nowMs, computedPhone || c.chatId)
          : existing?.call_time_ms || null;

        // Format scheduled_at cleanly (e.g. "Today 1:30 PM BDT" or "Today 1:30 PM AEST")
        const formattedScheduledAt = parsedCallMs
          ? formatTimeInTimezone(parsedCallMs, effTz, computedPhone || c.chatId, nowMs)
          : rawTimePhrase;

        // 30 minutes before the call (or 10s from now if the call is <30m away in the future; null if the call time already passed)
        let reminderAt: number | null = null;
        if (parsedCallMs) {
          const thirtyMinBefore = parsedCallMs - 30 * 60 * 1000;
          if (thirtyMinBefore > nowMs) {
            reminderAt = thirtyMinBefore;
          } else if (parsedCallMs > nowMs) {
            reminderAt = nowMs + 10_000;
          } else {
            reminderAt = null;
          }
        }

        const effEmail = bookingInfo.email || existing?.email || null;
        const hasBooked = Boolean(formattedScheduledAt);

        if (existing) {
          const timeOrTzChanged = Boolean(
            (bookingInfo.time && formattedScheduledAt !== existing.scheduled_at) ||
            (useExplicitTz && bookingInfo.timezone !== existing.timezone)
          );

          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || (existing.client_name === "New Lead" || existing.client_name === "Dashboard Lead" ? computedName : existing.client_name),
            phone: computedPhone || existing.phone,
            email: effEmail,
            scheduled_at: formattedScheduledAt,
            call_time_ms: parsedCallMs,
            timezone: effTz,
            company_or_website: bookingInfo.companyOrWebsite || existing.company_or_website,
            requirements: bookingInfo.requirements || existing.requirements,
            status: hasBooked ? "booked" : existing.status,
            followup_type: hasBooked ? "call_reminder" : existing.followup_type,
            next_followup_at: hasBooked ? reminderAt : nowMs + 3.5 * 3600 * 1000,
            followup_interval_hours: hasBooked ? 0 : 3.5,
            last_client_reply_at: nowMs,
          });

          if (wasAlreadyBooked && timeOrTzChanged) {
            bookingContext = `The client updated their call time/timezone to "${formattedScheduledAt}" (${tzDisplayName}). Confirm warmly that you have updated their booked call to ${formattedScheduledAt} and will send a reminder 30 minutes before the meeting. NEVER say "CRM", "app", or "database".`;
          } else if (effEmail && formattedScheduledAt) {
            const tzConfirmNote = phoneTz && !useExplicitTz
              ? ` Explicitly tell the client: "I've set your call for ${formattedScheduledAt} (${phoneTz.label}, based on your number) — please let me know if that timezone works for you, or if you prefer another time/timezone!"`
              : "";
            bookingContext = `The client has provided their name (${computedName}), email (${effEmail}), and meeting time (${formattedScheduledAt}). Confirm naturally that their call is booked for ${formattedScheduledAt}, our sales manager will send the calendar invite to ${effEmail}, and you'll send a reminder 30 minutes before the meeting.${tzConfirmNote}`;
          } else if (formattedScheduledAt && !effEmail) {
            const tzConfirmNote = phoneTz && !useExplicitTz
              ? ` Mention that you set it for ${formattedScheduledAt} (${phoneTz.label}, based on their number) and ask them to let you know if they prefer another time/timezone.`
              : "";
            bookingContext = `The client mentioned a preferred call time (${formattedScheduledAt}), which is now booked with a 30-minute reminder.${tzConfirmNote} Ask warmly for their best email address so our manager can send the calendar invite.`;
          } else if (effEmail && !formattedScheduledAt) {
            bookingContext = `The client shared their email (${effEmail}), but hasn't given a preferred day/time yet. Acknowledge the email and ask what day and time works best for a quick 15-minute call${phoneTz ? ` (in their ${phoneTz.label} timezone)` : ""}.`;
          }
        } else {
          await createBooking(env, {
            chat_id: c.chatId,
            client_name: computedName,
            phone: computedPhone,
            email: effEmail,
            scheduled_at: formattedScheduledAt,
            call_time_ms: parsedCallMs,
            timezone: effTz,
            company_or_website: bookingInfo.companyOrWebsite,
            requirements: bookingInfo.requirements,
            status: hasBooked ? "booked" : "lead",
            followup_type: hasBooked ? "call_reminder" : "auto_day1",
            next_followup_at: hasBooked ? reminderAt : nowMs + 3.5 * 3600 * 1000,
            followup_interval_hours: hasBooked ? 0 : 3.5,
            last_client_reply_at: nowMs,
            source: c.source,
          });

          if (effEmail && formattedScheduledAt) {
            const tzConfirmNote = phoneTz && !useExplicitTz
              ? ` Explicitly tell the client: "I've set your call for ${formattedScheduledAt} (${phoneTz.label}, based on your number) — please let me know if that timezone works for you, or if you prefer another time/timezone!"`
              : "";
            bookingContext = `The client provided their name (${computedName}), email (${effEmail}), and preferred time (${formattedScheduledAt}). Confirm naturally that you've booked their call for ${formattedScheduledAt} and noted ${effEmail}, and you'll remind them 30 minutes before the meeting.${tzConfirmNote}`;
          } else if (formattedScheduledAt && !effEmail) {
            const tzConfirmNote = phoneTz && !useExplicitTz
              ? ` Explicitly mention that you set it for ${formattedScheduledAt} (${phoneTz.label}, based on their number) and ask them to let you know if they prefer another time/timezone.`
              : "";
            bookingContext = `The client mentioned a preferred time (${formattedScheduledAt}).${tzConfirmNote} Ask what email address our manager should send the calendar invite to.`;
          } else if (effEmail && !formattedScheduledAt) {
            bookingContext = `The client provided their email (${effEmail}), but hasn't mentioned a time. Acknowledge their email and ask what day and time works best for a quick 15-minute call${phoneTz ? ` (in their ${phoneTz.label} timezone)` : ""}.`;
          }
        }
      }
      // CASE 2: Client says when they are free / will message later ("i msg you 2 hour later", "i am free at 2 pm", "follow up tomorrow")
      else if (bookingInfo.isClientChoiceFollowup && bookingInfo.time) {
        const effTz = bookingInfo.timezone || existing?.timezone || phoneTz?.code || "BDT";
        const targetFollowupMs = parseScheduledTimeToMs(bookingInfo.time, effTz, nowMs, computedPhone || c.chatId) || nowMs + 2 * 3600 * 1000;
        const formattedFollowupTime = formatTimeInTimezone(targetFollowupMs, effTz, computedPhone || c.chatId, nowMs);
        const nextStatus = bookingInfo.inferredStatus || (existing?.status && existing.status !== "fake_lead" ? existing.status : "lead");

        if (existing) {
          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || existing.client_name,
            phone: computedPhone || existing.phone,
            email: bookingInfo.email || existing.email,
            scheduled_at: `Follow-up: ${formattedFollowupTime}`,
            timezone: effTz,
            status: nextStatus,
            followup_type: "client_date",
            next_followup_at: targetFollowupMs,
            followup_interval_hours: Math.max(0.5, Math.round(((targetFollowupMs - nowMs) / (3600 * 1000)) * 10) / 10),
            last_client_reply_at: nowMs,
          });
        } else {
          await createBooking(env, {
            chat_id: c.chatId,
            client_name: computedName,
            phone: computedPhone,
            email: bookingInfo.email,
            scheduled_at: `Follow-up: ${formattedFollowupTime}`,
            timezone: effTz,
            company_or_website: bookingInfo.companyOrWebsite,
            requirements: bookingInfo.requirements,
            status: nextStatus,
            followup_type: "client_date",
            next_followup_at: targetFollowupMs,
            followup_interval_hours: Math.max(0.5, Math.round(((targetFollowupMs - nowMs) / (3600 * 1000)) * 10) / 10),
            last_client_reply_at: nowMs,
            source: c.source,
          });
        }

        bookingContext = `The client mentioned they will be free or message around "${formattedFollowupTime}". Respect their schedule warmly, confirm that you'll check back in with them at ${formattedFollowupTime}, and don't push for an immediate call right now.`;
      }
      // CASE 3: General lead message + automatic status detection ("not interested", "buy in few days", "confirmed", etc.)
      else {
        const isConfirmingBookedCall =
          existing?.status === "booked" &&
          /\b(yes|yeah|yep|ok|okay|sure|sounds good|works for me|confirmed|confirm|perfect|great|see you|book this time)\b/i.test(lowerContent);

        if (existing) {
          const nextStatus: BookingStatus =
            bookingInfo.inferredStatus ||
            (isConfirmingBookedCall ? "confirmed" : existing.status === "fake_lead" ? "lead" : existing.status);
          const isBooked = nextStatus === "booked" || nextStatus === "confirmed";
          const isStopped =
            bookingInfo.inferredFollowupType === "rejected" ||
            nextStatus === "not_interested" ||
            existing.followup_type === "rejected";

          let nextFollowupType: FollowupType = existing.followup_type;
          let nextFollowupAt: number | null = existing.next_followup_at;
          let nextInterval = existing.followup_interval_hours ?? 3.5;

          if (isStopped) {
            nextFollowupType = "rejected";
            nextFollowupAt = null;
            nextInterval = 0;
          } else if (bookingInfo.inferredFollowupType) {
            nextFollowupType = bookingInfo.inferredFollowupType;
            nextInterval = bookingInfo.inferredFollowupType === "on_hold" ? 48 : 24;
            nextFollowupAt = nowMs + nextInterval * 3600 * 1000;
          } else if (isBooked) {
            nextFollowupType = "call_reminder";
            nextFollowupAt = existing.next_followup_at;
            nextInterval = 0;
          } else {
            nextFollowupType = "auto_day1";
            nextFollowupAt = nowMs + 3.5 * 3600 * 1000;
            nextInterval = 3.5;
          }

          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || (existing.client_name === "New Lead" ? computedName : existing.client_name),
            phone: computedPhone || existing.phone,
            timezone: existing.timezone || phoneTz?.code || "BDT",
            company_or_website: bookingInfo.companyOrWebsite || existing.company_or_website,
            requirements: bookingInfo.requirements !== "Video Editing Consultation" ? bookingInfo.requirements : existing.requirements,
            status: nextStatus,
            last_client_reply_at: nowMs,
            followup_type: nextFollowupType,
            next_followup_at: nextFollowupAt,
            followup_interval_hours: nextInterval,
          });
        } else if (c.chatId !== "dashboard") {
          const nextStatus: BookingStatus = bookingInfo.inferredStatus || "lead";
          const isStopped = bookingInfo.inferredFollowupType === "rejected" || nextStatus === "not_interested";
          const nextFollowupType: FollowupType = isStopped
            ? "rejected"
            : bookingInfo.inferredFollowupType || "auto_day1";
          const nextInterval = isStopped ? 0 : bookingInfo.inferredFollowupType ? 24 : 3.5;

          await createBooking(env, {
            chat_id: c.chatId,
            client_name: computedName,
            phone: computedPhone,
            email: null,
            scheduled_at: null,
            timezone: bookingInfo.timezone || phoneTz?.code || "BDT",
            company_or_website: bookingInfo.companyOrWebsite,
            requirements: bookingInfo.requirements,
            status: nextStatus,
            followup_type: nextFollowupType,
            next_followup_at: isStopped ? null : nowMs + nextInterval * 3600 * 1000,
            followup_interval_hours: nextInterval,
            last_client_reply_at: nowMs,
            source: c.source,
          });
        }
      }
    } catch (err) {
      console.warn("Failed updating lead / follow-up timer:", err);
    }
  }

  // If Instant AI Reply is paused (globally or for this chat), we already logged the message
  // and updated the CRM lead & follow-up timers above — now skip sending an instant AI reply!
  if (c.source === "whatsapp" && isInstantReplyPaused(s, c.chatId, c.senderPhone)) {
    return { action: "ignore", reason: "instant-reply-paused (follow-ups active)" };
  }

  const memorySummary = analyzeConversationMemory({
    userContent: c.userContent,
    history,
    existing,
    bookingInfo,
    phoneTz,
    computedName,
  });

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
        memorySummary,
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
    return { action: "reply", reply: "Sorry about that, my connection had a quick hiccup. Could you send that once more?" };
  }
}
