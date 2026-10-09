import type { AppEnv } from "./env";
import { kvGet, kvSet } from "./db";

export type ReplyMode = "self" | "allowlist" | "everyone";

export interface Settings {
  /** Master switch. When off, Nyra Rose stays silent on WhatsApp (dashboard chat still works). */
  enabled: boolean;
  /** AI provider id — default "workers-ai". */
  provider: string;
  model: string;
  /** Friendly model name shown to the client/other person in their dashboard. */
  publicModelName: string;
  /** Password for the other person / client to log into their panel. */
  clientPassword: string;
  /**
   * Who Nyra Rose answers in private chats:
   * - self:      only your own "Message yourself" chat (safest, default)
   * - allowlist: self chat + the phone numbers in `allowlist`
   * - everyone:  every private chat
   */
  replyMode: ReplyMode;
  /** Phone numbers in international format, digits only (e.g. 8801712345678). */
  allowlist: string[];
  /** Answer in groups — only when mentioned, replied to, or a trigger word appears. */
  groupsEnabled: boolean;
  triggerWords: string[];
  historyLimit: number;
  maxReplyTokens: number;
  temperature: number;
  ownerName: string;
  extraInstructions: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: "workers-ai",
  model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  publicModelName: "Nyra Rose Intelligence 🌹",
  clientPassword: "rose2026",
  replyMode: "self",
  allowlist: [],
  groupsEnabled: false,
  triggerWords: ["nyra", "nyra rose", "নাইরা", "rose"],
  historyLimit: 14,
  maxReplyTokens: 450,
  temperature: 0.7,
  ownerName: "",
  extraInstructions: "",
};

/** Models offered in the admin dashboard. All tested with Workers AI chat messages format. */
export const MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B — ultra-fast, cheap, exceptional Bangla/English (Recommended 🌹)" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B — highest intelligence & deep reasoning" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B — sharp, concise, balanced" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B — ultra-lightweight, 0 latency" },
  { id: "@cf/qwen/qwen2.5-72b-instruct", label: "Qwen 2.5 72B — multilingual powerhouse" },
];

const KEY = "settings";

export async function getSettings(env: AppEnv): Promise<Settings> {
  const stored = await kvGet<Partial<Settings>>(env, KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(env: AppEnv, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(env);
  const next = sanitize({ ...current, ...patch });
  await kvSet(env, KEY, next);
  return next;
}

function sanitize(s: Settings): Settings {
  const clamp = (n: unknown, lo: number, hi: number, d: number) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  return {
    enabled: Boolean(s.enabled),
    provider: s.provider === "workers-ai" ? s.provider : "workers-ai",
    model: MODELS.some((m) => m.id === s.model) ? s.model : DEFAULT_SETTINGS.model,
    publicModelName: String(s.publicModelName ?? "").trim().slice(0, 80) || DEFAULT_SETTINGS.publicModelName,
    clientPassword: String(s.clientPassword ?? "").trim().slice(0, 100) || DEFAULT_SETTINGS.clientPassword,
    replyMode: (["self", "allowlist", "everyone"] as const).includes(s.replyMode) ? s.replyMode : "self",
    allowlist: [...new Set((Array.isArray(s.allowlist) ? s.allowlist : []).map((p) => String(p).replace(/\D/g, "")).filter((p) => p.length >= 6))],
    groupsEnabled: Boolean(s.groupsEnabled),
    triggerWords: (Array.isArray(s.triggerWords) ? s.triggerWords : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 20),
    historyLimit: Math.round(clamp(s.historyLimit, 0, 40, DEFAULT_SETTINGS.historyLimit)),
    maxReplyTokens: Math.round(clamp(s.maxReplyTokens, 50, 2000, DEFAULT_SETTINGS.maxReplyTokens)),
    temperature: clamp(s.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature),
    ownerName: String(s.ownerName ?? "").slice(0, 80),
    extraInstructions: String(s.extraInstructions ?? "").slice(0, 4000),
  };
}
