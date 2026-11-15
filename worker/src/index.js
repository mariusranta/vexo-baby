// Baby timeline API. One Worker, one D1 database, one static page in ../public.
// The contract is in the README. Every /api/* call needs the header  x-key: <APP_KEY>
// (or ?k=<APP_KEY>) once the APP_KEY secret is set.

const TYPES = ['feed', 'diaper', 'sleep_start', 'sleep_end', 'cry_start', 'cry_end', 'soothe', 'medicine', 'note'];
const CARE = ['feed', 'diaper', 'soothe', 'sleep_start', 'medicine'];   // things a caretaker does that can end a cry
const MIN = 60000;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-key',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (env.APP_KEY && (request.headers.get('x-key') || url.searchParams.get('k')) !== env.APP_KEY) {
      return json({ error: 'wrong or missing key' }, 401);
    }
    try {
      return await route(request, url, env, ctx);
    } catch (problem) {
      console.error(problem);
      return json({ error: String(problem.message || problem) }, 500);
    }
  },
};

async function route(request, url, env, ctx) {
  const path = url.pathname.slice(4);
  const method = request.method;
  const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
  const tz = body.tz || url.searchParams.get('tz') || 'America/Los_Angeles';
  const now = Date.now();

  if (method === 'GET' && path === '/timeline') {
    const hours = Math.min(Number(url.searchParams.get('hours')) || 24, 168);
    return json({ now, events: await eventsSince(env, now - hours * 60 * MIN) });
  }
  if (method === 'GET' && path === '/status') return json(await status(env, ctx, now, tz));

  if (method === 'POST' && path === '/notes') {
    const text = String(body.text || '').trim().slice(0, 1000);
    if (!text) return json({ error: 'text is empty' }, 400);
    const { events: parsed, answer } = await parseNote(env, text, now, tz);
    const saved = [];
    for (const e of parsed) {
      saved.push(await insert(env, { ...e, source: body.source || 'phone', who: body.who, raw: text }));
    }
    const speak_id = answer ? await say(env, answer, now, text) : null;
    return json({ events: saved, answer: answer || null, speak_id });
  }
  if (method === 'POST' && path === '/band') {
    // The bridge calls this every few seconds: it is alive, how loud it is, and the words it is hearing right now.
    const old = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'band'").first())?.value || '{}');
    const band = { ...old, seen: now, name: body.name || old.name || null, loudness: body.loudness ?? old.loudness ?? null,
      cry_score: body.cry_score ?? null };
    if (typeof body.heard === 'string') Object.assign(band, { heard: body.heard.slice(0, 300), heard_at: now, heard_final: !!body.final });
    await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind('band', JSON.stringify(band)).run();
    return json({ ok: true });
  }
  if (path === '/clientlog') {
    // The phone page reports what its sound is doing, so a problem can be seen from the laptop.
    const lines = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'clientlog'").first())?.value || '[]');
    if (method === 'GET') return json({ lines });
    lines.push(`${clock(now, tz)} ${String(body.msg || '').slice(0, 300)}`);
    await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind('clientlog', JSON.stringify(lines.slice(-25))).run();
    return json({ ok: true });
  }
  if (method === 'POST' && path === '/events') {
    if (!TYPES.includes(body.type)) return json({ error: 'type must be one of ' + TYPES.join(' ') }, 400);
    const event = await insert(env, { ...body, at: Number(body.at) || now, source: body.source || 'api' });
    let speak_id = null;
    if (body.type === 'cry_start') {
      speak_id = await say(env, cryWords(facts(await eventsSince(env, now - 48 * 60 * MIN), now)), now, null, 'cry');
    }
    return json({ event, speak_id });
  }
  if (method === 'DELETE' && path.startsWith('/events/')) {
    await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(Number(path.slice(8))).run();
    return json({ ok: true });
  }
  if (method === 'POST' && path === '/ask') {
    const question = String(body.question || '').trim().slice(0, 500);
    if (!question) return json({ error: 'question is empty' }, 400);
    const f = facts(await eventsSince(env, now - 48 * 60 * MIN), now);
    const out = await llmJson(env,
      'You answer a caretaker\'s question about a baby from the log below. One or two short plain sentences. ' +
      'It will be read aloud: say "ounces", not "oz". Use only the facts and the log. If they do not say, say so. Never give medical advice beyond "call the parent or a doctor".',
      `Time now: ${clock(now, tz)}\n\nFacts right now (already worked out; copy these durations word for word):\n${factsText(f)}\n\nLog (oldest first):\n${logLines(f.events, now, tz)}\n\nQuestion: ${question}`,
      { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false });
    return json({ answer: out.answer, speak_id: await say(env, out.answer, now, question) });
  }
  if (method === 'GET' && path === '/speech') {
    // The newest answer as sound (Deepgram text to speech). The phone page plays it.
    // ?text=... says those words (the page uses it to test the phone's sound); otherwise the newest answer.
    const asked = (url.searchParams.get('text') || '').slice(0, 300);
    const speak = asked ? { text: asked }
      : JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'speak'").first())?.value || 'null');
    if (!speak) return json({ error: 'nothing to say' }, 404);
    if (!env.DEEPGRAM_API_KEY) return json({ error: 'DEEPGRAM_API_KEY is not set on the Worker' }, 500);
    const sound = await fetch('https://api.deepgram.com/v1/speak?model=' + (env.VOICE || 'aura-2-thalia-en'), {
      method: 'POST',
      headers: { authorization: 'Token ' + env.DEEPGRAM_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text: speak.text }),
    });
    if (!sound.ok) return json({ error: 'deepgram status ' + sound.status }, 502);
    return new Response(sound.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', ...CORS } });
  }
  if (method === 'POST' && path === '/reset') {
    await env.DB.batch([env.DB.prepare('DELETE FROM events'), env.DB.prepare("DELETE FROM meta WHERE key NOT IN ('band', 'clientlog')")]);
    if (body.seed) for (const e of demoDay(now)) await insert(env, e);
    return json({ ok: true, seeded: !!body.seed });
  }
  return json({ error: 'no such endpoint' }, 404);
}

