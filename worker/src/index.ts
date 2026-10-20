import type { AppEnv } from "./env";
import { getLiveNeuronUsage } from "./analytics";
import {
  computeNextFollowupState,
  detectTimezoneFromPhone,
  formatTimeInTimezone,
  generateFollowupText,
  handleDashboardChat,
  handleIncoming,
  parseScheduledTimeToMs,
  processDueFollowups,
  syncBookingToTodo,
  type IncomingMessage,
} from "./brain";
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
  insertMessage,
  kvDelete,
  kvGet,
  kvSet,
  toggleTodo,
  updateBooking,
  updateRule,
  updateTodo,
  type Booking,
  type BookingStatus,
  type FollowupType,
  type Todo,
} from "./db";
import { getSettings, MODELS, saveSettings, type Settings } from "./settings";

const SESSION_KEY = "whatsapp/session.bin";
const SESSION_KV_KEY = "whatsapp_session_b64";
/** Gateway sends a heartbeat every 25s; allow up to 3 minutes before marking offline. */
const GATEWAY_OFFLINE_AFTER_MS = 180_000;

export type UserRole = "admin" | "client";

interface GatewayStatus {
  state: "starting" | "connecting" | "qr" | "open" | "closed" | "logged_out";
  qr?: string | null;
  me?: { id?: string; name?: string; phone?: string } | null;
  detail?: string | null;
  instanceId?: string | null;
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
      const now = Date.now();

      // Prevent a retiring/replaced instance from overwriting an active "open" gateway's status
      const anotherInstanceActive =
        prev &&
        prev.state === "open" &&
        now - prev.at < 45_000 &&
        prev.instanceId &&
        body.instanceId &&
        prev.instanceId !== body.instanceId;

      if (anotherInstanceActive && body.state !== "open") {
        return json({ ok: true, standby: true, activeInstanceId: prev.instanceId, command: null, outbound: [] });
      }

      const next: GatewayStatus = {
        state: body.state,
        qr: body.state === "qr" ? body.qr ?? prev?.qr ?? null : null,
        me: body.me ?? prev?.me ?? null,
        detail: body.detail ?? null,
        instanceId: body.instanceId ?? prev?.instanceId ?? null,
        at: now,
      };
      await kvSet(env, "gateway", next);
      const command = await kvGet<{ cmd: string }>(env, "gateway_command");
      if (command) await kvDelete(env, "gateway_command");

      let outbound: Array<{ jid: string; text: string; bookingId?: string }> = [];
      if (body.state === "open") {
        const [dueItems, manualQueue] = await Promise.all([
          processDueFollowups(env).catch(() => []),
          kvGet<Array<{ jid: string; text: string; bookingId?: string }>>(env, "gateway_outbound_queue").catch(() => null),
        ]);
        if (dueItems.length > 0) outbound.push(...dueItems);
        if (manualQueue && manualQueue.length > 0) {
          outbound.push(...manualQueue);
          await kvDelete(env, "gateway_outbound_queue").catch(() => {});
        }
      }

