// Merge the fetched page's title/description into the action, then encode it
const d = $('Decide action').first().json;
const action = Object.assign({}, d.action);
const page = $input.first().json || {};
const html = typeof page.data === 'string' ? page.data.slice(0, 200000) : '';
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&nbsp;': ' ', '&#x27;': "'", '&ndash;': '-', '&mdash;': '-' };
const dec = (s) => String(s || '').replace(/&[#a-z0-9]+;/gi, (m) => ENT[m.toLowerCase()] || (/^&#\d+;$/.test(m) ? String.fromCharCode(+m.slice(2, -1)) : ' ')).replace(/\s+/g, ' ').trim();
const meta = (prop) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re); return m ? dec(m[1] || m[2]) : '';
};
if (action.url && html) {
  const t = meta('og:title') || meta('twitter:title') || dec((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  action.title = t.replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, '').slice(0, 300) || null;
  action.summary = (meta('og:description') || meta('description')).slice(0, 1000) || null;
  action.site = meta('og:site_name') || null;
}
if (action.url) {
  try { const x = new URL(action.url); x.hash = ''; x.hostname = x.hostname.replace(/^www\./, '');
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|igshid$|mc_)/i.test(k)) x.searchParams.delete(k);
    action.canon = x.toString().replace(/\/$/, ''); } catch (e) {}
}
const toB64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
return [{ json: { action, ctx: d.ctx, b64: toB64(action) } }];
