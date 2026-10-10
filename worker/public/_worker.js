// src/db.ts
async function kvGet(env, key) {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function kvSet(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3"
  ).bind(key, JSON.stringify(value), Date.now()).run();
}
async function kvDelete(env, key) {
  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
}
async function insertMessage(env, m) {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_id, role, sender, sender_name, content, source, model, neurons, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(m.id, m.chat_id, m.role, m.sender, m.sender_name, m.content, m.source, m.model ?? null, m.neurons ?? null, m.created_at).run();
  return (res.meta.changes ?? 0) > 0;
}
async function recentMessages(env, chatId, limit, excludeId) {
  if (limit <= 0) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE chat_id = ? AND id != ? ORDER BY created_at DESC LIMIT ?"
  ).bind(chatId, excludeId ?? "", limit).all();
  return results.reverse();
}
async function upsertChat(env, chatId, name, isGroup) {
  const row = await env.DB.prepare(
    `INSERT INTO chats (chat_id, name, is_group, last_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(chat_id) DO UPDATE SET name = COALESCE(?2, name), last_at = ?4
     RETURNING muted`
  ).bind(chatId, name, isGroup ? 1 : 0, Date.now()).first();
  return { muted: Boolean(row?.muted) };
}
async function addUsage(env, neurons) {
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO usage (day, neurons, requests) VALUES (?1, ?2, 1)
     ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2, requests = requests + 1`
  ).bind(day, neurons ?? 0).run();
}
async function getRules(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules ORDER BY created_at DESC"
  ).all();
  return results;
}
async function getEnabledRules(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rules WHERE enabled = 1 ORDER BY created_at DESC"
  ).all();
  return results;
}
async function createRule(env, r) {
  const id = `rule_${crypto.randomUUID().slice(0, 8)}`;
  const enabled = r.enabled !== false ? 1 : 0;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO rules (id, type, triggers, response, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, r.type, r.triggers.trim(), r.response.trim(), enabled, created_at).run();
  return { id, type: r.type, triggers: r.triggers.trim(), response: r.response.trim(), enabled, created_at };
}
async function updateRule(env, id, patch) {
  const existing = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first();
  if (!existing) return null;
  const updated = {
    ...existing,
    type: patch.type ?? existing.type,
    triggers: patch.triggers !== void 0 ? patch.triggers.trim() : existing.triggers,
    response: patch.response !== void 0 ? patch.response.trim() : existing.response,
    enabled: patch.enabled !== void 0 ? patch.enabled : existing.enabled
  };
  await env.DB.prepare(
    `UPDATE rules SET type = ?, triggers = ?, response = ?, enabled = ? WHERE id = ?`
  ).bind(updated.type, updated.triggers, updated.response, updated.enabled, id).run();
  return updated;
}
async function deleteRule(env, id) {
  const res = await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
async function getNotes(env, chatId) {
  if (chatId) {
    const { results: results2 } = await env.DB.prepare(
      "SELECT * FROM notes WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(chatId).all();
    return results2;
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM notes ORDER BY created_at DESC LIMIT 100"
  ).all();
  return results;
}
async function createNote(env, chatId, content, title, tags) {
  const id = `note_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO notes (id, chat_id, title, content, tags, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, chatId, title ?? null, content.trim(), tags ?? null, created_at).run();
  return { id, chat_id: chatId, title: title ?? null, content: content.trim(), tags: tags ?? null, created_at };
}
async function deleteNote(env, id) {
  const res = await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
async function clearNotes(env, chatId) {
  const res = await env.DB.prepare("DELETE FROM notes WHERE chat_id = ?").bind(chatId).run();
  return (res.meta.changes ?? 0) > 0;
}
async function getTodos(env, chatId, onlyPending = false) {
  let query = "SELECT * FROM todos";
  const params = [];
  const clauses = [];
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
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return results;
}
async function createTodo(env, chatId, task, dueDate) {
  const id = `todo_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  await env.DB.prepare(
    `INSERT INTO todos (id, chat_id, task, completed, due_date, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).bind(id, chatId, task.trim(), dueDate ?? null, created_at).run();
  return { id, chat_id: chatId, task: task.trim(), completed: 0, due_date: dueDate ?? null, created_at };
}
async function toggleTodo(env, id, completed) {
  const existing = await env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first();
  if (!existing) return null;
  const nextCompleted = completed !== void 0 ? completed ? 1 : 0 : existing.completed ? 0 : 1;
  await env.DB.prepare("UPDATE todos SET completed = ? WHERE id = ?").bind(nextCompleted, id).run();
  return { ...existing, completed: nextCompleted };
}
async function deleteTodo(env, id) {
  const res = await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
async function getBookings(env, status, followupType) {
  let query = "SELECT * FROM bookings";
  const params = [];
  const clauses = [];
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
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return results;
}
async function createBooking(env, b) {
  const id = `book_${crypto.randomUUID().slice(0, 8)}`;
  const created_at = Date.now();
  const status = b.status || "booked";
  const followup_type = b.followup_type || "auto";
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
  ).bind(
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
  ).run();
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
    created_at
  };
}
async function updateBooking(env, id, patch) {
  const existing = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch
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
  ).bind(
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
  ).run();
  return next;
}
async function getDueFollowups(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings
     WHERE next_followup_at IS NOT NULL
       AND next_followup_at <= ?
       AND status NOT IN ('fake_lead', 'not_interested', 'completed', 'cancelled')
       AND followup_type != 'rejected'
     ORDER BY next_followup_at ASC
     LIMIT 5`
  ).bind(now).all();
  return results;
}
async function deleteBooking(env, id) {
  const res = await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}
async function findLatestBookingForChat(env, chatId) {
  return await env.DB.prepare("SELECT * FROM bookings WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1").bind(chatId).first();
}

// src/analytics.ts
var CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
var FREE_NEURONS_PER_DAY = 1e4;
async function getCloudflareAccessToken(env) {
  if (!env.CF_REFRESH_TOKEN) return null;
  const cached = await kvGet(env, "cf_token_cache");
  if (cached && cached.expiresAt > Date.now() + 6e4) {
    return cached.accessToken;
  }
  try {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("client_id", CLIENT_ID);
    params.set("refresh_token", env.CF_REFRESH_TOKEN);
    const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if (!res.ok) {
      console.warn("Could not refresh Cloudflare token:", res.status);
      return null;
    }
    const data = await res.json();
    if (!data.access_token) return null;
    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1e3;
    await kvSet(env, "cf_token_cache", { accessToken: data.access_token, expiresAt });
    return data.access_token;
  } catch (err) {
    console.warn("Error refreshing Cloudflare access token:", err);
    return null;
  }
}
async function getLiveNeuronUsage(env) {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const accountId = env.CF_ACCOUNT_ID || "b1063110432e3589537a148bd49d57ee";
  try {
    const accessToken = await getCloudflareAccessToken(env);
    if (accessToken) {
      const startDate = new Date(Date.now() - 7 * 24 * 3600 * 1e3).toISOString().slice(0, 10);
      const query = `query {
        viewer {
          accounts(filter: { accountTag: "${accountId}" }) {
            aiInferenceAdaptiveGroups(
              limit: 10
              filter: { date_geq: "${startDate}" }
              orderBy: [date_DESC]
            ) {
              count
              sum {
                totalNeurons
              }
              dimensions {
                date
              }
            }
          }
        }
      }`;
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query })
      });
      if (res.ok) {
        const json2 = await res.json();
        const groups = json2.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
        const todayGroup = groups.find((g) => g.dimensions?.date === today);
        const recent = groups.map((g) => ({
          day: g.dimensions?.date,
          neurons: Math.round((g.sum?.totalNeurons || 0) * 10) / 10,
          requests: g.count || 0
        }));
        return {
          isLive: true,
          accountWide: true,
          freePerDay: FREE_NEURONS_PER_DAY,
          today: {
            day: today,
            neurons: Math.round((todayGroup?.sum?.totalNeurons || 0) * 10) / 10,
            requests: todayGroup?.count || 0
          },
          recent
        };
      }
    }
  } catch (err) {
    console.warn("Failed fetching live Cloudflare Neuron analytics, falling back to local D1:", err);
  }
  const localUsage = await env.DB.prepare(
    "SELECT day, neurons, requests FROM usage ORDER BY day DESC LIMIT 7"
  ).all();
  return {
    isLive: false,
    accountWide: false,
    freePerDay: FREE_NEURONS_PER_DAY,
    today: localUsage.results.find((u) => u.day === today) ?? { day: today, neurons: 0, requests: 0 },
    recent: localUsage.results
  };
}

// src/persona.ts
function buildSystemPrompt(s, ctx) {
  const owner = s.ownerName?.trim() || "Vidmox Team";
  const lines = [
    `You are Nyra, Senior Sales Specialist and Client Partnerships Manager at Vidmox (https://vidmox.pages.dev).`,
    `You represent Vidmox and speak directly with agency owners, creators, and business leaders reaching out via WhatsApp.`,
    ``,
    `=== CRITICAL IDENTITY & HUMAN PERSONA RULES ===`,
    `1. ACT AS A REAL HUMAN: You are an authentic, friendly, and experienced sales professional at Vidmox. NEVER say, hint, or admit that you are an AI, bot, virtual assistant, language model, or automated system.`,
    `2. NO INTERNAL JARGON: NEVER mention "CRM", "our app", "our database", "logged in my system", or "saved in our sheet". Clients must never hear internal software terminology. Speak naturally: "I've noted that down", "I'll arrange that with our sales manager", "Let me check with our team".`,
    `3. NO ROBOTIC SIGNATURES: Do NOT attach rose emojis (\u{1F339}) or robotic sign-offs at the end of messages. Speak like a real human texting on WhatsApp.`,
    ``,
    `=== CALL BOOKING WORKFLOW ===`,
    `Our official call booking link is: https://calendly.com/armaan-gineus/30min (30-Minute Video Strategy Call).`,
    `\u2022 IF THE PROSPECT ASKS FOR THE BOOKING LINK:`,
    `  (e.g., "send me the link", "where can I book?", "booking link", "calendly link", "send link to schedule")`,
    `  -> Send the official booking link immediately and warmly:`,
    `     "Here's the direct link to book a 30-min strategy call with our sales team: https://calendly.com/armaan-gineus/30min"`,
    `     "Feel free to pick any slot that suits you best! Also, what's your best email and website so we can review your current videos beforehand?"`,
    `\u2022 IF THE PROSPECT DOES NOT EXPLICITLY ASK FOR A LINK:`,
    `  -> Guide the conversation naturally to collect their booking details so our sales manager can review and schedule it:`,
    `     1. Full Name`,
    `     2. Best Email Address`,
    `     3. Preferred Date & Time (e.g. "Tomorrow at 4pm", "Today 1:30pm")`,
    `     4. Timezone (automatically inferred from their phone number country code, e.g. +61 = Australian Time AEST, +880 = Bangladesh Time GMT+6, +44 = UK Time GMT, +1 = US Eastern Time EST, +91 = India Time IST, +971 = UAE Time GST)`,
    `     5. Website, YouTube channel, or Instagram link (to review their current video style)`,
    `     6. Video Requirements & Goals (Shorts/Reels, YouTube long-form, monthly volume)`,
    `\u2022 PHONE NUMBER TIMEZONE INFERENCE & CONFIRMATION RULE:`,
    `  - You automatically know the client's default timezone from their WhatsApp phone number country code (shown in your context).`,
    `  - When a client gives a time to book a call without stating a timezone, set the call in their phone-number timezone and confirm: "I've set your call for [Time] [Detected Timezone, e.g. Australian Time (AEST)] \u2014 please let me know if that timezone works for you, or if you prefer another time/timezone!"`,
    `  - If the client says "ok", "book this time", or doesn't say "no, another time", keep it booked for that time and timezone.`,
    `  - If the client says "no, another time" or specifies a different timezone (e.g. "no, 1:30 PM GMT" or "no, EST"), immediately confirm the updated time and timezone.`,
    `  - For any booked call, you will send a meeting reminder 30 minutes before the call (and no sales follow-ups).`,
    `\u2022 Proposing a call naturally:`,
    `  "I'd love to set up a quick 15-minute discovery call with our sales manager to discuss your requirements and tailor the best package for you. What day and time works best for you, and what's the best email and name to send the invite to?"`,
    `\u2022 When the client provides their time and email:`,
    `  Confirm naturally: "Got it, [Name]! I've set your call for [Preferred Time & Timezone] and noted [Email]. Please let me know if that timezone works or if you meant another timezone! I'll also send a quick reminder 30 minutes before our meeting."`,
    `\u2022 If the client gave their preferred time but forgot their email:`,
    `  Politely ask: "Perfect, I've set that for [Time & Timezone] (let me know if you prefer a different timezone)! What's the best email address for our manager to send the invite to?"`,
    `\u2022 If the client gave their email but no time:`,
    `  Politely ask: "Thanks! What day and time would be most convenient for you for a quick 15-minute call?"`,
    ``,
    `=== DYNAMIC STATUS-BASED BEHAVIOR & FOLLOW-UP RULES ===`,
    `Our sales executive / manager sets the client's lead status and follow-up strategy in our dashboard. Your conversation and follow-up style MUST adapt dynamically:`,
    ``,
    `1. *STATUS / STRATEGY: 'rejected' or 'not_interested' (Client Not Interested / Stopped)*:`,
    `   \u2022 Context: Client explicitly stated they are not interested, or our team marked them as rejected / not interested.`,
    `   \u2022 CRITICAL RULE: STRICTLY STOP ALL SALES FOLLOW-UPS. Do NOT pitch, push, or send promotional reminders.`,
    `   \u2022 If the client messages first, be polite, respectful, and brief ("Thank you for letting us know! If you ever need editing support down the road, feel free to reach out anytime."). Never pressure them.`,
    ``,
    `2. *STATUS / STRATEGY: 'on_hold' (Client on Hold / Will Book Later)*:`,
    `   \u2022 Context: Client asked to pause, is busy, or will decide later.`,
    `   \u2022 Tone: Warm, respectful, non-pushy.`,
    `   \u2022 Action: Gentle periodic check-in asking if they are ready to unpause or need any questions answered.`,
    `   \u2022 Example: "Hey [Name]! Just checking in to see if you're ready to unpause video editing with us or if you have any questions on how we work. Happy to help whenever you're ready!"`,
    ``,
    `3. *STATUS / STRATEGY: 'not_attended' (Missed Call / Did Not Attend)*:`,
    `   \u2022 Context: The client had a call scheduled but missed or did not show up.`,
    `   \u2022 Tone: Empathetic, polite, zero judgment or guilt.`,
    `   \u2022 Action: Follow up to reschedule. Ask what day and time works better for them. Sent daily or every couple of days.`,
    `   \u2022 Example: "Hey [Name], hope everything is okay! Sorry we missed each other on our scheduled call earlier today. Would you like to reschedule for tomorrow or later this week? Let me know what time works best for you."`,
    ``,
    `4. *STATUS / STRATEGY: 'buy_soon' (Buying in a Few Days / Deciding)*:`,
    `   \u2022 Context: Client expressed interest and mentioned they will decide or purchase in a few days.`,
    `   \u2022 Tone: Warm, helpful, consultative closing partner.`,
    `   \u2022 Action: Check in on their decision timeline and answer any lingering questions regarding packages, dedicated editors, or turnaround.`,
    `   \u2022 Example: "Hey [Name], hope you're having a productive week! Just following up to see if you had any questions on the Growth plan or if you're ready to get started. Happy to help whenever you're ready to roll!"`,
    ``,
    `5. *STATUS / STRATEGY: 'nurture' (Value & Portfolio Nurture)*:`,
    `   \u2022 Context: Lead wants to see more results or is not ready for an immediate call.`,
    `   \u2022 Action: Share relevant portfolio examples (https://vidmox.pages.dev/portfolio) and case studies.`,
    `   \u2022 Example: "Hey [Name]! Wanted to share a few recent edits we did for creators in your niche: https://vidmox.pages.dev/portfolio. Let me know if you'd like us to create a quick sample for your content!"`,
    ``,
    `6. *STATUS: 'booked' or 'confirmed'*:`,
    `   \u2022 Context: Call is scheduled or confirmed.`,
    `   \u2022 Action: Acknowledge the upcoming meeting and answer any quick preliminary questions.`,
    ``,
    `7. *STATUS: 'completed'*:`,
    `   \u2022 Context: Call was completed or client is signed up.`,
    `   \u2022 Action: Assist with onboarding via the intake brief link: https://vidmox.pages.dev/intake.`,
    ``,
    `=== BUSINESS OVERVIEW: VIDMOX ===`,
    `\u2022 What Vidmox is: A premier white-label video editing subscription service. We provide creators, agencies, and businesses with a dedicated video editor, dedicated project manager (PM), quality control (QC), and unlimited revisions \u2014 without hiring full-time.`,
    `\u2022 Official Website: https://vidmox.pages.dev (also https://vidmox.online)`,
    `\u2022 Official Booking URL: https://calendly.com/armaan-gineus/30min`,
    `\u2022 WhatsApp Support: +8801889755665 (https://wa.me/8801889755665)`,
    `\u2022 Portfolios:`,
    `  - General Portfolio: https://vidmox.pages.dev/portfolio`,
    `  - High-End Premium Portfolio: https://vidmox.pages.dev/premium-portfolio`,
    `\u2022 Intake Brief System: https://vidmox.pages.dev/intake (clients submit questions -> auto-generates structured PDF brief for PM & editors -> eliminates back-and-forth).`,
    `\u2022 Client Reviews: https://vidmox.pages.dev/reviews (4.9/5 stars, trusted by 120+ creators and agencies, average 24-hour turnaround on first drafts). Clients include Marcus Bennett (Bennett Media), Priya Raman (Lumen Studio), Oliver Grant (Northline Agency), Jordan Mills, Sana Qureshi, David Okafor.`,
    `\u2022 Capabilities & Services:`,
    `  - Short-form (Reels, TikTok, Shorts - hook-first cuts, trend pacing, vertical native)`,
    `  - Long-form (YouTube, courses, interviews - story structure, B-roll layering, clean audio mix)`,
    `  - YouTube Videos (retention edits, chapter markers, end screens, CTR thumbnails)`,
    `  - Talking Head Videos (filler removal, jump cuts, auto framing)`,
    `  - Podcast Editing (multi-cam sync, waveform cleanup, short-form extraction)`,
    `  - Facebook Videos (silent-first, aspect variants, Meta specs)`,
    `  - Motion Graphics (brand kits, animated titles, data viz)`,
    `  - Captions & Subtitles (word-level sync, brand styling, multi-language, SRT/VTT)`,
    `  - Thumbnail Design (CTR variants, A/B ready, brand safe)`,
    `  - Color Grading (LUT development, skin-tone accuracy, cross-cam match)`,
    `  - Sound Design (licensed music, custom SFX, broadcast levels)`,
    `  - YouTube Optimization (SEO metadata, chapters, playlist strategy)`,
    ``,
    `=== APPROVED PRICING PLANS (DO NOT INVENT PRICES) ===`,
    `1. *Kickstart / Paid Trial ($29)*: 1 trial video, unlimited revisions, 24/7 WhatsApp support. Try before committing to a monthly subscription (https://vidmox.pages.dev/29-video).`,
    `2. *Growth Plan ($490/mo)*: 25\u201330 short-form videos/month, 1 active request per day, dedicated PM, unlimited revisions, 24/7 WhatsApp & Slack. (Short-form only, not for long-form).`,
    `3. *Scale Plan ($890/mo)*: 55\u201360 short-form videos/month OR 6\u20138 long-form videos (up to 10\u201312 min each), 2 active requests per day, priority delivery, dedicated PM, unlimited revisions, WhatsApp & Slack.`,
    `4. *Advance Plan ($1,490/mo - Most popular for agencies)*: Up to 100 videos/month, 2 dedicated editors, 3 active requests, OR 10\u201312 long-form videos (up to 12\u201315 min each), priority queue, dedicated PM, unlimited revisions, WhatsApp & Slack.`,
    `5. *High-End Premium Editing ($2,499/mo)*: 50 premium videos or 5\u201310 high-end long-form, cinematic motion graphics, AI integration, 24\u201348h turnaround, premium B-roll (https://vidmox.pages.dev/premium-portfolio).`,
    `6. *Custom Packages / Agency Volume*: Tailored based on volume. Discussed directly on a call with our sales manager.`,
    ``,
    `=== SALES PLAYBOOK & HANDLING OBJECTIONS ===`,
    `1. *Consultative First*: Understand what type of videos they make (Shorts, YouTube, etc.) and volume before pushing a call.`,
    `2. *Sharing Work*: If they ask for samples, share https://vidmox.pages.dev/portfolio.`,
    `3. *Price Objections / Negotiation*:`,
    `   - Never negotiate price or promise discounts independently.`,
    `   - Reframe: "I completely understand! We do have custom options depending on your exact volume and scope. Let's arrange a quick 15-min call with our sales manager so we can tailor something that fits your budget perfectly."`,
    `4. *When Client Says They Are Busy or Will Book Later*:`,
    `   - Respect their time: "No problem at all! Whenever you're ready, feel free to drop your preferred day, time, and email right here or book directly at https://calendly.com/armaan-gineus/30min and I'll arrange everything for you."`,
    ``,
    `=== COMMUNICATION STYLE ===`,
    `\u2022 Tone: Professional, warm, clear, conversational. Like a trusted partner in a modern creative agency.`,
    `\u2022 Message Length: WhatsApp is fast. Keep messages short (1\u20133 concise sentences). Use line breaks for readability.`,
    `\u2022 Formatting: WhatsApp markdown only (*bold*, _italic_). NEVER use Markdown headers (###), HTML, or tables.`,
    `\u2022 Language: Match the lead's language naturally (English, \u09AC\u09BE\u0982\u09B2\u09BE, Banglish).`,
    ``,
    `Current date/time (UTC): ${ctx.now.toISOString()}.`
  ];
  if (ctx.bookingContext) {
    lines.push("", "Lead Booking & CRM Status Context:", ctx.bookingContext);
  }
  if (ctx.isGroup) {
    lines.push(
      `You are in a WhatsApp group${ctx.chatName ? ` called "${ctx.chatName}"` : ""}. Messages are prefixed with the sender's name. Only respond to the person who addressed you.`
    );
  }
  if (ctx.notes && ctx.notes.length > 0) {
    lines.push("", "Stored Notes & Context:", ...ctx.notes.map((n) => `- ${n}`));
  }
  if (ctx.todos && ctx.todos.length > 0) {
    lines.push("", "Active Tasks & To-Dos:", ...ctx.todos.map((t) => `- ${t}`));
  }
  if (ctx.guidelines && ctx.guidelines.length > 0) {
    lines.push("", "Rule Book Guidelines (Strictly Follow These):", ...ctx.guidelines.map((g) => `- ${g}`));
  }
  if (s.extraInstructions?.trim()) {
    lines.push("", `Custom instructions from ${owner}:`, s.extraInstructions.trim());
  }
  return lines.join("\n");
}

