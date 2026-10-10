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
  await env.DB.prepare(
    `INSERT INTO bookings (id, chat_id, client_name, phone, email, scheduled_at, timezone, company_or_website, requirements, status, followup_type, source, notes, last_followup_at, followup_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?)`
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
    next.notes,
    next.last_followup_at,
    next.followup_count,
    id
  ).run();
  return next;
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
    `     3. Preferred Date & Time (e.g. "Tomorrow at 4pm", "Monday afternoon")`,
    `     4. Timezone (e.g. EST, GMT, PST, BST, or city/country)`,
    `     5. Website, YouTube channel, or Instagram link (to review their current video style)`,
    `     6. Video Requirements & Goals (Shorts/Reels, YouTube long-form, monthly volume)`,
    `\u2022 Proposing a call naturally:`,
    `  "I'd love to set up a quick 15-minute discovery call with our sales manager to discuss your requirements and tailor the best package for you. What day and time works best for you, and what's the best email and name to send the invite to?"`,
    `\u2022 When the client provides their time and email:`,
    `  Confirm naturally: "Got it, [Name]! I've noted down [Email] and [Preferred Time]. Our sales manager will review our schedule and send over the calendar invite shortly. Looking forward to speaking!"`,
    `\u2022 If the client gave their preferred time but forgot their email:`,
    `  Politely ask: "Perfect, [Time] sounds great! What's the best email address for our manager to send the invite to?"`,
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
function extractBookingDetails(text, history) {
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
  const phoneRegex = /(?:\+?\d{1,4}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/;
  const phoneMatch = text.match(phoneRegex);
  const phone = phoneMatch && phoneMatch[0].replace(/\D/g, "").length >= 7 ? phoneMatch[0].trim() : null;
  const nameRegex = /(?:my name is|i'm|i am|name[:\s]+)\s+([A-Z][a-z]+(?:\s+(?!from|at|with|the|and|here|of\b)[A-Z][a-z]+)?)/i;
  const nameMatch = text.match(nameRegex);
  const clientName = nameMatch ? nameMatch[1].trim() : null;
  const timePhraseRegex = /(?:(?:next\s+)?(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|morning|evening|afternoon|noon|night))?|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b(?:\s*[A-Z]{2,4})?|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i;
  const timePhraseMatch = text.match(timePhraseRegex);
  let time = null;
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
  const tzRegex = /\b(EST|PST|CST|MST|EDT|PDT|CDT|MDT|GMT|BST|UTC|CET|AEST|Dhaka(?:\s+time)?|BD(?:\s+time)?)\b/i;
  const tzMatch = text.match(tzRegex);
  const timezone = tzMatch ? tzMatch[0].toUpperCase() : null;
  const siteRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.(?:com|org|io|net|co|app|agency|tv)|youtube\.com\/@[a-zA-Z0-9_.-]+|instagram\.com\/[a-zA-Z0-9_.-]+)/i;
  const siteMatch = text.match(siteRegex);
  const companyOrWebsite = siteMatch ? siteMatch[0] : null;
  const allUserText = [...history.filter((h) => h.role === "user").map((h) => h.content), text].join(" ").toLowerCase();
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
  if (allUserText.includes("premium") || allUserText.includes("1590") || allUserText.includes("1,590")) {
    reqsList.push("Premium Tier ($1,590/mo)");
  }
  const requirements = reqsList.length > 0 ? reqsList.join(", ") : "Video Editing Consultation";
  return { email, phone, time, timezone, companyOrWebsite, requirements, clientName };
}
function generateFollowupText(b) {
  const name = b.client_name?.trim() || "there";
  const type = b.followup_type || "auto";
  if (type === "rejected" || b.status === "not_interested") {
    return null;
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
  if (type === "custom") {
    if (b.notes?.trim()) {
      return `Hey ${name}! Following up regarding ${b.notes.trim()}. Would you like to arrange a quick call or have any questions I can answer for you?`;
    }
    return `Hey ${name}! Hope your week is going great. Just following up to see how your video content plans are coming along? Happy to help whenever you're ready!`;
  }
  switch (b.status) {
    case "booked":
      return `Hi ${name}! Looking forward to our call${b.scheduled_at ? ` on ${b.scheduled_at}` : ""}! Please let me know if you need to adjust the time or have any questions beforehand.`;
    case "completed":
      return `Hi ${name}! Great speaking with you on the call. Whenever you're ready with your first footage or project brief, you can submit it directly at https://vidmox.pages.dev/intake or send it over right here!`;
    default:
      return `Hey ${name}! Just following up to see if you're still looking for video editing support for your content? Happy to help figure out the best next step or arrange a quick call!`;
  }
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
  const existing = await findLatestBookingForChat(env, c.chatId).catch(() => null);
  let bookingContext = "";
  if (existing) {
    if (existing.followup_type === "rejected" || existing.status === "not_interested") {
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
  const asksForBookingLink = lowerContent.includes("link") && (lowerContent.includes("call") || lowerContent.includes("book") || lowerContent.includes("meet") || lowerContent.includes("schedule") || lowerContent.includes("send")) || lowerContent.includes("calendly") || lowerContent.includes("where can i book") || lowerContent.includes("where to book");
  if (asksForBookingLink) {
    bookingContext += (bookingContext ? " " : "") + `The client is asking for the call booking link. Share the official booking link immediately: https://calendly.com/armaan-gineus/30min, and ask for their email and website so our sales team can review their content before the call.`;
  }
  const bookingInfo = extractBookingDetails(c.userContent, history);
  if (bookingInfo.email || bookingInfo.time && (lowerContent.includes("call") || lowerContent.includes("meet") || lowerContent.includes("book") || lowerContent.includes("schedule"))) {
    try {
      const computedName = bookingInfo.clientName || (c.chatName && c.chatName !== "Dashboard" ? c.chatName : null) || (c.senderPhone ? `+${c.senderPhone}` : null) || (bookingInfo.email ? bookingInfo.email.split("@")[0] : "New Lead");
      const computedPhone = bookingInfo.phone || c.senderPhone || null;
      if (existing) {
        const nextStatus = existing.status === "not_interested" ? "booked" : (bookingInfo.email || existing.email) && (bookingInfo.time || existing.scheduled_at) ? "booked" : existing.status;
        await updateBooking(env, existing.id, {
          client_name: bookingInfo.clientName || (existing.client_name === "New Lead" || existing.client_name === "Dashboard Lead" ? computedName : existing.client_name),
          phone: computedPhone || existing.phone,
          email: bookingInfo.email || existing.email,
          scheduled_at: bookingInfo.time || existing.scheduled_at,
          timezone: bookingInfo.timezone || existing.timezone,
          company_or_website: bookingInfo.companyOrWebsite || existing.company_or_website,
          requirements: bookingInfo.requirements || existing.requirements,
          status: nextStatus
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
          timezone: bookingInfo.timezone,
          company_or_website: bookingInfo.companyOrWebsite,
          requirements: bookingInfo.requirements,
          status: "booked",
          followup_type: "auto",
          source: c.source
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
        notes: body.notes
      });
      return json({ booking });
    }
    case "PATCH /api/bookings": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const booking = await updateBooking(env, body.id, body);
      return json({ booking });
    }
    case "POST /api/bookings/followup": {
      const body = await request.json();
      if (!body?.id) return json({ error: "id is required" }, 400);
      const { results } = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(body.id).all();
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
            disabled: true
          },
          400
        );
      }
      const message = generateFollowupText(b);
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
      if (body.markSent) {
        const nextCount = (b.followup_count || 0) + 1;
        const now = Date.now();
        const patched = await updateBooking(env, b.id, {
          last_followup_at: now,
          followup_count: nextCount
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