// ---------------------------------------------------------------- storage

/** Something for the phone to say out loud. The page sees a new id in /status and plays /speech. */
async function say(env, text, now, question = null, kind = 'answer') {
  const speak = { id: now, text: String(text).slice(0, 400), question: question ? String(question).slice(0, 300) : null, kind };
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind('speak', JSON.stringify(speak)).run();
  return speak.id;
}

/** What the wristband says by itself when crying starts: the likely need, with the fact behind it. */
function cryWords(f) {
  const s = f.summary, r = ruleGuess(f);
  const why = r.cause === 'hungry' && s.last_feed_minutes_ago !== null ? `She last ate ${spoken(s.last_feed_minutes_ago)} ago.`
    : r.cause === 'tired' && s.awake_minutes !== null ? `She has been awake for ${spoken(s.awake_minutes)}.`
    : r.cause === 'needs a diaper change' && s.last_diaper_minutes_ago !== null ? `Her last diaper change was ${spoken(s.last_diaper_minutes_ago)} ago.`
    : 'She was fed, changed and rested not long ago.';
  const need = r.cause === 'hungry' ? 'she is probably hungry' : r.cause === 'tired' ? 'she is probably tired'
    : r.cause === 'needs a diaper change' ? 'she probably needs a diaper change' : 'she probably wants comfort';
  return `She is crying, and ${need}. ${why} Try this first: ${r.try_first.charAt(0).toLowerCase() + r.try_first.slice(1)}.`;
}

async function eventsSince(env, since) {
  const { results } = await env.DB.prepare('SELECT * FROM events WHERE at >= ? ORDER BY at ASC, id ASC').bind(since).all();
  return results;
}

async function insert(env, e) {
  const row = {
    at: Math.round(e.at), type: e.type, amount: e.amount ?? null, unit: e.unit ?? null,
    detail: e.detail ?? null, source: e.source ?? null, who: e.who ?? null, raw: e.raw ?? null,
  };
  const done = await env.DB.prepare(
    'INSERT INTO events (at, type, amount, unit, detail, source, who, raw) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
    .bind(row.at, row.type, row.amount, row.unit, row.detail, row.source, row.who, row.raw).first();
  return { id: done.id, ...row };
}

// ---------------------------------------------------------------- spoken note -> events

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: TYPES.filter((t) => !t.startsWith('cry_')) },
          minutes_ago: { type: 'number' },
          amount: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'] },
          detail: { type: 'string' },
        },
        required: ['type', 'minutes_ago', 'amount', 'unit', 'detail'],
        additionalProperties: false,
      },
    },
    answer: { type: ['string', 'null'] },
  },
  required: ['events', 'answer'],
  additionalProperties: false,
};

