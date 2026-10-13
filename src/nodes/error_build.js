const e = $('Error Trigger').first().json;
const cfg = $input.first().json.cfg;
const wf = e.workflow?.name || 'unknown workflow';
const node = e.execution?.lastNodeExecuted || e.trigger?.error?.node?.name || '?';
const m = e.execution?.error?.message || e.trigger?.error?.message || 'unknown error';
const url = e.execution?.url;
return [{ json: { method: 'sendMessage', body: { chat_id: cfg.telegram_chat_id, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  text: `⚠️ <b>Pipeline error</b> in <i>${esc(wf)}</i> at node <i>${esc(node)}</i>:\n<code>${esc(String(m).slice(0, 800))}</code>` + (url ? `\n${esc(url)}` : '') } } }];
