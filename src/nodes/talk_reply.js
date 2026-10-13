// Turn the bot's Telegram calls into a chat reply for the website
const calls = $input.all().map((i) => i.json);
const d = $('Decide action').first().json;
const replies = [];
let expectReply = false;
for (const c of calls) {
  const b = c.body || {};
  if (c.method === 'sendMessage' || c.method === 'editMessageText') {
    if (!b.text) continue;
    const kb = (b.reply_markup && b.reply_markup.inline_keyboard) || [];
    // buttons the website can press (everything except the final send confirmation)
    const buttons = kb.flat().filter((x) => x.callback_data && /^[kdrsepax]:\d+$/.test(x.callback_data)).map((x) => ({ text: x.text, data: x.callback_data }));
    const confirmInTelegram = kb.flat().some((x) => /^c:/.test(x.callback_data || ''));
    if (b.reply_markup && b.reply_markup.force_reply) expectReply = true;
    replies.push({ html: b.text, buttons, confirmInTelegram });
  } else if (c.method === 'answerCallbackQuery' && b.text && !calls.some((x) => x.method === 'sendMessage')) {
    replies.push({ html: String(b.text).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])), buttons: [] });
  }
}
let heard = null;
try { const v = $('Voice text').first().json; heard = v.failed ? '' : (v.transcript || ''); } catch (e) { heard = null; }
return [{ json: { ok: true, heard, expectReply, replies: replies.slice(0, 20), action: d.action && d.action.type } }];
