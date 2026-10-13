// Find each article's own picture: the og:image / twitter:image the publisher set for sharing
const asked = $('Articles without pictures').all().map((i) => i.json);
const pages = $input.all().map((i) => i.json);
const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return m ? m[1].replace(/&amp;/g, '&').trim() : '';
};
const out = asked.map((a, i) => {
  const p = pages[i] || {};
  const html = typeof p.data === 'string' ? p.data.slice(0, 300000) : '';
  let img = html ? (meta(html, 'og:image:secure_url') || meta(html, 'og:image') || meta(html, 'twitter:image') || meta(html, 'twitter:image:src')) : '';
  if (img.startsWith('//')) img = 'https:' + img;
  else if (img.startsWith('/')) { const host = (String(a.url).match(/^https?:\/\/[^/]+/i) || [''])[0]; img = host ? host.replace(/^http:/i, 'https:') + img : ''; }
  img = img.replace(/^http:\/\//i, 'https://');
  return { id: a.id, image: /^https:\/\/\S+$/i.test(img) ? img : '' };
});
return [{ json: { b64: Buffer.from(JSON.stringify(out), 'utf8').toString('base64'), found: out.filter((x) => x.image).length, tried: out.length } }];
