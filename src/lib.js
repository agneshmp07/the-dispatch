// ---- shared helpers (prepended to every Code node by build.js) ----
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const toB64 = (o) => {
  const s = JSON.stringify(o);
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
};
const istDate = (d, opts) => new Date(d).toLocaleString('en-IN', Object.assign({ timeZone: 'Asia/Kolkata' }, opts || { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }));
const cfgList = (v) => String(v || '').split('|').map((x) => x.trim()).filter(Boolean);
const num = (v, d) => (Number.isFinite(Number(v)) && String(v) !== '' ? Number(v) : d);

function geminiJson(resp) {
  const parts = resp?.candidates?.[0]?.content?.parts || [];
  let txt = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
  if (!txt) throw new Error('Gemini returned no text: ' + JSON.stringify(resp).slice(0, 600));
  txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(txt); } catch (e) {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Gemini returned invalid JSON: ' + txt.slice(0, 400));
  }
}

// ---- Telegram rendering ----
const TG_LIMIT = 3900;
function stateBadge(it) {
  if (it.state === 'kept') return it.edited ? '✏️ Edited & kept' : '✅ Kept';
  if (it.state === 'dropped') return '🗑 Dropped';
  return '⏳ Awaiting review';
}
function renderItem(it) {
  const head = `<b>#${it.position} · ${esc(it.topic)}</b>`;
  const title = `<a href="${esc(it.url)}">${esc(it.title)}</a>` + (it.source ? ` (<i>${esc(it.source)}</i>)` : '');
  const commentary = it.commentary ? esc(it.commentary) : '<i>(no commentary yet: tap ✏️ Edit)</i>';
  const body = it.state === 'dropped' ? `<s>${commentary}</s>` : commentary;
  const why = it.reason && it.state !== 'dropped' ? `\n\n<i>Why picked: ${esc(it.reason)}</i>` : '';
  return `${head}\n${title}\n\n${body}${why}\n\n${stateBadge(it)}`.slice(0, TG_LIMIT);
}
function itemKeyboard(it) {
  if (it.state === 'dropped') return { inline_keyboard: [[{ text: '↩️ Restore', callback_data: `r:${it.item_id}` }]] };
  return { inline_keyboard: [
    [{ text: '✅ Keep', callback_data: `k:${it.item_id}` }, { text: '🔁 Swap', callback_data: `s:${it.item_id}` }],
    [{ text: '✏️ Edit', callback_data: `e:${it.item_id}` }, { text: '🗑 Drop', callback_data: `d:${it.item_id}` }],
  ] };
}
const approveKeyboard = (issueId) => ({ inline_keyboard: [[{ text: '📋 Review final draft & approve', callback_data: `a:${issueId}` }]] });
const confirmKeyboard = (issueId) => ({ inline_keyboard: [
  [{ text: '✅ Confirm & schedule send', callback_data: `c:${issueId}` }],
  [{ text: '↩️ Keep editing', callback_data: `x:${issueId}` }],
] });

