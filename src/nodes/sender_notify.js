const r = $input.first().json.r;
const cfg = $input.first().json.cfg;
if (!r.finalized) return [];
const s = r.stats || {};
return [{ json: { method: 'sendMessage', body: { chat_id: cfg.telegram_chat_id, parse_mode: 'HTML',
  text: `📬 <b>Issue #${esc(r.issue_no)} has been sent.</b>\nDelivered: ${s.sent || 0} · Failed: ${s.failed || 0} · Skipped (unsubscribed or bounced): ${s.skipped || 0}` +
    (cfg.site_url ? `\n\n🔗 Shareable page: ${String(cfg.site_url).replace(/\/+$/, '')}/issue/${esc(r.issue_no)}` : '') } } }];