const NOTE_RULES = `You turn what a caretaker said about a baby into log events. Speech-to-text may have small mistakes; read through them.
Types:
- feed: bottle, breast or solids. amount and unit if said (4 oz, 120 ml, 15 min).
- diaper: detail is "wet", "dirty" or "wet and dirty".
- sleep_start: fell asleep, down for a nap. sleep_end: woke up.
- soothe: something done to calm the baby (rocking, pacifier, swaddle, held, walk, burped). detail names it.
- medicine: detail names it, amount and unit if said.
- note: anything else worth keeping (mood, fever, rash, a message for the next caretaker).
minutes_ago: how long ago it happened. 0 if it is happening now or no time was said. If a clock time was said, work it out from the time now.
detail: a few plain words, no full sentence. One note can hold several events. If nothing in it is about the baby or its care (small talk, "hello", testing the device), return no events.

answer: you are also the voice of the baby's wristband. Fill it in only when the words hold a question that the log can help with:
- a question to you about the baby ("when did she last eat?", "how long has she been up?", "why is she crying?"), or
- a caretaker asking the baby what it needs ("are you hungry?", "are you tired, sweetie?", "what's wrong?"). Answer for the baby from the log: "Probably, yes. She last ate 2 hours 50 minutes ago and usually eats every 3 hours."
One or two short sentences that sound natural read aloud: no lists, no symbols, "ounces" not "oz". Take every duration from "Facts right now" exactly as written there; never work one out yourself from clock times. Use only the facts and the log. Never medical advice beyond "call her parent or a doctor".
A question is never an event: when the words are only a question, events is empty.
Otherwise answer is null: for plain notes, small talk, questions about anything else, and whenever you are unsure the question is about the baby.
If the words only repeat what the wristband itself just said (given below), return no events and a null answer.`;

async function parseNote(env, text, now, tz) {
  try {
    const f = facts(await eventsSince(env, now - 48 * 60 * MIN), now);
    const spoke = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'speak'").first())?.value || 'null');
    const out = await llmJson(env, NOTE_RULES,
      `Time now: ${clock(now, tz)}\nFacts right now (already worked out; copy these durations word for word in an answer):\n${factsText(f)}\n\n` +
      `Log, last entries (oldest first):\n${logLines(f.events.slice(-25), now, tz)}\n` +
      (spoke && now - spoke.id < 90000 ? `The wristband itself just said: "${spoke.text}"\n` : '') +
      `\nThe caretaker said: "${text}"`, NOTE_SCHEMA);
    const events = (out.events || []).filter((e) => TYPES.includes(e.type)).map((e) => ({
      type: e.type, at: now - Math.max(0, Math.min(Number(e.minutes_ago) || 0, 2880)) * MIN,
      amount: typeof e.amount === 'number' ? e.amount : null, unit: e.unit || null, detail: e.detail || null,
    }));
    return { events, answer: typeof out.answer === 'string' && out.answer.trim() ? out.answer.trim() : null };
  } catch (problem) {
    console.error('note parser fell back to keywords:', problem.message);
  }
  // No model, or it failed: keywords, so a note is never lost.
  const t = text.toLowerCase();
  const amount = t.match(/(\d+(?:\.\d+)?)\s*(oz|ounces?|ml|minutes?|min)/);
  const type = /\b(fed|feed|ate|bottle|nurs|ounce|oz|milk|formula)/.test(t) ? 'feed'
    : /\b(diaper|poop|pee|changed)/.test(t) ? 'diaper'
    : /\b(woke|awake)/.test(t) ? 'sleep_end'
    : /\b(asleep|nap|sleeping|down for)/.test(t) ? 'sleep_start'
    : /\b(rock|pacifier|swaddl|held|burp)/.test(t) ? 'soothe' : 'note';
  return { events: [{ type, at: now, amount: amount ? Number(amount[1]) : null, unit: amount ? amount[2].replace(/ounces?/, 'oz') : null, detail: text }], answer: null };
}

// ---------------------------------------------------------------- facts from the log

