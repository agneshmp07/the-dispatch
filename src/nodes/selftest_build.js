// Fake Telegram updates from Shreya's chat, posted to the bot's own webhook
const cfg = $('Load config').first().json.cfg;
const chat = Number(cfg.telegram_chat_id);
const link = ($('Pick a news link').first().json.url) || 'https://inc42.com/';
const base = Math.floor(Date.now() / 1000);
const texts = ['help', 'alternates', 'stats', link + ' self-test (auto-removed)'];
return texts.map((text, i) => {
  const isCmd = !text.startsWith('http');
  const first = text.split(' ')[0];
  return { json: { step: isCmd ? first : 'paste a link', body: {
    update_id: base * 10 + i,
    message: {
      message_id: base * 10 + i, date: base,
      chat: { id: chat, type: 'private' },
      from: { id: chat, is_bot: false, first_name: 'Self-test' },
      text,
      entities: isCmd ? [] : [{ offset: 0, length: first.length, type: 'url' }],
    } } } };
});
