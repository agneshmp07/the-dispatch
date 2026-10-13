// Website "Talk" page: check the dashboard key, then turn the request into the same
// update the Telegram bot understands, so the website and Telegram share one brain.
const cfg = $('Load config').first().json.cfg;
let b = $('Talk').first().json.body;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
b = b || {};
const key = String(b.key || '');
if (!cfg.dashboard_key || key.length < 8 || key !== String(cfg.dashboard_key)) return [{ json: { _stop: 'unauthorized' } }];
const chat = { id: Number(cfg.telegram_chat_id) || String(cfg.telegram_chat_id), type: 'private' };
const now = Math.floor(Date.now() / 1000);
if (b.callback) {
  // story buttons from the website; the final "Confirm & schedule send" stays Telegram-only
  const data = String(b.callback).slice(0, 40);
  if (!/^[kdrsepax]:\d+$/.test(data)) return [{ json: { _stop: 'bad_button' } }];
  return [{ json: { update_id: now, callback_query: { id: 'web-' + now, data, message: { message_id: 0, chat } } } }];
}
const text = String(b.text || '').replace(/[\u0000-\u0008\u000b-\u001f]+/g, ' ').trim().slice(0, 2000);
const hasAudio = typeof b.audio === 'string' && b.audio.length > 100;
if (!text && !hasAudio) return [{ json: { _stop: 'empty' } }];
const msg = { message_id: now, date: now, chat, from: { id: chat.id, is_bot: false, first_name: 'Shreya (website)' }, text };
if (b.reply) msg.reply_to_message = { message_id: 0, from: { is_bot: true } };   // answering the bot's "edit" prompt
if (hasAudio) msg.voice = { file_id: 'web', mime_type: 'audio/wav' };
return [{ json: Object.assign({ update_id: now, message: msg }, hasAudio ? { _audio: true } : {}) }];
