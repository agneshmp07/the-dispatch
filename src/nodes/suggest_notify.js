// Ping Shreya about the first few reader suggestions each day (the rest wait for "suggestions")
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const { r, cfg } = $input.first().json;
if (!r || !r.ok || !r.notify || !r.suggestion || !cfg.telegram_chat_id) return [];
const sg = r.suggestion;
return [{ json: { method: 'sendMessage', body: { chat_id: cfg.telegram_chat_id, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  text: `📮 <b>Reader suggestion #${sg.id}</b>${sg.name ? ` from ${esc(sg.name)}` : ''}\n<a href="${esc(sg.url)}">${esc(sg.title || sg.url)}</a>` +
    (sg.note ? `\n“${esc(sg.note)}”` : '') +
    `\n\nType <b>take ${sg.id}</b> to add it to the next draft, or <b>skip ${sg.id}</b>.` +
    (r.open_count > 1 ? ` (${r.open_count} waiting: send <b>suggestions</b>)` : '') } } }];
