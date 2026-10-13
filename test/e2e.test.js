// End-to-end simulation: runs every Code node body + every SQL function against a
// real Postgres, with Gemini / Telegram / RSS / Gmail responses mocked.
// usage: PGURL=postgres://postgres@/dispatch_test?host=/tmp node test/e2e.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Client } = require(process.env.PG_MODULE || 'pg');

const ROOT = path.join(__dirname, '..');
const LIB = fs.readFileSync(path.join(ROOT, 'src/lib.js'), 'utf8');
const body = (f) => LIB + '\n' + fs.readFileSync(path.join(ROOT, 'src/nodes', f + '.js'), 'utf8');

// ---- tiny n8n Code-node emulator ----
const wrap = (arr) => arr.map((j) => ({ json: j }));
function runCode(file, { input = [], nodes = {}, eachItem = null }) {
  const $ = (name) => {
    if (!(name in nodes)) throw new Error('no node ' + name);
    const items = wrap([].concat(nodes[name]));
    return { first: () => items[0], all: () => items, item: items[eachItem ?? 0] };
  };
  const $input = { first: () => wrap(input)[0], all: () => wrap(input) };
  if (eachItem !== null) {
    const fn = new Function('$input', '$', '$json', 'console', body(file));
    return fn($input, $, input[eachItem], { log() {} });
  }
  const fn = new Function('$input', '$', 'console', body(file));
  return fn($input, $, { log() {} });
}

function runRaw(file, input, nodes) {
  const $ = (n) => ({ first: () => wrap([].concat(nodes[n]))[0], all: () => wrap([].concat(nodes[n])) });
  return new Function('$input', '$', fs.readFileSync(path.join(ROOT, 'src/nodes', file + '.js'), 'utf8'))({ first: () => wrap(input)[0], all: () => wrap(input) }, $);
}
let db;
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const setClock = (ts) => q("UPDATE config SET value=$1 WHERE key='clock_override'", [ts]);
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };

// ---- fixtures ----
function rssItems(prefix, n, extra = []) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const W = ['Razorpay', 'Zepto', 'Meesho', 'Ola Electric', 'CRED', 'PhonePe', 'Swiggy', 'Groww', 'Lenskart', 'Byjus', 'Nykaa', 'Zerodha'];
    const V = ['raises Series D led by Tiger', 'faces RBI scrutiny over lending', 'cuts 300 jobs in restructuring', 'files DRHP ahead of IPO', 'launches AI copilot for merchants', 'enters quick commerce in tier-2 cities', 'posts first profitable quarter', 'acquires logistics startup'];
    const h = (prefix.length * 7 + i * 5) % W.length, v = (prefix.length * 3 + i * 3) % V.length;
    out.push({ title: `${W[h]} ${V[v]} (${prefix} ${i})`,
      link: `https://${prefix.toLowerCase()}.com/story-${i}?utm_source=rss&utm_medium=feed`,
      contentSnippet: `<p>Summary of ${prefix} story ${i}. Crore rupees and founders.</p>`, isoDate: '2026-10-05T03:00:00.000Z' });
  }
  return out.concat(extra);
}
function geminiWrap(obj) { return { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '```json\n' + JSON.stringify(obj) + '\n```' }] } }] }; }

