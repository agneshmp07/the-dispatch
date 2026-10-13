// Tuesday 18:00: what's trending so far, so Shreya can start thinking early
const r = $input.first().json.r;
const cfg = $input.first().json.cfg;
const top = r.top || [];
const lines = top.map((c, i) => `${i + 1}. <a href="${esc(c.url)}">${esc(c.title)}</a> <i>(${esc(c.source || '')}${c.coverage > 1 ? `, ${c.coverage} outlets` : ''})</i>`).join('\n');
const pins = (r.pinned || []).map((t) => `📌 ${esc(t)}`).join('\n');
return [{ json: { method: 'sendMessage', body: { chat_id: cfg.telegram_chat_id, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  text: `🗞 <b>Tuesday preview</b>: ${r.candidate_count} fresh stories so far.\n\n<b>Most covered right now</b>\n${lines || '(nothing yet)'}` +
    (pins ? `\n\n<b>Your picks</b>\n${pins}` : '') +
    (r.reader_suggestions ? `\n\n📮 ${r.reader_suggestions} reader suggestion${r.reader_suggestions === 1 ? '' : 's'} waiting. Send <b>suggestions</b> to see them.` : '') +
    `\n\nDraft arrives tomorrow at 15:00. Paste any link here to guarantee it a spot.` } } }];
