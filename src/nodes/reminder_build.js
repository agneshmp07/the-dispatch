// Reminder only: never sends the newsletter
const r = $input.first().json.r;
const cfg = $input.first().json.cfg;
if (!r.send) return [];
const chat_id = cfg.telegram_chat_id;
if (r.kind === 'missing') return [{ json: { method: 'sendMessage', body: { chat_id, text: r.text } } }];
const v = r.view;
const text = `⏰ <b>Reminder:</b> this week's ${esc(cfg.newsletter_name || 'Dispatch')} is still waiting for your approval.\n${summaryLine(v)}\n\n` +
  `It will <b>not</b> be sent until you confirm. Scheduled send: ${istDate(v.send_at)} IST.`;
return [{ json: { method: 'sendMessage', body: { chat_id, text, parse_mode: 'HTML', reply_markup: approveKeyboard(v.issue.id) } } }];
