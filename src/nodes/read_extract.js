// Pull readable paragraphs out of each fetched page and add them to the commentary prompt
const prev = $('Validate selection').first().json;
const asked = $('List stories to read').all().map((i) => i.json);
const pages = $input.all().map((i) => i.json);
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '-', '&hellip;': '...', '&#8217;': "'", '&#8216;': "'", '&#8220;': '"', '&#8221;': '"', '&#x27;': "'" };
const decode = (s) => s.replace(/&[#a-z0-9]+;/gi, (m) => ENT[m.toLowerCase()] || (/^&#\d+;$/.test(m) ? String.fromCharCode(+m.slice(2, -1)) : ' '));
const JUNK = /cookie|subscribe to|sign up|newsletter|all rights reserved|follow us|download the app|read more:|also read|click here|advertisement|copyright|whatsapp|telegram channel|log ?in to|already a (member|subscriber)/i;
function extract(html) {
  if (typeof html !== 'string' || html.length < 500) return '';
  let h = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|figure)[\s\S]*?<\/\1>/gi, ' ');
  const art = h.match(/<article[\s\S]*?<\/article>/i);
  if (art && art[0].length > 1500) h = art[0];
  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi; let m;
  while ((m = re.exec(h)) && paras.join(' ').length < 2600) {
    const t = decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t.length >= 70 && !JUNK.test(t) && !paras.includes(t)) paras.push(t);
  }
  const text = paras.join(' ').slice(0, 2500);
  return text.length >= 300 ? text : '';
}
const excerpts = {}; let read = 0;
asked.forEach((a, i) => {
  if (!a.id || a.skip) return;
  const p = pages[i] || {};
  const body = typeof p.data === 'string' ? p.data : (typeof p.body === 'string' ? p.body : (typeof p === 'string' ? p : ''));
  const t = extract(body);
  if (t) { excerpts[String(a.id)] = t; read++; }
});
const request = JSON.parse(JSON.stringify(prev.request));
if (read) {
  const block = Object.entries(excerpts).map(([id, t]) => `[${id}] ${t}`).join('\n\n');
  request.contents[0].parts[0].text += `\n\nFULL-TEXT EXCERPTS (the article bodies; prefer these concrete facts and numbers over the summary):\n${block}`;
  request.systemInstruction.parts[0].text = request.systemInstruction.parts[0].text
    .replace('Use only facts in the summary', 'Use only facts in the summary or the full-text excerpt');
}
const texts_b64 = Buffer.from(JSON.stringify(excerpts), 'utf8').toString('base64');   // saved so Shreya can read them too ("read 3")
return [{ json: { request, model: prev.model, selection: prev.selection, articles_read: read, articles_tried: asked.filter((a) => a.id && !a.skip).length, texts_b64 } }];
