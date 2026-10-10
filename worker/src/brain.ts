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

// ─── Time Parsing & Follow-Up Scheduling Engine ──────────────────────────────

function getTimezoneOffsetHours(tz?: string | null): number {
  const u = (tz || "").toUpperCase().trim();
  if (u === "EST" || u === "EDT") return -4;
  if (u === "CST" || u === "CDT") return -5;
  if (u === "MST" || u === "MDT") return -6;
  if (u === "PST" || u === "PDT") return -7;
  if (u === "GMT" || u === "UTC") return 0;
  if (u === "CET") return 1;
  if (u === "AEST") return 10;
  // Default: Bangladesh / Dhaka time (UTC+6)
  return 6;
}

/**
 * Parses natural date/time expressions ("tomorrow at 4pm", "Monday 3pm",
 * "in 2 hours", "after 3 days", "8 pm", "2026-10-15 14:00") into Unix ms.
 */
export function parseScheduledTimeToMs(
  phrase: string | null | undefined,
  timezone?: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!phrase || !phrase.trim()) return null;
  const p = phrase.toLowerCase().trim();

  // 1. Direct ISO / Date.parse check if it looks like a full date string
  if (/^\d{4}-\d{2}-\d{2}/.test(p)) {
    const parsed = Date.parse(phrase);
    if (!Number.isNaN(parsed) && parsed > nowMs - 86400_000) return parsed;
  }

  // 2. Relative expressions ("in 2 hours", "after 3 days", "30 min later", "2 days later")
  const relMatch = p.match(/(?:in|after)?\s*(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day|week)s?(?:\s+later)?/i);
  if (relMatch && (p.includes("in ") || p.includes("after ") || p.includes("later"))) {
    const val = parseFloat(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    if (unit.startsWith("min")) return Math.round(nowMs + val * 60 * 1000);
    if (unit.startsWith("hour") || unit.startsWith("hr")) return Math.round(nowMs + val * 3600 * 1000);
    if (unit.startsWith("day")) return Math.round(nowMs + val * 24 * 3600 * 1000);
    if (unit.startsWith("week")) return Math.round(nowMs + val * 7 * 24 * 3600 * 1000);
  }

  // 3. Calculate in local timezone
  const tzOffsetHours = getTimezoneOffsetHours(timezone);
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

  // Extract time of day
  let hour = 15; // default 3:00 PM
  let minute = 0;
  const timeMatch = p.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || p.match(/(?:at\s+)(\d{1,2})(?::(\d{2}))?\b/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const mer = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (!mer && h >= 1 && h <= 7) h += 12;
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
  // If same day and the time has already passed, assume tomorrow
  if (dayOffset === 0 && targetUtcMs <= nowMs) {
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
    const callMs = b.call_time_ms || parseScheduledTimeToMs(b.scheduled_at, b.timezone, nowMs);
    let reminderAt: number | null = null;
    if (callMs) {
      const thirtyMinBefore = callMs - 30 * 60 * 1000;
      if (thirtyMinBefore > nowMs) {
        reminderAt = thirtyMinBefore;
      } else if (callMs > nowMs && (!b.last_followup_at || b.last_followup_at < thirtyMinBefore)) {
        // Call is less than 30 mins away and reminder hasn't been sent yet
        reminderAt = nowMs + 15_000;
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

  // Detect phone mentions in text
  const phoneRegex = /(?:\+?\d{1,4}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/;
  const phoneMatch = text.match(phoneRegex);
  const phone = phoneMatch && phoneMatch[0].replace(/\D/g, "").length >= 7 ? phoneMatch[0].trim() : null;

  // Detect client name mentions
  const nameRegex = /(?:my name is|i'm|i am|name[:\s]+)\s+([A-Z][a-z]+(?:\s+(?!from|at|with|the|and|here|of\b)[A-Z][a-z]+)?)/i;
  const nameMatch = text.match(nameRegex);
  const clientName = nameMatch ? nameMatch[1].trim() : null;

  // Detect time/date mentions and relative phrases
  const timePhraseRegex = /(?:(?:in|after)\s+\d+\s*(?:hour|hr|minute|min|day|week)s?(?:\s+later)?|(?:next\s+)?(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|morning|evening|afternoon|noon|night))?|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b(?:\s*[A-Z]{2,4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i;
  const timePhraseMatch = text.match(timePhraseRegex);
  let time: string | null = null;
  if (timePhraseMatch) {
    time = timePhraseMatch[0].trim();
  } else {
    const looseTime = /(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b\d{1,2}\s*(am|pm)\b|evening|morning|next week)/i;
    const looseMatch = text.match(looseTime);
    if (looseMatch) {
      const sentence = text.split(/[.?!,\n]/).find((s) => looseTime.test(s));
      time = sentence ? sentence.trim() : looseMatch[0].trim();
    }
  }

  // Detect timezone mentions
  const tzRegex = /\b(EST|PST|CST|MST|EDT|PDT|CDT|MDT|GMT|BST|UTC|CET|AEST|Dhaka(?:\s+time)?|BD(?:\s+time)?)\b/i;
  const tzMatch = text.match(tzRegex);
  const timezone = tzMatch ? tzMatch[0].toUpperCase() : null;

  // Detect website / channel URL mentions
  const siteRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.(?:com|org|io|net|co|app|agency|tv)|youtube\.com\/@[a-zA-Z0-9_.-]+|instagram\.com\/[a-zA-Z0-9_.-]+)/i;
  const siteMatch = text.match(siteRegex);
  const companyOrWebsite = siteMatch ? siteMatch[0] : null;

  const lower = text.toLowerCase();
  const isRescheduleRequest =
    Boolean(time) &&
    (lower.includes("change") ||
      lower.includes("reschedule") ||
      lower.includes("move") ||
      lower.includes("shift") ||
      lower.includes("instead") ||
      lower.includes("postpone") ||
      lower.includes("another time") ||
      lower.includes("new time"));

  const isClientChoiceFollowup =
    Boolean(time) &&
    !isRescheduleRequest &&
    (lower.includes("follow up") ||
      lower.includes("followup") ||
      lower.includes("message me") ||
      lower.includes("text me") ||
      lower.includes("contact me") ||
      lower.includes("reach out") ||
      lower.includes("ping me") ||
      lower.includes("remind me") ||
      lower.includes("busy") ||
      lower.includes("book later") ||
      lower.includes("talk later") ||
      lower.includes("check back"));

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
  };
}

export function generateFollowupText(b: {
  client_name?: string | null;
  scheduled_at?: string | null;
  status: string;
  followup_type?: string | null;
  followup_count?: number;
  requirements?: string | null;
  notes?: string | null;
}): string | null {
  const name = b.client_name && b.client_name !== "New Lead" && b.client_name !== "Dashboard Lead" ? b.client_name.trim() : "there";
  const type = b.followup_type || "auto_day1";
  const count = b.followup_count || 0;

  // If rejected, not interested, or fake lead -> strictly NO follow-up
  if (type === "rejected" || b.status === "not_interested" || b.status === "fake_lead") {
    return null;
  }

  // Booked Call -> 30-Minute Pre-Call Meeting Reminder
  if (type === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
    return `Hi ${name}! Just a quick reminder that you have your video strategy meeting with our team in 30 minutes${b.scheduled_at ? ` (${b.scheduled_at})` : ""}. Looking forward to speaking with you!`;
  }

  // Stage 1: Day 1 Auto Follow-Up (every 3–4 hours)
  if (type === "auto_day1" || type === "auto") {
    const day1Templates = [
      `Hi ${name}! Just checking in to see if you had a chance to look at my previous message. Happy to help if you have any questions about our video editing services!`,
      `Hey ${name}! Are you still exploring video editing support for your content? Let me know what you're looking for, and I'll help you figure out the best next step.`,
      `Hi ${name}! Would you be available for a quick 15-minute call to discuss your video editing requirements? You can share a convenient time right here or book directly at https://calendly.com/armaan-gineus/30min`,
      `Hey ${name}! Just wanted to make sure my message didn't get buried. Whenever you're ready to chat about scaling your video content, let me know!`,
    ];
    return day1Templates[count % day1Templates.length];
  }

  // Stage 2: Next 3 Days No-Reply Follow-Up (every 8 hours)
  if (type === "no_reply_3d") {
    const day3Templates = [
      `Hey ${name}! Hope your week is going well. Just wanted to check if you're still looking for a dedicated video editing team to scale your content? Happy to answer any questions or set up a quick call!`,
      `Hi ${name}! Whenever you're ready to take video editing off your plate, we can start with a $29 trial edit or jump on a quick 15-minute call (https://calendly.com/armaan-gineus/30min). Let me know what works best for you!`,
      `Hey ${name}! Just checking in — are you still deciding which editing package would fit your workflow best? Happy to walk you through our Growth and Scale plans whenever you're free.`,
    ];
    return day3Templates[count % day3Templates.length];
  }

  // Stage 3: 3-to-30 Day Long-Term Follow-Up (every 24 hours until 30 days)
  if (type === "long_term_30d") {
    const longTermTemplates = [
      `Hey ${name}! Wanted to share a few recent video edits we produced for creators and agencies in your space: https://vidmox.pages.dev/portfolio. Let me know if you'd like to try a sample edit!`,
      `Hi ${name}! Just checking in to see how your content pipeline is going this month. If you need extra editing capacity or want to test our dedicated team, feel free to reach out anytime!`,
      `Hey ${name}! Hope business is booming. If you're still looking to outsource your short-form or long-form video editing with a 24-hour turnaround, I'd love to help get you set up!`,
    ];
    return longTermTemplates[count % longTermTemplates.length];
  }

  // Stage 4: Client Choice Date Follow-Up
  if (type === "client_date") {
    return `Hi ${name}! Hope you're doing well. You mentioned following up around today${b.scheduled_at ? ` (${b.scheduled_at})` : ""} — would now be a convenient time to arrange a quick call and discuss your video editing requirements?`;
  }

  // Stage 5: Custom Management Timer Follow-Up
  if (type === "custom_timer" || type === "custom") {
    if (b.notes?.trim()) {
      return `Hey ${name}! Following up regarding ${b.notes.trim()}. Would you like to arrange a quick call or have any questions I can answer for you?`;
    }
    return `Hey ${name}! Following up as promised to see if you had any questions about our editing packages or if you're ready to schedule a quick strategy call? Happy to help!`;
  }

  // Other CRM statuses
  if (type === "on_hold") {
    return `Hey ${name}! Hope you're doing well. Just checking in to see if you're ready to unpause video editing with us or if you have any questions on how our dedicated team works? Happy to help whenever you're ready!`;
  }
  if (type === "not_attended" || b.status === "not_attended") {
    return `Hey ${name}! Hope everything is okay. Sorry we missed each other on our scheduled call earlier today! Would you like to reschedule for tomorrow or later this week? Let me know what day and time works best for you!`;
  }
  if (type === "buy_soon" || b.status === "buy_soon") {
    return `Hey ${name}! Hope you're having a great week. Just wanted to follow up and see if you had any questions on our editing workflow or packages before getting started? Happy to help whenever you're ready to roll!`;
  }
  if (type === "nurture") {
    return `Hey ${name}! Wanted to share a few recent video edits we did for creators in your niche (https://vidmox.pages.dev/portfolio). Let me know if you'd like us to create a sample for your content or jump on a quick 15-minute call!`;
  }
  if (b.status === "completed") {
    return `Hi ${name}! Great speaking with you on the call. Whenever you're ready with your first footage or project brief, you can submit it directly at https://vidmox.pages.dev/intake or send it over right here!`;
  }

  return `Hey ${name}! Just following up to see if you're still looking for video editing support for your content? Happy to help figure out the best next step or arrange a quick call!`;
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
    recentMessages(env, c.chatId, s.historyLimit, c.excludeId),
    getNotes(env, c.chatId).catch(() => []),
    getTodos(env, c.chatId, true).catch(() => []),
  ]);

  const guidelines = rules.filter((r) => r.type === "ai_guideline").map((r) => r.response);
  const notesText = userNotes.slice(0, 10).map((n) => n.content);
  const todosText = userTodos.slice(0, 10).map((t) => t.task);

  const nowMs = Date.now();
  const existing = await findLatestBookingForChat(env, c.chatId).catch(() => null);
  let bookingContext = "";

  if (existing) {
    if (existing.followup_type === "rejected" || existing.status === "not_interested" || existing.status === "fake_lead") {
      bookingContext = `[LEAD STATUS: REJECTED / NOT INTERESTED]. Client is marked as REJECTED / NOT INTERESTED. Strictly DO NOT send sales pitches, promos, or follow-ups. Keep reply polite, brief, and respectful without trying to sell.`;
    } else if (existing.followup_type === "on_hold") {
      bookingContext = `[LEAD STATUS: ON HOLD]. Client is currently on hold. Be warm, friendly, and helpful. Do not pressure them to book right away.`;
    } else if (existing.followup_type === "not_attended" || existing.status === "not_attended") {
      bookingContext = `[LEAD STATUS: MISSED CALL / NOT ATTENDED]. Client missed our scheduled call earlier (${existing.scheduled_at || "previously"}). Follow up gently and warmly offering to reschedule at their convenience.`;
    } else if (existing.followup_type === "buy_soon" || existing.status === "buy_soon") {
      bookingContext = `[LEAD STATUS: BUYING IN FEW DAYS / CONSIDERING]. Client is considering purchasing soon. Check in warmly on their decision timeline and answer any lingering questions without being pushy.`;
    } else if (existing.followup_type === "nurture") {
      bookingContext = `[LEAD STATUS: NURTURE]. Client wants to see more work. Share our portfolio (https://vidmox.pages.dev/portfolio) and provide helpful creative advice.`;
    } else if (existing.status === "booked" || existing.status === "confirmed") {
      bookingContext = `[LEAD STATUS: CALL SCHEDULED FOR ${existing.scheduled_at}]. The discovery call is already scheduled. Reconfirm and answer any preliminary questions.`;
    } else if (existing.status === "completed") {
      bookingContext = `[LEAD STATUS: CALL COMPLETED / CLIENT ONBOARDED]. The call took place. If they need to submit project footage, guide them to our intake form: https://vidmox.pages.dev/intake.`;
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
    (Boolean(bookingInfo.time) &&
      !bookingInfo.isClientChoiceFollowup &&
      (lowerContent.includes("call") ||
        lowerContent.includes("meet") ||
        lowerContent.includes("book") ||
        lowerContent.includes("schedule") ||
        lowerContent.includes("slot") ||
        lowerContent.includes("free at") ||
        lowerContent.includes("available at") ||
        existing?.status === "booked" ||
        existing?.status === "confirmed"));

  if (!c.isGroup) {
    try {
      // CASE 1: Client is rescheduling an existing booked call OR booking a call with a time
      if (isBookingCallIntent || bookingInfo.isRescheduleRequest) {
        const effTimeText = bookingInfo.time || existing?.scheduled_at || null;
        const effTz = bookingInfo.timezone || existing?.timezone || null;
        const parsedCallMs = effTimeText ? parseScheduledTimeToMs(effTimeText, effTz, nowMs) : existing?.call_time_ms || null;
        // 30 minutes before the call
        const reminderAt = parsedCallMs ? parsedCallMs - 30 * 60 * 1000 : null;
        const effEmail = bookingInfo.email || existing?.email || null;
        const hasBooked = Boolean(effTimeText);

        if (existing) {
          const wasAlreadyBooked = existing.status === "booked" || existing.status === "confirmed";
          const timeChanged = Boolean(bookingInfo.time && bookingInfo.time !== existing.scheduled_at);

          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || (existing.client_name === "New Lead" || existing.client_name === "Dashboard Lead" ? computedName : existing.client_name),
            phone: computedPhone || existing.phone,
            email: effEmail,
            scheduled_at: effTimeText,
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

          if (wasAlreadyBooked && timeChanged && bookingInfo.time) {
            bookingContext = `The client has changed/rescheduled their call time to "${bookingInfo.time}". Confirm warmly that you have updated their meeting time to ${bookingInfo.time}${effTz ? ` (${effTz})` : ""} and that you will send them a reminder 30 minutes before the meeting. NEVER say "CRM", "app", or "database".`;
          } else if (effEmail && effTimeText) {
            bookingContext = `The client has provided their name (${computedName}), email (${effEmail}), and meeting time (${effTimeText}). Confirm naturally that their call is scheduled for ${effTimeText}, our sales manager will send the calendar invite to ${effEmail}, and you'll send a quick reminder 30 minutes before the meeting.`;
          } else if (effTimeText && !effEmail) {
            bookingContext = `The client mentioned a preferred call time (${effTimeText}), which is now noted, and a reminder is set for 30 minutes before. Ask warmly for their best email address so our manager can send the calendar invite.`;
          } else if (effEmail && !effTimeText) {
            bookingContext = `The client shared their email (${effEmail}), but hasn't given a preferred day/time yet. Acknowledge the email and ask what day and time works best for a quick 15-minute call.`;
          }
        } else {
          await createBooking(env, {
            chat_id: c.chatId,
            client_name: computedName,
            phone: computedPhone,
            email: effEmail,
            scheduled_at: effTimeText,
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

          if (effEmail && effTimeText) {
            bookingContext = `The client provided their name (${computedName}), email (${effEmail}), and preferred time (${effTimeText}). Confirm naturally that you've noted down ${effTimeText} and ${effEmail}, our sales manager will send over the calendar invite shortly, and you'll remind them 30 minutes before the meeting.`;
          } else if (effTimeText && !effEmail) {
            bookingContext = `The client mentioned a preferred time (${effTimeText}). Acknowledge the time warmly and ask what email address our manager should send the calendar invite to.`;
          } else if (effEmail && !effTimeText) {
            bookingContext = `The client provided their email (${effEmail}), but hasn't mentioned a time. Acknowledge their email and ask what day and time works best for a quick 15-minute call.`;
          }
        }
      }
      // CASE 2: Client asks to follow up on a specific date ("Client Choice Follow-Up")
      else if (bookingInfo.isClientChoiceFollowup && bookingInfo.time) {
        const effTz = bookingInfo.timezone || existing?.timezone || null;
        const targetFollowupMs = parseScheduledTimeToMs(bookingInfo.time, effTz, nowMs) || nowMs + 24 * 3600 * 1000;

        if (existing) {
          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || existing.client_name,
            phone: computedPhone || existing.phone,
            email: bookingInfo.email || existing.email,
            scheduled_at: `Follow-up requested: ${bookingInfo.time}`,
            timezone: effTz,
            followup_type: "client_date",
            next_followup_at: targetFollowupMs,
            last_client_reply_at: nowMs,
          });
        } else {
          await createBooking(env, {
            chat_id: c.chatId,
            client_name: computedName,
            phone: computedPhone,
            email: bookingInfo.email,
            scheduled_at: `Follow-up requested: ${bookingInfo.time}`,
            timezone: effTz,
            company_or_website: bookingInfo.companyOrWebsite,
            requirements: bookingInfo.requirements,
            status: "lead",
            followup_type: "client_date",
            next_followup_at: targetFollowupMs,
            last_client_reply_at: nowMs,
            source: c.source,
          });
        }

        bookingContext = `The client requested that you follow up with them at "${bookingInfo.time}". Respect their schedule warmly, confirm that you'll reach back out to them on ${bookingInfo.time}, and don't push for an immediate call right now.`;
      }
      // CASE 3: General lead message (not booked yet) -> Start or reset Day 1 Auto Follow-Up (3.5h timer)
      else {
        if (existing) {
          const isBooked = existing.status === "booked" || existing.status === "confirmed";
          const isStopped = existing.followup_type === "rejected" || existing.status === "not_interested" || existing.status === "fake_lead";
          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || (existing.client_name === "New Lead" ? computedName : existing.client_name),
            phone: computedPhone || existing.phone,
            company_or_website: bookingInfo.companyOrWebsite || existing.company_or_website,
            requirements: bookingInfo.requirements !== "Video Editing Consultation" ? bookingInfo.requirements : existing.requirements,
            last_client_reply_at: nowMs,
            // If lead hasn't booked and isn't stopped, reset to Day 1 Auto Follow-up (3.5 hours later)
            followup_type: isBooked ? "call_reminder" : isStopped ? existing.followup_type : "auto_day1",
            next_followup_at: isBooked ? existing.next_followup_at : isStopped ? null : nowMs + 3.5 * 3600 * 1000,
            followup_interval_hours: isBooked ? 0 : 3.5,
          });
        } else if (c.chatId !== "dashboard") {
          // New WhatsApp lead -> automatically register for Day 1 Auto Follow-Up (every 3.5 hours)
          await createBooking(env, {
            chat_id: c.chatId,
            client_name: computedName,
            phone: computedPhone,
            email: null,
            scheduled_at: null,
            timezone: bookingInfo.timezone,
            company_or_website: bookingInfo.companyOrWebsite,
            requirements: bookingInfo.requirements,
            status: "lead",
            followup_type: "auto_day1",
            next_followup_at: nowMs + 3.5 * 3600 * 1000,
            followup_interval_hours: 3.5,
            last_client_reply_at: nowMs,
            source: c.source,
          });
        }
      }
    } catch (err) {
      console.warn("Failed updating lead / follow-up timer:", err);
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
    return { action: "reply", reply: "Sorry about that, my connection had a quick hiccup. Could you send that once more?" };
  }
}
