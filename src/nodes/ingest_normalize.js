// Normalise one feed's items into an ingest payload (runs once per feed in the loop)
const src = $('Loop feeds').first().json;
let rows = $input.all().map((i) => i.json);
if (src.kind === 'newsdata') {                         // news API JSON -> RSS-like rows
  const j = rows[0] || {};
  if (j.status !== 'success') {
    const msg = (j.results && j.results.message) || j.message || j.error || ('HTTP ' + (j.statusCode || 'error'));
    rows = [{ error: 'News API: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 200) }];
  } else {
    rows = (j.results || []).map((a) => ({ link: a.link, title: a.title, description: a.description,
      isoDate: a.pubDate ? String(a.pubDate).replace(' ', 'T') + 'Z' : null, _source: a.source_name || a.source_id, _image: a.image_url || null }));
  }
}
const TRACKING = /^(utm_|fbclid$|gclid$|ref$|ref_src$|mc_|igshid$|cmpid$|ito$|from$|source$)/i;
function canon(u) {
  try {
    const x = new URL(String(u).trim());
    x.hash = '';
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    return x.toString().replace(/\/$/, '');
  } catch (e) { return String(u || '').trim(); }
}
const strip = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#8217;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
  .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();

// Distinctive tokens (companies, people, numbers) used to stop formulaic headlines
// ("X raises Series A") from being mistaken for the same story.
const STOP = new Set(('a an the and or of in on for to with by at from as is are was were be its it this that new first after over into amid via vs than '+
  'india indias indian startup startups unicorn company companies firm founder founders ceo cofounder report reports sources says said '+
  'raises raised raise funding round series seed pre led leads backed investors investor invest invests investment vc vcs fund funds '+
  'acquires acquire acquisition buys buy merger merges stake valuation crore cr lakh million billion mn bn usd rs inr '+
  'launches launch launched unveils rolls out expands expansion enters entry plans plan eyes set sets bets bet '+
  'files filing drhp ipo listing listed public market markets shares share stock stocks '+
  'cuts cut layoffs layoff lays off jobs employees staff hiring hires appoints exits exit quits resigns '+
  'posts profit profitable loss losses revenue revenues quarter fy fy24 fy25 fy26 q1 q2 q3 q4 growth grows jumps falls rises '+
  'ai tech app platform deal deals business sector industry week year today why how what who').split(/\s+/));
function entities(title) {
  const out = new Set();
  for (const w of String(title).split(/[^A-Za-z0-9&]+/)) {
    const lw = w.toLowerCase();
    if (w.length < 2 || STOP.has(lw)) continue;
    if (/^[A-Z]/.test(w) || /\d/.test(w) || /[A-Z]{2,}/.test(w)) out.add(lw);
  }
  return [...out].slice(0, 12);
}

// the article's own picture, when the feed carries one (enclosure, media tag or first <img> in the body)
function imageOf(r) {
  const ok = (u) => (typeof u === 'string' && /^https:\/\/\S+$/i.test(u.trim()) ? u.trim() : null);
  if (r._image) return ok(r._image);
  const enc = r.enclosure || {};
  if (enc.url && (/^image\//i.test(enc.type || '') || /\.(jpe?g|png|webp)(\?|$)/i.test(enc.url))) return ok(enc.url);
  for (const k of ['media:content', 'media:thumbnail', 'mediaContent', 'mediaThumbnail']) {
    const m = r[k]; const u = m && (m.url || (m.$ && m.$.url) || (Array.isArray(m) && m[0] && (m[0].url || (m[0].$ && m[0].$.url))));
    if (u) return ok(u);
  }
  const html = String(r['content:encoded'] || r.content || r.description || '');
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return img ? ok(img[1].replace(/&amp;/g, '&')) : null;
}

let payload;
if (rows.length === 1 && rows[0].error) {
  const e = rows[0].error;
  payload = { source_id: src.source_id, error: typeof e === 'string' ? e : (e.message || JSON.stringify(e)) };
} else {
  const items = [];
  for (const r of rows) {
    if (!r || !r.link || !r.title) continue;
    let title = strip(r.title), source_name = r._source || null;
    if (src.kind === 'gnews') {                       // "Headline - Publisher"
      const m = title.match(/^(.*\S)\s+[-–—|]\s+([^-–—|]{2,60})$/);
      if (m) { title = m[1]; source_name = m[2].trim(); }
    }
    items.push({
      url: String(r.link).trim(),
      canon: canon(r.link),
      title,
      entities: entities(title),
      source_name,
      summary: strip(r.contentSnippet || r.content || r.summary || r.description || '').slice(0, 1200),
      published_at: r.isoDate || r.pubDate || null,
      image: imageOf(r),
    });
  }
  payload = { source_id: src.source_id, items };
}
return [{ json: { b64: toB64(payload), count: payload.items ? payload.items.length : 0, error: payload.error || null } }];
