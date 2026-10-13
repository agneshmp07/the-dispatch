// Parse Gemini's transcription; on any failure, report it instead of guessing
let out = { transcript: '', command: '', failed: true };
try {
  const j = geminiJson($input.first().json);
  out = { transcript: String(j.transcript || '').trim().slice(0, 1500), command: String(j.command || '').trim().slice(0, 1500), failed: false };
  if (!out.transcript) out.failed = true;
} catch (e) { out.error = String(e.message || e).slice(0, 200); }
return [{ json: out }];
