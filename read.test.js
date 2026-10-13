const fs = require('fs'); const path = require('path'); const assert = require('assert');
const code = (f) => fs.readFileSync(path.join(__dirname, '../src/nodes', f + '.js'), 'utf8');
const wrap = (a) => a.map((j) => ({ json: j }));
function run(file, input, nodes) {
  const $ = (n) => ({ first: () => wrap([].concat(nodes[n]))[0], all: () => wrap([].concat(nodes[n])) });
  return new Function('$input', '$', code(file))({ first: () => wrap(input)[0], all: () => wrap(input) }, $);
}
const ctx = { candidates: [
  { id: 1, url: 'https://inc42.com/a' }, { id: 2, url: 'https://news.google.com/rss/articles/CBMi123' },
  { id: 3, url: 'https://the-ken.com/story/x' }, { id: 4, url: 'https://broken.example/x' } ] };
const validate = { model: 'm', selection: { picks: [{ id: 1 }, { id: 2 }], alternates: [{ id: 3 }, { id: 4 }] },
  request: { systemInstruction: { parts: [{ text: 'Rules: ... Use only facts in the summary: do not invent.' }] }, contents: [{ parts: [{ text: 'Write commentary.\n\n[1] Title' }] }] } };
const list = run('read_list', [validate], { 'Load context': { ctx } }).map((i) => i.json);
assert.strictEqual(list.length, 4); assert.ok(list[1].skip && list[1].url === 'about:blank');
const article = '<html><head><script>var x=1</script></head><body><nav><p>Home | Startups | Funding | This is a navigation paragraph that is long enough to count</p></nav><article><h1>T</h1>' +
  '<p>Bengaluru-based Zepto has raised $450 Mn in a round led by Motilal Oswal, valuing the quick commerce startup at $7 Bn, according to regulatory filings accessed by Inc42.</p>' +
  '<p>The company plans to use the capital to add 300 dark stores across tier-2 cities by March 2027, chief executive Aadit Palicha said in a note to employees on Monday.</p>' +
  '<p>Also Read: Swiggy Instamart cuts delivery fees in 12 cities as competition with Blinkit intensifies</p>' +
  '<p>Zepto&rsquo;s revenue grew 120% year-on-year to &#8377;4,454 Cr in FY24, while losses narrowed to &#8377;1,249 Cr, the filings show, signalling improving unit economics.</p>' +
  '<p>Subscribe to our newsletter for daily updates on Indian startups and more stuff here.</p></article>' + ' '.repeat(600) + '</body></html>';
const paywall = '<html><body><article><p>This story is for subscribers only. Already a subscriber? Log in to continue reading this premium story.</p></article>' + ' '.repeat(600) + '</body></html>';
const pages = [{ data: article }, { error: { message: 'Invalid URL' } }, { data: paywall }, { error: { message: 'ETIMEDOUT' } }];
const out = run('read_extract', pages, { 'Validate selection': validate, 'List stories to read': list })[0].json;
assert.strictEqual(out.articles_read, 1, 'only the real article is read');
assert.strictEqual(out.articles_tried, 3, 'google news link skipped');
const u = out.request.contents[0].parts[0].text;
assert.ok(u.includes('FULL-TEXT EXCERPTS') && u.includes('$450 Mn') && u.includes('300 dark stores'), 'facts included');
assert.ok(!u.includes('Also Read') && !u.includes('Subscribe to our') && !u.includes('navigation paragraph') && !u.includes('var x'), 'junk stripped');
assert.ok(u.includes("Zepto's revenue"), 'entities decoded');
assert.ok(out.request.systemInstruction.parts[0].text.includes('summary or the full-text excerpt'), 'rule updated');
assert.ok(!validate.request.contents[0].parts[0].text.includes('EXCERPTS'), 'original request not mutated');
const none = run('read_extract', [{ error: {} }, { error: {} }, { data: paywall }, { error: {} }], { 'Validate selection': validate, 'List stories to read': list })[0].json;
assert.strictEqual(none.articles_read, 0); assert.ok(!none.request.contents[0].parts[0].text.includes('EXCERPTS'), 'falls back cleanly');
console.log('read tests passed:', out.articles_read, 'of', out.articles_tried, '| excerpt:', u.split('[1] ').pop().slice(0, 140));
const saved = JSON.parse(Buffer.from(out.texts_b64, 'base64').toString('utf8'));
assert.ok(Object.keys(saved).length === 1 && saved['1'].includes('$450 Mn'), 'excerpts handed on for saving');
console.log('read test ok');
