// Keep Shreya's Telegram cards in step with what she did on the website (edits only, no new messages)
return $input.all().map((i) => i.json)
  .filter((c) => (c.method === 'editMessageText' || c.method === 'editMessageReplyMarkup') && c.body && c.body.message_id)
  .map((c) => ({ json: c }));
