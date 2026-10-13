// One personalised email per claimed recipient
const r = $input.first().json.r;
const cfg = $input.first().json.cfg;
if (!r.claimed) return [];
return r.recipients.map((rc) => {
  const e = renderEmail(r.newsletter, cfg, rc);
  return { json: { delivery_id: rc.delivery_id, to: rc.email, name: rc.name || undefined, subject: e.subject, html: e.html, unsub: e.unsub, issue_no: r.newsletter.issue.issue_no } };
});
