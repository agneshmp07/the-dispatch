// Classify bounce notifications and "unsubscribe" replies
const out = [];
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HARD = /address not found|does ?n[o']t exist|user unknown|no such user|unknown user|mailbox unavailable|invalid (?:recipient|address)|recipient address rejected|\b5\.1\.[0-9]\b|\b550[ -]5\.1|account (?:has been )?disabled|address couldn'?t be found/i;
const BOUNCE_SUBJ = /delivery status notification|undeliverable|undelivered mail|mail delivery (?:failed|subsystem)|returned mail|delivery failure|failure notice/i;
for (const { json: m } of $input.all()) {
  if (!m || !m.id) continue;
  const from = (m.from && m.from.value && m.from.value[0] && m.from.value[0].address) || String(m.from && m.from.text || '').match(EMAIL)?.[0] || '';
  const subject = String(m.subject || '');
  const text = String(m.text || '');
  const headers = m.headers || {};
  const isBounce = /mailer-daemon|postmaster/i.test(from) || BOUNCE_SUBJ.test(subject);
  if (isBounce) {
    let email = null;
    const hdr = headers['x-failed-recipients'] || headers['X-Failed-Recipients'];
    if (hdr) email = String(hdr).replace(/^[^:]*:/, '').match(EMAIL)?.[0];
    if (!email) {
      const m2 = text.match(/(?:wasn'?t delivered to|couldn'?t be delivered to|could not be delivered to|Final-Recipient:\s*rfc822;|Original-Recipient:\s*rfc822;|failed permanently:|delivery to the following recipients? failed[^\n]*\n)\s*<?([^\s<>;]+@[^\s<>;]+?)>?[\s.,;]/i);
      if (m2) email = m2[1];
    }
    if (!email) email = (text.match(new RegExp(EMAIL.source, 'g')) || []).find((e) => !/mailer-daemon|postmaster|googlemail\.com$/i.test(e)) || null;
    out.push({ gmail_id: m.id, kind: 'bounce', email, hard: HARD.test(text) || HARD.test(subject), detail: subject.slice(0, 120) });
    continue;
  }
  // only the reply itself, not the quoted newsletter footer
  const own = text.split(/\n\s*>|\nOn .{0,200}wrote:|\n-{2,}\s*Original Message/i)[0].slice(0, 500);
  const isReply = /^\s*re\s*:/i.test(subject);
  if (/\bunsubscribe\b/i.test(subject) || (isReply && /^\s*(?:please\s+)?(?:unsubscribe|remove me|stop sending)/im.test(own))) {
    out.push({ gmail_id: m.id, kind: 'unsubscribe', email: from, detail: subject.slice(0, 120) });
  }
}
if (!out.length) return [];
return [{ json: { b64: toB64(out), count: out.length } }];