function draftWarnings(v, cfg) {
  const w = [];
  const min = num(cfg.min_stories, 8), max = num(cfg.max_stories, 10), minT = num(cfg.min_topics, 3);
  if (v.active_count < min || v.active_count > max) w.push(`${v.active_count} stories (target ${min}–${max})`);
  if (v.topic_count < minT) w.push(`only ${v.topic_count} topic areas (target ≥${minT})`);
  if ((v.items || []).some((i) => i.state !== 'dropped' && !i.commentary)) w.push('some stories have no commentary');
  return w;
}
function summaryLine(v) {
  return `${v.active_count} stories · ${v.topic_count} topics · ${v.pending_count} awaiting review · ${v.alternates_left} alternates left`;
}
function previewChunks(v, cfg) {
  const iss = v.issue;
  const live = (v.items || []).filter((i) => i.state !== 'dropped');
  const parts = [`<b>${esc(cfg.newsletter_name || 'The Dispatch')}: final draft</b>\n${summaryLine(v)}` +
    (iss.intro ? `\n\n<i>${esc(iss.intro)}</i>` : '\n\n<i>(no intro: add one with /intro your text)</i>')];
  live.forEach((it, idx) => {
    parts.push(`<b>${idx + 1}. ${esc(it.title)}</b> <i>[${esc(it.topic)}]</i>\n${esc(it.commentary || '(no commentary)')}`);
  });
  if (iss.sponsor && iss.sponsor.text) parts.push(`<b>Sponsor:</b> ${esc(iss.sponsor.text)}${iss.sponsor.url ? ' (' + esc(iss.sponsor.url) + ')' : ''}`);
  const w = draftWarnings(v, cfg);
  let tail = `\nSends to <b>${v.active_subscribers}</b> active subscribers at <b>${istDate(v.send_at)}</b> IST, and only after you tap Confirm.`;
  if (w.length) tail = `\n⚠️ ${esc(w.join('; '))}` + tail;
  parts.push(tail);
  const chunks = []; let cur = '';
  for (const p of parts) {
    if ((cur + '\n\n' + p).length > TG_LIMIT && cur) { chunks.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => c.slice(0, 4090));
}
const HELP = [
  '<b>The Dispatch bot</b>',
  'Each story in the weekly draft has buttons:',
  '✅ Keep · 🔁 Swap (next-best alternate) · ✏️ Edit commentary · 🗑 Drop',
  '',
  '📌 Paste any link here during the week and it\'s guaranteed a spot in the next draft (add a note after the link if you like).',
  '',
  '🎙 Or just send a voice note: "drop 3", "swap 5", "edit 2: new commentary…", "intro …", "approve". I\'ll show what I heard.',
  'Typed works too: <b>keep 1</b> · <b>drop 3</b> · <b>swap 5</b> · <b>restore 3</b> · <b>edit 2: new text</b>',
  '',
  'Just type a word (no / needed):',
  '<b>status</b>: draft summary',
  '<b>alternates</b>: runners-up you can add with one tap',
  '<b>intro</b> your text: set this week\'s 2-line opener',
  '<b>sponsor</b> text | link: add a sponsor block (<b>nosponsor</b> removes it)',
  '<b>stats</b>: subscribers, opens, clicks, source health',
  '<b>preview</b>: show the full draft',
  '<b>approve</b>: review & confirm the final draft',
  '<b>unapprove</b>: withdraw approval before sending starts',
  '<b>cancel</b>: cancel an edit in progress',
  '<b>selftest</b>: check the bot end to end',
  '<b>testsend</b>: email the current draft to yourself only',
  '<b>newskey</b> KEY: connect the NewsData.io news API',
  '<b>read 3</b>: the full article Gemini read for story 3',
  '<b>voice</b>: your voice guide · <b>voicerule</b> text: add a house rule',
  '<b>suggestions</b>: links readers sent from the website (<b>take 12</b> / <b>skip 12</b>)',
  '',
  'Nothing is ever emailed until you tap <b>Confirm & schedule send</b>.',
].join('\n');

// ---- Email rendering ----
function renderEmail(v, cfg, r) {
  const iss = v.issue;
  const items = (v.items || []).filter((i) => i.state === 'kept' || i.state === 'proposed');
  const name = cfg.newsletter_name || 'The Dispatch';
  const dateStr = istDate(`${iss.week_start}T12:00:00+05:30`, { day: 'numeric', month: 'long', year: 'numeric' });
  const base = String(cfg.public_base_url || '').replace(/\/+$/, '');
  const unsub = `${base}/webhook/dispatch-unsubscribe?t=${encodeURIComponent(r.unsub_token)}`;
  const site = String(cfg.site_url || '').replace(/\/+$/, '');
  const webUrl = site ? `${site}/issue/${encodeURIComponent(iss.issue_no)}` : '';
  const stories = items.map((it, i) => `
      <tr><td style="padding:22px 0;border-top:1px solid #e6e6e6;">
        <div style="font:600 11px/1.4 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#b4441b;">${i + 1} · ${esc(it.topic)}</div>
        <a href="${esc(it.url)}" style="display:block;margin:6px 0 8px;font:700 19px/1.35 Georgia,serif;color:#111;text-decoration:none;">${esc(it.title)}</a>
        <div style="font:16px/1.6 Georgia,serif;color:#333;">${esc(it.commentary)}</div>
        <div style="margin-top:8px;font:13px/1.4 Arial,sans-serif;color:#777;">${esc(it.source || '')} · <a href="${esc(it.url)}" style="color:#b4441b;">Read →</a></div>
      </td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f4ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef;"><tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;padding:0 28px;">
      <tr><td style="padding:28px 0 18px;">
        <div style="font:700 28px/1.2 Georgia,serif;color:#111;">${esc(name)}</div>
        <div style="font:13px/1.5 Arial,sans-serif;color:#777;">Issue #${esc(iss.issue_no)} · ${esc(dateStr)}${cfg.newsletter_tagline ? ' · ' + esc(cfg.newsletter_tagline) : ''}${webUrl ? ` · <a href="${esc(webUrl)}" style="color:#777;">View in browser</a>` : ''}</div>
      </td></tr>${iss.intro ? `
      <tr><td style="padding:0 0 22px;font:italic 17px/1.6 Georgia,serif;color:#333;">${esc(iss.intro)}</td></tr>` : ''}${stories}${iss.sponsor && iss.sponsor.text ? `
      <tr><td style="padding:18px;border:1px dashed #d9cfc2;border-radius:8px;background:#fbf8f2;">
        <div style="font:600 10px/1.4 Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#999;">Sponsored</div>
        <div style="margin-top:6px;font:15px/1.55 Georgia,serif;color:#333;">${esc(iss.sponsor.text)}${iss.sponsor.url ? ` <a href="${esc(iss.sponsor.url)}" style="color:#b4441b;">Learn more →</a>` : ''}</div>
      </td></tr>` : ''}
      <tr><td style="padding:22px 0 30px;border-top:1px solid #e6e6e6;font:12px/1.6 Arial,sans-serif;color:#888;">
        You're receiving this because you subscribed to ${esc(name)}.<br>
        <a href="${esc(unsub)}" style="color:#888;">Unsubscribe in one click</a>, or reply with "unsubscribe".
      </td></tr>
    </table></td></tr></table></body></html>`;
  const lead = items[0] ? items[0].title : '';
  const subject = `${name} #${iss.issue_no}: ${lead}`.slice(0, 120);
  return { subject, html, unsub, webUrl };
}
// ---- end shared helpers ----
