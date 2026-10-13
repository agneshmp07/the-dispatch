// Pull the page title so Shreya sees a headline, not just a link
const { s } = $('Check suggestion').first().json;
const page = $input.first().json || {};
const html = typeof page.data === 'string' ? page.data.slice(0, 200000) : '';
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '-', '&#8217;': "'", '&#8216;': "'", '&#8220;': '"', '&#8221;': '"', '&#x27;': "'" };
const decode = (t) => t.replace(/&[#a-z0-9]+;/gi, (m) => ENT[m.toLowerCase()] || ' ');
const meta = (prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return m ? m[1] : '';
};
let title = meta('og:title') || meta('twitter:title') || ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
title = decode(title.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
if (!title) {
  // the site blocked us: make a readable headline from the link itself ("meesho-shares-surge-5" -> "Meesho shares surge 5")
  const segs = s.url.replace(/[?#].*$/, '').split('/').filter((x) => /[a-z]-[a-z]/i.test(x));
  const slug = segs.sort((x, y) => y.length - x.length)[0] || '';
  const words = slug.replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ').replace(/\b\d{6,}\b/g, '').trim();
  if (words) title = (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 200);
}
const b64 = Buffer.from(JSON.stringify(Object.assign({}, s, { title })), 'utf8').toString('base64');
return [{ json: { b64 } }];
