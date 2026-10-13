const r = $input.first().json.r || {};
const cfg = $input.first().json.cfg || {};
const name = esc(cfg.newsletter_name || 'The Dispatch');
const msg = r.ok ? (r.already ? 'You were already unsubscribed.' : `You've been unsubscribed from ${name}. You won't receive any more issues.`)
  : 'This unsubscribe link is invalid or expired. Reply "unsubscribe" to any issue instead.';
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title></head>
<body style="font-family:Georgia,serif;background:#f6f4ef;color:#222;display:flex;min-height:90vh;align-items:center;justify-content:center;margin:0;padding:16px;">
<div style="max-width:440px;background:#fff;padding:32px;border-radius:8px;text-align:center;"><h2 style="margin-top:0;">${name}</h2><p>${esc(msg)}</p></div></body></html>`;
return [{ json: { html } }];
