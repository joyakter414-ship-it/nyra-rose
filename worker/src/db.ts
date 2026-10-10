import type { AppEnv } from "./env";

export async function kvGet<T>(env: AppEnv, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function kvSet(env: AppEnv, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
  )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

export async function kvDelete(env: AppEnv, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
}

export interface StoredMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  sender: string | null;
  sender_name: string | null;
  content: string;
  source: string;
  model: string | null;
  neurons: number | null;
  created_at: number;
}

/**
 * Insert a message. Returns false if a message with the same id already
 * exists — that's how duplicate WhatsApp deliveries are ignored.
 */
export async function insertMessage(
  env: AppEnv,
  m: Omit<StoredMessage, "model" | "neurons"> & Partial<StoredMessage>
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_id, role, sender, sender_name, content, source, model, neurons, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(m.id, m.chat_id, m.role, m.sender, m.sender_name, m.content, m.source, m.model ?? null, m.neurons ?? null, m.created_at)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function recentMessages(env: AppEnv, chatId: string, limit: number, excludeId?: string): Promise<StoredMessage[]> {
  if (limit <= 0) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(chatId, excludeId ?? "", limit)
    .all<StoredMessage>();
  return results.reverse();
}

export async function upsertChat(env: AppEnv, chatId: string, name: string | null, isGroup: boolean): Promise<{ muted: boolean }> {
  const row = await env.DB.prepare(
    `INSERT INTO chats (chat_id, name, is_group, last_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(?2, name), last_at = ?4
     RETURNING muted`,
  )
    .bind(chatId, name, isGroup ? 1 : 0, Date.now())
    .first<{ muted: number }>();
  return { muted: Boolean(row?.muted) };
}

export async function addUsage(env: AppEnv, neurons: number | undefined): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO usage (day, neurons, requests) VALUES (?1, ?2, 1)
     ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2, requests = requests + 1`,
  )
    .bind(day, neurons ?? 0)
    .run();
}

export interface Rule {
  id: string;
  type: "instant" | "ai_guideline";
  triggers: string;
  response: string;
  enabled: number;
  created_at: number;
}

export async function getRules(env: AppEnv): Promise<Rule[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules ORDER BY created_at DESC"
  ).all<Rule>();
  return results;
}

export async function getEnabledRules(env: AppEnv): Promise<Rule[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules WHERE enabled = 1 ORDER BY created_at DESC"
  ).all<Rule>();
  return results;
}

export async function createRule(
  env: AppEnv,
  r: { type: "instant" | "ai_guideline"; triggers: string; response: string; enabled?: boolean }
): Promise<Rule> {
  const id = `rule_${crypto.randomUUID().slice(0, 8)}`;
  const enabled = r.enabled !== false ? 1 : 0;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO rules (id, type, triggers, response, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, r.type, r.triggers.trim(), r.response.trim(), enabled, created_at)
    .run();
  return { id, type: r.type, triggers: r.triggers.trim(), response: r.response.trim(), enabled, created_at };
}

export async function updateRule(
  env: AppEnv,
  id: string,
  patch: Partial<Pick<Rule, "type" | "triggers" | "response" | "enabled">>
): Promise<Rule | null> {
  const existing = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first<Rule>();
  if (!existing) return null;
  const updated: Rule = {
    ...existing,
    type: patch.type ?? existing.type,
    triggers: patch.triggers !== undefined ? patch.triggers.trim() : existing.triggers,
    response: patch.response !== undefined ? patch.response.trim() : existing.response,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
  };
  await env.DB.prepare(
    `UPDATE rules SET type = ?, triggers = ?, response = ?, enabled = ? WHERE id = ?`
  )
    .bind(updated.type, updated.triggers, updated.response, updated.enabled, id)
    .run();
  return updated;
}

export async function deleteRule(env: AppEnv, id: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// ─── Notes & Memory ─────────────────────────────────────────────────────────

export interface Note {
  id: string;
  chat_id: string;
  title: string | null;
  content: string;
  tags: string | null;
  created_at: number;
}

export async function getNotes(env: AppEnv, chatId?: string): Promise<Note[]> {
  if (chatId) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM notes WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(chatId).all<Note>();
    return results;
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM notes ORDER BY created_at DESC LIMIT 100"
  ).all<Note>();
  return results;
}

export async function createNote(
  env: AppEnv,
  chatId: string,
  content: string,
  title?: string,
  tags?: string
): Promise<Note> {
  const id = `note_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO notes (id, chat_id, title, content, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, chatId, title ?? null, content.trim(), tags ?? null, created_at)
    .run();
  return { id, chat_id: chatId, title: title ?? null, content: content.trim(), tags: tags ?? null, created_at };
}

