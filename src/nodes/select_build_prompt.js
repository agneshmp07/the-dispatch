// Guard + build the Gemini editorial-selection request
const ctx = $input.first().json.ctx;
const cfg = ctx.config;
const min = num(cfg.min_stories, 8), max = num(cfg.max_stories, 10), minT = num(cfg.min_topics, 3), nAlt = num(cfg.num_alternates, 6);
if (['approved', 'sending', 'sent'].includes(ctx.existing_status)) {
  throw new Error(`This week's issue is already ${ctx.existing_status}; not regenerating.`);
}
if (ctx.candidate_count < min) {
  throw new Error(`Only ${ctx.candidate_count} fresh candidate articles this week (need ≥${min}). Check the sources in the ingest workflow.`);
}
const topics = cfgList(cfg.topics);
const lines = ctx.candidates.map((c) =>
  `[${c.id}]${c.pinned ? ' [MUST INCLUDE: editor\'s pick]' : ''} ${c.title} | ${c.source || 'unknown'} | coverage:${c.coverage} | ${c.published_at ? String(c.published_at).slice(0, 10) : ''}\n    ${String(c.summary || '').slice(0, 260)}${c.note ? `\n    Editor's note: ${String(c.note).slice(0, 200)}` : ''}`);
const recent = ctx.recent_coverage.map((r) => `- (${r.week}) ${r.title}`).join('\n') || '(none yet)';

const system = `You are the research editor for "${cfg.newsletter_name || 'The Dispatch'}", a weekly newsletter on the Indian startup ecosystem read by founders, operators and investors (38% open rate; readers expect sharp curation, not a news roundup).

Your job: from this week's batch of candidate articles, select the stories with the highest signal-to-noise relative to the rest of the batch.

Editorial criteria (in priority order):
1. Counterintuitive: the story cuts against the prevailing narrative or reveals a surprising number/decision.
2. Under-reported: matters more than its coverage suggests. "coverage" = how many outlets ran the same story; low coverage plus high importance is ideal.
3. Connective: links two trends nobody else has linked (e.g. a policy change that reshapes a funding pattern).
4. Consequential for Indian startups: money, regulation, market structure, talent, exits.
Penalise: routine funding announcements with no angle, PR puff, listicles, opinion pieces without news, global stories with no India angle, and anything that is the same story as one already covered in the last four issues (list provided), even if the headline differs.

Hard rules:
- Pick between ${min} and ${max} stories (aim for ${max}). Never pick two articles about the same underlying story.
- The picks must span at least ${minT} different topic areas.
- Assign each pick exactly one topic from this list: ${topics.join(' | ')}.
- Also return ${nAlt} ranked alternates (next-best stories, different from the picks, ideally covering varied topics) for the editor to swap in.
- "reason": one short sentence on why it earns a slot (what is the non-obvious angle).
- Use only ids that appear in the candidate list.
- Candidates marked [MUST INCLUDE: editor's pick] were chosen by the editor herself: always include them in picks (they count toward the total) and build the rest of the selection around them.`;

const user = `ALREADY COVERED IN THE LAST FOUR ISSUES (do not repeat these stories):\n${recent}\n\nTHIS WEEK'S CANDIDATES (${ctx.candidate_count}):\n${lines.join('\n')}`;

const item = { type: 'OBJECT', properties: { id: { type: 'INTEGER' }, topic: { type: 'STRING', enum: topics }, reason: { type: 'STRING' } }, required: ['id', 'topic', 'reason'] };
const request = {
  systemInstruction: { parts: [{ text: system }] },
  contents: [{ role: 'user', parts: [{ text: user }] }],
  generationConfig: {
    temperature: 0.4,
    responseMimeType: 'application/json',
    responseSchema: { type: 'OBJECT', properties: { picks: { type: 'ARRAY', items: item }, alternates: { type: 'ARRAY', items: item } }, required: ['picks', 'alternates'] },
  },
};
return [{ json: { request, model: cfg.gemini_model_select || 'gemini-3.8-flash', week_start: ctx.week_start } }];