// src/providers/workers-ai.ts
var workersAi = {
  id: "workers-ai",
  async generate(env, opts) {
    const run = env.AI.run.bind(env.AI);
    const res = await run(opts.model, {
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature
    });
    const text = (res.response ?? res.choices?.[0]?.message?.content ?? res.choices?.[0]?.text ?? "").trim();
    if (!text) throw new Error(`Empty response from ${opts.model}`);
    return { text, provider: "workers-ai", model: opts.model, neurons: res.usage?.neurons };
  }
};

// src/providers/index.ts
var PROVIDERS = {
  [workersAi.id]: workersAi
};
function getProvider(id) {
  return PROVIDERS[id] ?? workersAi;
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  enabled: true,
  provider: "workers-ai",
  model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  publicModelName: "Nyra Rose Intelligence \u{1F339}",
  clientPassword: "rose2026",
  replyMode: "self",
  allowlist: [],
  groupsEnabled: false,
  triggerWords: ["nyra", "nyra rose", "\u09A8\u09BE\u0987\u09B0\u09BE", "rose"],
  historyLimit: 14,
  maxReplyTokens: 450,
  temperature: 0.7,
  ownerName: "",
  extraInstructions: ""
};
var MODELS = [
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B \u2014 ultra-fast, cheap, exceptional Bangla/English (Recommended \u{1F339})" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B \u2014 highest intelligence & deep reasoning" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B \u2014 sharp, concise, balanced" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B \u2014 ultra-lightweight, 0 latency" },
  { id: "@cf/qwen/qwen2.5-72b-instruct", label: "Qwen 2.5 72B \u2014 multilingual powerhouse" }
];
var KEY = "settings";
async function getSettings(env) {
  const stored = await kvGet(env, KEY);
  return { ...DEFAULT_SETTINGS, ...stored ?? {} };
}
async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = sanitize({ ...current, ...patch });
  await kvSet(env, KEY, next);
  return next;
}
function sanitize(s) {
  const clamp = (n, lo, hi, d) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  return {
    enabled: Boolean(s.enabled),
    provider: s.provider === "workers-ai" ? s.provider : "workers-ai",
    model: MODELS.some((m) => m.id === s.model) ? s.model : DEFAULT_SETTINGS.model,
    publicModelName: String(s.publicModelName ?? "").trim().slice(0, 80) || DEFAULT_SETTINGS.publicModelName,
    clientPassword: String(s.clientPassword ?? "").trim().slice(0, 100) || DEFAULT_SETTINGS.clientPassword,
    replyMode: ["self", "allowlist", "everyone"].includes(s.replyMode) ? s.replyMode : "self",
    allowlist: [...new Set((Array.isArray(s.allowlist) ? s.allowlist : []).map((p) => String(p).replace(/\D/g, "")).filter((p) => p.length >= 6))],
    groupsEnabled: Boolean(s.groupsEnabled),
    triggerWords: (Array.isArray(s.triggerWords) ? s.triggerWords : []).map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 20),
    historyLimit: Math.round(clamp(s.historyLimit, 0, 40, DEFAULT_SETTINGS.historyLimit)),
    maxReplyTokens: Math.round(clamp(s.maxReplyTokens, 50, 2e3, DEFAULT_SETTINGS.maxReplyTokens)),
    temperature: clamp(s.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature),
    ownerName: String(s.ownerName ?? "").slice(0, 80),
    extraInstructions: String(s.extraInstructions ?? "").slice(0, 4e3)
  };
}

