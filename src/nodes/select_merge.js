// Merge commentary into the selection and build the save_draft payload
const prev = $('Validate selection').first().json;
const ctx = $('Load context').first().json.ctx;
const out = geminiJson($input.first().json);
const byId = {};
for (const it of out.items || []) byId[String(it.id)] = String(it.commentary || '').trim();
const attach = (p) => ({ article_id: p.id, topic: p.topic, reason: p.reason, commentary: byId[String(p.id)] || '' });
const payload = {
  week_start: ctx.week_start,
  intro: String(out.intro || '').trim().slice(0, 600) || null,
  model: `${prev.model}`,
  picks: prev.selection.picks.map(attach),
  alternates: prev.selection.alternates.map(attach),
};
return [{ json: { b64: toB64(payload), warnings: prev.selection.warnings } }];
