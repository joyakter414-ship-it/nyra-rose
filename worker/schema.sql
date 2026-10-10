-- Nyra Rose 🌹 — D1 Schema
-- Safe to re-run.

-- Messages table (stores processed user and assistant messages)
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,          -- WhatsApp message id (used for deduplication)
  chat_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  sender      TEXT,                      -- phone digits, when known
  sender_name TEXT,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'whatsapp',  -- 'whatsapp' | 'dashboard'
  model       TEXT,
  neurons     REAL,
  created_at  INTEGER NOT NULL           -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);

-- Chats registry
CREATE TABLE IF NOT EXISTS chats (
  chat_id    TEXT PRIMARY KEY,
  name       TEXT,
  is_group   INTEGER NOT NULL DEFAULT 0,
  muted      INTEGER NOT NULL DEFAULT 0,
  last_at    INTEGER NOT NULL
);

-- Daily Neuron usage tracker (Free allocation: 10,000/day)
CREATE TABLE IF NOT EXISTS usage (
  day      TEXT PRIMARY KEY,             -- YYYY-MM-DD (UTC)
  neurons  REAL NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0
);

-- Key/Value configuration & gateway state
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Rule Book (Instant keyword triggers and AI behavior guidelines)
CREATE TABLE IF NOT EXISTS rules (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('instant', 'ai_guideline')),
  triggers   TEXT NOT NULL,
  response   TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules (enabled, created_at);

-- Quick Notes & Facts memory for Nyra Rose
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  title      TEXT,
  content    TEXT NOT NULL,
  tags       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_chat ON notes (chat_id, created_at);

-- Tasks & To-Dos managed by Nyra Rose
CREATE TABLE IF NOT EXISTS todos (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  task       TEXT NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0,
  due_date   TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_chat ON todos (chat_id, completed, created_at);

-- Booked Calls & Sales Leads CRM Sheet
CREATE TABLE IF NOT EXISTS bookings (
  id                 TEXT PRIMARY KEY,
  chat_id            TEXT NOT NULL,
  client_name        TEXT,
  phone              TEXT,
  email              TEXT,
  scheduled_at       TEXT,
  timezone           TEXT,
  company_or_website TEXT,
  requirements            TEXT,
  status                  TEXT NOT NULL DEFAULT 'booked', -- 'lead', 'booked', 'confirmed', 'not_attended', 'buy_soon', 'not_interested', 'fake_lead', 'completed', 'cancelled'
  followup_type           TEXT NOT NULL DEFAULT 'auto',   -- 'auto', 'auto_day1', 'no_reply_3d', 'long_term_30d', 'client_date', 'custom_timer', 'call_reminder', 'rejected', 'on_hold', 'not_attended', 'buy_soon', 'nurture', 'custom'
  next_followup_at        INTEGER,
  call_time_ms            INTEGER,
  last_client_reply_at    INTEGER,
  followup_interval_hours REAL DEFAULT 3.5,
  source                  TEXT NOT NULL DEFAULT 'whatsapp',
  notes                   TEXT,
  last_followup_at        INTEGER,
  followup_count          INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_chat ON bookings (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_next_followup ON bookings (next_followup_at);