// src/modules/commands.ts
async function handleCommand(env, chatId, text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = trimmed.slice(cmd.length + 2).trim();
  switch (cmd) {
    case "help":
    case "start": {
      const help = `*Nyra Rose* \u{1F339} _Your Personal AI Assistant_

Here is what I can do for you:

\u{1F4AC} *Conversation:* Just send any message (English, \u09AC\u09BE\u0982\u09B2\u09BE, Banglish) and I will respond.

\u{1F4DD} *Notes & Memory:*
\u2022 */note <text>* \u2014 Save a quick note or fact
\u2022 */notes* \u2014 View your saved notes
\u2022 */clearnotes* \u2014 Clear all notes

\u2705 *Tasks & To-Dos:*
\u2022 */todo <task>* \u2014 Add a new task
\u2022 */todos* \u2014 View your active tasks
\u2022 */done <number>* \u2014 Mark a task as completed

\u2699\uFE0F *Controls:*
\u2022 */status* \u2014 Check model & usage stats
\u2022 */reset* \u2014 Clear conversation history & start fresh
\u2022 */help* \u2014 Show this menu`;
      return { handled: true, reply: help };
    }
    case "reset":
    case "new": {
      await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chatId).run();
      return {
        handled: true,
        reply: "Our conversation has been cleared \u2014 a fresh rose petal awaits. \u2728\u{1F339}"
      };
    }
    case "note": {
      if (!args) {
        return { handled: true, reply: "Please provide a note to save! Example:\n*/note Remember to call Rafiq at 5 PM*" };
      }
      await createNote(env, chatId, args);
      return { handled: true, reply: `Saved note: "${args}" \u{1F4DD}` };
    }
    case "notes": {
      const notes = await getNotes(env, chatId);
      if (notes.length === 0) {
        return { handled: true, reply: "You don't have any saved notes yet. Use */note <text>* to add one! \u{1F4DD}" };
      }
      const list = notes.map((n, idx) => `${idx + 1}. ${n.content}`).join("\n");
      return { handled: true, reply: `*Your Notes:* \u{1F4DD}

${list}` };
    }
    case "clearnotes": {
      await clearNotes(env, chatId);
      return { handled: true, reply: "All your saved notes have been cleared. \u{1F5D1}\uFE0F" };
    }
    case "todo": {
      if (!args) {
        return { handled: true, reply: "Please specify what you need to do! Example:\n*/todo Submit motion graphics proposal*" };
      }
      await createTodo(env, chatId, args);
      return { handled: true, reply: `Added to-do: "${args}" \u2705` };
    }
    case "todos":
    case "tasks": {
      const todos = await getTodos(env, chatId);
      if (todos.length === 0) {
        return { handled: true, reply: "No active tasks! Add one with */todo <task>* \u2728" };
      }
      const list = todos.map((t, idx) => `${idx + 1}. [${t.completed ? "\u2713" : " "}] ${t.task}`).join("\n");
      return { handled: true, reply: `*Your Tasks:* \u2705

${list}` };
    }
    case "done": {
      if (!args) {
        return { handled: true, reply: "Please specify the task number! Example: */done 1*" };
      }
      const num = parseInt(args, 10);
      const todos = await getTodos(env, chatId);
      if (isNaN(num) || num < 1 || num > todos.length) {
        return { handled: true, reply: `Invalid task number. Check */todos* to see your current list.` };
      }
      const target = todos[num - 1];
      await toggleTodo(env, target.id, true);
      return { handled: true, reply: `Completed task: ~${target.task}~ \u{1F389}` };
    }
    case "status": {
      const settings = await getSettings(env);
      const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      const row = await env.DB.prepare("SELECT neurons, requests FROM usage WHERE day = ?").bind(today).first();
      const reqCount = row?.requests ?? 0;
      return {
        handled: true,
        reply: `*Nyra Rose Status* \u{1F339}

\u2022 *Brain:* ${settings.publicModelName || "Nyra Rose Intelligence \u{1F339}"}
\u2022 *Replies today:* ${reqCount}
\u2022 *Uptime:* Continuous 24/7 Cloud Relay \u26A1`
      };
    }
    default:
      return { handled: false };
  }
}

