// Build a Gemini request that transcribes Shreya's voice note and maps it to a bot command
const cfg = $('Load config').first().json.cfg;
const item = $input.first();
const bin = item.binary && item.binary.data;
if (!bin) return [{ json: { skip: true } }];
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
let mime = String(bin.mimeType || 'audio/ogg');
if (!mime.startsWith('audio/')) mime = 'audio/ogg';
const prompt = [
  'You are the voice interface of a Telegram bot that helps an editor review her weekly newsletter draft.',
  'Transcribe the voice note faithfully in English (it may mix English and Hindi; write Hindi words in English letters).',
  'Then map it to ONE bot command, or return an empty command if it is dictated text rather than a command.',
  'Allowed commands (output exactly this form):',
  '  keep N | drop N | swap N | restore N | edit N | edit N: <new commentary exactly as spoken>',
  '  status | preview | alternates | stats | approve | unapprove | cancel | nosponsor | selftest | help',
  '  intro <text> | sponsor <text> | <link if spoken>',
  'N is the story number (1-12). Spoken numbers like "third" or "number three" become 3.',
  'Never invent a command that was not clearly asked for. If unsure, return an empty command.',
  'Examples: "drop the third one" -> "drop 3"; "replace story five" -> "swap 5";',
  '"change two to say funding is drying up in tier two cities" -> "edit 2: Funding is drying up in tier-two cities.";',
  '"okay looks good, approve it" -> "approve"; "set the intro to quiet week for funding" -> "intro Quiet week for funding."',
].join('\n');
return [{ json: {
  model: cfg.gemini_model_write || cfg.gemini_model_select || 'gemini-3.8-flash',
  request: {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { transcript: { type: 'STRING' }, command: { type: 'STRING' } }, required: ['transcript', 'command'] } },
  },
} }];
