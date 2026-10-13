// Website microphone: the page records a short WAV; Gemini transcribes it and maps it to a command
const cfg = $('Load config').first().json.cfg;
let b = $('Talk').first().json.body;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
const audio = String((b && b.audio) || '').replace(/^data:[^,]*,/, '');
if (!/^[A-Za-z0-9+/=]+$/.test(audio) || audio.length > 4000000) return [{ json: { skip: true } }];
const prompt = [
  'You are the voice interface of a newsletter assistant that helps an editor review her weekly draft.',
  'Transcribe the recording faithfully in English (it may mix English and Hindi; write Hindi words in English letters).',
  'Then map it to ONE assistant command, or return an empty command if it is dictated text or a question rather than a command.',
  'Allowed commands (output exactly this form):',
  '  keep N | drop N | swap N | restore N | edit N | edit N: <new commentary exactly as spoken> | read N',
  '  status | preview | alternates | stats | approve | unapprove | cancel | nosponsor | help | voice | suggestions | take N | skip N',
  '  intro <text> | sponsor <text> | voicerule <rule> | <link if spoken>',
  'N is the story or suggestion number. Spoken numbers like "third" or "number three" become 3.',
  'Never invent a command that was not clearly asked for. If unsure, return an empty command.',
  'Examples: "drop the third one" -> "drop 3"; "what did Gemini read for story two" -> "read 2";',
  '"any reader suggestions?" -> "suggestions"; "add a rule: never call a valuation a win" -> "voicerule never call a valuation a win";',
  '"okay looks good, approve it" -> "approve"; "set the intro to quiet week for funding" -> "intro Quiet week for funding."',
].join('\n');
return [{ json: {
  model: cfg.gemini_model_write || cfg.gemini_model_select || 'gemini-3.8-flash',
  request: {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: audio } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { transcript: { type: 'STRING' }, command: { type: 'STRING' } }, required: ['transcript', 'command'] } },
  },
} }];
