// List the shortlisted stories (picks + alternates) whose full text we try to read
const v = $input.first().json;
const ctx = $('Load context').first().json.ctx;
const byId = Object.fromEntries(ctx.candidates.map((c) => [String(c.id), c]));
const items = [];
for (const p of [...v.selection.picks, ...v.selection.alternates]) {
  const c = byId[String(p.id)];
  if (!c || !c.url) continue;
  // Google News links are encrypted redirects; the teaser is all we can get for them
  const readable = !/^https?:\/\/news\.google\./i.test(c.url);
  items.push({ json: { id: p.id, url: readable ? c.url : 'about:blank', skip: !readable } });
}
return items.length ? items : [{ json: { id: null, url: 'about:blank', skip: true } }];
