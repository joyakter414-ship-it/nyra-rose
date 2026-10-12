// Nyra Rose 🌹 — WhatsApp gateway.
//
// Links to your WhatsApp as a "Linked device" (like WhatsApp Web), forwards
// incoming text messages to the Nyra Rose brain on Cloudflare, and sends her
// replies back. All decisions (who to answer, what to say) are made by the
// brain, so you control everything from the dashboard.

import { createServer } from "node:http";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import qrTerminal from "qrcode-terminal";
import { brain } from "./brain.js";
import { AUTH_DIR, backupNow, restoreSession, scheduleBackup, wipeSession } from "./session-store.js";

const log = pino({ level: process.env.LOG_LEVEL || "info", transport: undefined });
// Baileys is very chatty; keep its own logs quiet unless debugging.
const waLog = log.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL || "warn" });

/** Don't answer messages older than this (e.g. backlog delivered after downtime). */
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
/** Safety valve against reply loops / floods: max replies per chat per minute. */
const MAX_REPLIES_PER_MINUTE = 8;
const HEARTBEAT_MS = 25_000;
const INSTANCE_ID = `gw_${Math.random().toString(36).slice(2, 8)}_${Date.now()}`;

let sock = null;
let state = "starting";
let latestQrDataUrl = null;
let me = { pn: null, lid: null, name: null };
let reconnectAttempts = 0;
let restartTimer = null;
const sentIds = new Set(); // ids of messages Nyra Rose sent, so she never answers herself
const replyLog = new Map(); // chatJid -> timestamps of recent replies
const groupNames = new Map();

// ─── Connection ──────────────────────────────────────────────────────────────

async function start() {
  clearTimeout(restartTimer);
  if (state !== "qr") {
    await setState("connecting");
  }
  await restoreSession(log);

  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const keys = {
    get: (type, ids) => auth.keys.get(type, ids),
    set: async (data) => {
      await auth.keys.set(data);
      scheduleBackup(log);
    },
  };
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  try {
    sock?.end(undefined);
  } catch {}

  sock = makeWASocket({
    version,
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(keys, waLog) },
    logger: waLog,
    browser: Browsers.ubuntu("Chrome"),
    // Stay "offline" so your phone keeps receiving notifications as normal.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    getMessage: async () => undefined,
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    scheduleBackup(log);
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log.info("Scan this QR in WhatsApp → Settings → Linked devices → Link a device (also shown on the dashboard):");
      qrTerminal.generate(qr, { small: true });
      latestQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      await setState("qr", { qr: latestQrDataUrl });
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      latestQrDataUrl = null;
      me = {
        pn: sock.user?.id ? jidNormalizedUser(sock.user.id) : null,
        lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
        name: sock.user?.name ?? null,
      };
      log.info(`✅ Connected to WhatsApp as ${me.name ?? ""} (+${jidDecode(me.pn)?.user ?? "?"})`);
      await setState("open");
      await backupNow(log);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.warn("Logged out from WhatsApp. Clearing session — a new QR code will appear.");
        latestQrDataUrl = null;
        await wipeSession(log);
        await setState("logged_out");
        scheduleRestart(1_500);
      } else if (code === DisconnectReason.connectionReplaced) {
        // Another gateway instance took over the session — do NOT overwrite the active instance's "open" status in KV!
        log.warn("Connection replaced: another Nyra Rose gateway instance is active. Standing by for 60s.");
        scheduleRestart(60_000);
      } else {
        const isFastRetry =
          code === DisconnectReason.restartRequired ||
          code === DisconnectReason.timedOut ||
          code === 408 ||
          code === 515;
        const delay = isFastRetry ? 1_000 : Math.min(5_000, 1_500 * Math.min(4, ++reconnectAttempts));
        log.warn(`Connection closed (code ${code ?? "unknown"}). Reconnecting in ${Math.round(delay / 1000)}s…`);
        if (latestQrDataUrl) {
          // Keep showing the QR state while rotating QR socket
          await setState("qr", { qr: latestQrDataUrl });
        } else {
          await setState("connecting", { detail: `Reconnecting seamlessly…` });
        }
        scheduleRestart(delay);
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      onMessage(msg).catch((err) => log.error({ err: String(err), stack: err?.stack }, "Failed to handle message"));
    }
  });
}

