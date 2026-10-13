// Brevo webhook: one event object (or a batch) -> base64 for the database
let b = $input.first().json.body;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
if (!b) return [{ json: { b64: Buffer.from('[]').toString('base64') } }];
return [{ json: { b64: Buffer.from(JSON.stringify(b), 'utf8').toString('base64') } }];