      return json({ ok: true, command: command?.cmd ?? null, outbound });
    }
    case "GET /gw/session": {
      const obj = await env.BUCKET.get(SESSION_KEY).catch(() => null);
      if (obj) {
        return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
      }
      const b64 = await kvGet<string>(env, SESSION_KV_KEY).catch(() => null);
      if (b64) {
        const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Response(binary, { headers: { "content-type": "application/octet-stream" } });
      }
      return new Response(null, { status: 404 });
    }
    case "PUT /gw/session": {
      const buf = await request.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binaryStr = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binaryStr += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binaryStr);
      await Promise.all([
        env.BUCKET.put(SESSION_KEY, buf).catch(() => {}),
        kvSet(env, SESSION_KV_KEY, b64).catch(() => {}),
      ]);
      return json({ ok: true });
    }
    case "DELETE /gw/session": {
      await Promise.all([
        env.BUCKET.delete(SESSION_KEY).catch(() => {}),
        kvDelete(env, SESSION_KV_KEY).catch(() => {}),
      ]);
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
        // Management view:
        // - Sees publicModelName as the active flagship AI engine
        // - Can view and change their own login password (clientPassword)
        // - Does not see underlying Cloudflare Neuron quotas or raw model IDs
        const clientSettings: Partial<Settings> & { modelLabel: string } = {
          enabled: settings.enabled,
          instantReplyPaused: settings.instantReplyPaused,
          pausedInstantChats: settings.pausedInstantChats,
          provider: "workers-ai",
          model: settings.publicModelName || "Nyra Rose Intelligence 🌹",
          modelLabel: settings.publicModelName || "Nyra Rose Intelligence 🌹",
          publicModelName: settings.publicModelName,
          clientPassword: settings.clientPassword || "rose2026",
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

      // Root Admin panel: full access to raw model selection, live neurons, and management password
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
        // Prevent changing underlying Cloudflare model or display name, but allow changing their own login password
        delete patch.model;
        delete patch.provider;
        delete patch.publicModelName;
        if (typeof patch.clientPassword === "string" && patch.clientPassword.trim().length >= 4) {
          patch.clientPassword = patch.clientPassword.trim();
        } else {
          delete patch.clientPassword;
        }
      }
      const saved = await saveSettings(env, patch);
      if (role === "client") {
        return json({
          settings: {
            ...saved,
            model: saved.publicModelName || "Nyra Rose Intelligence 🌹",
            modelLabel: saved.publicModelName || "Nyra Rose Intelligence 🌹",
            clientPassword: saved.clientPassword || "rose2026",
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
      await Promise.all([
        env.BUCKET.delete(SESSION_KEY).catch(() => {}),
        kvDelete(env, SESSION_KV_KEY).catch(() => {}),
      ]);
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
      const now = Date.now();
      const allBookings = await getBookings(env).catch(() => []);
      for (const b of allBookings) {
        if (!b.timezone) {
          b.timezone = detectTimezoneFromPhone(b.phone || b.chat_id)?.code || "BD";
        }
        if (b.next_followup_at) {
          await syncBookingToTodo(env, b, now);
        }
      }
      const todos = await getTodos(env, chat);
      return json({ todos, bookings: allBookings });
    }

    case "POST /api/todos": {
      const body = (await request.json()) as {
        chatId?: string;
        task?: string;
        dueDate?: string;
        scheduledAtMs?: number | string | null;
        timePhrase?: string;
        delayHours?: number;
        timezone?: string;
        clientName?: string;
        phone?: string;
        aiMessage?: string;
        taskType?: string;
        bookingId?: string;
        autoSend?: boolean | number;
      };
      const now = Date.now();
      const cleanPhone = (body.phone || "").replace(/[^0-9]/g, "") || null;
      const effTz = body.timezone || detectTimezoneFromPhone(cleanPhone || body.chatId)?.code || "BD";

      let targetMs: number | null = null;
      if (typeof body.scheduledAtMs === "number" && body.scheduledAtMs > 0) {
        targetMs = body.scheduledAtMs;
      } else if (typeof body.scheduledAtMs === "string" && body.scheduledAtMs.trim()) {
        targetMs =
          parseScheduledTimeToMs(body.scheduledAtMs, effTz, now, cleanPhone || body.chatId) ??
          (Number.isNaN(Date.parse(body.scheduledAtMs)) ? null : Date.parse(body.scheduledAtMs));
      }
      if (!targetMs && body.delayHours && body.delayHours > 0) {
        targetMs = Math.round(now + body.delayHours * 3600 * 1000);
      }
      if (!targetMs && (body.timePhrase || body.dueDate)) {
        targetMs = parseScheduledTimeToMs(body.timePhrase || body.dueDate, effTz, now, cleanPhone || body.chatId);
      }

      const formattedDue = targetMs
        ? formatTimeInTimezone(targetMs, effTz, cleanPhone || body.chatId, now)
        : body.dueDate || body.timePhrase || null;

      // Match existing booking by bookingId or phone if applicable
      let linkedBooking: Booking | null = null;
      if (body.bookingId) {
        linkedBooking = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(body.bookingId).first<Booking>();
      } else if (cleanPhone && cleanPhone.length >= 7) {
        linkedBooking = await env.DB.prepare(
          "SELECT * FROM bookings WHERE phone LIKE ? OR chat_id LIKE ? ORDER BY created_at DESC LIMIT 1"
        )
          .bind(`%${cleanPhone.slice(-8)}%`, `%${cleanPhone.slice(-8)}%`)
          .first<Booking>();
      }

      const clientLabel = body.clientName?.trim() || linkedBooking?.client_name || (cleanPhone ? `+${cleanPhone}` : null);
      const taskTitle =
        body.task?.trim() ||
        (clientLabel
          ? `⚡ Follow up ${clientLabel}${formattedDue ? ` (${formattedDue})` : ""}`
          : "Scheduled AI Task");

      const defaultMsg =
        body.aiMessage?.trim() ||
        (linkedBooking
          ? generateFollowupText({
              ...linkedBooking,
              client_name: clientLabel || linkedBooking.client_name,
              scheduled_at: formattedDue || linkedBooking.scheduled_at,
            })
          : clientLabel
          ? `Hey ${clientLabel}! Just following up as promised to see if you had any questions about your video edits or if now is a good time to chat?`
          : null);

      if (linkedBooking && (targetMs || body.aiMessage)) {
        const updatedB = await updateBooking(env, linkedBooking.id, {
          client_name: clientLabel || linkedBooking.client_name,
          phone: cleanPhone || linkedBooking.phone,
          timezone: effTz,
          next_followup_at: targetMs ?? linkedBooking.next_followup_at,
          scheduled_at: formattedDue ? `Follow-up: ${formattedDue}` : linkedBooking.scheduled_at,
          followup_type: targetMs ? "client_date" : linkedBooking.followup_type,
          custom_followup_msg: body.aiMessage?.trim() || linkedBooking.custom_followup_msg || null,
        });
        await syncBookingToTodo(env, updatedB, now);
        const syncedTodo = await env.DB.prepare("SELECT * FROM todos WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1")
          .bind(linkedBooking.id)
          .first<Todo>();
        if (syncedTodo && body.task?.trim()) {
          const finalTodo = await updateTodo(env, syncedTodo.id, { task: body.task.trim() });
          return json({ todo: finalTodo, booking: updatedB });
        }
        return json({ todo: syncedTodo, booking: updatedB });
      }

      const todo = await createTodo(
        env,
        body.chatId || (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : "dashboard"),
        taskTitle,
        formattedDue,
        {
          client_name: clientLabel,
          phone: cleanPhone,
          scheduled_at_ms: targetMs,
          timezone: effTz,
          ai_message: defaultMsg,
          task_type: body.taskType || (cleanPhone || defaultMsg ? "ai_scheduled" : "general"),
          booking_id: linkedBooking?.id || null,
          auto_send: body.autoSend !== undefined ? (body.autoSend ? 1 : 0) : cleanPhone && defaultMsg ? 1 : 0,
        }
      );
      return json({ todo });
    }

    case "PATCH /api/todos": {
      const body = (await request.json()) as {
        id: string;
        completed?: boolean;
        task?: string;
        dueDate?: string | null;
        scheduledAtMs?: number | string | null;
        timePhrase?: string;
        delayHours?: number;
        timezone?: string;
        clientName?: string | null;
        phone?: string | null;
        aiMessage?: string | null;
        taskType?: string;
        autoSend?: boolean | number;
      };
      if (!body?.id) return json({ error: "id is required" }, 400);

      const existing = await env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(body.id).first<Todo>();
      if (!existing) return json({ error: "Task not found" }, 404);

      const isSimpleToggle =
        body.completed !== undefined &&
        body.task === undefined &&
        body.dueDate === undefined &&
        body.scheduledAtMs === undefined &&
        body.timePhrase === undefined &&
        body.delayHours === undefined &&
        body.aiMessage === undefined &&
        body.clientName === undefined &&
        body.phone === undefined &&
        body.autoSend === undefined;

      if (isSimpleToggle) {
        const todo = await toggleTodo(env, body.id, body.completed);
        return json({ todo });
      }

      const now = Date.now();
      const cleanPhone =
        body.phone !== undefined
          ? (body.phone || "").replace(/[^0-9]/g, "") || null
          : existing.phone;
      const effTz = body.timezone || existing.timezone || detectTimezoneFromPhone(cleanPhone || existing.chat_id)?.code || "BD";

      let targetMs: number | null | undefined = undefined;
      if (body.scheduledAtMs === null || body.scheduledAtMs === "") {
        targetMs = null;
      } else if (typeof body.scheduledAtMs === "number" && body.scheduledAtMs > 0) {
        targetMs = body.scheduledAtMs;
      } else if (typeof body.scheduledAtMs === "string" && body.scheduledAtMs.trim()) {
        targetMs =
          parseScheduledTimeToMs(body.scheduledAtMs, effTz, now, cleanPhone || existing.chat_id) ??
          (Number.isNaN(Date.parse(body.scheduledAtMs)) ? undefined : Date.parse(body.scheduledAtMs));
      }
      if (targetMs === undefined && body.delayHours && body.delayHours > 0) {
        targetMs = Math.round(now + body.delayHours * 3600 * 1000);
      }
      if (targetMs === undefined && body.timePhrase) {
        targetMs = parseScheduledTimeToMs(body.timePhrase, effTz, now, cleanPhone || existing.chat_id);
      }

      const finalMs = targetMs !== undefined ? targetMs : existing.scheduled_at_ms;
      const formattedDue =
        targetMs !== undefined && targetMs !== null
          ? formatTimeInTimezone(targetMs, effTz, cleanPhone || existing.chat_id, now)
          : body.dueDate !== undefined && body.dueDate !== null
          ? body.dueDate
          : existing.due_date;

      // Find linked booking if booking_id not set yet but phone matches
      let bookingId = existing.booking_id;
      if (!bookingId && cleanPhone && cleanPhone.length >= 7) {
        const foundB = await env.DB.prepare(
          "SELECT id FROM bookings WHERE phone LIKE ? OR chat_id LIKE ? ORDER BY created_at DESC LIMIT 1"
        )
          .bind(`%${cleanPhone.slice(-8)}%`, `%${cleanPhone.slice(-8)}%`)
          .first<{ id: string }>();
        if (foundB) bookingId = foundB.id;
      }

      let updatedTaskTitle = body.task !== undefined ? body.task : existing.task;
      if (formattedDue && existing.due_date && updatedTaskTitle === existing.task && updatedTaskTitle.includes(existing.due_date)) {
        updatedTaskTitle = updatedTaskTitle.replace(existing.due_date, formattedDue);
      }

      const patch: Partial<Todo> = {
        task: updatedTaskTitle,
        completed: body.completed !== undefined ? (body.completed ? 1 : 0) : existing.completed,
        due_date: formattedDue,
        scheduled_at_ms: finalMs,
        timezone: effTz,
        client_name: body.clientName !== undefined ? body.clientName : existing.client_name,
        phone: cleanPhone,
        ai_message: body.aiMessage !== undefined ? body.aiMessage : existing.ai_message,
        task_type: body.taskType !== undefined ? body.taskType : existing.task_type,
        booking_id: bookingId,
        auto_send: body.autoSend !== undefined ? (body.autoSend ? 1 : 0) : existing.auto_send,
      };

      const todo = await updateTodo(env, body.id, patch);

      // Sync back to linked CRM booking if present
      let updatedBooking: Booking | null = null;
      if (todo?.booking_id) {
        const bookingPatch: Partial<Booking> = {};
        if (targetMs !== undefined) {
          bookingPatch.next_followup_at = targetMs;
          if (formattedDue) bookingPatch.scheduled_at = `Follow-up: ${formattedDue}`;
          if (patch.task_type === "call_reminder" && targetMs) {
            bookingPatch.call_time_ms = targetMs + 30 * 60 * 1000;
            bookingPatch.followup_type = "call_reminder";
          } else if (patch.task_type === "client_date") {
            bookingPatch.followup_type = "client_date";
          } else if (targetMs) {
            bookingPatch.followup_type = "custom_timer";
          }
        }
        if (body.aiMessage !== undefined) {
          bookingPatch.custom_followup_msg = body.aiMessage?.trim() || null;
        }
        if (body.clientName !== undefined && body.clientName) {
          bookingPatch.client_name = body.clientName.trim();
        }
        if (cleanPhone) {
          bookingPatch.phone = cleanPhone;
        }
        if (Object.keys(bookingPatch).length > 0) {
          updatedBooking = await updateBooking(env, todo.booking_id, bookingPatch);
        }
      }

      return json({ todo, booking: updatedBooking });
    }

    case "POST /api/todos/send": {
      const body = (await request.json()) as { id: string; customText?: string };
      if (!body?.id) return json({ error: "id is required" }, 400);
      const t = await env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(body.id).first<Todo>();
      if (!t) return json({ error: "Task not found" }, 404);

      const cleanPhone = (t.phone || (t.chat_id?.includes("@") ? t.chat_id.split("@")[0] : "")).replace(/[^0-9]/g, "");
      if (cleanPhone.length < 7) {
        return json({ error: "No valid WhatsApp phone number on this task to send." }, 400);
      }
      const message = body.customText?.trim() || t.ai_message?.trim() || t.task;
      if (!message) {
        return json({ error: "No message content to send." }, 400);
      }

      const now = Date.now();
      const jid = `${cleanPhone}@s.whatsapp.net`;
      const existingQueue = (await kvGet<Array<{ jid: string; text: string; bookingId?: string }>>(env, "gateway_outbound_queue")) || [];
      existingQueue.push({ jid, text: message, bookingId: t.booking_id || t.id });
      await kvSet(env, "gateway_outbound_queue", existingQueue);

      await insertMessage(env, {
        id: `task:${crypto.randomUUID()}`,
        chat_id: jid,
        role: "assistant",
        sender: null,
        sender_name: "Nyra Rose",
        content: message,
        source: "whatsapp",
        model: "task:manual_send",
        neurons: 0,
        created_at: now,
      }).catch(() => {});

      let updatedTodo: Todo | null = null;
      if (t.booking_id) {
        const b = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(t.booking_id).first<Booking>();
        if (b) {
          const nextInterval = b.followup_interval_hours && b.followup_interval_hours > 0 ? b.followup_interval_hours : 3.5;
          const nextFollowupAt = b.followup_type === "call_reminder" ? null : Math.round(now + nextInterval * 3600 * 1000);
          const updatedB = await updateBooking(env, b.id, {
            last_followup_at: now,
            followup_count: (b.followup_count || 0) + 1,
            next_followup_at: nextFollowupAt,
            custom_followup_msg: null,
          });
          await syncBookingToTodo(env, updatedB, now);
          updatedTodo = await updateTodo(env, t.id, { sent_at: now });
        }
      } else {
        updatedTodo = await updateTodo(env, t.id, { completed: 1, sent_at: now, ai_message: message });
      }

      return json({ ok: true, queuedToGateway: true, todo: updatedTodo, message });
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
      const list = await getBookings(env, status, followupType);
      const now = Date.now();
      for (const b of list) {
        if (!b.timezone) {
          b.timezone = detectTimezoneFromPhone(b.phone || b.chat_id)?.code || "BD";
        }
        if (
          !b.call_time_ms &&
          b.scheduled_at &&
          (b.status === "booked" || b.status === "confirmed" || b.followup_type === "call_reminder")
        ) {
          b.call_time_ms = parseScheduledTimeToMs(b.scheduled_at, b.timezone, b.created_at || now, b.phone || b.chat_id);
        }
      }
      return json({ bookings: list });
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
        status?: BookingStatus;
        followupType?: FollowupType;
        followup_type?: FollowupType;
        delayHours?: number;
        customFollowupAt?: string | number;
        source?: string;
        notes?: string;
        customFollowupMsg?: string;
      };
      const now = Date.now();
      const status: BookingStatus = body.status || "booked";
      const rawType: FollowupType = body.followupType || body.followup_type || (status === "booked" ? "call_reminder" : "auto_day1");
      const effTz = body.timezone || detectTimezoneFromPhone(body.phone || body.chatId)?.code || "BD";
      const callTimeMs = body.scheduledAt ? parseScheduledTimeToMs(body.scheduledAt, effTz, now, body.phone || body.chatId) : null;
      const formattedScheduledAt = callTimeMs ? formatTimeInTimezone(callTimeMs, effTz, body.phone || body.chatId, now) : body.scheduledAt;

      let nextFollowupAt: number | null = null;
      let intervalHours = 3.5;

      if (body.customFollowupAt) {
        const parsed = typeof body.customFollowupAt === "number" ? body.customFollowupAt : Date.parse(body.customFollowupAt);
        if (!Number.isNaN(parsed)) nextFollowupAt = parsed;
      } else if (body.delayHours && body.delayHours > 0) {
        intervalHours = body.delayHours;
        nextFollowupAt = Math.round(now + body.delayHours * 3600 * 1000);
      } else {
        const computed = computeNextFollowupState(
          {
            status,
            followup_type: rawType,
            scheduled_at: formattedScheduledAt,
            call_time_ms: callTimeMs,
            timezone: effTz,
            phone: body.phone,
            chat_id: body.chatId,
            created_at: now,
            last_client_reply_at: now,
          },
          now,
        );
        nextFollowupAt = computed.next_followup_at;
        intervalHours = computed.followup_interval_hours;
      }

      const booking = await createBooking(env, {
        chat_id: body.chatId || "manual_crm",
        client_name: body.clientName,
        phone: body.phone,
        email: body.email,
        scheduled_at: formattedScheduledAt,
        call_time_ms: callTimeMs,
        timezone: effTz,
        company_or_website: body.companyOrWebsite,
        requirements: body.requirements,
        status,
        followup_type: rawType,
        next_followup_at: nextFollowupAt,
        followup_interval_hours: intervalHours,
        last_client_reply_at: now,
        source: body.source || "dashboard",
        notes: body.notes,
        custom_followup_msg: body.customFollowupMsg,
      });
      await syncBookingToTodo(env, booking, now);
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
        status?: BookingStatus;
        followup_type?: FollowupType;
        next_followup_at?: number | null;
        call_time_ms?: number | null;
        followup_interval_hours?: number;
        delayHours?: number;
        customFollowupAt?: string | number | null;
        notes?: string;
        custom_followup_msg?: string | null;
        last_followup_at?: number;
        followup_count?: number;
      };
      if (!body?.id) return json({ error: "id is required" }, 400);

      const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(body.id).all<Booking>();
      const existing = results?.[0];
      if (!existing) return json({ error: "Booking not found" }, 404);

      const now = Date.now();
      const patch: Partial<Booking> = { ...body };
      let nextStatus = body.status ?? existing.status;
      let nextType = body.followup_type ?? existing.followup_type;
      const effTz = body.timezone ?? existing.timezone ?? detectTimezoneFromPhone(body.phone || existing.phone || existing.chat_id)?.code ?? "BD";
      patch.timezone = effTz;

      // Synchronize status and followup_type when one is explicitly changed in CRM
      if (body.status && !body.followup_type) {
        if (body.status === "not_attended") nextType = "not_attended";
        else if (body.status === "buy_soon") nextType = "buy_soon";
        else if (body.status === "booked" || body.status === "confirmed") nextType = "call_reminder";
        else if (body.status === "not_interested" || body.status === "fake_lead") nextType = "rejected";
        else if (body.status === "lead" && (existing.followup_type === "call_reminder" || existing.followup_type === "rejected")) {
          nextType = "auto_day1";
        }
        patch.followup_type = nextType;
      } else if (body.followup_type && !body.status) {
        if (body.followup_type === "not_attended") nextStatus = "not_attended";
        else if (body.followup_type === "buy_soon") nextStatus = "buy_soon";
        else if (body.followup_type === "rejected") nextStatus = "not_interested";
        else if (body.followup_type === "call_reminder") nextStatus = "booked";
        else if (existing.status === "booked" || existing.status === "confirmed" || existing.status === "not_interested" || existing.status === "fake_lead") {
          nextStatus = "lead";
        }
        patch.status = nextStatus;
      }

      // If scheduled_at or timezone changed, re-parse call_time_ms and format scheduled_at cleanly
      if (
        (body.scheduled_at !== undefined && body.scheduled_at !== existing.scheduled_at) ||
        (body.timezone !== undefined && body.timezone !== existing.timezone)
      ) {
        const rawSched = body.scheduled_at ?? existing.scheduled_at;
        patch.call_time_ms = parseScheduledTimeToMs(rawSched, effTz, now, body.phone || existing.phone || existing.chat_id);
        if (patch.call_time_ms && !body.customFollowupAt) {
          patch.scheduled_at = formatTimeInTimezone(patch.call_time_ms, effTz, body.phone || existing.phone || existing.chat_id, now);
        }
        if (nextStatus === "booked" || nextStatus === "confirmed" || nextType === "call_reminder") {
          patch.followup_type = "call_reminder";
          if (patch.call_time_ms) {
            const thirtyBefore = patch.call_time_ms - 30 * 60 * 1000;
            patch.next_followup_at = thirtyBefore > now ? thirtyBefore : patch.call_time_ms > now ? now + 10_000 : null;
          } else {
            patch.next_followup_at = null;
          }
          patch.followup_interval_hours = 0;
        }
      }

      // If custom timer delay in hours was passed from the app ("2 hours later", "1 day later", "2 days later", etc.)
      if (body.delayHours !== undefined && body.delayHours > 0) {
        patch.followup_interval_hours = body.delayHours;
        patch.next_followup_at = Math.round(now + body.delayHours * 3600 * 1000);
        if (!body.followup_type) patch.followup_type = "custom_timer";
      } else if (body.customFollowupAt !== undefined) {
        if (body.customFollowupAt === null || body.customFollowupAt === "") {
          patch.next_followup_at = null;
        } else {
          const parsed = typeof body.customFollowupAt === "number" ? body.customFollowupAt : Date.parse(body.customFollowupAt);
          if (!Number.isNaN(parsed)) {
            patch.next_followup_at = parsed;
            if (!body.followup_type) patch.followup_type = "client_date";
          }
        }
      } else if (body.followup_type || body.status) {
        // Recompute schedule based on chosen strategy or status
        if (
          nextType === "rejected" ||
          nextStatus === "not_interested" ||
          nextStatus === "fake_lead" ||
          nextStatus === "completed" ||
          nextStatus === "cancelled"
        ) {
          patch.next_followup_at = null;
          patch.followup_interval_hours = 0;
          if (nextStatus === "fake_lead" || nextStatus === "not_interested") {
            patch.followup_type = "rejected";
          }
        } else if (nextType === "call_reminder") {
          const cMs = patch.call_time_ms ?? existing.call_time_ms ?? parseScheduledTimeToMs(existing.scheduled_at, effTz, now, existing.phone || existing.chat_id);
          patch.call_time_ms = cMs;
          patch.followup_type = "call_reminder";
          if (cMs) {
            const thirtyBefore = cMs - 30 * 60 * 1000;
            patch.next_followup_at = thirtyBefore > now ? thirtyBefore : cMs > now ? now + 10_000 : null;
          } else {
            patch.next_followup_at = null;
          }
          patch.followup_interval_hours = 0;
        } else if (nextType === "auto_day1" || nextType === "auto") {
          patch.followup_interval_hours = 3.5;
          patch.next_followup_at = Math.round(now + 3.5 * 3600 * 1000);
        } else if (nextType === "no_reply_3d") {
          patch.followup_interval_hours = 8;
          patch.next_followup_at = Math.round(now + 8 * 3600 * 1000);
        } else if (nextType === "long_term_30d") {
          patch.followup_interval_hours = 24;
          patch.next_followup_at = Math.round(now + 24 * 3600 * 1000);
        } else if (nextType === "on_hold" || nextType === "nurture") {
          patch.followup_interval_hours = 48;
          patch.next_followup_at = Math.round(now + 48 * 3600 * 1000);
        } else if (nextType === "not_attended" || nextType === "buy_soon") {
          patch.followup_interval_hours = 24;
          patch.next_followup_at = Math.round(now + 24 * 3600 * 1000);
        }
      }

      const booking = await updateBooking(env, body.id, patch);
      await syncBookingToTodo(env, booking, now);
      return json({ booking });
    }

    case "POST /api/bookings/followup": {
      const body = (await request.json()) as {
        id: string;
        markSent?: boolean;
        sendViaGateway?: boolean;
        customText?: string;
        saveCustomText?: boolean;
        followupType?: FollowupType;
        delayHours?: number;
      };
      if (!body?.id) return json({ error: "id is required" }, 400);
      const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(body.id).all<Booking>();
      const b = results?.[0];
      if (!b) return json({ error: "Booking not found" }, 404);

      const now = Date.now();
      if (body.saveCustomText && body.customText !== undefined) {
        b.custom_followup_msg = body.customText.trim() || null;
        await updateBooking(env, b.id, { custom_followup_msg: b.custom_followup_msg });
      }
      if (body.followupType && body.followupType !== b.followup_type) {
        const nextPatch: Partial<Booking> = { followup_type: body.followupType };
        if (body.followupType !== "rejected" && (b.status === "not_interested" || b.status === "fake_lead")) {
          nextPatch.status = "lead";
          b.status = "lead";
        } else if (body.followupType === "not_attended") {
          nextPatch.status = "not_attended";
          b.status = "not_attended";
        } else if (body.followupType === "buy_soon") {
          nextPatch.status = "buy_soon";
          b.status = "buy_soon";
        } else if (body.followupType === "call_reminder") {
          nextPatch.status = "booked";
          b.status = "booked";
        }
        const computed = computeNextFollowupState({ ...b, ...nextPatch }, now);
        nextPatch.next_followup_at = computed.next_followup_at;
        nextPatch.followup_interval_hours = computed.followup_interval_hours;
        b.followup_type = body.followupType;
        b.next_followup_at = computed.next_followup_at;
        b.followup_interval_hours = computed.followup_interval_hours;
        await updateBooking(env, b.id, nextPatch);
      }

      if (b.followup_type === "rejected" || b.status === "not_interested" || b.status === "fake_lead") {
        await syncBookingToTodo(env, b, now);
        return json(
          {
            error: `Follow-ups are disabled for this lead (marked as ${b.status === "fake_lead" ? "Fake Lead" : "Rejected / Not Interested"}).`,
            disabled: true,
          },
          400,
        );
      }

      const generated = generateFollowupText(b);
      const message = body.customText?.trim() || generated;
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
      let queuedToGateway = false;

      if (body.sendViaGateway) {
        const jid = b.chat_id?.endsWith("@s.whatsapp.net")
          ? b.chat_id
          : cleanPhone.length >= 7
          ? `${cleanPhone}@s.whatsapp.net`
          : null;
        if (!jid) {
          return json({ error: "No valid WhatsApp number on this lead to send directly." }, 400);
        }
        const existingQueue = (await kvGet<Array<{ jid: string; text: string; bookingId?: string }>>(env, "gateway_outbound_queue")) || [];
        existingQueue.push({ jid, text: message, bookingId: b.id });
        await kvSet(env, "gateway_outbound_queue", existingQueue);
        await insertMessage(env, {
          id: `followup:${crypto.randomUUID()}`,
          chat_id: jid,
          role: "assistant",
          sender: null,
          sender_name: "Nyra Rose",
          content: message,
          source: "whatsapp",
          model: "crm:followup",
          neurons: 0,
          created_at: now,
        }).catch(() => {});
        queuedToGateway = true;
      }

      if (body.markSent || body.sendViaGateway) {
        const nextCount = (b.followup_count || 0) + 1;
        const nextInterval = body.delayHours ?? b.followup_interval_hours ?? 3.5;
        const nextFollowupAt =
          b.followup_type === "call_reminder"
            ? null
            : nextInterval > 0
            ? Math.round(now + nextInterval * 3600 * 1000)
            : null;
        const patched = await updateBooking(env, b.id, {
          last_followup_at: now,
          followup_count: nextCount,
          next_followup_at: nextFollowupAt,
          custom_followup_msg: null,
        });
        if (patched) updatedBooking = patched;
      }

      await syncBookingToTodo(env, updatedBooking, now);

      return json({
        message,
        waLink,
        queuedToGateway,
        status: updatedBooking.status,
        followupType: updatedBooking.followup_type,
        nextFollowupAt: updatedBooking.next_followup_at,
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

    // ── Admin-only: Export all leads/bookings as CSV ────────────────────────
    case "GET /api/bookings/export-csv": {
      // 🔒 Master admin only — management (client role) is blocked
      if (role !== "admin") {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { results } = await env.DB.prepare(
        `SELECT id, client_name, phone, email, status, followup_type,
                scheduled_at, timezone, company_or_website, requirements,
                source, notes, followup_count, next_followup_at,
                last_followup_at, created_at
         FROM bookings
         ORDER BY created_at DESC`,
      ).all<Record<string, unknown>>();

      // CSV header
      const COLS = [
        "id", "client_name", "phone", "email", "status", "followup_type",
        "scheduled_at", "timezone", "company_or_website", "requirements",
        "source", "notes", "followup_count", "next_followup_at_ms",
        "last_followup_at_ms", "created_at_ms",
      ];

      function csvCell(v: unknown): string {
        if (v === null || v === undefined) return "";
        const s = String(v);
        // Escape double-quotes and wrap in quotes if needed
        if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      }

      const rows = [COLS.join(",")];
      for (const row of results) {
        rows.push([
          csvCell(row.id),
          csvCell(row.client_name),
          csvCell(row.phone),
          csvCell(row.email),
          csvCell(row.status),
          csvCell(row.followup_type),
          csvCell(row.scheduled_at),
          csvCell(row.timezone),
          csvCell(row.company_or_website),
          csvCell(row.requirements),
          csvCell(row.source),
          csvCell(row.notes),
          csvCell(row.followup_count),
          csvCell(row.next_followup_at),
          csvCell(row.last_followup_at),
          csvCell(row.created_at),
        ].join(","));
      }

      const csv = rows.join("\r\n");
      const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="nyra-rose-leads-${now}.csv"`,
          "Cache-Control": "no-store",
        },
      });
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
