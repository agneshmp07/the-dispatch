// Pair Telegram responses with item ids so later edits can update messages in place
const sent = $('Build Telegram messages').all();
const res = $input.all();
const pairs = [];
res.forEach((r, i) => {
  const item_id = sent[i] && sent[i].json.item_id;
  const message_id = r.json && r.json.result && r.json.result.message_id;
  if (item_id && message_id) pairs.push({ item_id, message_id });
});
const failed = res.filter((r) => !(r.json && r.json.ok)).map((r) => r.json && r.json.description).filter(Boolean);
if (failed.length) console.log('Telegram send failures', failed);
return [{ json: { b64: toB64(pairs), recorded: pairs.length, failed } }];