function facts(events, now) {
  const last = (type) => events.findLast((e) => e.type === type) || null;
  const ago = (e) => (e ? Math.round((now - e.at) / MIN) : null);
  const cryStart = last('cry_start'), cryEnd = last('cry_end');
  const crying = !!cryStart && (!cryEnd || cryEnd.at < cryStart.at);
  const sleepStart = last('sleep_start'), sleepEnd = last('sleep_end');
  const asleep = !!sleepStart && (!sleepEnd || sleepEnd.at < sleepStart.at);

  const dayStart = now - 24 * 60 * MIN;
  let sleepMin = 0, open = null;
  for (const e of events) {
    if (e.type === 'sleep_start') open = e.at;
    if (e.type === 'sleep_end' && open !== null) { sleepMin += (e.at - Math.max(open, dayStart)) / MIN; open = null; }
  }
  if (open !== null) sleepMin += (now - Math.max(open, dayStart)) / MIN;

  const feeds = events.filter((e) => e.type === 'feed');
  const gaps = feeds.slice(1).map((e, i) => (e.at - feeds[i].at) / MIN).filter((g) => g > 30).sort((a, b) => a - b);
  const usualFeedGap = gaps.length >= 2 ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;

  // Past cries, and what the caretaker did that ended each one. This is the "learning" part.
  const episodes = [];
  let start = null;
  for (const e of events) {
    if (e.type === 'cry_start') start = e;
    if (e.type === 'cry_end' && start) {
      const care = events.filter((c) => CARE.includes(c.type) && c.at >= start.at - 2 * MIN && c.at <= e.at + 2 * MIN);
      episodes.push({
        at: start.at, minutes: Math.max(1, Math.round((e.at - start.at) / MIN)),
        calmed_by: care.length ? care[care.length - 1].type + (care[care.length - 1].detail ? ` (${care[care.length - 1].detail})` : '') : null,
      });
      start = null;
    }
  }

  const feed = last('feed');
  const summary = {
    crying, crying_minutes: crying ? ago(cryStart) : null,
    asleep, asleep_minutes: asleep ? ago(sleepStart) : null,
    awake_minutes: asleep ? null : ago(sleepEnd),
    last_feed_minutes_ago: ago(feed), last_feed_amount: feed?.amount ?? null, last_feed_unit: feed?.unit ?? null,
    last_diaper_minutes_ago: ago(last('diaper')), last_diaper: last('diaper')?.detail ?? null,
    usual_feed_gap_minutes: usualFeedGap,
    feeds_24h: feeds.filter((e) => e.at >= dayStart).length,
    sleep_minutes_24h: Math.round(sleepMin),
    cries_24h: events.filter((e) => e.type === 'cry_start' && e.at >= dayStart).length,
  };
  return { events, summary, episodes, lastId: events.reduce((m, e) => Math.max(m, e.id), 0) };
}

// A guess from plain rules. Always available, instant, and the fallback when the model is slow or down.
function ruleGuess(f) {
  const s = f.summary;
  const feedGap = s.usual_feed_gap_minutes || 180;
  const options = [
    { cause: 'hungry', score: s.last_feed_minutes_ago === null ? 0.5 : s.last_feed_minutes_ago / feedGap,
      try_first: 'Offer a feed',
      why: s.last_feed_minutes_ago === null ? 'No feed in the log yet'
        : `Last fed ${span(s.last_feed_minutes_ago)} ago${s.last_feed_amount ? ` (${s.last_feed_amount} ${s.last_feed_unit || ''})`.replace(' )', ')') : ''}; usual gap is about ${span(feedGap)}` },
    { cause: 'tired', score: s.awake_minutes === null ? 0.3 : s.awake_minutes / 105,
      try_first: 'Dim the room and try a nap',
      why: s.awake_minutes === null ? 'No sleep in the log yet' : `Awake for ${span(s.awake_minutes)}` },
    { cause: 'needs a diaper change', score: s.last_diaper_minutes_ago === null ? 0.4 : s.last_diaper_minutes_ago / 180,
      try_first: 'Check the diaper',
      why: s.last_diaper_minutes_ago === null ? 'No diaper change in the log yet' : `Last diaper ${span(s.last_diaper_minutes_ago)} ago` },
  ].sort((a, b) => b.score - a.score);
  const top = options[0];
  const calmed = f.episodes.filter((e) => e.calmed_by).slice(-3).map((e) => e.calmed_by);
  const evidence = options.map((o) => o.why);
  if (calmed.length) evidence.push('Calmed before by: ' + [...new Set(calmed)].join(', '));
  if (top.score < 0.6) {
    return { cause: 'wants comfort', confidence: 'low', try_first: calmed.length ? `Try what worked before: ${calmed[calmed.length - 1]}` : 'Hold and rock',
      evidence, by: 'rules' };
  }
  return { cause: top.cause, confidence: top.score > 1 && top.score - options[1].score > 0.3 ? 'high' : top.score > 0.8 ? 'medium' : 'low',
    try_first: top.try_first, evidence, by: 'rules' };
}