// src/brain.ts
function matchesTriggers(text, triggers) {
  const words = triggers.split(/[,;\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}
function shouldAnswer(s, m) {
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
async function handleIncoming(env, m) {
  const s = await getSettings(env);
  const verdict = shouldAnswer(s, m);
  if (!verdict.ok) return { action: "ignore", reason: verdict.reason };
  const { muted } = await upsertChat(env, m.chatId, m.chatName ?? m.senderName ?? null, m.isGroup);
  if (muted) return { action: "ignore", reason: "chat muted" };
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
    created_at: m.timestamp ?? Date.now()
  });
  if (!isNew) return { action: "ignore", reason: "duplicate delivery" };
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
      created_at: Date.now()
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }
  return generateReply(env, s, rules, {
    chatId: m.chatId,
    chatName: m.chatName ?? void 0,
    senderPhone: m.senderPhone ?? void 0,
    isGroup: m.isGroup,
    excludeId: msgId,
    userContent: m.isGroup && m.senderName ? `${m.senderName}: ${m.text}` : m.text,
    source: "whatsapp"
  });
}
async function handleDashboardChat(env, text) {
  const s = await getSettings(env);
  const chatId = "dashboard";
  await upsertChat(env, chatId, "Dashboard", false);
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
    created_at: Date.now()
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
      created_at: Date.now()
    });
    return { action: "reply", reply, model: "rulebook:instant", neurons: 0 };
  }
  return generateReply(env, s, rules, {
    chatId,
    chatName: "Dashboard Lead",
    senderPhone: void 0,
    isGroup: false,
    excludeId: msgId,
    userContent: text,
    source: "dashboard"
  });
}
var PHONE_PREFIX_TIMEZONES = [
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
  { prefix: "1", tz: { code: "EST", label: "US/Canada Eastern Time (EST, GMT-5)", country: "USA/Canada", offsetHours: -5 } }
];
function detectTimezoneFromPhone(phoneOrChatId) {
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
function getTimezoneOffsetHours(tz, phoneFallback) {
  const u = (tz || "").toUpperCase().trim();
  if (u) {
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
  return 6;
}
function formatTimeInTimezone(utcMs, tz, phoneFallback, nowMs = Date.now()) {
  const offsetHours = getTimezoneOffsetHours(tz, phoneFallback);
  const localMs = utcMs + offsetHours * 3600 * 1e3;
  const localNowMs = nowMs + offsetHours * 3600 * 1e3;
  const d = new Date(localMs);
  const nowD = new Date(localNowMs);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const timeStr = `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
  const sameDay = d.getUTCFullYear() === nowD.getUTCFullYear() && d.getUTCMonth() === nowD.getUTCMonth() && d.getUTCDate() === nowD.getUTCDate();
  const tmrwD = new Date(localNowMs + 24 * 3600 * 1e3);
  const isTomorrow = d.getUTCFullYear() === tmrwD.getUTCFullYear() && d.getUTCMonth() === tmrwD.getUTCMonth() && d.getUTCDate() === tmrwD.getUTCDate();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayPrefix = sameDay ? "Today" : isTomorrow ? "Tomorrow" : `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const tzLabel = (tz || detectTimezoneFromPhone(phoneFallback)?.code || "BDT").toUpperCase();
  return `${dayPrefix} ${timeStr} ${tzLabel}`;
}
function parseScheduledTimeToMs(phrase, timezone, nowMs = Date.now(), phoneFallback) {
  if (!phrase || !phrase.trim()) return null;
  const p = phrase.toLowerCase().replace(/\blatter\b/g, "later").replace(/(\d{1,2})\s*:\s*(\d{2})/g, "$1:$2").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(p)) {
    const parsed = Date.parse(phrase);
    if (!Number.isNaN(parsed) && parsed > nowMs - 864e5) return parsed;
  }
  const relMatch = p.match(/(?:in|after)?\s*(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day|week)s?(?:\s+later)?/i);
  if (relMatch) {
    const val = parseFloat(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    if (unit.startsWith("min")) return Math.round(nowMs + val * 60 * 1e3);
    if (unit.startsWith("hour") || unit.startsWith("hr")) return Math.round(nowMs + val * 3600 * 1e3);
    if (unit.startsWith("day")) return Math.round(nowMs + val * 24 * 3600 * 1e3);
    if (unit.startsWith("week")) return Math.round(nowMs + val * 7 * 24 * 3600 * 1e3);
  }
  const tzOffsetHours = getTimezoneOffsetHours(timezone, phoneFallback);
  const localNowMs = nowMs + tzOffsetHours * 3600 * 1e3;
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
  let hour = 15;
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
  let targetUtcMs = targetLocal.getTime() - tzOffsetHours * 3600 * 1e3;
  if (dayOffset === 0 && targetUtcMs <= nowMs - 15 * 60 * 1e3 && !p.includes("today")) {
    targetUtcMs += 24 * 3600 * 1e3;
  }
  return targetUtcMs;
}
function computeNextFollowupState(b, nowMs = Date.now()) {
  const curStatus = b.status || "lead";
  const curType = b.followup_type || "auto_day1";
  if (curType === "rejected" || curStatus === "not_interested" || curStatus === "fake_lead" || curStatus === "completed" || curStatus === "cancelled") {
    return {
      status: curStatus,
      followup_type: curType === "rejected" ? "rejected" : curType,
      next_followup_at: null,
      followup_interval_hours: 0
    };
  }
  if (curStatus === "booked" || curStatus === "confirmed") {
    const callMs = b.call_time_ms || parseScheduledTimeToMs(b.scheduled_at, b.timezone, nowMs, b.phone || b.chat_id);
    let reminderAt = null;
    if (callMs) {
      const thirtyMinBefore = callMs - 30 * 60 * 1e3;
      if (thirtyMinBefore > nowMs) {
        reminderAt = thirtyMinBefore;
      } else if (callMs > nowMs - 10 * 60 * 1e3 && (!b.last_followup_at || b.last_followup_at < thirtyMinBefore)) {
        reminderAt = nowMs + 5e3;
      }
    }
    return {
      status: curStatus,
      followup_type: "call_reminder",
      next_followup_at: reminderAt,
      followup_interval_hours: 0
    };
  }
  if (curType === "client_date" && b.next_followup_at && b.next_followup_at > nowMs) {
    return {
      status: curStatus,
      followup_type: "client_date",
      next_followup_at: b.next_followup_at,
      followup_interval_hours: b.followup_interval_hours ?? 24
    };
  }
  if (curType === "custom_timer" && b.next_followup_at && b.next_followup_at > nowMs) {
    return {
      status: curStatus,
      followup_type: "custom_timer",
      next_followup_at: b.next_followup_at,
      followup_interval_hours: b.followup_interval_hours ?? 2
    };
  }
  const lastReplyMs = b.last_client_reply_at || b.created_at || nowMs;
  const elapsedHours = (nowMs - lastReplyMs) / (3600 * 1e3);
  if (elapsedHours >= 24 * 30) {
    return {
      status: "fake_lead",
      followup_type: "rejected",
      next_followup_at: null,
      followup_interval_hours: 0
    };
  }
  if (elapsedHours >= 24 * 4) {
    return {
      status: curStatus,
      followup_type: "long_term_30d",
      next_followup_at: nowMs + 24 * 3600 * 1e3,
      followup_interval_hours: 24
    };
  }
  if (elapsedHours >= 24) {
    return {
      status: curStatus,
      followup_type: "no_reply_3d",
      next_followup_at: nowMs + 8 * 3600 * 1e3,
      followup_interval_hours: 8
    };
  }
  return {
    status: curStatus,
    followup_type: "auto_day1",
    next_followup_at: nowMs + 3.5 * 3600 * 1e3,
    followup_interval_hours: 3.5
  };
}
function normalizeTimezoneMention(rawTz) {
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
function extractBookingDetails(text, history) {
  const normalizedText = text.replace(/\blatter\b/gi, "later").replace(/(\d{1,2})\s*:\s*(\d{2})/g, "$1:$2");
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
  const phoneRegex = /(?:\+?\d{1,4}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/;
  const phoneMatch = normalizedText.match(phoneRegex);
  const phone = phoneMatch && phoneMatch[0].replace(/\D/g, "").length >= 7 ? phoneMatch[0].trim() : null;
  const nameRegex = /(?:my name is|i'm|i am|name[:\s]+)\s+([A-Z][a-z]+(?:\s+(?!from|at|with|the|and|here|of\b)[A-Z][a-z]+)?)/i;
  const nameMatch = normalizedText.match(nameRegex);
  const clientName = nameMatch ? nameMatch[1].trim() : null;
  const timePhraseRegex = /(?:(?:in|after)?\s*\d+(?:\.\d+)?\s*(?:hour|hr|minute|min|day|week)s?(?:\s+later)|(?:in|after)\s+\d+(?:\.\d+)?\s*(?:hour|hr|minute|min|day|week)s?|(?:next\s+)?(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:at\s+)?(?:\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|morning|evening|afternoon|noon|night))?|\b\d{1,2}:\d{2}\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i;
  const timePhraseMatch = normalizedText.match(timePhraseRegex);
  let time = null;
  if (timePhraseMatch) {
    const dayPrefixMatch = normalizedText.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    const rawMatched = timePhraseMatch[0].trim();
    if (dayPrefixMatch && !rawMatched.toLowerCase().includes(dayPrefixMatch[1].toLowerCase())) {
      time = `${dayPrefixMatch[1]} ${rawMatched}`;
    } else {
      time = rawMatched;
    }
  } else {
    const looseTime = /(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b\d{1,2}\s*(am|pm)\b|evening|morning|next week)/i;
    const looseMatch = normalizedText.match(looseTime);
    if (looseMatch) {
      const sentence = normalizedText.split(/[.?!,\n]/).find((s) => looseTime.test(s));
      time = sentence ? sentence.trim() : looseMatch[0].trim();
    }
  }
  const tzRegex = /\b((?:GMT|UTC)\s*[+-]\d{1,2}(?::\d{2})?|EST|PST|CST|MST|EDT|PDT|CDT|MDT|GMT|BST|BDT|UTC|CET|AEST|AEDT|AWST|ACST|NZST|IST|PKT|GST|AST|SGT|MYT|PHT|HKT|JST|KST|Australi(?:an|a)(?:\s+time(?:\s*zone)?)?|Sydney(?:\s+time)?|Melbourne(?:\s+time)?|Dhaka(?:\s+time)?|Bangladesh(?:\s+time)?|BD(?:\s+time)?|UK(?:\s+time)?|London(?:\s+time)?|India(?:\s+time)?|Pakistan(?:\s+time)?|Dubai(?:\s+time)?|UAE(?:\s+time)?|Eastern(?:\s+time)?|Pacific(?:\s+time)?|Central(?:\s+time)?)\b/i;
  const tzMatch = normalizedText.match(tzRegex);
  const timezone = tzMatch ? normalizeTimezoneMention(tzMatch[1]) : null;
  const textWithoutEmails = normalizedText.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "");
  const siteRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.(?:com|org|io|net|co|app|agency|tv|dev)|youtube\.com\/@[a-zA-Z0-9_.-]+|instagram\.com\/[a-zA-Z0-9_.-]+)/i;
  const siteMatch = textWithoutEmails.match(siteRegex);
  const companyOrWebsite = siteMatch ? siteMatch[0] : null;
  const lower = normalizedText.toLowerCase();
  const isRescheduleRequest = (Boolean(time) || Boolean(timezone)) && (lower.includes("change") || lower.includes("reschedule") || lower.includes("move") || lower.includes("shift") || lower.includes("instead") || lower.includes("postpone") || lower.includes("another time") || lower.includes("new time") || lower.startsWith("no ") || lower.startsWith("no,"));
  const isClientChoiceFollowup = Boolean(time) && !isRescheduleRequest && !lower.includes("book") && !lower.includes("call") && (lower.includes("follow up") || lower.includes("followup") || lower.includes("message me") || lower.includes("text me") || lower.includes("contact me") || lower.includes("reach out") || lower.includes("ping me") || lower.includes("remind me") || lower.includes("busy") || lower.includes("talk later") || lower.includes("check back"));
  const allUserText = [...history.filter((h) => h.role === "user").map((h) => h.content), normalizedText].join(" ").toLowerCase();
  const reqsList = [];
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
    isRescheduleRequest
  };
}
function generateFollowupText(b) {
  const name = b.client_name && b.client_name !== "New Lead" && b.client_name !== "Dashboard Lead" ? b.client_name.trim() : "there";
  const type = b.followup_type || "auto_day1";
  const count = b.followup_count || 0;
  if (type === "rejected" || b.status === "not_interested" || b.status === "fake_lead") {
    return null;
  }
  if (type === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
    let minsText = "30 minutes";
    if (b.call_time_ms && b.call_time_ms > Date.now()) {
      const diffMins = Math.max(1, Math.round((b.call_time_ms - Date.now()) / 6e4));
      if (diffMins <= 35) minsText = `${diffMins} minute${diffMins === 1 ? "" : "s"}`;
    }
    return `Hi ${name}! Just a quick reminder that you have your video strategy meeting with our team in ${minsText}${b.scheduled_at ? ` (${b.scheduled_at})` : ""}. Looking forward to speaking with you!`;
  }
  if (type === "auto_day1" || type === "auto") {
    const day1Templates = [
      `Hi ${name}! Just checking in to see if you had a chance to look at my previous message. Happy to help if you have any questions about our video editing services!`,
      `Hey ${name}! Are you still exploring video editing support for your content? Let me know what you're looking for, and I'll help you figure out the best next step.`,
      `Hi ${name}! Would you be available for a quick 15-minute call to discuss your video editing requirements? You can share a convenient time right here or book directly at https://calendly.com/armaan-gineus/30min`,
      `Hey ${name}! Just wanted to make sure my message didn't get buried. Whenever you're ready to chat about scaling your video content, let me know!`
    ];
    return day1Templates[count % day1Templates.length];
  }
  if (type === "no_reply_3d") {
    const day3Templates = [
      `Hey ${name}! Hope your week is going well. Just wanted to check if you're still looking for a dedicated video editing team to scale your content? Happy to answer any questions or set up a quick call!`,
      `Hi ${name}! Whenever you're ready to take video editing off your plate, we can start with a $29 trial edit or jump on a quick 15-minute call (https://calendly.com/armaan-gineus/30min). Let me know what works best for you!`,
      `Hey ${name}! Just checking in \u2014 are you still deciding which editing package would fit your workflow best? Happy to walk you through our Growth and Scale plans whenever you're free.`
    ];
    return day3Templates[count % day3Templates.length];
  }
  if (type === "long_term_30d") {
    const longTermTemplates = [
      `Hey ${name}! Wanted to share a few recent video edits we produced for creators and agencies in your space: https://vidmox.pages.dev/portfolio. Let me know if you'd like to try a sample edit!`,
      `Hi ${name}! Just checking in to see how your content pipeline is going this month. If you need extra editing capacity or want to test our dedicated team, feel free to reach out anytime!`,
      `Hey ${name}! Hope business is booming. If you're still looking to outsource your short-form or long-form video editing with a 24-hour turnaround, I'd love to help get you set up!`
    ];
    return longTermTemplates[count % longTermTemplates.length];
  }
  if (type === "client_date") {
    return `Hi ${name}! Hope you're doing well. You mentioned following up around today${b.scheduled_at ? ` (${b.scheduled_at})` : ""} \u2014 would now be a convenient time to arrange a quick call and discuss your video editing requirements?`;
  }
  if (type === "custom_timer" || type === "custom") {
    if (b.notes?.trim()) {
      return `Hey ${name}! Following up regarding ${b.notes.trim()}. Would you like to arrange a quick call or have any questions I can answer for you?`;
    }
    return `Hey ${name}! Following up as promised to see if you had any questions about our editing packages or if you're ready to schedule a quick strategy call? Happy to help!`;
  }
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
async function processDueFollowups(env) {
  const now = Date.now();
  const dueList = await getDueFollowups(env, now).catch(() => []);
  const outbound = [];
  for (const b of dueList) {
    const lastReplyMs = b.last_client_reply_at || b.created_at || now;
    const elapsedHours = (now - lastReplyMs) / (3600 * 1e3);
    if (b.status !== "booked" && b.status !== "confirmed" && b.followup_type !== "call_reminder" && elapsedHours >= 24 * 30) {
      await updateBooking(env, b.id, {
        status: "fake_lead",
        followup_type: "rejected",
        next_followup_at: null,
        followup_interval_hours: 0
      });
      continue;
    }
    const message = generateFollowupText(b);
    if (!message) {
      await updateBooking(env, b.id, { next_followup_at: null });
      continue;
    }
    const cleanPhone = (b.phone || (b.chat_id?.includes("@") ? b.chat_id.split("@")[0] : "")).replace(/[^0-9]/g, "");
    const jid = b.chat_id?.endsWith("@s.whatsapp.net") ? b.chat_id : cleanPhone.length >= 7 ? `${cleanPhone}@s.whatsapp.net` : null;
    let nextFollowupAt = null;
    let nextType = b.followup_type;
    let nextInterval = b.followup_interval_hours ?? 3.5;
    let nextStatus = b.status;
    if (b.followup_type === "call_reminder" || b.status === "booked" || b.status === "confirmed") {
      nextFollowupAt = null;
      nextType = "call_reminder";
      nextInterval = 0;
    } else if (elapsedHours >= 24 * 30) {
      nextStatus = "fake_lead";
      nextType = "rejected";
      nextFollowupAt = null;
      nextInterval = 0;
    } else if (elapsedHours >= 24 * 4) {
      nextType = "long_term_30d";
      nextInterval = 24;
      nextFollowupAt = now + 24 * 3600 * 1e3;
    } else if (elapsedHours >= 24) {
      nextType = "no_reply_3d";
      nextInterval = 8;
      nextFollowupAt = now + 8 * 3600 * 1e3;
    } else {
      nextType = "auto_day1";
      nextInterval = 3.5;
      nextFollowupAt = now + 3.5 * 3600 * 1e3;
    }
    await updateBooking(env, b.id, {
      status: nextStatus,
      followup_type: nextType,
      followup_interval_hours: nextInterval,
      last_followup_at: now,
      followup_count: (b.followup_count || 0) + 1,
      next_followup_at: nextFollowupAt
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
        created_at: now
      }).catch(() => {
      });
    }
  }
  return outbound;
}
async function generateReply(env, s, rules, c) {
  const [history, userNotes, userTodos] = await Promise.all([
    recentMessages(env, c.chatId, s.historyLimit, c.excludeId),
    getNotes(env, c.chatId).catch(() => []),
    getTodos(env, c.chatId, true).catch(() => [])
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
  const asksForBookingLink = lowerContent.includes("link") && (lowerContent.includes("call") || lowerContent.includes("book") || lowerContent.includes("meet") || lowerContent.includes("schedule") || lowerContent.includes("send")) || lowerContent.includes("calendly") || lowerContent.includes("where can i book") || lowerContent.includes("where to book");
  if (asksForBookingLink) {
    bookingContext += (bookingContext ? " " : "") + `The client is asking for the call booking link. Share the official booking link immediately: https://calendly.com/armaan-gineus/30min, and ask for their email and website so our sales team can review their content before the call.`;
  }
  const bookingInfo = extractBookingDetails(c.userContent, history);
  const computedName = bookingInfo.clientName || (c.chatName && c.chatName !== "Dashboard" ? c.chatName : null) || (c.senderPhone ? `+${c.senderPhone}` : null) || (bookingInfo.email ? bookingInfo.email.split("@")[0] : "New Lead");
  const computedPhone = bookingInfo.phone || c.senderPhone || null;
  const isBookingCallIntent = Boolean(bookingInfo.email) || existing?.status === "booked" && Boolean(bookingInfo.timezone) || Boolean(bookingInfo.time) && !bookingInfo.isClientChoiceFollowup && (lowerContent.includes("call") || lowerContent.includes("meet") || lowerContent.includes("book") || lowerContent.includes("schedule") || lowerContent.includes("slot") || lowerContent.includes("free") || lowerContent.includes("available") || lowerContent.includes("today") || lowerContent.includes("tomorrow") || existing?.status === "booked" || existing?.status === "confirmed");
  if (!c.isGroup) {
    try {
      if (isBookingCallIntent || bookingInfo.isRescheduleRequest) {
        const wasAlreadyBooked = Boolean(existing && (existing.status === "booked" || existing.status === "confirmed"));
        const useExplicitTz = Boolean(
          bookingInfo.timezone && (!phoneTz || wasAlreadyBooked || bookingInfo.isRescheduleRequest)
        );
        const effTz = useExplicitTz ? bookingInfo.timezone : phoneTz?.code || existing?.timezone || bookingInfo.timezone || "BDT";
        const tzDisplayName = useExplicitTz ? bookingInfo.timezone : phoneTz ? phoneTz.label : existing?.timezone || "Bangladesh Time (GMT+6)";
        const rawTimePhrase = bookingInfo.time || existing?.scheduled_at || null;
        const parsedCallMs = rawTimePhrase ? parseScheduledTimeToMs(rawTimePhrase, effTz, nowMs, computedPhone || c.chatId) : existing?.call_time_ms || null;
        const formattedScheduledAt = parsedCallMs ? formatTimeInTimezone(parsedCallMs, effTz, computedPhone || c.chatId, nowMs) : rawTimePhrase;
        let reminderAt = null;
        if (parsedCallMs) {
          const thirtyMinBefore = parsedCallMs - 30 * 60 * 1e3;
          if (thirtyMinBefore > nowMs) {
            reminderAt = thirtyMinBefore;
          } else if (parsedCallMs > nowMs) {
            reminderAt = nowMs + 1e4;
          } else {
            reminderAt = null;
          }
        }
        const effEmail = bookingInfo.email || existing?.email || null;
        const hasBooked = Boolean(formattedScheduledAt);
        if (existing) {
          const timeOrTzChanged = Boolean(
            bookingInfo.time && formattedScheduledAt !== existing.scheduled_at || useExplicitTz && bookingInfo.timezone !== existing.timezone
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
            next_followup_at: hasBooked ? reminderAt : nowMs + 3.5 * 3600 * 1e3,
            followup_interval_hours: hasBooked ? 0 : 3.5,
            last_client_reply_at: nowMs
          });
          if (wasAlreadyBooked && timeOrTzChanged) {
            bookingContext = `The client updated their call time/timezone to "${formattedScheduledAt}" (${tzDisplayName}). Confirm warmly that you have updated their booked call to ${formattedScheduledAt} and will send a reminder 30 minutes before the meeting. NEVER say "CRM", "app", or "database".`;
          } else if (effEmail && formattedScheduledAt) {
            const tzConfirmNote = phoneTz && !useExplicitTz ? ` Explicitly tell the client: "I've set your call for ${formattedScheduledAt} (${phoneTz.label}, based on your number) \u2014 please let me know if that timezone works for you, or if you prefer another time/timezone!"` : "";
            bookingContext = `The client has provided their name (${computedName}), email (${effEmail}), and meeting time (${formattedScheduledAt}). Confirm naturally that their call is booked for ${formattedScheduledAt}, our sales manager will send the calendar invite to ${effEmail}, and you'll send a reminder 30 minutes before the meeting.${tzConfirmNote}`;
          } else if (formattedScheduledAt && !effEmail) {
            const tzConfirmNote = phoneTz && !useExplicitTz ? ` Mention that you set it for ${formattedScheduledAt} (${phoneTz.label}, based on their number) and ask them to let you know if they prefer another time/timezone.` : "";
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
            next_followup_at: hasBooked ? reminderAt : nowMs + 3.5 * 3600 * 1e3,
            followup_interval_hours: hasBooked ? 0 : 3.5,
            last_client_reply_at: nowMs,
            source: c.source
          });
          if (effEmail && formattedScheduledAt) {
            const tzConfirmNote = phoneTz && !useExplicitTz ? ` Explicitly tell the client: "I've set your call for ${formattedScheduledAt} (${phoneTz.label}, based on your number) \u2014 please let me know if that timezone works for you, or if you prefer another time/timezone!"` : "";
            bookingContext = `The client provided their name (${computedName}), email (${effEmail}), and preferred time (${formattedScheduledAt}). Confirm naturally that you've booked their call for ${formattedScheduledAt} and noted ${effEmail}, and you'll remind them 30 minutes before the meeting.${tzConfirmNote}`;
          } else if (formattedScheduledAt && !effEmail) {
            const tzConfirmNote = phoneTz && !useExplicitTz ? ` Explicitly mention that you set it for ${formattedScheduledAt} (${phoneTz.label}, based on their number) and ask them to let you know if they prefer another time/timezone.` : "";
            bookingContext = `The client mentioned a preferred time (${formattedScheduledAt}).${tzConfirmNote} Ask what email address our manager should send the calendar invite to.`;
          } else if (effEmail && !formattedScheduledAt) {
            bookingContext = `The client provided their email (${effEmail}), but hasn't mentioned a time. Acknowledge their email and ask what day and time works best for a quick 15-minute call${phoneTz ? ` (in their ${phoneTz.label} timezone)` : ""}.`;
          }
        }
      } else if (bookingInfo.isClientChoiceFollowup && bookingInfo.time) {
        const effTz = bookingInfo.timezone || existing?.timezone || phoneTz?.code || "BDT";
        const targetFollowupMs = parseScheduledTimeToMs(bookingInfo.time, effTz, nowMs, computedPhone || c.chatId) || nowMs + 24 * 3600 * 1e3;
        const formattedFollowupTime = formatTimeInTimezone(targetFollowupMs, effTz, computedPhone || c.chatId, nowMs);
        if (existing) {
          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || existing.client_name,
            phone: computedPhone || existing.phone,
            email: bookingInfo.email || existing.email,
            scheduled_at: `Follow-up: ${formattedFollowupTime}`,
            timezone: effTz,
            followup_type: "client_date",
            next_followup_at: targetFollowupMs,
            last_client_reply_at: nowMs
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
            status: "lead",
            followup_type: "client_date",
            next_followup_at: targetFollowupMs,
            last_client_reply_at: nowMs,
            source: c.source
          });
        }
        bookingContext = `The client requested that you follow up with them at "${formattedFollowupTime}". Respect their schedule warmly, confirm that you'll reach back out to them at ${formattedFollowupTime}, and don't push for an immediate call right now.`;
      } else {
        if (existing) {
          const isBooked = existing.status === "booked" || existing.status === "confirmed";
          const isStopped = existing.followup_type === "rejected" || existing.status === "not_interested" || existing.status === "fake_lead";
          await updateBooking(env, existing.id, {
            client_name: bookingInfo.clientName || (existing.client_name === "New Lead" ? computedName : existing.client_name),
            phone: computedPhone || existing.phone,
            timezone: existing.timezone || phoneTz?.code || "BDT",
            company_or_website: bookingInfo.companyOrWebsite || existing.company_or_website,
            requirements: bookingInfo.requirements !== "Video Editing Consultation" ? bookingInfo.requirements : existing.requirements,
            last_client_reply_at: nowMs,
            // If lead hasn't booked and isn't stopped, reset to Day 1 Auto Follow-up (3.5 hours later)
            followup_type: isBooked ? "call_reminder" : isStopped ? existing.followup_type : "auto_day1",
            next_followup_at: isBooked ? existing.next_followup_at : isStopped ? null : nowMs + 3.5 * 3600 * 1e3,
            followup_interval_hours: isBooked ? 0 : 3.5
          });
        } else if (c.chatId !== "dashboard") {
          await createBooking(env, {
            chat_id: c.chatId,
            client_name: computedName,
            phone: computedPhone,
            email: null,
            scheduled_at: null,
            timezone: bookingInfo.timezone || phoneTz?.code || "BDT",
            company_or_website: bookingInfo.companyOrWebsite,
            requirements: bookingInfo.requirements,
            status: "lead",
            followup_type: "auto_day1",
            next_followup_at: nowMs + 3.5 * 3600 * 1e3,
            followup_interval_hours: 3.5,
            last_client_reply_at: nowMs,
            source: c.source
          });
        }
      }
    } catch (err) {
      console.warn("Failed updating lead / follow-up timer:", err);
    }
  }
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(s, {
        isGroup: c.isGroup,
        chatName: c.chatName,
        now: /* @__PURE__ */ new Date(),
        guidelines,
        notes: notesText,
        todos: todosText,
        bookingContext
      })
    },
    ...history.map((h) => ({
      role: h.role,
      content: c.isGroup && h.role === "user" && h.sender_name ? `${h.sender_name}: ${h.content}` : h.content
    })),
    { role: "user", content: c.userContent }
  ];
  try {
    const out = await getProvider(s.provider).generate(env, {
      model: s.model,
      messages,
      maxTokens: s.maxReplyTokens,
      temperature: s.temperature
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
        created_at: Date.now()
      }),
      addUsage(env, out.neurons)
    ]);
    return { action: "reply", reply: out.text, model: out.model, neurons: out.neurons };
  } catch (err) {
    console.error("AI generation failed", { model: s.model, error: String(err) });
    return { action: "reply", reply: "Sorry about that, my connection had a quick hiccup. Could you send that once more?" };
  }
}