function scheduleRestart(delay) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => start().catch(fatalRetry), delay);
}

function fatalRetry(err) {
  log.error({ err: String(err) }, "Gateway start failed; retrying in 5s");
  scheduleRestart(5_000);
}

// ─── Messages ────────────────────────────────────────────────────────────────

function extractText(message) {
  const m = normalizeMessageContent(message);
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

function contextInfoOf(message) {
  const m = normalizeMessageContent(message);
  if (!m) return undefined;
  for (const value of Object.values(m)) {
    if (value && typeof value === "object" && value.contextInfo) return value.contextInfo;
  }
  return undefined;
}

const isMe = (jid) => {
  if (!jid) return false;
  const norm = jidNormalizedUser(jid);
  if ([me.pn, me.lid].filter(Boolean).includes(norm)) return true;
  const p = phoneOf(jid);
  const myP = phoneOf(me.pn);
  return Boolean(p && myP && p === myP);
};
const phoneOf = (...jids) => {
  const pn = jids.find((j) => j && isPnUser(j));
  return pn ? jidDecode(pn)?.user ?? null : null;
};

async function groupName(jid) {
  if (groupNames.has(jid)) return groupNames.get(jid);
  const name = await sock.groupMetadata(jid).then((g) => g.subject).catch(() => null);
  groupNames.set(jid, name);
  return name;
}

function underRateLimit(chatJid) {
  const now = Date.now();
  const recent = (replyLog.get(chatJid) || []).filter((t) => now - t < 60_000);
  replyLog.set(chatJid, recent);
  return recent.length < MAX_REPLIES_PER_MINUTE;
}

function rememberSent(id) {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value);
}

async function onMessage(msg) {
  const key = msg.key;
  const chatJid = key?.remoteJid;
  if (!key?.id || !chatJid || sentIds.has(key.id)) return;
  if (chatJid === "status@broadcast" || chatJid.endsWith("@broadcast") || chatJid.endsWith("@newsletter")) return;
  if (!msg.message || msg.messageStubType) return;

  const text = extractText(msg.message);
  if (!text) return; // text only for now (voice/images can come later)

  const sentAt = Number(msg.messageTimestamp || 0) * 1000;
  if (sentAt && Date.now() - sentAt > MAX_MESSAGE_AGE_MS) return;

  const isGroup = !!isJidGroup(chatJid);
  const isSelfChat = !isGroup && (isMe(chatJid) || isMe(key.remoteJidAlt));
  const ctx = contextInfoOf(msg.message);
  const mentioned = isGroup && (
    (ctx?.mentionedJid || []).some(isMe) ||
    isMe(ctx?.participant) // replying to one of Nyra Rose's messages
  );

  const payload = {
    id: key.id,
    chatId: isGroup ? chatJid : jidNormalizedUser(isPnUser(chatJid) ? chatJid : key.remoteJidAlt || chatJid),
    chatName: isGroup ? await groupName(chatJid) : msg.pushName || null,
    isGroup,
    isSelfChat,
    fromMe: !!key.fromMe,
    senderPhone: isGroup ? phoneOf(key.participant, key.participantAlt) : phoneOf(chatJid, key.remoteJidAlt),
    senderName: key.fromMe ? me.name : msg.pushName || null,
    text: text.slice(0, 4000),
    mentioned,
    timestamp: sentAt || Date.now(),
  };

  const decision = await brain("POST", "/gw/message", { json: payload });
  if (decision?.action !== "reply" || !decision.reply) {
    log.info({ chat: payload.chatId, from: payload.senderPhone, text: payload.text, reason: decision?.reason }, "Message ignored by brain");
    return;
  }
  if (!underRateLimit(chatJid)) {
    log.warn({ chat: payload.chatId }, "Rate limit hit — not replying");
    return;
  }

  await sock.readMessages([key]).catch(() => {});
  await sock.sendPresenceUpdate("composing", chatJid).catch(() => {});
  const sent = await sock.sendMessage(chatJid, { text: decision.reply }, isGroup ? { quoted: msg } : undefined);
  rememberSent(sent?.key?.id);
  replyLog.get(chatJid).push(Date.now());
  await sock.sendPresenceUpdate("paused", chatJid).catch(() => {});
  log.info(`💬 Replied in ${isSelfChat ? "your self-chat" : payload.chatName || payload.chatId}${decision.neurons ? ` (${decision.neurons.toFixed(1)} neurons)` : ""}`);
}