(async () => {
  db = new Client({ connectionString: process.env.PGURL });
  await db.connect();
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await q(fs.readFileSync(path.join(ROOT, 'sql/schema.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(ROOT, 'sql/seed.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(ROOT, 'sql/addon_web.sql'), 'utf8'));
  await q(fs.readFileSync(path.join(ROOT, 'sql/addon_features.sql'), 'utf8'));
  for (const f of ['addon_demo', 'addon_issue_pages', 'addon_newsapi', 'addon_voice', 'addon_pipeline_view', 'addon_more', 'addon_images'])
    await q(fs.readFileSync(path.join(ROOT, 'sql', f + '.sql'), 'utf8'));
  await q("UPDATE config SET value='111' WHERE key='telegram_chat_id'");
  await q("UPDATE config SET value='https://n8n.example.com' WHERE key='public_base_url'");
  await q("UPDATE config SET value='5' WHERE key='daily_send_cap'"); // tiny cap to exercise multi-day sending
  await q("UPDATE config SET value='3' WHERE key='send_batch_size'");
  await q("INSERT INTO subscribers (email, name) SELECT 'reader'||g||'@example.com', 'Reader '||g FROM generate_series(1,8) g");

  // =========== WEEK 1: INGEST (Mon) ===========
  console.log('\n[1] Ingest + dedup');
  await setClock('2026-10-05 10:00+05:30');
  const sources = await q('SELECT id, name, kind, url FROM sources WHERE active ORDER BY id');
  const feeds = runCode('ingest_build_urls', { input: sources }).map((x) => x.json);
  ok(feeds.find((f) => f.kind === 'gnews').feed_url.startsWith('https://news.google.com/rss/search?q='), 'gnews query becomes RSS URL');

  const feedData = {
    1: rssItems('Inc42', 8),
    2: rssItems('Entrackr', 6, [
      // same story as Inc42 #0 with a slightly different headline -> near duplicate
      { title: rssItems('Inc42', 1)[0].title.replace('(Inc42 0)', '') + 'report', link: 'https://entrackr.com/dup-story', contentSnippet: 'dup', isoDate: '2026-10-05T04:00:00Z' },
      // same URL as Inc42 #1 but different tracking params -> exact duplicate
      { title: 'whatever title here long enough', link: 'https://www.inc42.com/story-1?utm_campaign=x', contentSnippet: '', isoDate: '2026-10-05T04:00:00Z' },
      // stale
      { title: 'A very old story that should be ignored entirely', link: 'https://entrackr.com/old', isoDate: '2026-08-01T00:00:00Z' },
    ]),
    3: [{ error: { message: 'getaddrinfo ENOTFOUND yourstory.com' } }],
    10: [{ title: 'Zepto files DRHP for public listing in Mumbai - Moneycontrol', link: 'https://news.google.com/rss/articles/abc', isoDate: '2026-10-05T05:00:00Z' }],
  };
  for (const f of feeds) {
    const items = feedData[f.source_id] || [{}]; // alwaysOutputData -> one empty item
    const [norm] = runCode('ingest_normalize', { input: items, nodes: { 'Loop feeds': f } });
    const res = (await one('SELECT ingest_batch($1) AS result', [norm.json.b64])).result;
    if (f.source_id === 2) ok(res.new === 6 && res.duplicate === 1 && res.already_seen === 1 && res.too_old === 1, `Entrackr: 6 new, 1 near-dup, 1 exact dup, 1 stale (${JSON.stringify(res)})`);
    if (f.source_id === 3) ok(res.error && res.error.includes('ENOTFOUND'), 'feed errors recorded, loop continues');
  }
  const gn = await one("SELECT title, source_name FROM articles WHERE url LIKE 'https://news.google.com%'");
  ok(gn.title === 'Zepto files DRHP for public listing in Mumbai' && gn.source_name === 'Moneycontrol', 'Google News publisher suffix split off');
  ok((await one("SELECT last_error FROM sources WHERE id=3")).last_error.includes('ENOTFOUND'), 'source health shows error');
  // re-run same feed -> nothing new
  const [again] = runCode('ingest_normalize', { input: feedData[1], nodes: { 'Loop feeds': feeds[0] } });
  ok((await one('SELECT ingest_batch($1) AS result', [again.json.b64])).result.already_seen === 8, 'second fetch of same feed inserts nothing');

  // Tuesday: more articles
  await setClock('2026-10-06 10:00+05:30');
  for (const f of feeds.filter((x) => x.source_id === 4)) {
    const [norm] = runCode('ingest_normalize', { input: rssItems('Medianama', 6), nodes: { 'Loop feeds': f } });
    await one('SELECT ingest_batch($1) AS result', [norm.json.b64]);
  }

  // =========== WEEK 1: SELECT (Wed 15:00) ===========
  console.log('\n[2] Selection + commentary');
  await setClock('2026-10-07 15:00+05:30');
  const ctx = (await one('SELECT build_selection_context() AS ctx')).ctx;
  ok(ctx.candidate_count === 19, `19 unique candidates (got ${ctx.candidate_count})`);
  const dupCand = ctx.candidates.find((c) => c.title === rssItems('Inc42', 1)[0].title);
  ok(dupCand.coverage === 3, 'coverage counts the near-duplicate outlets');
  const [sp] = runCode('select_build_prompt', { input: [{ ctx }] });
  ok(sp.json.request.generationConfig.responseSchema.properties.picks, 'selection request uses JSON schema');
  ok(sp.json.model === 'gemini-3.8-flash', 'model from config');

  // Gemini returns 12 picks, all one topic, with a bogus id and a duplicate -> must be repaired
  const ids = ctx.candidates.map((c) => c.id);
  const sel = {
    picks: [{ id: 999999, topic: 'Fintech', reason: 'bogus' }, ...ids.slice(0, 12).map((id) => ({ id, topic: 'Fintech', reason: 'r' + id })), { id: ids[0], topic: 'Fintech', reason: 'dup' }],
    alternates: ids.slice(12, 20).map((id, i) => ({ id, topic: ['Policy & Regulation', 'AI & Deep Tech', 'funding & vc', 'Made Up Topic'][i % 4], reason: 'alt' + id })),
  };
  const [val] = runCode('select_validate', { input: [geminiWrap(sel)], nodes: { 'Load context': { ctx } } });
  const s = val.json.selection;
  ok(s.picks.length === 10, `trimmed to 10 picks (got ${s.picks.length})`);
  ok(new Set(s.picks.map((p) => p.topic)).size >= 3, `topic diversity repaired to ≥3 (${[...new Set(s.picks.map((p) => p.topic))].join(', ')})`);
  ok(!s.picks.some((p) => p.id === 999999), 'invalid ids dropped');
  ok([...s.picks, ...s.alternates].some((p) => p.topic === 'Funding & VC') && ![...s.picks, ...s.alternates].some((p) => p.topic === 'Made Up Topic'), 'topics normalised to taxonomy');
  ok(new Set([...s.picks, ...s.alternates].map((p) => p.id)).size === s.picks.length + s.alternates.length, 'no id in both picks and alternates');
  ok(s.alternates.length === 6, 'alternates capped at num_alternates');

  // Gemini fails to return enough -> clear error
  assert.throws(() => runCode('select_validate', { input: [geminiWrap({ picks: ids.slice(0, 3).map((id) => ({ id, topic: 'Fintech', reason: '' })), alternates: [] })], nodes: { 'Load context': { ctx } } }), /only 3 usable picks/);
  ok(true, 'too-few picks raises a clear error (→ error workflow alerts Shreya)');
  assert.throws(() => runCode('select_build_prompt', { input: [{ ctx: { ...ctx, candidate_count: 3 } }] }), /Only 3 fresh candidate/);
  ok(true, 'too few candidates raises a clear error');

  const all = [...s.picks, ...s.alternates];
  const commentary = { items: all.filter((_, i) => i !== 1).map((p) => ({ id: p.id, commentary: `Commentary for ${p.id}. It matters because of reasons & <tags>.` })) };
  const [merged] = runCode('select_merge', { input: [geminiWrap(commentary)], nodes: { 'Validate selection': val.json, 'Load context': { ctx } } });
  const draft = (await one('SELECT save_draft($1) AS r', [merged.json.b64])).r;
  ok(draft.items.length === 10 && draft.alternates_left === 6, 'draft saved: 10 items + 6 alternates');
  ok(draft.items.some((i) => i.commentary === ''), 'missing commentary is kept empty (flagged in Telegram)');

  const msgs = runCode('select_tg_messages', { input: [{ r: draft }], nodes: { 'Load context': { ctx }, 'Merge commentary': merged.json } }).map((m) => m.json);
  ok(msgs.length === 12, 'header + 10 stories + approve footer');
  ok(msgs[1].body.text.includes('&lt;tags&gt;') && msgs[1].body.parse_mode === 'HTML', 'telegram text HTML-escaped');
  ok(msgs[0].body.text.includes('some stories have no commentary'), 'warning surfaced in header');
  ok(msgs[11].body.reply_markup.inline_keyboard[0][0].callback_data === `a:${draft.issue.id}`, 'approve button carries issue id');
  ok(msgs.every((m) => m.body.text.length <= 4096), 'all messages within Telegram limit');
  const tgResp = msgs.map((m, i) => ({ ok: true, result: { message_id: 500 + i } }));
  const [col] = runCode('select_collect_ids', { input: tgResp, nodes: { 'Build Telegram messages': msgs } });
  ok(col.json.recorded === 10, 'message ids paired to items');
  await one('SELECT record_telegram_ids($1) AS n', [col.json.b64]);

  // regenerate replaces in_review draft
  const draft2 = (await one('SELECT save_draft($1) AS r', [merged.json.b64])).r;
  ok(draft2.issue.id === draft.issue.id && draft2.items.length === 10, 're-running selection replaces the in-review draft');
  const col2 = runCode('select_collect_ids', { input: tgResp, nodes: { 'Build Telegram messages': runCode('select_tg_messages', { input: [{ r: draft2 }], nodes: { 'Load context': { ctx }, 'Merge commentary': merged.json } }).map((m) => m.json) } });
  await one('SELECT record_telegram_ids($1) AS n', [col2[0].json.b64]);

  // =========== REVIEW via Telegram ===========
  console.log('\n[3] Telegram review');
  const cfg = (await one('SELECT d_config_json() AS cfg')).cfg;
  async function tg(update, pageHtml) {
    const dec = runCode('review_decide', { nodes: { 'Load config': { cfg }, 'Telegram Trigger': update } });
    if (!dec.length) return { calls: [] };
    const page = pageHtml ? { data: pageHtml } : { error: { message: 'Invalid URL' } };
    const info = runRaw('review_pageinfo', [page], { 'Decide action': dec[0].json })[0].json;
    const r = (await one('SELECT review_apply_more($1) AS r', [info.b64])).r;
    const calls = runCode('review_render', { input: [{ r }], nodes: { 'Decide action': dec[0].json, 'Load config': { cfg } } }).map((c) => c.json);
    return { r, calls };
  }
  const cb = (data, chat = 111, mid = 501) => ({ update_id: 1, callback_query: { id: 'cbq' + data, data, message: { message_id: mid, chat: { id: chat } } } });
  const txt = (text, chat = 111) => ({ update_id: 2, message: { message_id: 900, chat: { id: chat }, text } });
  let items = draft2.items;

  let t = await tg(cb('k:' + items[0].item_id, 999));
  ok(t.calls.some((c) => c.body.text && c.body.text.includes('Your chat ID is <code>999</code>')), 'stranger gets "private bot" + their chat id, no action taken');
  ok((await one('SELECT state FROM issue_items WHERE id=$1', [items[0].item_id])).state === 'proposed', 'stranger cannot change the draft');

  t = await tg(cb('k:' + items[0].item_id));
  ok(t.r.ok && t.calls[0].method === 'answerCallbackQuery' && t.calls[1].method === 'editMessageText', 'keep → answer callback + edit message');
  ok(t.calls[1].body.text.includes('✅ Kept'), 'message shows kept state');

  t = await tg(cb('s:' + items[1].item_id, 111, 502));
  const swappedIn = t.r.item;
  ok(t.r.ok && swappedIn.item_id !== items[1].item_id && swappedIn.position === items[1].position, 'swap brings in an alternate at the same position');
  ok(t.calls[1].method === 'editMessageText' && t.calls[1].body.message_id === 502, 'swap edits the same Telegram message in place');
  t = await tg(cb('k:' + items[1].item_id));
  ok(!t.r.ok && t.calls[0].body.show_alert, 'stale button on swapped-out story → alert, no change');

  t = await tg(cb('d:' + items[2].item_id));
  ok(t.calls[1].body.text.includes('<s>') && t.calls[1].body.reply_markup.inline_keyboard[0][0].callback_data.startsWith('r:'), 'drop strikes through + offers restore');
  t = await tg(cb('r:' + items[2].item_id));
  ok(t.r.item.state === 'kept', 'restore works');
  t = await tg(cb('d:' + items[2].item_id));

  t = await tg(txt('random text with no pending edit'));
  ok(!t.r.ok && t.calls[0].body.text.includes('Tap ✏️ Edit'), 'free text without edit → guidance');
  t = await tg(cb('e:' + items[3].item_id));
  ok(t.calls.some((c) => c.body.reply_markup && c.body.reply_markup.force_reply), 'edit asks for reply with current text');
  t = await tg(txt('Shreya rewrote this: the real story is the unit economics, not the round size.'));
  ok(t.r.ok && t.r.item.edited && t.r.item.state === 'kept', 'edit saved, flagged edited, kept');
  const mid3 = (await one('SELECT telegram_msg_id FROM issue_items WHERE id=$1', [items[3].item_id])).telegram_msg_id;
  ok(mid3 && t.calls.some((c) => c.method === 'editMessageText' && String(c.body.message_id) === String(mid3)), 'edited story message updated in place');

  t = await tg(txt('/status'));
  ok(t.calls[0].body.text.includes('in_review') && t.calls[0].body.text.includes('9 stories'), '/status summarises draft');
  t = await tg(txt('/help'));
  ok(t.calls[0].body.text.includes('Confirm & schedule send'), '/help');

  // reminder before approval
  console.log('\n[4] Reminder');
  await setClock('2026-10-07 22:00+05:30');
  let rem = (await one('SELECT reminder_check() AS r, d_config_json() AS cfg'));
  let rb = runCode('reminder_build', { input: [rem] });
  ok(rb.length === 1 && rb[0].json.body.text.includes('not</b> be sent'), 'Wed 22:00 reminder sent while unapproved');
  ok((await one('SELECT count(*)::int c FROM deliveries')).c === 0, 'reminder never queues email');

  // approve
  console.log('\n[5] Approval');
  t = await tg(cb('a:' + draft2.issue.id));
  ok(t.calls.some((c) => c.body.reply_markup && c.body.reply_markup.inline_keyboard[0][0].callback_data === `c:${draft2.issue.id}`), 'approve shows final preview + confirm button');
  ok(t.calls.filter((c) => c.method === 'sendMessage').every((c) => c.body.text.length <= 4096), 'preview chunks within limits');
  ok((await one('SELECT status FROM issues WHERE id=$1', [draft2.issue.id])).status === 'in_review', 'preview alone does not approve');
  // unsubscribe someone before approval: they must not be queued
  await q("UPDATE subscribers SET status='unsubscribed' WHERE email='reader8@example.com'");
  t = await tg(cb('c:' + draft2.issue.id, 111, 777));
  ok(t.r.ok && t.r.queued === 7, `confirm queues active subscribers only (${t.r.queued})`);
  ok(t.calls.some((c) => c.method === 'editMessageReplyMarkup' && c.body.message_id === 777), 'confirm buttons removed after use');
  const iss = await one('SELECT * FROM issues WHERE id=$1', [draft2.issue.id]);
  ok(iss.status === 'approved' && iss.issue_no === 105, 'issue approved with number 105');
  ok((await one("SELECT count(*)::int c FROM issue_items WHERE issue_id=$1 AND state='kept'", [iss.id])).c === 9, 'pending stories kept, dropped excluded');
  t = await tg(cb('k:' + items[4].item_id));
  ok(!t.r.ok && t.calls[0].body.text.includes('locked'), 'draft locked after approval');
  rem = await one('SELECT reminder_check() AS r, d_config_json() AS cfg');
  ok(runCode('reminder_build', { input: [rem] }).length === 0, 'no reminder after approval');
  // unapprove + re-confirm
  t = await tg(txt('/unapprove'));
  ok(t.r.ok && (await one('SELECT count(*)::int c FROM deliveries')).c === 0, '/unapprove withdraws and clears queue');
  t = await tg(txt('/approve'));
  t = await tg(cb('c:' + draft2.issue.id));
  ok(t.r.ok && t.r.queued === 7, 're-confirm works');

  // =========== SEND ===========
  console.log('\n[6] Sending');
  await setClock('2026-10-08 07:50+05:30');
  let cl = await one('SELECT claim_delivery_batch() AS r, d_config_json() AS cfg');
  ok(cl.r.claimed === 0 && cl.r.reason === 'waiting for send time', 'nothing sent before Thursday 08:00');
  await setClock('2026-10-08 08:00+05:30');
  const tick = async (failEmail) => {
    const c = await one('SELECT claim_delivery_batch() AS r, d_config_json() AS cfg');
    const emails = runCode('sender_render', { input: [c] }).map((e) => e.json);
    for (let i = 0; i < emails.length; i++) {
      const gmailOut = emails[i].to === failEmail ? { error: { message: 'Invalid To header' } } : { id: 'gm' + emails[i].delivery_id, threadId: 'x', labelIds: ['SENT'] };
      const res = runCode('sender_result', { input: [gmailOut], nodes: { 'Render emails': emails }, eachItem: 0 });
      // emulate pairing: Render emails .item must be the i-th
      const res2 = new Function('$input', '$', '$json', 'console', body('sender_result'))(null, () => ({ item: { json: emails[i] } }), gmailOut, console);
      await one('SELECT delivery_results($1) AS r', [res2.json.b64]);
    }
    return { c, emails };
  };
  let r1 = await tick('reader3@example.com');
  ok(r1.emails.length === 3, 'batch size respected (3)');
  const e0 = r1.emails[0];
  ok(e0.subject.startsWith('The Dispatch #105:'), 'subject has issue number');
  ok(e0.html.includes('/webhook/dispatch-unsubscribe?t=') && e0.html.includes('Unsubscribe'), 'email has one-click unsubscribe link');
  ok(!e0.html.includes('<tags>') && e0.html.includes('&lt;tags&gt;'), 'email content HTML-escaped');
  ok((e0.html.match(/<a href="https:\/\/[a-z0-9]+\.com\/story/g) || []).length >= 9 * 1, 'all stories linked');
  let r3, guard = 0;
  do { r3 = await tick('reader3@example.com'); } while (r3.emails.length && guard++ < 10);
  const sentToday = (await one("SELECT count(*)::int c FROM deliveries WHERE status='sent'")).c;
  ok(r3.c.r.reason === 'daily cap reached' && sentToday === 5, `daily cap (5) stops sending for today (sent ${sentToday})`);
  await setClock('2026-10-09 08:00+05:30');
  let fin = await one('SELECT finalize_sends() AS r, d_config_json() AS cfg');
  ok(!fin.r.finalized, 'not finalized while queue not drained');
  for (let i = 0; i < 4; i++) await tick('reader3@example.com');
  fin = await one('SELECT finalize_sends() AS r, d_config_json() AS cfg');
  ok(fin.r.finalized && fin.r.stats.sent === 6 && fin.r.stats.failed === 1 && fin.r.stats.skipped === 0, `resumes next day, finalizes: ${JSON.stringify(fin.r.stats)}`);
  ok((await one("SELECT attempts FROM deliveries d JOIN subscribers s ON s.id=d.subscriber_id WHERE s.email='reader3@example.com'")).attempts === 3, 'failed delivery retried max_send_attempts times');
  ok(runCode('sender_notify', { input: [fin] })[0].json.body.text.includes('has been sent'), 'Shreya notified when sending completes');
  ok((await one("SELECT count(*)::int c FROM articles WHERE status='published'")).c === 9, 'published articles marked');
  ok((await one("SELECT count(*)::int c FROM deliveries WHERE status='sent'")).c === 6, 'no double sends');

  // =========== UNSUBSCRIBE + BOUNCES ===========
  console.log('\n[7] Unsubscribes & bounces');
  const tok = (await one("SELECT unsub_token FROM subscribers WHERE email='reader1@example.com'")).unsub_token;
  let u = await one('SELECT unsubscribe_token($1) AS r, d_config_json() AS cfg', [tok]);
  ok(u.r.ok && !u.r.already, 'unsubscribe link works');
  ok(runCode('unsub_page', { input: [u] })[0].json.html.includes("You've been unsubscribed"), 'confirmation page');
  u = await one('SELECT unsubscribe_token($1) AS r, d_config_json() AS cfg', [tok]);
  ok(u.r.already, 'second click is idempotent');
  u = await one('SELECT unsubscribe_token($1) AS r, d_config_json() AS cfg', ['none']);
  ok(!u.r.ok && runCode('unsub_page', { input: [u] })[0].json.html.includes('invalid'), 'bad token handled');

  const mails = [
    { id: 'g1', from: { value: [{ address: 'mailer-daemon@googlemail.com' }] }, subject: 'Delivery Status Notification (Failure)', headers: { 'x-failed-recipients': 'X-Failed-Recipients: reader2@example.com' },
      text: "Address not found\nYour message wasn't delivered to reader2@example.com because the address couldn't be found." },
    { id: 'g2', from: { value: [{ address: 'mailer-daemon@googlemail.com' }] }, subject: 'Delivery Status Notification (Delay)', headers: {},
      text: "Message not delivered yet\nThere was a temporary problem delivering your message to reader4@example.com. Mailbox full." },
    { id: 'g3', from: { value: [{ address: 'reader5@example.com' }] }, subject: 'Re: The Dispatch #105: Inc42 story', headers: {}, text: 'Unsubscribe please\n\nOn Thu, Shreya wrote:\n> ...' },
    { id: 'g4', from: { value: [{ address: 'reader6@example.com' }] }, subject: 'Re: The Dispatch #105: Inc42 story', headers: {}, text: 'Great issue! Loved the fintech take.\n\nOn Thu, Shreya wrote:\n> Unsubscribe in one click' },
    { id: 'g5', from: { value: [{ address: 'promo@shop.com' }] }, subject: 'Big sale', headers: {}, text: 'unsubscribe | view in browser' },
  ];
  const cls = runCode('inbound_classify', { input: mails });
  const parsed = JSON.parse(Buffer.from(cls[0].json.b64, 'base64').toString());
  ok(parsed.find((x) => x.gmail_id === 'g1').email === 'reader2@example.com' && parsed.find((x) => x.gmail_id === 'g1').hard, 'hard bounce parsed (X-Failed-Recipients)');
  ok(parsed.find((x) => x.gmail_id === 'g2').email === 'reader4@example.com' && !parsed.find((x) => x.gmail_id === 'g2').hard, 'soft bounce parsed from body');
  ok(parsed.find((x) => x.gmail_id === 'g3').kind === 'unsubscribe', 'reply "unsubscribe please" detected');
  ok(!parsed.find((x) => x.gmail_id === 'g4') && !parsed.find((x) => x.gmail_id === 'g5'), 'quoted footer / promo mails ignored');
  let pi = (await one('SELECT process_inbound($1) AS r', [cls[0].json.b64])).r;
  ok(pi.bounces === 2 && pi.unsubscribes === 1, `inbound processed: ${JSON.stringify(pi)}`);
  pi = (await one('SELECT process_inbound($1) AS r', [cls[0].json.b64])).r;
  ok(pi.already_processed === 3, 'same Gmail messages not double-counted');
  const st = Object.fromEntries((await q('SELECT email, status, bounce_count FROM subscribers')).map((r) => [r.email, r]));
  ok(st['reader2@example.com'].status === 'bounced' && st['reader4@example.com'].status === 'active' && st['reader4@example.com'].bounce_count === 1, 'hard → bounced; soft → strike');
  ok(st['reader5@example.com'].status === 'unsubscribed', 'reply-unsubscribe applied');

  // =========== WEEK 2: cross-week dedup ===========
  console.log('\n[8] Week 2: cross-issue dedup');
  await setClock('2026-10-07 18:30+05:30'); // after week-1 selection
  const [late] = runCode('ingest_normalize', { input: [{ title: 'Late Wednesday scoop: Dunzo founders start new venture', link: 'https://late.com/x', isoDate: '2026-10-07T12:00:00Z' }], nodes: { 'Loop feeds': feeds[5] } });
  await one('SELECT ingest_batch($1) AS result', [late.json.b64]);
  await setClock('2026-10-12 10:00+05:30');
  const pubTitle = (await one("SELECT title FROM articles WHERE status='published' LIMIT 1")).title;
  const [n2] = runCode('ingest_normalize', { input: [
    { title: pubTitle + ' - updated', link: 'https://another.com/rehash', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'Zerodha acquires logistics startup Shiprocket in all-stock deal', link: 'https://fresh.com/a1', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'Ola Electric acquires logistics startup Shadowfax', link: 'https://fresh.com/a2', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'Jar raises Series B led by Tiger Global', link: 'https://fresh.com/a3', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'Kuku FM raises Series B led by Tiger Global', link: 'https://fresh.com/a4', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'SEBI tightens SME IPO norms after Rexpro listing frenzy', link: 'https://fresh.com/a5', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'MeitY drafts rules for AI-generated content labelling', link: 'https://fresh.com/a6', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'Blinkit dark stores cross 2,000 as Zomato doubles down', link: 'https://fresh.com/a7', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'ONDC volumes stall as buyer apps cut incentives', link: 'https://fresh.com/a8', isoDate: '2026-10-12T03:00:00Z' },
    { title: 'Ather Energy Q2 loss narrows on scooter demand', link: 'https://fresh.com/a9', isoDate: '2026-10-12T03:00:00Z' },
  ], nodes: { 'Loop feeds': feeds[5] } });
  const r2i = (await one('SELECT s.r AS result, save_ingest_images($1) AS images FROM (SELECT ingest_batch($1) AS r OFFSET 0) s', [n2.json.b64])).result; console.log('    week2 ingest', JSON.stringify(r2i));
  const w2 = Object.fromEntries((await q("SELECT url, status FROM articles WHERE fetched_at >= '2026-10-12'")).map((r) => [r.url, r.status]));
  ok(w2['https://another.com/rehash'] === 'duplicate', 'rehash of a published story flagged duplicate at ingest');
  ok(w2['https://fresh.com/a2'] === 'new' && w2['https://fresh.com/a4'] === 'new', 'formulaic headlines about different companies are NOT merged');
  ok(r2i.new === 8, `8 genuinely new stories (${JSON.stringify(r2i)})`);
  await setClock('2026-10-14 15:00+05:30');
  const ctx2 = (await one('SELECT build_selection_context() AS ctx')).ctx;
  ok(ctx2.candidates.every((c) => !c.title.includes(pubTitle)), 'published stories never re-offered');
  ok(ctx2.recent_coverage.length === 9, 'last issues passed to Gemini for semantic dedup');
  ok(ctx2.edit_examples.length === 1 && ctx2.edit_examples[0].shreya_final.includes('unit economics'), "Shreya's edits fed back as voice examples");
  ok(!ctx2.candidates.some((c) => c.title.includes('(Medianama')), "last week's batch does not leak into this week");
  ok(ctx2.candidates.some((c) => c.title.startsWith('Late Wednesday scoop')), 'articles fetched after last Wednesday\'s selection roll into this week');
  ok(ctx2.candidate_count === 9, `week 2 candidates = 8 new + 1 late scoop (${ctx2.candidate_count})`);


  // =========== ADD-ONS ===========
  console.log('\n[9] Add-ons');
  const kenHtml = '<html><head><meta property="og:title" content="Zepto&rsquo;s dark stores are really a real-estate business | The Ken"><meta property="og:description" content="Inside the property maths behind quick commerce."><meta property="og:site_name" content="The Ken"></head><body>' + 'x'.repeat(600) + '</body></html>';
  let t9 = await tg(txt('must lead with this https://the-ken.com/story/zepto-real-estate?utm_source=tw'), kenHtml);
  ok(t9.r.ok && t9.r.type === 'suggest' && t9.r.title.startsWith("Zepto's dark stores are really a real-estate business"), 'pasted link saved as pick with page title (site suffix stripped)');
  ok(t9.calls.some((c) => c.body.text && c.body.text.includes('Saved for the next draft')), 'bot confirms the pick');
  const pinRow = await one("SELECT pinned, pinned_note, url_hash = md5('https://the-ken.com/story/zepto-real-estate') AS canon FROM articles WHERE url LIKE 'https://the-ken.com/story/zepto%'");
  ok(pinRow.pinned && pinRow.pinned_note === 'must lead with this' && pinRow.canon, 'pick stored pinned with note and canonical URL');
  t9 = await tg(txt('/suggest https://the-ken.com/story/zepto-real-estate'), kenHtml);
  ok(t9.r.ok && (await one("SELECT count(*)::int c FROM articles WHERE url LIKE 'https://the-ken.com/story/zepto%'")).c === 1, 're-suggesting the same link does not duplicate it');
  const ctx3 = (await one('SELECT build_selection_context() AS ctx')).ctx;
  const pinC = ctx3.candidates.find((c) => c.pinned);
  ok(pinC && pinC.note === 'must lead with this', 'pick appears in candidates with the note');
  const [sp3] = runCode('select_build_prompt', { input: [{ ctx: ctx3 }] });
  ok(sp3.json.request.contents[0].parts[0].text.includes(`[${pinC.id}] [MUST INCLUDE`), 'selection prompt marks the pick as MUST INCLUDE');
  const ids3 = ctx3.candidates.filter((c) => !c.pinned).map((c) => c.id);
  const sel3 = { picks: ids3.slice(0, 8).map((id, i) => ({ id, topic: ['Fintech', 'Policy & Regulation', 'AI & Deep Tech'][i % 3], reason: 'r' })), alternates: ids3.slice(8).map((id) => ({ id, topic: 'Funding & VC', reason: 'alt' })) };
  const [val3] = runCode('select_validate', { input: [geminiWrap(sel3)], nodes: { 'Load context': { ctx: ctx3 } } });
  ok(val3.json.selection.picks[0].id === pinC.id && val3.json.selection.picks.length <= 10, 'pick forced into the selection even when Gemini skipped it');
  ok(val3.json.request.contents[0].parts[0].text.includes("Editor's note (use this angle): must lead with this"), 'note passed to the commentary writer');
  ok(val3.json.request.generationConfig.responseSchema.properties.intro, 'commentary call asks for an intro');
  const allP = [...val3.json.selection.picks, ...val3.json.selection.alternates];
  const [m3] = runCode('select_merge', { input: [geminiWrap({ intro: 'Quick commerce is quietly becoming a property business. Follow the leases, not the GMV.', items: allP.map((p) => ({ id: p.id, commentary: 'C ' + p.id })) })], nodes: { 'Validate selection': val3.json, 'Load context': { ctx: ctx3 } } });
  const d3 = (await one('SELECT save_draft($1) AS r', [m3.json.b64])).r;
  ok(d3.issue.intro.startsWith('Quick commerce is quietly'), 'intro saved on the draft');
  const tgm3 = runCode('select_tg_messages', { input: [{ r: d3 }], nodes: { 'Load context': { ctx: ctx3 }, 'Merge commentary': m3.json } }).map((m) => m.json);
  ok(tgm3[0].body.text.includes('<b>Intro:</b>'), 'Telegram header shows the intro');
  t9 = await tg(txt('/intro The leases tell the story this week.'));
  ok(t9.r.ok && t9.r.view.issue.intro === 'The leases tell the story this week.', '/intro edits the opener');
  t9 = await tg(txt('/sponsor Acme Analytics: dashboards for D2C founders | https://acme.example/d2c'));
  ok(t9.r.ok && t9.r.view.issue.sponsor.url === 'https://acme.example/d2c' && t9.r.view.issue.sponsor.text.startsWith('Acme'), '/sponsor sets text and link');
  t9 = await tg(txt('/alternates'));
  const altBtn = t9.calls.find((c) => c.body.reply_markup && c.body.reply_markup.inline_keyboard);
  ok(t9.r.alternates.length > 0 && altBtn.body.reply_markup.inline_keyboard[0][0].callback_data.startsWith('p:'), '/alternates lists runners-up with add buttons');
  const altId = +altBtn.body.reply_markup.inline_keyboard[0][0].callback_data.slice(2);
  const before = t9.r.alternates.length;
  t9 = await tg(cb('p:' + altId, 111, 4242));
  ok(t9.r.ok && t9.r.item && t9.r.item.state === 'proposed' && t9.calls.some((c) => c.method === 'sendMessage' && c.body.reply_markup && c.body.reply_markup.inline_keyboard[0][0].callback_data === 'k:' + altId), 'one tap adds a runner-up as a new story with review buttons');
  t9 = await tg(cb('p:' + altId));
  ok(!t9.r.ok, 'same runner-up cannot be added twice');
  t9 = await tg(cb('a:' + d3.issue.id));
  const prevTxt = t9.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text).join('\n');
  ok(prevTxt.includes('The leases tell the story') && prevTxt.includes('Sponsor:'), 'final preview shows intro and sponsor');
  const v3 = (await one('SELECT issue_view($1) AS v', [d3.issue.id])).v;
  const em3 = new Function('$input', '$', 'console', LIB + '\nreturn renderEmail;')(null, null, console)(v3, cfg, { unsub_token: 'tok' });
  ok(em3.html.includes('The leases tell the story') && em3.html.includes('Sponsored') && em3.html.includes('https://acme.example/d2c'), 'email shows intro and sponsor block');
  t9 = await tg(txt('/nosponsor'));
  ok(t9.r.ok && !t9.r.view.issue.sponsor, '/nosponsor removes it');
  t9 = await tg(txt('/help'));
  ok(t9.calls[0].body.text.includes('<b>alternates</b>') && t9.calls[0].body.text.includes('Paste any link'), 'help lists the new commands');
  // ---- add-ons 2-5: voice guide, full-article reading, reader suggestions ----
  await q("INSERT INTO config VALUES ('style_guide', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [fs.readFileSync(path.join(ROOT, 'style_guide.md'), 'utf8')]);
  t9 = await tg(txt('voice'));
  ok(t9.r.type === 'voice_show' && t9.calls[0].body.text.includes("Shreya's voice") && t9.calls[0].body.text.includes('Optimistic about India'), '"voice" shows the voice guide');
  t9 = await tg(txt('voice rule: never call a valuation an achievement'));
  ok(t9.r.ok && t9.calls[0].body.text.includes('House rule #1'), '"voice rule: …" adds a house rule');
  ok((await one("SELECT d_cfg('style_guide','') AS g")).g.endsWith("## Shreya's house rules\n- never call a valuation an achievement"), 'house rule saved into the guide Gemini reads');
  const pv = (await one("SELECT ii.position, ii.article_id FROM issue_items ii JOIN issues i ON i.id = ii.issue_id WHERE i.status <> 'cancelled' AND ii.state IN ('proposed','kept') ORDER BY i.week_start DESC, ii.position LIMIT 1"));
  ok((await one('SELECT save_article_texts($1) AS n', [Buffer.from(JSON.stringify({ [pv.article_id]: 'Zepto raised $450 Mn. '.repeat(20), 999999: 'x'.repeat(300) })).toString('base64')])).n === 1, 'full article text saved for real articles only');
  t9 = await tg(txt('read ' + pv.position));
  ok(t9.r.type === 'read_story' && t9.calls[0].body.text.includes('$450 Mn') && t9.calls[0].body.text.includes('Gemini read'), '"read N" shows the full text Gemini read');
  t9 = await tg(txt('read 77'));
  ok(!t9.r.ok && t9.calls[0].body.text.includes('no story #77'), '"read 77" explains there is no such story');
  const sug = (o) => runRaw('suggest_parse', [{ body: JSON.stringify(o) }], {})[0].json;
  ok(sug({ url: 'http://127.0.0.1/admin' }).fetch_url === 'about:blank' && sug({ url: 'https://localhost/x' }).fetch_url === 'about:blank' && sug({ url: 'https://intranet/x' }).fetch_url === 'about:blank', 'suggestion fetch refuses IPs and internal hosts');
  const rsp = sug({ url: 'https://yourstory.com/2026/10/agri-startup-raises', note: 'Big for farmers', name: 'Asha', email: 'asha@mail.in' });
  ok(rsp.fetch_url.startsWith('https://yourstory.com/'), 'public suggestion link is fetched for its title');
  const stl = runRaw('suggest_title', [{ data: '<html><head><meta property="og:title" content="Agri startup raises &amp; expands"></head></html>' }], { 'Check suggestion': rsp })[0].json;
  let ws = (await one('SELECT web_suggest($1) AS r', [stl.b64])).r;
  ok(ws.ok && ws.notify && ws.suggestion.title === 'Agri startup raises & expands', 'reader suggestion saved with its headline');
  ok(!(await one('SELECT web_suggest($1) AS r', [stl.b64])).r.notify, 'same link twice in a week is not saved again');
  ok(!(await one('SELECT web_suggest($1) AS r', [Buffer.from(JSON.stringify({ url: 'not a link' })).toString('base64')])).r.ok, 'bad link rejected with a message');
  ok((await one('SELECT web_suggest($1) AS r', [Buffer.from(JSON.stringify({ url: 'https://spam.example/x', website: 'bot' })).toString('base64')])).r.ok
     && (await one("SELECT count(*)::int AS n FROM reader_suggestions WHERE url LIKE 'https://spam%'")).n === 0, 'honeypot submissions silently dropped');
  const nt = runRaw('suggest_notify', [{ r: ws, cfg }], {});
  ok(nt.length === 1 && nt[0].json.body.text.includes('take ' + ws.suggestion.id), 'Shreya is pinged with take/skip');
  t9 = await tg(txt('suggestions'));
  ok(t9.calls[0].body.text.includes('Agri startup raises') && t9.calls[0].body.text.includes('Asha'), '"suggestions" lists reader links');
  t9 = await tg(txt('take ' + ws.suggestion.id));
  ok(t9.r.ok && t9.calls[0].body.text.includes('added'), '"take N" pins a reader suggestion for the next draft');
  ok((await one("SELECT pinned FROM articles WHERE url = 'https://yourstory.com/2026/10/agri-startup-raises'")).pinned, 'taken suggestion is a pinned candidate');
  t9 = await tg(txt('skip ' + ws.suggestion.id));
  ok(!t9.r.ok && t9.calls[0].body.text.includes('already taken'), 'cannot skip a suggestion already taken');
  const pj = (await one('SELECT pipeline_json() AS p')).p;
  ok(pj.suggestions.taken === 1 && pj.voice_rules.length === 1 && pj.reading && pj.voice && pj.audience, 'dashboard data includes suggestions, voice rules and reading');

  // ---- website Talk page: same brain as the Telegram bot ----
  const dashKey = 'test-dashboard-key-123';
  await q("INSERT INTO config VALUES ('dashboard_key', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [dashKey]);
  const cfgT = (await one('SELECT d_config_json() AS cfg')).cfg;
  async function talk(body) {
    const up = runRaw('talk_update', [], { 'Load config': { cfg: cfgT }, Talk: { body: JSON.stringify(body) } })[0].json;
    if (up._stop) return { stop: up._stop };
    const dec = runCode('review_decide', { nodes: { 'Load config': { cfg: cfgT }, 'Telegram Trigger': up } });
    const info = runRaw('review_pageinfo', [{ error: { message: 'no page' } }], { 'Decide action': dec[0].json })[0].json;
    const r = (await one('SELECT review_apply_more($1) AS r', [info.b64])).r;
    const calls = runCode('review_render', { input: [{ r }], nodes: { 'Decide action': dec[0].json, 'Load config': { cfg: cfgT } } }).map((c) => c.json);
    const web = runRaw('talk_reply', calls, { 'Decide action': dec[0].json })[0].json;
    const sync = runRaw('talk_sync', calls, {}).map((x) => x.json);
    return { r, web, sync };
  }
  ok((await talk({ key: 'wrong-key-xyz', text: 'status' })).stop === 'unauthorized', 'Talk page refuses a wrong dashboard key');
  ok((await talk({ key: dashKey, callback: 'c:1' })).stop === 'bad_button', 'Talk page cannot press the final send confirmation');
  let tk = await talk({ key: dashKey, text: 'status' });
  ok(tk.web.ok && tk.web.replies[0].html.includes('Issue status'), 'Talk page answers "status" like the bot');
  tk = await talk({ key: dashKey, text: 'voice' });
  ok(tk.web.replies[0].html.includes("Shreya's voice"), 'Talk page shows the voice guide');
  tk = await talk({ key: dashKey, text: 'alternates' });
  ok((tk.r.alternates || []).length ? (tk.web.replies[0].buttons.length >= 1 && /^p:\d+$/.test(tk.web.replies[0].buttons[0].data)) : tk.web.replies[0].html.includes('No runners-up'), 'runner-up buttons (or "none left") come through to the website');
  const kb = runRaw('talk_reply', [{ method: 'sendMessage', body: { text: 'Final check', reply_markup: { inline_keyboard: [[{ text: 'Confirm', callback_data: 'c:9' }, { text: 'Keep', callback_data: 'k:3' }]] } } }], { 'Decide action': { action: { type: 'request_approve' } } })[0].json;
  ok(kb.replies[0].buttons.length === 1 && kb.replies[0].buttons[0].data === 'k:3' && kb.replies[0].confirmInTelegram, 'send confirmation button is never offered on the website');
  tk = await talk({ key: dashKey, text: 'help' });
  ok(tk.web.replies[0].html.includes('<b>alternates</b>'), 'help works from the website');
  ok(runRaw('talk_voice', [], { 'Load config': { cfg: cfgT }, Talk: { body: { audio: 'UklGRiQAAABXQVZF'.repeat(10) } } })[0].json.request.contents[0].parts[1].inline_data.mime_type === 'audio/wav', 'website voice is sent to Gemini as WAV');

  // ---- article pictures ----
  const [pic] = runCode('ingest_normalize', { input: [
    { title: 'Zepto picture test story about quick commerce growth', link: 'https://inc42.com/pic-a', isoDate: new Date().toISOString(), enclosure: { url: 'https://inc42.com/img/a.jpg', type: 'image/jpeg' } },
    { title: 'Swiggy picture test story about delivery in tier two', link: 'https://inc42.com/pic-b', isoDate: new Date().toISOString(), 'content:encoded': '<p><img src="https://cdn.inc42.com/b.webp?w=800&amp;q=80"></p>' },
    { title: 'Ola picture test story with no image at all here', link: 'https://inc42.com/pic-c', isoDate: new Date().toISOString() }], nodes: { 'Loop feeds': feeds[0] } });
  const picRes = await one('SELECT s.r AS result, save_ingest_images($1) AS images FROM (SELECT ingest_batch($1) AS r OFFSET 0) s', [pic.json.b64]);
  ok(picRes.images === 2, 'pictures carried by the feed are saved at ingest');
  ok((await one("SELECT image_url FROM articles WHERE url = 'https://inc42.com/pic-b'")).image_url === 'https://cdn.inc42.com/b.webp?w=800&q=80', 'picture found inside the article body');
  const need = await q("SELECT * FROM articles_needing_images(60)");
  ok(need.some((x) => x.url === 'https://inc42.com/pic-c') && !need.some((x) => x.url === 'https://inc42.com/pic-a'), 'articles without a picture are queued for a look-up');
  const ask = need.filter((x) => x.url === 'https://inc42.com/pic-c');
  const ex = runRaw('images_extract', [{ data: '<html><head><meta property="og:image" content="/uploads/c.jpg"></head></html>' }], { 'Articles without pictures': ask })[0].json;
  ok(ex.found === 1, 'og:image read from the article page');
  ok((await one('SELECT save_article_images($1) AS r', [ex.b64])).r.found === 1 && (await one("SELECT image_url FROM articles WHERE url = 'https://inc42.com/pic-c'")).image_url === 'https://inc42.com/uploads/c.jpg', 'relative picture link made absolute and saved');
  ok(!(await q("SELECT * FROM articles_needing_images(60)")).some((x) => x.url === 'https://inc42.com/pic-c'), 'checked articles are not fetched again');
  ok((await one("SELECT d_clean_image('http://x.com/a.jpg') AS a, d_clean_image('https://x.com/logo.png') AS b")).a === null, 'only https, non-logo pictures are kept');
  ok(Object.keys((await one('SELECT pipeline_json() AS p')).p.images).length >= 3, 'dashboard data carries the pictures');

  // email events + stats
  const evB64 = runRaw('events_parse', [{ body: JSON.stringify([{ event: 'delivered', email: 'reader4@example.com', 'message-id': '<a>', tags: ['dispatch', 'issue-105'], ts_event: 1760001000 },
    { event: 'unique_opened', email: 'reader4@example.com', 'message-id': '<a>', tags: ['dispatch', 'issue-105'], ts_event: 1760001100 },
    { event: 'click', email: 'reader4@example.com', 'message-id': '<a>', link: 'https://inc42.com/story-3', tags: ['dispatch', 'issue-105'], ts_event: 1760001200 },
    { event: 'unsubscribed', email: 'reader7@example.com', tags: ['issue-105'] }]) }], {})[0].json.b64;
  ok((await one('SELECT record_email_events($1) AS r', [evB64])).r.recorded === 4, 'Brevo events recorded');
  ok((await one("SELECT status FROM subscribers WHERE email='reader7@example.com'")).status === 'unsubscribed', 'Brevo unsubscribe applied to the list');
  t9 = await tg(txt('/stats'));
  ok(t9.calls[0].body.text.includes('Last issue #105') && /Opened \d+ \(\d+%\)/.test(t9.calls[0].body.text), '/stats shows open and click rates');
  const stj = (await one('SELECT stats_json() AS s')).s;
  ok(stj.top_links.length >= 1 && stj.issues[0].clicked >= 1 && Array.isArray(stj.sources), 'dashboard stats: issues, top links, sources');
  ok(!JSON.stringify(stj).includes('@example.com'), 'dashboard stats contain no email addresses');
  // feed alert + tuesday preview
  await q("UPDATE sources SET last_alerted_at = NULL");
  const fa = runCode('feed_alert', { input: [{ bad: (await one('SELECT feed_alerts() AS b')).b, cfg }] });
  ok(fa.length === 1 && fa[0].json.body.text.includes('failing'), 'broken feed alert built');
  ok(runCode('feed_alert', { input: [{ bad: (await one('SELECT feed_alerts() AS b')).b, cfg }] }).length === 0, 'same broken feed not re-alerted within 24h');
  const tp = runCode('tuesday_build', { input: [{ r: (await one('SELECT tuesday_preview() AS r')).r, cfg }] });
  ok(tp[0].json.body.text.includes('Tuesday preview') && tp[0].json.body.text.includes('Your picks'), 'Tuesday preview lists trending stories and picks');

  // error alert
  const ea = runCode('error_build', { input: [{ cfg }], nodes: { 'Error Trigger': { workflow: { name: 'Dispatch 2' }, execution: { lastNodeExecuted: 'Gemini · select stories', error: { message: '429 <quota>' }, url: 'https://n8n/x' } } } });
  ok(ea[0].json.body.text.includes('&lt;quota&gt;'), 'error alert escapes + names the node');

  console.log(`\nAll ${passed} checks passed.`);
  await db.end();
})().catch(async (e) => { console.error('\nFAILED:', e); try { await db.end(); } catch (_) {} process.exit(1); });
