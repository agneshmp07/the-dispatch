// Reader suggestion from the website form: tidy the input and decide whether the link is safe to fetch
let b = $input.first().json.body;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
b = b || {};
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);
const s = { url: clip(b.url, 600), note: clip(b.note, 400), name: clip(b.name, 80), email: clip(b.email, 200), website: clip(b.website, 100) };
let fetch_url = 'about:blank';
// (no URL class in the n8n sandbox, so parse by hand) only public http(s) pages by name:
// no IP literals, no user:pass@, no odd ports, no local or internal hosts
const m = s.url.match(/^(https?):\/\/([a-z0-9.-]+)(?::(\d+))?([\/?#][^\s]*)?$/i);
if (m) {
  const host = m[2].toLowerCase(), port = m[3];
  const ipLike = /^[0-9.]+$/.test(host);
  const local = /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host) || !host.includes('.');
  if (!ipLike && !local && (!port || port === '80' || port === '443')) fetch_url = s.url;
}
if (s.website) fetch_url = 'about:blank';            // honeypot filled: don't bother fetching
return [{ json: { s, fetch_url } }];