const REASON_SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string' }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    try_first: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['cause', 'confidence', 'try_first', 'evidence'],
  additionalProperties: false,
};

async function modelGuess(env, f, now, tz, key) {
  const out = await llmJson(env,
    `A baby is crying or may cry soon. From the log, say the most likely reason and what the caretaker should try first.
cause: two or three plain words (hungry, tired, needs a diaper change, wants comfort, gas, unclear).
try_first: one short action. Prefer what calmed this baby before in a similar situation.
evidence: two to four short facts from the log with numbers ("Last fed 2 h 50 min ago, usual gap 3 h").
confidence: high only when one cause clearly stands out. You are not a doctor: never name an illness.
If the cry has lasted over 20 minutes and nothing in the log explains it, say so and suggest calling the parent.`,
    `Time now: ${clock(now, tz)}\nSummary: ${JSON.stringify(f.summary)}\nPast cries and what ended them: ${JSON.stringify(
      f.episodes.slice(-8).map((e) => ({ when: clock(e.at, tz), minutes: e.minutes, calmed_by: e.calmed_by })))}\n\nLog (oldest first):\n${logLines(f.events.slice(-40), now, tz)}`,
    REASON_SCHEMA);
  const reason = { ...out, evidence: (out.evidence || []).slice(0, 4), by: 'model' };
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind('reason', JSON.stringify({ key, reason })).run();
}

async function status(env, ctx, now, tz) {
  const f = facts(await eventsSince(env, now - 48 * 60 * MIN), now);
  let reason = ruleGuess(f);
  // The model's answer is worked out in the background, once per new event (and every 10 minutes), so this call stays fast.
  const key = `${f.lastId}:${Math.floor(now / (10 * MIN))}`;
  const cached = await env.DB.prepare("SELECT value FROM meta WHERE key = 'reason'").first();
  const saved = cached ? JSON.parse(cached.value) : null;
  if (saved?.key === key && saved.reason) reason = saved.reason;
  else if (saved?.key !== key && f.events.length) {
    await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind('reason', JSON.stringify({ key, reason: null })).run();
    ctx.waitUntil(modelGuess(env, f, now, tz, key).catch((p) => console.error('model guess failed:', p.message)));
  }
  const b = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'band'").first())?.value || '{}');
  const band = {
    online: !!b.seen && now - b.seen < 12000, name: b.name || null, seen_seconds_ago: b.seen ? Math.round((now - b.seen) / 1000) : null,
    loudness: b.loudness ?? null, cry_score: b.cry_score ?? null, heard: b.heard || null, heard_final: !!b.heard_final,
    heard_seconds_ago: b.heard_at ? Math.round((now - b.heard_at) / 1000) : null,
  };
  const spoke = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'speak'").first())?.value || 'null');
  const speak = spoke && now - spoke.id < 5 * MIN ? { id: spoke.id, text: spoke.text, question: spoke.question || null, kind: spoke.kind || 'answer', seconds_ago: Math.round((now - spoke.id) / 1000) } : null;
  return { now, ...f.summary, reason, episodes: f.episodes.slice(-5), band, speak };
}

// ---------------------------------------------------------------- the model

async function llmJson(env, instructions, input, schema) {
  if (env.OPENAI_API_KEY) {
    const answer = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-6-luna', store: false, instructions, input,
        text: { format: { type: 'json_schema', name: 'answer', strict: true, schema } },
      }),
    });
    if (!answer.ok) throw new Error('openai status ' + answer.status);
    const data = await answer.json();
    const text = (data.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
    return JSON.parse(text);
  }
  // No OpenAI key set: Cloudflare's own model, so the app works before the team key arrives.
  const out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }],
    response_format: { type: 'json_schema', json_schema: schema },
    max_tokens: 700,
  });
  return typeof out.response === 'string' ? JSON.parse(out.response) : out.response;
}

// ---------------------------------------------------------------- words

