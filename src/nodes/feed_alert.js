// Telegram warning for sources that keep failing (max once a day per source)
const r = $input.first().json;
const bad = r.bad || [];
if (!bad.length) return [];
const cfg = r.cfg;
const lines = bad.map((b) => `• <b>${esc(b.name)}</b>: <code>${esc(b.error)}</code>`).join('\n');
return [{ json: { method: 'sendMessage', body: { chat_id: cfg.telegram_chat_id, parse_mode: 'HTML',
  text: `⚠️ <b>${bad.length} news source${bad.length > 1 ? 's are' : ' is'} failing</b> (no successful fetch in 36h):\n${lines}\n\nThe pipeline keeps running on the other sources. Fix or switch off the feed in the <code>sources</code> table.` } } }];
