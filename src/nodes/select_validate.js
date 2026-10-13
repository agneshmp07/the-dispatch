// Validate + deterministically repair Gemini's selection, then build the commentary request
const ctx = $('Load context').first().json.ctx;
const cfg = ctx.config;
const sel = geminiJson($input.first().json);
const result = repairSelection(sel, ctx.candidates, cfg);
const byId = Object.fromEntries(ctx.candidates.map((c) => [String(c.id), c]));

const stories = [...result.picks, ...result.alternates].map((p) => {
  const c = byId[String(p.id)];
  return `[${p.id}] ${c.title} (${c.source || 'unknown'}) [${p.topic}]\n    Summary: ${String(c.summary || '').slice(0, 500)}\n    Why it was picked: ${p.reason || ''}${c.note ? `\n    Editor's note (use this angle): ${String(c.note).slice(0, 300)}` : ''}`;
}).join('\n');
const edits = (ctx.edit_examples || []).map((e) => `Story: ${e.title}\nAI draft: ${e.draft}\nShreya's final: ${e.shreya_final}`).join('\n---\n');
const voice = (ctx.voice_samples || []).map((v) => `- ${v.title}: ${v.commentary}`).join('\n');

const system = `You write the commentary lines for "${cfg.newsletter_name || 'The Dispatch'}" in the voice of its editor, Shreya. Follow her style guide exactly.

=== STYLE GUIDE ===
${cfg.style_guide || ''}
=== END STYLE GUIDE ===
${voice ? `\nRecent published commentary (match this voice):\n${voice}\n` : ''}${edits ? `\nHow Shreya rewrites AI drafts (learn from the differences):\n${edits}\n` : ''}
Rules: for every story write two to three sentences (about 35–75 words). Say why it matters or what's non-obvious; never just restate the headline. Use only facts in the summary: do not invent numbers, names or quotes. No hype words, no emojis, no hashtags. Plain text only.`;
const request = {
  systemInstruction: { parts: [{ text: system }] },
  contents: [{ role: 'user', parts: [{ text: `Write commentary for each story below. Return every id.\nAlso write "intro": two sentences (max 45 words) naming the thread that runs through this week's PICKS (the first ${result.picks.length} stories), in the same voice. No greeting, no "this week we".\n\n${stories}` }] }],
  generationConfig: {
    temperature: 0.7,
    responseMimeType: 'application/json',
    responseSchema: { type: 'OBJECT', properties: { intro: { type: 'STRING' }, items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' }, commentary: { type: 'STRING' } }, required: ['id', 'commentary'] } } }, required: ['intro', 'items'] },
  },
};
return [{ json: { request, model: cfg.gemini_model_write || cfg.gemini_model_select || 'gemini-3.8-flash', selection: result } }];

function repairSelection(sel, candidates, cfg) {
  const min = num(cfg.min_stories, 8), max = num(cfg.max_stories, 10), minT = num(cfg.min_topics, 3), nAlt = num(cfg.num_alternates, 6);
  const topics = cfgList(cfg.topics);
  const valid = new Set(candidates.map((c) => String(c.id)));
  const fixTopic = (t) => topics.find((x) => x.toLowerCase() === String(t || '').toLowerCase().trim()) || topics[topics.length - 1] || 'General';
  const seen = new Set();
  const clean = (arr) => (Array.isArray(arr) ? arr : []).filter((p) => p && valid.has(String(p.id)) && !seen.has(String(p.id)) && seen.add(String(p.id)))
    .map((p) => ({ id: Number(p.id), topic: fixTopic(p.topic), reason: String(p.reason || '').slice(0, 300) }));
  let picks = clean(sel.picks);
  let alternates = clean(sel.alternates);
  const warnings = [];
  // editor's picks are guaranteed a slot
  const pinned = candidates.filter((c) => c.pinned).slice(0, max);
  for (const c of pinned) {
    const sid = String(c.id);
    if (picks.some((p) => String(p.id) === sid)) continue;
    const ai = alternates.findIndex((a) => String(a.id) === sid);
    const entry = ai >= 0 ? alternates.splice(ai, 1)[0] : { id: Number(c.id), topic: topics[topics.length - 1] || 'General', reason: "Editor's pick" };
    entry.reason = entry.reason || "Editor's pick";
    picks.unshift(entry);
  }
  const isPinned = (p) => pinned.some((c) => String(c.id) === String(p.id));
  while (picks.length > max) {
    let i = picks.length - 1; while (i >= 0 && isPinned(picks[i])) i--;
    if (i < 0) break;
    alternates.unshift(picks.splice(i, 1)[0]);
  }
  while (picks.length < min && alternates.length) picks.push(alternates.shift());
  const distinct = () => new Set(picks.map((p) => p.topic)).size;
  let guard = 0;
  while (distinct() < minT && guard++ < 10) {
    const have = new Set(picks.map((p) => p.topic));
    const ai = alternates.findIndex((a) => !have.has(a.topic));
    if (ai < 0) break;
    const counts = {}; picks.forEach((p) => (counts[p.topic] = (counts[p.topic] || 0) + 1));
    let ri = -1;
    for (let i = picks.length - 1; i >= 0; i--) if (counts[picks[i].topic] > 1 && !isPinned(picks[i])) { ri = i; break; }
    if (ri < 0) break;
    const [out] = picks.splice(ri, 1, alternates.splice(ai, 1)[0]);
    alternates.unshift(out);
  }
  if (picks.length < min) throw new Error(`Gemini returned only ${picks.length} usable picks (need ${min}).`);
  if (distinct() < minT) warnings.push(`Selection spans only ${distinct()} topics`);
  return { picks, alternates: alternates.slice(0, nAlt), warnings };
}