// src/index.ts
var SESSION_KEY = "whatsapp/session.bin";
var GATEWAY_OFFLINE_AFTER_MS = 9e4;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/gw/")) return await gatewayRoutes(request, env, url);
      if (url.pathname.startsWith("/api/")) return await dashboardRoutes(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error", { path: url.pathname, error: String(err), stack: err?.stack });
      return json({ error: "Internal error" }, 500);
    }
  }
};
async function gatewayRoutes(request, env, url) {
  if (!await checkSecret(request, env.GATEWAY_TOKEN)) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "POST /gw/message": {
      const m = await request.json();
      if (!m?.id || !m?.chatId || typeof m.text !== "string") return json({ error: "Invalid message" }, 400);
      return json(await handleIncoming(env, m));
    }
    case "POST /gw/status": {
      const body = await request.json();
      const prev = await kvGet(env, "gateway");
      const next = {
        state: body.state,
        qr: body.state === "qr" ? body.qr ?? null : null,
        me: body.me ?? prev?.me ?? null,
        detail: body.detail ?? null,
        at: Date.now()
      };
      await kvSet(env, "gateway", next);
      const command = await kvGet(env, "gateway_command");
      if (command) await kvDelete(env, "gateway_command");
      let outbound = [];
      if (body.state === "open") {
        const [dueItems, manualQueue] = await Promise.all([
          processDueFollowups(env).catch(() => []),
          kvGet(env, "gateway_outbound_queue").catch(() => null)
        ]);
        if (dueItems.length > 0) outbound.push(...dueItems);
        if (manualQueue && manualQueue.length > 0) {
          outbound.push(...manualQueue);
          await kvDelete(env, "gateway_outbound_queue").catch(() => {
          });
        }
      }
      return json({ ok: true, command: command?.cmd ?? null, outbound });
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
async function dashboardRoutes(request, env, url) {
  const role = await getAuthRole(request, env);
  if (!role) return json({ error: "Unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/overview": {
      const [settings, gateway, usage] = await Promise.all([
        getSettings(env),
        kvGet(env, "gateway"),
        getLiveNeuronUsage(env)
      ]);
      const online = !!gateway && Date.now() - gateway.at < GATEWAY_OFFLINE_AFTER_MS;
      if (role === "client") {
        const clientSettings = {
          enabled: settings.enabled,
          provider: "workers-ai",
          model: settings.publicModelName || "Nyra Rose Intelligence \u{1F339}",
          modelLabel: settings.publicModelName || "Nyra Rose Intelligence \u{1F339}",
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
          extraInstructions: settings.extraInstructions
        };
        return json({
          name: "Nyra Rose",
          symbol: "\u{1F339}",
          role: "client",
          settings: clientSettings,
          models: [],
          gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
          usage: {
            isLive: false,
            accountWide: false,
            freePerDay: 0,
            today: {
              day: usage.today?.day || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
              neurons: 0,
              requests: usage.today?.requests || 0
            },
            recent: []
          }
        });
      }
      const activeModel = MODELS.find((m) => m.id === settings.model);
      return json({
        name: "Nyra Rose",
        symbol: "\u{1F339}",
        role: "admin",
        settings: {
          ...settings,
          modelLabel: activeModel ? activeModel.label.split("\u2014")[0].trim() : settings.model
        },
        models: MODELS,
        gateway: gateway ? { ...gateway, online } : { state: "never_connected", online: false },
        usage
      });
    }
    case "PUT /api/settings": {
      const patch = await request.json();
      if (role === "client") {
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
            model: saved.publicModelName || "Nyra Rose Intelligence \u{1F339}",
            modelLabel: saved.publicModelName || "Nyra Rose Intelligence \u{1F339}",
            clientPassword: ""
          }
        });
      }
      const activeModel = MODELS.find((m) => m.id === saved.model);
      return json({
        settings: {
          ...saved,
          modelLabel: activeModel ? activeModel.label.split("\u2014")[0].trim() : saved.model
        }
      });
    }
    case "POST /api/chat": {
      const { text } = await request.json();
      if (!text?.trim()) return json({ error: "Empty message" }, 400);
      const res = await handleDashboardChat(env, text.trim().slice(0, 4e3));
      if (role === "client" && "neurons" in res) {
        delete res.neurons;
        delete res.model;
      }
      return json(res);
    }
    case "GET /api/chats": {
      const { results } = await env.DB.prepare(
        `SELECT c.chat_id, c.name, c.is_group, c.muted, c.last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS message_count
         FROM chats c ORDER BY c.last_at DESC LIMIT 100`
      ).all();
      return json({ chats: results });
    }
    case "GET /api/messages": {
      const chat = url.searchParams.get("chat");
      if (!chat) return json({ error: "chat is required" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 200) ORDER BY created_at ASC"
      ).bind(chat).all();
      if (role === "client") {
        for (const row of results) {
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
      const { chat, muted } = await request.json();
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
            "User-Agent": "Nyra-Rose-Brain"
          },
          body: JSON.stringify({ ref: "main" })
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
      await env.BUCKET.delete(SESSION_KEY).catch(() => {
      });
      await kvSet(env, "gateway", {
        state: "logged_out",
        qr: null,
        me: null,
        detail: "WhatsApp unlinked by user. Scan new QR code to connect.",
        at: Date.now()
      });
      await kvSet(env, "gateway_command", { cmd: "logout" });
      return json({
        ok: true,
        note: "WhatsApp unlinked and session cleared! A fresh QR code will appear."
      });
    }
    case "GET /api/rules": {
      return json({ rules: await getRules(env) });
    }
    case "POST /api/rules": {
      const body = await request.json();
      if (!body?.triggers?.trim() || !body?.response?.trim()) return json({ error: "Triggers and response are required" }, 400);
      const rule = await createRule(env, body);
      return json({ rule });
    }
    case "PATCH /api/rules": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const rule = await updateRule(env, body.id, {
        enabled: body.enabled,
        triggers: body.triggers,
        response: body.response,
        type: body.type
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
      const chat = url.searchParams.get("chat") || void 0;
      return json({ notes: await getNotes(env, chat) });
    }
    case "POST /api/notes": {
      const body = await request.json();
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
      const chat = url.searchParams.get("chat") || void 0;
      return json({ todos: await getTodos(env, chat) });
    }
    case "POST /api/todos": {
      const body = await request.json();
      if (!body?.task?.trim()) return json({ error: "Task content required" }, 400);
      const todo = await createTodo(env, body.chatId || "dashboard", body.task, body.dueDate);
      return json({ todo });
    }
    case "PATCH /api/todos": {
      const body = await request.json();
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
      const status = url.searchParams.get("status") || void 0;
      const followupType = url.searchParams.get("followup_type") || void 0;
      return json({ bookings: await getBookings(env, status, followupType) });
    }
    case "POST /api/bookings": {
      const body = await request.json();
      const now = Date.now();
      const status = body.status || "booked";
      const rawType = body.followupType || body.followup_type || (status === "booked" ? "call_reminder" : "auto_day1");
      const effTz = body.timezone || detectTimezoneFromPhone(body.phone || body.chatId)?.code || "BDT";
      const callTimeMs = body.scheduledAt ? parseScheduledTimeToMs(body.scheduledAt, effTz, now, body.phone || body.chatId) : null;
      const formattedScheduledAt = callTimeMs ? formatTimeInTimezone(callTimeMs, effTz, body.phone || body.chatId, now) : body.scheduledAt;
      let nextFollowupAt = null;
      let intervalHours = 3.5;
      if (body.customFollowupAt) {
        const parsed = typeof body.customFollowupAt === "number" ? body.customFollowupAt : Date.parse(body.customFollowupAt);
        if (!Number.isNaN(parsed)) nextFollowupAt = parsed;
      } else if (body.delayHours && body.delayHours > 0) {
        intervalHours = body.delayHours;
        nextFollowupAt = Math.round(now + body.delayHours * 3600 * 1e3);
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
            last_client_reply_at: now
          },
          now
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
        notes: body.notes
      });
      return json({ booking });
    }
    case "PATCH /api/bookings": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(body.id).all();
      const existing = results?.[0];
      if (!existing) return json({ error: "Booking not found" }, 404);
      const now = Date.now();
      const patch = { ...body };
      const nextStatus = body.status ?? existing.status;
      const nextType = body.followup_type ?? existing.followup_type;
      const effTz = body.timezone ?? existing.timezone ?? detectTimezoneFromPhone(body.phone || existing.phone || existing.chat_id)?.code ?? "BDT";
      patch.timezone = effTz;
      if (body.scheduled_at !== void 0 && body.scheduled_at !== existing.scheduled_at || body.timezone !== void 0 && body.timezone !== existing.timezone) {
        const rawSched = body.scheduled_at ?? existing.scheduled_at;
        patch.call_time_ms = parseScheduledTimeToMs(rawSched, effTz, now, body.phone || existing.phone || existing.chat_id);
        if (patch.call_time_ms && !body.customFollowupAt) {
          patch.scheduled_at = formatTimeInTimezone(patch.call_time_ms, effTz, body.phone || existing.phone || existing.chat_id, now);
        }
        if (nextStatus === "booked" || nextStatus === "confirmed" || nextType === "call_reminder") {
          patch.followup_type = "call_reminder";
          if (patch.call_time_ms) {
            const thirtyBefore = patch.call_time_ms - 30 * 60 * 1e3;
            patch.next_followup_at = thirtyBefore > now ? thirtyBefore : patch.call_time_ms > now ? now + 1e4 : null;
          } else {
            patch.next_followup_at = null;
          }
          patch.followup_interval_hours = 0;
        }
      }
      if (body.delayHours !== void 0 && body.delayHours > 0) {
        patch.followup_interval_hours = body.delayHours;
        patch.next_followup_at = Math.round(now + body.delayHours * 3600 * 1e3);
        if (!body.followup_type) patch.followup_type = "custom_timer";
      } else if (body.customFollowupAt !== void 0) {
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
        if (nextType === "rejected" || nextStatus === "not_interested" || nextStatus === "fake_lead" || nextStatus === "completed" || nextStatus === "cancelled") {
          patch.next_followup_at = null;
          patch.followup_interval_hours = 0;
          if (nextStatus === "fake_lead" || nextStatus === "not_interested") {
            patch.followup_type = "rejected";
          }
        } else if (nextType === "call_reminder" || nextStatus === "booked" || nextStatus === "confirmed") {
          const cMs = patch.call_time_ms ?? existing.call_time_ms ?? parseScheduledTimeToMs(existing.scheduled_at, effTz, now, existing.phone || existing.chat_id);
          patch.call_time_ms = cMs;
          patch.followup_type = "call_reminder";
          if (cMs) {
            const thirtyBefore = cMs - 30 * 60 * 1e3;
            patch.next_followup_at = thirtyBefore > now ? thirtyBefore : cMs > now ? now + 1e4 : null;
          } else {
            patch.next_followup_at = null;
          }
          patch.followup_interval_hours = 0;
        } else if (nextType === "auto_day1") {
          patch.followup_interval_hours = 3.5;
          patch.next_followup_at = Math.round(now + 3.5 * 3600 * 1e3);
        } else if (nextType === "no_reply_3d") {
          patch.followup_interval_hours = 8;
          patch.next_followup_at = Math.round(now + 8 * 3600 * 1e3);
        } else if (nextType === "long_term_30d") {
          patch.followup_interval_hours = 24;
          patch.next_followup_at = Math.round(now + 24 * 3600 * 1e3);
        } else if (nextType === "on_hold" || nextType === "nurture") {
          patch.followup_interval_hours = 48;
          patch.next_followup_at = Math.round(now + 48 * 3600 * 1e3);
        } else if (nextType === "not_attended" || nextType === "buy_soon") {
          patch.followup_interval_hours = 24;
          patch.next_followup_at = Math.round(now + 24 * 3600 * 1e3);
        }
      }
      const booking = await updateBooking(env, body.id, patch);
      return json({ booking });
    }
    case "POST /api/bookings/followup": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(body.id).all();
      const b = results?.[0];
      if (!b) return json({ error: "Booking not found" }, 404);
      const now = Date.now();
      if (body.followupType && body.followupType !== b.followup_type) {
        b.followup_type = body.followupType;
        await updateBooking(env, b.id, { followup_type: body.followupType });
      }
      if (b.followup_type === "rejected" || b.status === "not_interested" || b.status === "fake_lead") {
        return json(
          {
            error: `Follow-ups are disabled for this lead (marked as ${b.status === "fake_lead" ? "Fake Lead" : "Rejected / Not Interested"}).`,
            disabled: true
          },
          400
        );
      }
      const generated = generateFollowupText(b);
      const message = body.customText?.trim() || generated;
      if (!message) {
        return json(
          {
            error: "Follow-up is disabled or not configured for this lead.",
            disabled: true
          },
          400
        );
      }
      const cleanPhone = (b.phone || b.chat_id?.split("@")[0] || "").replace(/[^0-9]/g, "");
      const waLink = cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}` : null;
      let updatedBooking = b;
      let queuedToGateway = false;
      if (body.sendViaGateway) {
        const jid = b.chat_id?.endsWith("@s.whatsapp.net") ? b.chat_id : cleanPhone.length >= 7 ? `${cleanPhone}@s.whatsapp.net` : null;
        if (!jid) {
          return json({ error: "No valid WhatsApp number on this lead to send directly." }, 400);
        }
        const existingQueue = await kvGet(env, "gateway_outbound_queue") || [];
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
          created_at: now
        }).catch(() => {
        });
        queuedToGateway = true;
      }
      if (body.markSent || body.sendViaGateway) {
        const nextCount = (b.followup_count || 0) + 1;
        const nextInterval = body.delayHours ?? b.followup_interval_hours ?? 3.5;
        const nextFollowupAt = b.followup_type === "call_reminder" ? null : nextInterval > 0 ? Math.round(now + nextInterval * 3600 * 1e3) : null;
        const patched = await updateBooking(env, b.id, {
          last_followup_at: now,
          followup_count: nextCount,
          next_followup_at: nextFollowupAt
        });
        if (patched) updatedBooking = patched;
      }
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
        lastFollowupAt: updatedBooking.last_followup_at
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
async function getAuthRole(request, env) {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given) return null;
  if (env.DASHBOARD_PASSWORD && await safeEqual(given, env.DASHBOARD_PASSWORD)) {
    return "admin";
  }
  const settings = await getSettings(env);
  const clientSecret = settings.clientPassword || "rose2026";
  if (clientSecret && await safeEqual(given, clientSecret)) {
    return "client";
  }
  return null;
}
async function checkSecret(request, secret) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(given, secret);
}
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
export {
  index_default as default
};
