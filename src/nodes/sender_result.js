// Runs once per Gmail result (success or error output); pairs it back to its delivery
const src = $('Render emails').item.json;
const j = $json;
const ok = !!(j && (j.messageId || j.id) && !j.error && !j.code);
const err = ok ? null : (j.message || (j.error && (j.error.message || j.error.description || JSON.stringify(j.error)))) || 'send failed';
return { json: { b64: toB64([{ delivery_id: src.delivery_id, ok, gmail_id: ok ? (j.messageId || j.id) : null, error: err }]) } };