// ─── Status, heartbeat, health ───────────────────────────────────────────────

async function setState(next, extra = {}) {
  state = next;
  await sendStatus(extra);
}

async function sendStatus(extra = {}) {
  try {
    const res = await brain("POST", "/gw/status", {
      retries: 1,
      json: {
        state,
        instanceId: INSTANCE_ID,
        qr: state === "qr" ? extra.qr || latestQrDataUrl || null : null,
        me: me.pn ? { id: me.pn, name: me.name, phone: jidDecode(me.pn)?.user } : null,
        ...extra,
      },
    });
    if (res?.command === "logout" && sock) {
      log.warn("Logout requested from the dashboard.");
      latestQrDataUrl = null;
      await sock.logout().catch((err) => log.error({ err: String(err) }, "Logout failed"));
    }
    if (Array.isArray(res?.outbound) && res.outbound.length > 0 && sock && state === "open") {
      for (const item of res.outbound) {
        if (!item?.jid || !item?.text) continue;
        try {
          await sock.sendPresenceUpdate("composing", item.jid).catch(() => {});
          await new Promise((r) => setTimeout(r, 800));
          const sent = await sock.sendMessage(item.jid, { text: item.text });
          rememberSent(sent?.key?.id);
          await sock.sendPresenceUpdate("paused", item.jid).catch(() => {});
          log.info(`📤 Sent scheduled follow-up/reminder to ${item.jid}`);
        } catch (sendErr) {
          log.warn({ err: String(sendErr), jid: item.jid }, "Failed to send scheduled follow-up");
        }
      }
    }
  } catch (err) {
    log.warn({ err: String(err) }, "Could not reach the brain");
  }
}

// Always send heartbeats every 25s (including while waiting in "qr" state) so the dashboard never drops offline!
setInterval(() => sendStatus(), HEARTBEAT_MS).unref();

const port = Number(process.env.PORT || 8080);
const srv = createServer((req, res) => {
  res.writeHead(state === "open" ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ name: "nyra-rose-gateway", state, instanceId: INSTANCE_ID, connectedAs: me.pn ? `+${jidDecode(me.pn)?.user}` : null }));
});
srv.on("error", (err) => log.warn({ err: String(err) }, "Health check port busy; continuing gateway operation"));
srv.listen(port, () => log.info(`Health check on http://localhost:${port}`));

async function shutdown(signal) {
  log.info(`${signal} received — saving session and exiting.`);
  await backupNow(log);
  sock?.end(undefined);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log.error({ err: String(err), stack: err?.stack }, "Uncaught exception in gateway — keeping process alive");
});
process.on("unhandledRejection", (reason) => {
  log.error({ err: String(reason) }, "Unhandled rejection in gateway — keeping process alive");
});

// GitHub Actions 24/7 continuous relay:
// GitHub jobs have a ~6h runtime limit. At 5 hours, automatically dispatch the next runner.
// Concurrency (cancel-in-progress: true) will seamlessly replace this runner with zero downtime.
if (process.env.GH_PAT && process.env.GITHUB_REPOSITORY) {
  const RELAY_AFTER_MS = 5 * 60 * 60 * 1000; // 5 hours
  setTimeout(async () => {
    log.info("🔄 5 hours elapsed. Dispatching next GitHub relay runner for continuous 24/7 uptime...");
    try {
      const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/gateway.yml/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `token ${process.env.GH_PAT}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Nyra-Rose-Gateway",
        },
        body: JSON.stringify({ ref: "main" }),
      });
      log.info(`Relay runner dispatched: HTTP ${res.status}`);
    } catch (e) {
      log.error({ err: String(e) }, "Failed to trigger relay runner");
    }
  }, RELAY_AFTER_MS).unref();
}

log.info(`🌹 Nyra Rose gateway starting (${INSTANCE_ID})…`);
start().catch(fatalRetry);