export async function deleteNote(env: AppEnv, id: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function clearNotes(env: AppEnv, chatId: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM notes WHERE chat_id = ?").bind(chatId).run();
  return (res.meta.changes ?? 0) > 0;
}

// ─── Tasks & To-Dos ────────────────────────────────────────────────────────

export interface Todo {
  id: string;
  chat_id: string;
  task: string;
  completed: number;
  due_date: string | null;
  created_at: number;
}

export async function getTodos(env: AppEnv, chatId?: string, onlyPending = false): Promise<Todo[]> {
  let query = "SELECT * FROM todos";
  const params: unknown[] = [];
  const clauses: string[] = [];

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

  const { results } = await env.DB.prepare(query).bind(...params).all<Todo>();
  return results;
}

export async function createTodo(
  env: AppEnv,
  chatId: string,
  task: string,
  dueDate?: string
): Promise<Todo> {
  const id = `todo_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO todos (id, chat_id, task, completed, due_date, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  )
    .bind(id, chatId, task.trim(), dueDate ?? null, created_at)
    .run();
  return { id, chat_id: chatId, task: task.trim(), completed: 0, due_date: dueDate ?? null, created_at };
}

export async function toggleTodo(env: AppEnv, id: string, completed?: boolean): Promise<Todo | null> {
  const existing = await env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first<Todo>();
  if (!existing) return null;
  const nextCompleted = completed !== undefined ? (completed ? 1 : 0) : (existing.completed ? 0 : 1);
  await env.DB.prepare("UPDATE todos SET completed = ? WHERE id = ?").bind(nextCompleted, id).run();
  return { ...existing, completed: nextCompleted };
}

export async function deleteTodo(env: AppEnv, id: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// ─── Bookings & Leads CRM Sheet ──────────────────────────────────────────────

export type BookingStatus =
  | "lead"
  | "booked"
  | "confirmed"
  | "not_attended"
  | "buy_soon"
  | "not_interested"
  | "fake_lead"
  | "completed"
  | "cancelled";

export type FollowupType =
  | "auto"
  | "auto_day1"
  | "no_reply_3d"
  | "long_term_30d"
  | "client_date"
  | "custom_timer"
  | "call_reminder"
  | "rejected"
  | "on_hold"
  | "not_attended"
  | "buy_soon"
  | "nurture"
  | "custom";

export interface Booking {
  id: string;
  chat_id: string;
  client_name: string | null;
  phone: string | null;
  email: string | null;
  scheduled_at: string | null;
  timezone: string | null;
  company_or_website: string | null;
  requirements: string | null;
  status: BookingStatus;
  followup_type: FollowupType;
  next_followup_at: number | null;
  call_time_ms: number | null;
  last_client_reply_at: number | null;
  followup_interval_hours: number | null;
  source: string;
  notes: string | null;
  last_followup_at: number | null;
  followup_count: number;
  created_at: number;
}

export async function getBookings(env: AppEnv, status?: string, followupType?: string): Promise<Booking[]> {
  let query = "SELECT * FROM bookings";
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (status && status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  if (followupType && followupType !== "all") {
    clauses.push("followup_type = ?");
    params.push(followupType);
  }

  if (clauses.length > 0) {
    query += " WHERE " + clauses.join(" AND ");
  }

  query += " ORDER BY created_at DESC LIMIT 200";
  const { results } = await env.DB.prepare(query).bind(...params).all<Booking>();
  return results;
}

export async function createBooking(
  env: AppEnv,
  b: {
    chat_id: string;
    client_name?: string | null;
    phone?: string | null;
    email?: string | null;
    scheduled_at?: string | null;
    timezone?: string | null;
    company_or_website?: string | null;
    requirements?: string | null;
    status?: BookingStatus;
    followup_type?: FollowupType;
    next_followup_at?: number | null;
    call_time_ms?: number | null;
    last_client_reply_at?: number | null;
    followup_interval_hours?: number | null;
    source?: string;
    notes?: string | null;
  }
): Promise<Booking> {
  const id = `book_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  const status: BookingStatus = b.status || "booked";
  const followup_type: FollowupType = b.followup_type || "auto";
  const source = b.source || "whatsapp";
  const followup_interval_hours = b.followup_interval_hours ?? 3.5;
  const last_client_reply_at = b.last_client_reply_at ?? created_at;

  await env.DB.prepare(
    `INSERT INTO bookings (
       id, chat_id, client_name, phone, email, scheduled_at, timezone,
       company_or_website, requirements, status, followup_type,
       next_followup_at, call_time_ms, last_client_reply_at, followup_interval_hours,
       source, notes, last_followup_at, followup_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?)`
  )
    .bind(
      id,
      b.chat_id,
      b.client_name?.trim() ?? null,
      b.phone?.trim() ?? null,
      b.email?.trim() ?? null,
      b.scheduled_at?.trim() ?? null,
      b.timezone?.trim() ?? null,
      b.company_or_website?.trim() ?? null,
      b.requirements?.trim() ?? null,
      status,
      followup_type,
      b.next_followup_at ?? null,
      b.call_time_ms ?? null,
      last_client_reply_at,
      followup_interval_hours,
      source,
      b.notes?.trim() ?? null,
      created_at
    )
    .run();

  return {
    id,
    chat_id: b.chat_id,
    client_name: b.client_name?.trim() ?? null,
    phone: b.phone?.trim() ?? null,
    email: b.email?.trim() ?? null,
    scheduled_at: b.scheduled_at?.trim() ?? null,
    timezone: b.timezone?.trim() ?? null,
    company_or_website: b.company_or_website?.trim() ?? null,
    requirements: b.requirements?.trim() ?? null,
    status,
    followup_type,
    next_followup_at: b.next_followup_at ?? null,
    call_time_ms: b.call_time_ms ?? null,
    last_client_reply_at,
    followup_interval_hours,
    source,
    notes: b.notes?.trim() ?? null,
    last_followup_at: null,
    followup_count: 0,
    created_at,
  };
}

export async function updateBooking(
  env: AppEnv,
  id: string,
  patch: Partial<Booking>
): Promise<Booking | null> {
  const existing = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first<Booking>();
  if (!existing) return null;

  const next: Booking = {
    ...existing,
    ...patch,
  };

  await env.DB.prepare(
    `UPDATE bookings SET
       client_name = ?,
       phone = ?,
       email = ?,
       scheduled_at = ?,
       timezone = ?,
       company_or_website = ?,
       requirements = ?,
       status = ?,
       followup_type = ?,
       next_followup_at = ?,
       call_time_ms = ?,
       last_client_reply_at = ?,
       followup_interval_hours = ?,
       notes = ?,
       last_followup_at = ?,
       followup_count = ?
     WHERE id = ?`
  )
    .bind(
      next.client_name,
      next.phone,
      next.email,
      next.scheduled_at,
      next.timezone,
      next.company_or_website,
      next.requirements,
      next.status,
      next.followup_type ?? "auto",
      next.next_followup_at ?? null,
      next.call_time_ms ?? null,
      next.last_client_reply_at ?? null,
      next.followup_interval_hours ?? 3.5,
      next.notes,
      next.last_followup_at,
      next.followup_count,
      id
    )
    .run();

  return next;
}

export async function getDueFollowups(env: AppEnv, now: number): Promise<Booking[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings
     WHERE next_followup_at IS NOT NULL
       AND next_followup_at <= ?
       AND status NOT IN ('fake_lead', 'not_interested', 'completed', 'cancelled')
       AND followup_type != 'rejected'
     ORDER BY next_followup_at ASC
     LIMIT 5`
  )
    .bind(now)
    .all<Booking>();
  return results;
}

export async function deleteBooking(env: AppEnv, id: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function findLatestBookingForChat(env: AppEnv, chatId: string): Promise<Booking | null> {
  return await env.DB.prepare("SELECT * FROM bookings WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(chatId)
    .first<Booking>();
}


