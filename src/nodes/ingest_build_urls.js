// Turn source rows into fetchable URLs (Google News queries need no key; NewsData.io needs newsdata_api_key)
const out = [];
for (const { json: s } of $input.all()) {
  let feed_url = s.url;
  if (s.kind === 'gnews') {
    feed_url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(`${s.url} when:3d`) + '&hl=en-IN&gl=IN&ceid=IN:en';
  } else if (s.kind === 'newsdata') {
    if (!s.api_key) continue;                       // not set up yet: skip quietly
    feed_url = 'https://newsdata.io/api/1/latest?apikey=' + encodeURIComponent(s.api_key) +
      '&country=in&language=en&q=' + encodeURIComponent(s.url);
  }
  out.push({ json: { source_id: s.id, name: s.name, kind: s.kind, feed_url } });
}
return out;
