// Render the current draft as the real email, addressed only to Shreya's own inbox
const p = $input.first().json.p || {};
const cfg = p.cfg || {};
if (!p.view || !p.to) {
  return [{ json: { skip: true, tg: { chat_id: cfg.telegram_chat_id, parse_mode: 'HTML',
    text: !p.view ? '📧 No draft to test yet. The draft arrives Wednesday 3 PM.' : '📧 No email address is configured for test sends.' } } }];
}
const view = JSON.parse(JSON.stringify(p.view));
view.issue.issue_no = view.issue.issue_no || 'TEST';
const e = renderEmail(view, cfg, { unsub_token: 'test' });
return [{ json: { skip: false, to: p.to, subject: '[TEST] ' + e.subject, html: e.html,
  tg: { chat_id: cfg.telegram_chat_id, parse_mode: 'HTML', text: `📧 Test email sent to <b>${esc(p.to)}</b>. Check how it looks (and your spam folder). Subscribers got nothing.` } } }];
