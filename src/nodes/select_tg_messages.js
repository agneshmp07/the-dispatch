// Build the Telegram review messages: header, one per story, approve footer
const v = $input.first().json.r;
const cfg = $('Load context').first().json.ctx.config;
const warn = [...($('Merge commentary').first().json.warnings || []), ...draftWarnings(v, cfg)];
const chat_id = cfg.telegram_chat_id;
const wk = istDate(`${v.issue.week_start}T12:00:00+05:30`, { day: 'numeric', month: 'short' });
const header = `📰 <b>${esc(cfg.newsletter_name || 'The Dispatch')}: draft for the week of ${wk}</b>\n${summaryLine(v)}\n\n` +
  `Review each story below: ✅ Keep · 🔁 Swap · ✏️ Edit · 🗑 Drop.\nWhen you're done, tap <b>Review final draft & approve</b> at the bottom.\n` +
  `Nothing is emailed until you confirm.` + (v.issue.intro ? `\n\n<b>Intro:</b> <i>${esc(v.issue.intro)}</i>\n(change it with /intro your text)` : '') + (warn.length ? `\n\n⚠️ ${esc(warn.join('; '))}` : '');
const msgs = [{ json: { method: 'sendMessage', item_id: null, body: { chat_id, text: header, parse_mode: 'HTML' } } }];
for (const it of v.items) {
  msgs.push({ json: { method: 'sendMessage', item_id: it.item_id, body: {
    chat_id, text: renderItem(it), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: itemKeyboard(it) } } });
}
msgs.push({ json: { method: 'sendMessage', item_id: null, body: {
  chat_id, text: `That's all ${v.items.length} stories. Send time: <b>${istDate(v.send_at)}</b> IST, after your confirmation.`, parse_mode: 'HTML', reply_markup: approveKeyboard(v.issue.id) } } });
return msgs;
