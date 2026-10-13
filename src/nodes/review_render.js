// Turn the DB result into Telegram API calls
const r = $input.first().json.r;
const { ctx } = $('Decide action').first().json;
const cfg = $('Load config').first().json.cfg;
const chat_id = ctx.chat_id;
const calls = [];
const send = (text, extra) => calls.push({ method: 'sendMessage', body: Object.assign({ chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, extra || {}) });
const editItem = (it) => {
  const message_id = it.telegram_msg_id || ctx.message_id;
  if (!message_id) return;
  calls.push({ method: 'editMessageText', body: { chat_id, message_id, text: renderItem(it), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: itemKeyboard(it) } });
};
const clearButtons = () => ctx.message_id && calls.push({ method: 'editMessageReplyMarkup', body: { chat_id, message_id: ctx.message_id, reply_markup: { inline_keyboard: [] } } });

if (ctx.callback_id) {
  calls.push({ method: 'answerCallbackQuery', body: { callback_query_id: ctx.callback_id, text: String(r.message || (r.ok ? 'Done' : 'Not possible')).slice(0, 190), show_alert: !r.ok } });
}

if (ctx.user_msg_id && !ctx.unauthorized) {             // never leave an API key sitting in the chat
  calls.push({ method: 'deleteMessage', body: { chat_id, message_id: ctx.user_msg_id } });
}
if (ctx.voice !== undefined && !ctx.unauthorized) {
  send(ctx.voice_failed
    ? '🎙 Sorry, I couldn\'t make that out. Try again a little slower, or type it.'
    : `🎙 <i>I heard:</i> “${esc(ctx.voice)}”`);
}
if (ctx.unauthorized) {
  send(`This is a private bot. Your chat ID is <code>${esc(chat_id)}</code>.`);
} else if (ctx.testsend) {
  send('📧 Sending a test copy of the current draft to your own inbox (not to subscribers). It arrives in about a minute.');
} else if (ctx.selftest) {
  send('🧪 <b>Self-test started.</b> In the next ~40 seconds I\'ll send myself help, alternates, stats and a news link, and you\'ll see each reply here. A report follows at the end. The test link is unpinned afterwards.');
} else if (ctx.help) {
  send(HELP);
} else if (!r.ok) {
  if (!ctx.callback_id) send(esc(r.message || 'Something went wrong.'));
} else {
  const v = r.view;
  switch (r.type) {
    case 'keep': case 'drop': case 'restore': case 'swap':
      if (r.item) editItem(r.item);
      if (r.type === 'swap' && v.alternates_left === 0) send('ℹ️ That was the last alternate for this week.');
      break;
    case 'edit_start': {
      const it = r.item;
      send(`✏️ Editing <b>#${it.position}</b>: ${esc(it.title)}\n\nCurrent commentary:\n<code>${esc(it.commentary || '')}</code>\n\nReply with the replacement text (tap the code above to copy it), or /cancel.`,
        { reply_markup: { force_reply: true, input_field_placeholder: 'New commentary…' } });
      break;
    }
    case 'edit_text':
      if (r.item) editItem(r.item);
      send(`✅ ${esc(r.message)}\n${summaryLine(v)}`);
      break;
    case 'request_approve': {
      const chunks = previewChunks(v, cfg);
      chunks.forEach((c, i) => send(c, i === chunks.length - 1 ? { reply_markup: confirmKeyboard(v.issue.id) } : {}));
      break;
    }
    case 'confirm':
      clearButtons();
      send(`✅ <b>Approved: Issue #${esc(v.issue.issue_no)}</b>\n${r.queued} subscribers queued. Sending starts <b>${istDate(v.send_at)}</b> IST.\nChanged your mind? Send /unapprove before then.`);
      break;
    case 'cancel':
      if (ctx.callback_id) clearButtons(); else send('Cancelled.');
      break;
    case 'unapprove':
      send(esc(r.message));
      break;
    case 'status':
      send(`<b>Issue status:</b> ${esc(v.issue.status)}${v.issue.issue_no ? ' (#' + esc(v.issue.issue_no) + ')' : ''}\n${summaryLine(v)}\nActive subscribers: ${v.active_subscribers}\nSend time: ${istDate(v.send_at)} IST` +
        (v.issue.status === 'in_review' ? '\n\nSend /approve when ready.' : ''));
      break;
    case 'preview':
      previewChunks(v, cfg).forEach((c) => send(c));
      break;
    case 'text':
    case 'suggest':
      if (r.type === 'suggest' || r.title) {
        send(`📌 <b>Saved for the next draft</b>\n${esc(r.title || '')}\n\nIt's guaranteed a place among Wednesday's stories (${esc(r.pinned_count || 1)} pick${r.pinned_count > 1 ? 's' : ''} so far). Add a note after the link next time and Gemini will use it.`);
      } else if (r.item) { editItem(r.item); send(`✅ ${esc(r.message)}\n${summaryLine(v)}`); }
      break;
    case 'read_story': {
      const body = r.full_text || r.summary || '';
      send(`📖 <b>#${esc(r.position)} ${esc(r.title)}</b>\n<i>${esc(r.source || '')}</i>\n\n` +
        (r.full_text ? esc(body.slice(0, 3200)) + (body.length > 3200 ? '…' : '') + '\n\n<i>This is the text Gemini read before writing the commentary.</i>'
                     : (body ? esc(body.slice(0, 1500)) + '\n\n' : '') + '<i>The full article couldn\'t be read (paywall or blocked), so Gemini worked from the summary.</i>') +
        `\n\n<a href="${esc(r.url)}">Open the article</a>`);
      break;
    }
    case 'suggestions': {
      const list = r.list || [];
      if (!list.length) { send('📮 No new reader suggestions. They come in from the “Suggest a story” form on the website.'); break; }
      send(`📮 <b>Reader suggestions</b> (${list.length})\n\n` + list.map((s) =>
        `<b>#${s.id}</b> <a href="${esc(s.url)}">${esc(s.title || s.url)}</a>${s.name ? ` <i>from ${esc(s.name)}</i>` : ''}${s.note ? `\n   “${esc(s.note)}”` : ''}`).join('\n\n') +
        `\n\nType <b>take ${list[0].id}</b> to add one to the next draft, or <b>skip ${list[0].id}</b> to dismiss it.`);
      break;
    }
    case 'take_suggestion':
      send(`📌 <b>Reader suggestion #${esc(r.id)} added</b>\n${esc(r.title || '')}\n\nIt's guaranteed a place in the next draft.`);
      break;
    case 'skip_suggestion':
      send(`Skipped suggestion #${esc(r.id)}. ${r.left ? `${r.left} still waiting (send <b>suggestions</b>).` : 'None left.'}`);
      break;
    case 'voice_show': {
      const rules = r.rules || [];
      send(`🗣 <b>Shreya's voice</b>\n` + (r.stance ? `\n${esc(String(r.stance).replace(/\*\*/g, '').replace(/\s*\n\s+/g, ' ').slice(0, 1400))}\n` : '') +
        `\nEdits Gemini has learned from: <b>${esc(r.edits || 0)}</b>` + (r.edit_rate != null ? ` · you edit ${esc(r.edit_rate)}% of stories` : '') +
        (rules.length ? `\n\n<b>Your house rules</b>\n${rules.map((x, i) => `${i + 1}. ${esc(x)}`).join('\n')}` : '') +
        `\n\nAdd a rule: <b>voicerule</b> never call a valuation an achievement\nFull guide: ${esc(String(cfg.site_url || 'https://the-dispatch-india.vercel.app').replace(/\/$/, ''))}/dashboard?p=voice`);
      break;
    }
    case 'voice_rule':
      send(`✅ House rule #${esc(r.rules)} added to the voice guide:\n<i>${esc(r.rule)}</i>\n\nGemini uses it from the next draft.`);
      break;
    case 'set_intro':
      send(`✅ Intro updated:\n<i>${esc(v.issue.intro || '')}</i>`);
      break;
    case 'sponsor':
      send(`✅ Sponsor block added:\n${esc(v.issue.sponsor && v.issue.sponsor.text)}${v.issue.sponsor && v.issue.sponsor.url ? '\n' + esc(v.issue.sponsor.url) : ''}\nRemove with /nosponsor.`);
      break;
    case 'nosponsor':
      send('Sponsor block removed.');
      break;
    case 'alternates': {
      const alts = r.alternates || [];
      if (!alts.length) { send('No runners-up left for this draft.'); break; }
      const lines = alts.map((a, i) => `<b>${i + 1}.</b> ${esc(a.title)} <i>[${esc(a.topic)}]</i>${a.reason ? '\n   ' + esc(a.reason) : ''}`);
      send(`<b>Runners-up</b> (tap to add one to the draft):\n\n${lines.join('\n\n')}`.slice(0, 4000),
        { reply_markup: { inline_keyboard: alts.slice(0, 10).map((a, i) => [{ text: `➕ ${i + 1}. ${a.title}`.slice(0, 60), callback_data: `p:${a.item_id}` }]) } });
      break;
    }
    case 'add_alt':
      if (ctx.message_id) calls.push({ method: 'editMessageReplyMarkup', body: { chat_id, message_id: ctx.message_id, reply_markup: { inline_keyboard: [] } } });
      if (r.item) calls.push({ method: 'sendMessage', body: { chat_id, text: renderItem(r.item), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: itemKeyboard(r.item) } });
      send(summaryLine(v));
      break;
    case 'set_news_key':
      send(`🔑 News API key saved (${esc(r.masked)}) and your message deleted. ${r.sources} news API source${r.sources === 1 ? '' : 's'} will be read from the next ingestion run.`);
      break;
    case 'clear_demo': {
      const c = r.cleared || {};
      send(c.subscribers || c.issues ? `🧹 Demo data removed: ${c.subscribers} fake subscribers, ${c.issues} fake issues, ${c.events} fake email events. Stats now show only real data.` : 'There was no demo data to remove.');
      break;
    }
    case 'stats': {
      const s = r.stats || {}; const sub = s.subscribers || {}; const last = (s.issues || []).slice(-1)[0];
      const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : 'n/a');
      const bad = (s.sources || []).filter((x) => !x.ok).map((x) => x.name);
      send(`<b>📊 The Dispatch: stats</b>\nActive subscribers: <b>${sub.active || 0}</b> (+${sub.new_7d || 0} this week, ${sub.web_signups || 0} from the website)\nUnsubscribed: ${sub.unsubscribed || 0} · Bounced: ${sub.bounced || 0}` +
        (last ? `\n\n<b>Last issue #${esc(last.issue_no)}</b>\nSent ${last.sent} · Opened ${last.opened} (${pct(last.opened, last.delivered || last.sent)}) · Clicked ${last.clicked} (${pct(last.clicked, last.delivered || last.sent)})` : '') +
        `\n\nArticles collected this week: ${s.articles_this_week || 0}` + (bad.length ? `\n⚠️ Broken sources: ${esc(bad.join(', '))}` : '\nAll sources healthy ✅'));
      break;
    }
  }
}
return calls.map((c) => ({ json: c }));
