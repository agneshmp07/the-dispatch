// Summarise the run and send it to Shreya
const cfg = $('Load config').first().json.cfg;
const sent = $('Send to bot').all().map((x, i) => ({
  step: $('Build test messages').all()[i].json.step,
  ok: String(x.json.statusCode || '').startsWith('2'),
  code: x.json.statusCode,
}));
const pinned = $('Unpin test link').all().filter((x) => x.json.id).length > 0;
const lines = sent.map((s) => `${s.ok ? '✅' : '❌'} ${s.step}${s.ok ? '' : ` (HTTP ${s.code})`}`);
lines.push(`${pinned ? '✅' : '❌'} pasted link was pinned for the next draft${pinned ? ' (and removed again)' : ''}`);
const allOk = sent.every((s) => s.ok) && pinned;
const text = `🧪 <b>Self-test ${allOk ? 'passed' : 'found a problem'}</b>\n\n${lines.join('\n')}\n\n` +
  (allOk ? 'Every reply above came from the live bot.' : 'Something did not respond. The error alert, if any, will follow in this chat.');
return [{ json: { method: 'sendMessage', body: { chat_id: cfg.telegram_chat_id, text, parse_mode: 'HTML' } } }];
