import type { AppEnv } from "./env";
import { getLiveNeuronUsage } from "./analytics";
import { generateFollowupText, handleDashboardChat, handleIncoming, type IncomingMessage } from "./brain";
import {
  createBooking,
  createNote,
  createRule,
  createTodo,
  deleteBooking,
  deleteNote,
  deleteRule,
  deleteTodo,
  getBookings,
  getNotes,
  getRules,
  getTodos,
  kvDelete,
  kvGet,
  kvSet,
  toggleTodo,
  updateBooking,
  updateRule,
  type Booking,
} from "./db";
import { getSettings, MODELS, saveSettings, type Settings } from "./settings";

const SESSION_KEY = "whatsapp/session.bin";
/** Gateway sends a heartbeat every 30s; after this long without one it's shown offline. */
const GATEWAY_OFFLINE_AFTER_MS = 90_000;

export type UserRole = "admin" | "client";

interface GatewayStatus {
  state: "starting" | "connecting" | "qr" | "open" | "closed" | "logged_out";
  qr?: string | null;
  me?: { id?: string; name?: string; phone?: string } | null;
  detail?: string | null;
  at: number;
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/gw/")) return await gatewayRoutes(request, env, url);
      if (url.pathname.startsWith("/api/")) return await dashboardRoutes(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error", { path: url.pathname, error: String(err), stack: (err as Error)?.stack });
      return json({ error: "Internal error" }, 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;

// ─── Gateway (WhatsApp connector) ────────────────────────────────────────────

async function gatewayRoutes(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (!(await checkSecret(request, env.GATEWAY_TOKEN))) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case "POST /gw/message": {
      const m = (await request.json()) as IncomingMessage;
      if (!m?.id || !m?.chatId || typeof m.text !== "string") return json({ error: "Invalid message" }, 400);
      return json(await handleIncoming(env, m));
    }
    case "POST /gw/status": {
      const body = (await request.json()) as Omit<GatewayStatus, "at">;
      const prev = await kvGet<GatewayStatus>(env, "gateway");
      const next: GatewayStatus = {
        state: body.state,
        qr: body.state === "qr" ? body.qr ?? null : null,
        me: body.me ?? prev?.me ?? null,
        detail: body.detail ?? null,
        at: Date.now(),
      };
      await kvSet(env, "gateway", next);
      const command = await kvGet<{ cmd: string }>(env, "gateway_command");
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

// ─── Dashboard API ───────────────────────────────────────────────────────────

async function dashboardRoutes(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const role = await getAuthRole(request, env);
  if (!role) return json({ error: "Unauthorized" }, 401);

  const route = `${request.method} ${url.pathname}`;

  switch (route) {
    case "GET /api/overview": {
      const [settings, gateway, usage] = await Promise.all([
        getSettings(env),
        kvGet<GatewayStatus>(env, "gateway"),
        getLiveNeuronUsage(env),
      ]);
      const online = !!gateway && Date.now() - gateway.at < GATEWAY_OFFLINE_AFTER_MS;

      if (role === "client") {
        // Client panel:
        // - Cannot see raw model name (sees only publicModelName configured by admin)
        // - Cannot see raw models dropdown
        // - Cannot see live Cloudflare Neuron numbers/quotas
        // - Cannot see client password
        const clientSettings: Partial<Settings> & { modelLabel: string } = {
          enabled: settings.enabled,
          provider: "workers-ai",
          model: settings.publicModelName || "Nyra Rose Intelligence 🌹",
          modelLabel: settings.publicModelName || "Nyra Rose Intelligence 🌹",
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
          extraInstructions: settings.extraInstructions,
        };

        return json({
          name: "Nyra Rose",
          symbol: "🌹",
          role: "client",
          settings: clientSettings,
          models: [],
          gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
          usage: {
            isLive: false,
            accountWide: false,
            freePerDay: 0,
            today: {
              day: usage.today?.day || new Date().toISOString().slice(0, 10),
              neurons: 0,
              requests: usage.today?.requests || 0,
            },
            recent: [],
          },
        });
      }

      // Admin panel: full access to raw model selection, live neurons, and client password
      const activeModel = MODELS.find((m) => m.id === settings.model);
      return json({
        name: "Nyra Rose",
        symbol: "🌹",
        role: "admin",
        settings: {
          ...settings,
          modelLabel: activeModel ? activeModel.label.split("—")[0].trim() : settings.model,
        },
        models: MODELS,
        gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
        usage,
      });
    }

    case "PUT /api/settings": {
      const patch = (await request.json()) as Partial<Settings>;
      if (role === "client") {
        // Prevent client from changing underlying model, public model name, or client password
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
            model: saved.publicModelName || "Nyra Rose Intelligence 🌹",
            modelLabel: saved.publicModelName || "Nyra Rose Intelligence 🌹",
            clientPassword: "",
          },
        });
      }
      const activeModel = MODELS.find((m) => m.id === saved.model);
      return json({
        settings: {
          ...saved,
          modelLabel: activeModel ? activeModel.label.split("—")[0].trim() : saved.model,
        },
      });
    }

    case "POST /api/chat": {
      const { text } = (await request.json()) as { text?: string };
      if (!text?.trim()) return json({ error: "Empty message" }, 400);
      const res = await handleDashboardChat(env, text.trim().slice(0, 4000));
      if (role === "client" && "neurons" in res) {
        delete (res as Record<string, unknown>).neurons;
        delete (res as Record<string, unknown>).model;
      }
      return json(res);
    }

    case "GET /api/chats": {
      const { results } = await env.DB.prepare(
        `SELECT c.chat_id, c.name, c.is_group, c.muted, c.last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS message_count
         FROM chats c ORDER BY c.last_at DESC LIMIT 100`,
      ).all();
      return json({ chats: results });
    }

    case "GET /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at ASC",
      )
        .bind(chat)
        .all();

      if (role === "client") {
        // Sanitize neuron and model fields for client
        for (const row of results as Array<Record<string, unknown>>) {
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
      const { chat, muted } = (await request.json()) as { chat?: string; muted?: boolean };
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
            "User-Agent": "Nyra-Rose-Brain",
          },
          body: JSON.stringify({ ref: "main" }),
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
      await env.BUCKET.delete(SESSION_KEY).catch(() => {});
      await kvSet(env, "gateway", {
        state: "logged_out",
        qr: null,
        me: null,
        detail: "WhatsApp unlinked by user. Scan new QR code to connect.",
        at: Date.now(),
      });
      await kvSet(env, "gateway_command", { cmd: "logout" });
      return json({
        ok: true,
        note: "WhatsApp unlinked and session cleared! A fresh QR code will appear.",
      });
    }

    case "GET /api/rules": {
      return json({ rules: await getRules(env) });
    }

    case "POST /api/rules": {
      const body = (await request.json()) as { type: "instant" | "ai_guideline"; triggers: string; response: string; enabled?: boolean };
      if (!body?.triggers?.trim() || !body?.response?.trim()) return json({ error: "Triggers and response are required" }, 400);
      const rule = await createRule(env, body);
      return json({ rule });
    }

    case "PATCH /api/rules": {
      const body = (await request.json()) as { id: string; enabled?: number; triggers?: string; response?: string; type?: "instant" | "ai_guideline" };
      if (!body?.id) return json({ error: "id is required" }, 400);
      const rule = await updateRule(env, body.id, {
        enabled: body.enabled,
        triggers: body.triggers,
        response: body.response,
        type: body.type,
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
      const chat = url.searchParams.get("chat") || undefined;
      return json({ notes: await getNotes(env, chat) });
    }

    case "POST /api/notes": {
      const body = (await request.json()) as { chatId?: string; content: string; title?: string; tags?: string };
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
      const chat = url.searchParams.get("chat") || undefined;
      return json({ todos: await getTodos(env, chat) });
    }

    case "POST /api/todos": {
      const body = (await request.json()) as { chatId?: string; task: string; dueDate?: string };
      if (!body?.task?.trim()) return json({ error: "Task content required" }, 400);
      const todo = await createTodo(env, body.chatId || "dashboard", body.task, body.dueDate);
      return json({ todo });
    }

    case "PATCH /api/todos": {
      const body = (await request.json()) as { id: string; completed?: boolean };
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

    case "GET /api/bookings": {
      const status = url.searchParams.get("status") || undefined;
      const followupType = url.searchParams.get("followup_type") || undefined;
      return json({ bookings: await getBookings(env, status, followupType) });
    }

    case "POST /api/bookings": {
      const body = (await request.json()) as {
        chatId?: string;
        clientName?: string;
        phone?: string;
        email?: string;
        scheduledAt?: string;
        timezone?: string;
        companyOrWebsite?: string;
        requirements?: string;
        status?: "booked" | "confirmed" | "not_attended" | "buy_soon" | "not_interested" | "completed" | "cancelled";
        followupType?: "auto" | "rejected" | "on_hold" | "not_attended" | "buy_soon" | "nurture" | "custom";
        followup_type?: "auto" | "rejected" | "on_hold" | "not_attended" | "buy_soon" | "nurture" | "custom";
        source?: string;
        notes?: string;
      };
      const booking = await createBooking(env, {
        chat_id: body.chatId || "manual_crm",
        client_name: body.clientName,
        phone: body.phone,
        email: body.email,
        scheduled_at: body.scheduledAt,
        timezone: body.timezone,
        company_or_website: body.companyOrWebsite,
        requirements: body.requirements,
        status: body.status || "booked",
        followup_type: body.followupType || body.followup_type || "auto",
        source: body.source || "dashboard",
        notes: body.notes,
      });
      return json({ booking });
    }

    case "PATCH /api/bookings": {
      const body = (await request.json()) as {
        id: string;
        client_name?: string;
        phone?: string;
        email?: string;
        scheduled_at?: string;
        timezone?: string;
        company_or_website?: string;
        requirements?: string;
        status?: "booked" | "confirmed" | "not_attended" | "buy_soon" | "not_interested" | "completed" | "cancelled";
        followup_type?: "auto" | "rejected" | "on_hold" | "not_attended" | "buy_soon" | "nurture" | "custom";
        notes?: string;
        last_followup_at?: number;
        followup_count?: number;
      };
      if (!body?.id) return json({ error: "id is required" }, 400);
      const booking = await updateBooking(env, body.id, body);
      return json({ booking });
    }

    case "POST /api/bookings/followup": {
      const body = (await request.json()) as { id: string; markSent?: boolean; followupType?: "auto" | "rejected" | "on_hold" | "not_attended" | "buy_soon" | "nurture" | "custom" };
      if (!body?.id) return json({ error: "id is required" }, 400);
      const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(body.id).all<Booking>();
      const b = results?.[0];
      if (!b) return json({ error: "Booking not found" }, 404);

      if (body.followupType && body.followupType !== b.followup_type) {
        b.followup_type = body.followupType;
        await updateBooking(env, b.id, { followup_type: body.followupType });
      }

      if (b.followup_type === "rejected" || b.status === "not_interested") {
        return json(
          {
            error: "Follow-ups are disabled for this lead (marked as Rejected / Not Interested).",
            disabled: true,
          },
          400,
        );
      }

      const message = generateFollowupText(b);
      if (!message) {
        return json(
          {
            error: "Follow-up is disabled or not configured for this lead.",
            disabled: true,
          },
          400,
        );
      }

      const cleanPhone = (b.phone || b.chat_id?.split("@")[0] || "").replace(/[^0-9]/g, "");
      const waLink = cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}` : null;

      let updatedBooking = b;
      if (body.markSent) {
        const nextCount = (b.followup_count || 0) + 1;
        const now = Date.now();
        const patched = await updateBooking(env, b.id, {
          last_followup_at: now,
          followup_count: nextCount,
        });
        if (patched) updatedBooking = patched;
      }

      return json({
        message,
        waLink,
        status: updatedBooking.status,
        followupType: updatedBooking.followup_type,
        clientName: updatedBooking.client_name,
        phone: updatedBooking.phone,
        followupCount: updatedBooking.followup_count,
        lastFollowupAt: updatedBooking.last_followup_at,
      });
    }

    case "DELETE /api/bookings": {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      await deleteBooking(env, id);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAuthRole(request: Request, env: AppEnv): Promise<UserRole | null> {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given) return null;

  // 1. Admin authentication (full access)
  if (env.DASHBOARD_PASSWORD && (await safeEqual(given, env.DASHBOARD_PASSWORD))) {
    return "admin";
  }

  // 2. Client authentication (restricted panel)
  const settings = await getSettings(env);
  const clientSecret = settings.clientPassword || "rose2026";
  if (clientSecret && (await safeEqual(given, clientSecret))) {
    return "client";
  }

  return null;
}

async function checkSecret(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(given, secret);
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
