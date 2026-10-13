// Parse the Telegram update into a review action (only Shreya's chat is obeyed)
const cfg = $('Load config').first().json.cfg;
const u = $('Telegram Trigger').first().json;
const cq = u.callback_query;
const msg = u.message || u.edited_message;
const chat_id = String(cq ? cq.message?.chat?.id : msg?.chat?.id ?? '');
if (!chat_id) return [];
const ctx = { chat_id, callback_id: cq ? cq.id : null, message_id: cq ? cq.message?.message_id : null, unauthorized: false, help: false, command: null };
let action = { type: 'noop', chat_id };
const URL_RE = /https?:\/\/[^\s<>"']+/i;

if (chat_id !== String(cfg.telegram_chat_id || '').trim()) {
  ctx.unauthorized = true;
} else if (cq) {
  const [code, idStr] = String(cq.data || '').split(':');
  const id = parseInt(idStr, 10);
  const itemTypes = { k: 'keep', d: 'drop', r: 'restore', s: 'swap', e: 'edit_start', p: 'add_alt' };
  const issueTypes = { a: 'request_approve', c: 'confirm', x: 'cancel' };
  if (itemTypes[code]) action = { type: itemTypes[code], chat_id, item_id: id };
  else if (issueTypes[code]) action = { type: issueTypes[code], chat_id, issue_id: id };
} else if (msg) {
  // forwarded posts and captions count as text too
  let text = String(msg.text || msg.caption || '').trim();
  // voice notes: Gemini's transcript (and its normalised command) stand in for typed text
  let voice = null;
  try { voice = $('Voice text').first().json; } catch (e) { voice = null; }
  if (voice) {
    ctx.voice = voice.transcript || '';
    if (voice.failed || !voice.transcript) ctx.voice_failed = true;
    text = msg.reply_to_message ? String(voice.transcript || '').trim() : String(voice.command || voice.transcript || '').trim();
  }
  // Commands work with or without the "/": "stats", "Stats", "self test", "intro Big week for fintech"
  // (not when replying to the bot's edit prompt, so commentary is never mistaken for a command)
  if (!text.startsWith('/') && !msg.reply_to_message) {
    const words = text.toLowerCase().replace(/[.!?]+$/, '').split(/\s+/);
    const bare = { help: 1, start: 1, status: 1, preview: 1, draft: 1, approve: 1, unapprove: 1, cancel: 1, alternates: 1,
      more: 1, stats: 1, nosponsor: 1, selftest: 1, test: 1, cleardemo: 1, testsend: 1, sendtest: 1, testemail: 1, voice: 1, myvoice: 1, voiceguide: 1, suggestions: 1, readersuggestions: 1 };
    const joined = words.join('');
    if (words.length <= 2 && bare[joined]) text = '/' + joined;                       // "stats", "self test", "no sponsor"
    else if (['intro', 'sponsor', 'suggest', 'newskey', 'voicerule'].includes(words[0].replace(/:$/, '')) && words.length > 1)
      text = '/' + text.replace(/^(\w+):?/, (m, w) => w.toLowerCase());               // "intro: ...", "Sponsor ... | link"
  }
  if (!msg.reply_to_message) text = text.replace(/^\/?voice\s+rule\b:?/i, '/voicerule');        // "voice rule: …"
  const ent = [...(msg.entities || []), ...(msg.caption_entities || [])].find((e) => e.type === 'text_link' && e.url);
  const num = !msg.reply_to_message && text.match(/^\/?(keep|drop|remove|delete|swap|replace|restore|undo|edit)\s*(?:story\s*)?(?:#|no\.?|number\s*)?(\d{1,2})\b\s*[:.,-]?\s*([\s\S]*)$/i);
  const one = !msg.reply_to_message && text.match(/^\/?(read|take|skip)\s*(?:story\s*|suggestion\s*)?(?:#|no\.?\s*)?(\d{1,5})\s*$/i);
  if (ctx.voice_failed) {
    // nothing usable was heard
  } else if (one) {
    const t = { read: 'read_story', take: 'take_suggestion', skip: 'skip_suggestion' }[one[1].toLowerCase()];
    action = { type: t, chat_id, n: parseInt(one[2], 10) };
  } else if (num) {
    const verbs = { keep: 'keep', drop: 'drop', remove: 'drop', delete: 'drop', swap: 'swap', replace: 'swap', restore: 'restore', undo: 'restore', edit: 'edit_start' };
    let type = verbs[num[1].toLowerCase()];
    const rest = (num[3] || '').trim();
    if (type === 'edit_start' && rest.length >= 10) type = 'edit_with_text';
    action = { type, chat_id, position: parseInt(num[2], 10), text: type === 'edit_with_text' ? rest : undefined };
  } else if (text.startsWith('/')) {
    const cmd = text.split(/[\s@]/)[0].slice(1).toLowerCase();
    const rest = text.replace(/^\/\S+\s*/, '').trim();
    ctx.command = cmd;
    const simple = { status: 'status', preview: 'preview', draft: 'preview', approve: 'request_approve', unapprove: 'unapprove',
      cancel: 'cancel', alternates: 'alternates', more: 'alternates', stats: 'stats', nosponsor: 'nosponsor', cleardemo: 'clear_demo',
      voice: 'voice_show', myvoice: 'voice_show', voiceguide: 'voice_show', suggestions: 'suggestions', readersuggestions: 'suggestions' };
    if (simple[cmd]) action = { type: simple[cmd], chat_id };
    else if (cmd === 'selftest' || cmd === 'test') ctx.selftest = true;   // handled by the Self-test workflow
    else if (['testsend', 'sendtest', 'testemail'].includes(cmd)) ctx.testsend = true;   // handled by the Test send workflow
    else if (cmd === 'newskey' && rest) { action = { type: 'set_news_key', chat_id, key: rest.split(/\s+/)[0] }; ctx.user_msg_id = msg.message_id; }
    else if (cmd === 'intro' && rest) action = { type: 'set_intro', chat_id, text: rest };
    else if (cmd === 'voicerule') action = { type: 'voice_rule', chat_id, text: rest };
    else if (cmd === 'sponsor' && rest) {
      const [t, link] = rest.split('|').map((x) => x.trim());
      action = { type: 'sponsor', chat_id, text: t, url: (link && URL_RE.test(link)) ? link.match(URL_RE)[0] : ((t.match(URL_RE) || [])[0] || null) };
    } else if (cmd === 'suggest' && URL_RE.test(rest)) {
      const url = rest.match(URL_RE)[0];
      action = { type: 'suggest', chat_id, url, note: rest.replace(url, '').trim() };
    } else ctx.help = true;                       // /start, /help, unknown, empty /intro
  } else if (text || ent) {
    const m = text.match(URL_RE);
    const url = m ? m[0] : (ent ? ent.url : null);
    action = { type: 'text', chat_id, text, url: url ? url.replace(/[).,]+$/, '') : null, note: url ? text.replace(m ? m[0] : '', '').trim().slice(0, 300) : null };
  }
}
// links get their title/description fetched before saving
const fetch_url = (action.url && (action.type === 'text' || action.type === 'suggest')) ? action.url : 'about:blank';
return [{ json: { action, ctx, fetch_url } }];