/** The facts as sentences ready to be read aloud, so the model copies durations instead of working them out. */
function factsText(f) {
  const s = f.summary, r = ruleGuess(f);
  const lines = [
    s.last_feed_minutes_ago === null ? 'No feed is in the log.'
      : `Last feed: ${spoken(s.last_feed_minutes_ago)} ago${s.last_feed_amount ? `, ${s.last_feed_amount} ${unitWord(s.last_feed_unit)}` : ''}.`,
    s.usual_feed_gap_minutes ? `She usually eats about every ${spoken(Math.round(s.usual_feed_gap_minutes / 15) * 15)}.` : '',
    s.asleep ? `She is asleep, for ${spoken(s.asleep_minutes)} now.` : s.awake_minutes !== null ? `She has been awake for ${spoken(s.awake_minutes)}.` : '',
    s.last_diaper_minutes_ago === null ? 'No diaper change is in the log.' : `Last diaper change: ${spoken(s.last_diaper_minutes_ago)} ago (${s.last_diaper || 'no detail'}).`,
    `Sleep in the last 24 hours: ${spoken(s.sleep_minutes_24h)}. Feeds in the last 24 hours: ${s.feeds_24h}. Times she cried: ${s.cries_24h}.`,
    s.crying ? `She is crying now, for ${spoken(Math.max(1, s.crying_minutes))}.` : 'She is not crying now.',
    `Most likely need right now: ${r.cause} (${r.confidence} confidence). Try first: ${r.try_first}.`,
    f.episodes.filter((e) => e.calmed_by).length ? 'What ended her last cries: ' + f.episodes.filter((e) => e.calmed_by).slice(-3).map((e) => e.calmed_by).join('; ') + '.' : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function spoken(minutes) {
  const m = Math.max(0, Math.round(minutes)), h = Math.floor(m / 60), r = m % 60;
  const hours = h ? `${h} hour${h > 1 ? 's' : ''}` : '', mins = r || !h ? `${r} minute${r === 1 ? '' : 's'}` : '';
  return [hours, mins].filter(Boolean).join(' ');
}

const unitWord = (u) => ({ oz: 'ounces', ml: 'milliliters', min: 'minutes' }[String(u || '').toLowerCase()] || u || '');

function clock(ms, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

function span(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

function logLines(events, now, tz) {
  return events.map((e) =>
    `${clock(e.at, tz)} (${span((now - e.at) / MIN)} ago) ${e.type}` +
    `${e.amount != null ? ` ${e.amount}${e.unit ? ' ' + e.unit : ''}` : ''}${e.detail ? ` - ${e.detail}` : ''}${e.who ? ` [${e.who}]` : ''}`).join('\n') || '(empty)';
}

// A believable day that ends just before a feed is due, for the demo. Times are minutes before now.
function demoDay(now) {
  const day = [
    [690, 'sleep_end', null, null, 'woke for the day', 'Mom'],
    [680, 'feed', 4, 'oz', 'bottle', 'Mom'],
    [670, 'diaper', null, null, 'wet', 'Mom'],
    [590, 'sleep_start', null, null, 'nap', 'Mom'],
    [520, 'sleep_end', null, null, 'woke up', 'Mom'],
    [512, 'cry_start', null, null, null, null],
    [508, 'feed', 4, 'oz', 'bottle', 'Mom'],
    [506, 'cry_end', null, null, null, null],
    [495, 'diaper', null, null, 'dirty', 'Mom'],
    [400, 'cry_start', null, null, null, null],
    [396, 'soothe', null, null, 'pacifier and rocking', 'Dad'],
    [393, 'cry_end', null, null, null, null],
    [385, 'sleep_start', null, null, 'nap', 'Dad'],
    [325, 'sleep_end', null, null, 'woke up', 'Dad'],
    [338 - 15, 'cry_start', null, null, null, null],
    [320, 'feed', 5, 'oz', 'bottle', 'Dad'],
    [318, 'cry_end', null, null, null, null],
    [300, 'diaper', null, null, 'wet', 'Dad'],
    [215, 'sleep_start', null, null, 'nap', 'Dad'],
    [175, 'sleep_end', null, null, 'woke up', 'Grandma'],
    [170, 'feed', 4, 'oz', 'bottle', 'Grandma'],
    [160, 'diaper', null, null, 'wet', 'Grandma'],
    [115, 'sleep_start', null, null, 'nap', 'Grandma'],
    [60, 'sleep_end', null, null, 'woke up', 'Grandma'],
    [55, 'diaper', null, null, 'wet', 'Grandma'],
    [15, 'note', null, null, 'chewing on her hands', 'Grandma'],
  ];
  return day.map(([ago, type, amount, unit, detail, who]) => ({ at: now - ago * MIN, type, amount, unit, detail, who, source: 'seed' }));
}
