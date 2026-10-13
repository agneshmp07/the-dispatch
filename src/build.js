// Assembles the n8n workflow JSON files from src/lib.js + src/nodes/*.js
// usage: node src/build.js   -> writes workflows/*.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LIB = fs.readFileSync(path.join(__dirname, 'lib.js'), 'utf8');
const code = (f) => LIB + '\n' + fs.readFileSync(path.join(__dirname, 'nodes', f + '.js'), 'utf8');
const id = () => crypto.randomUUID();

const PG = { postgres: { id: 'REPLACE_PG', name: 'Dispatch Postgres' } };
const GMAIL = { gmailOAuth2: { id: 'REPLACE_GMAIL', name: 'Dispatch Gmail' } };
const BREVO = { httpHeaderAuth: { id: 'REPLACE_BREVO', name: 'Dispatch Brevo' } };
const TG = { telegramApi: { id: 'REPLACE_TG', name: 'Dispatch Telegram Bot' } };

// ---------- node factories ----------
const n = (name, type, typeVersion, parameters, pos, extra = {}) => ({ id: id(), name, type, typeVersion, position: pos, parameters, ...extra });
const cron = (name, exprs, pos) => n(name, 'n8n-nodes-base.scheduleTrigger', 1.2,
  { rule: { interval: exprs.map((e) => ({ field: 'cronExpression', expression: e })) } }, pos);
const manual = (pos) => n('Run manually', 'n8n-nodes-base.manualTrigger', 1, {}, pos);
const pg = (name, query, pos, replacement, extra = {}) => n(name, 'n8n-nodes-base.postgres', 2.6, {
  operation: 'executeQuery', query,
  options: replacement ? { queryReplacement: replacement } : {},
}, pos, { credentials: PG, ...extra });
const jsRaw = (name, file, pos) => n(name, 'n8n-nodes-base.code', 2, { jsCode: fs.readFileSync(path.join(__dirname, 'nodes', file + '.js'), 'utf8') }, pos);
const js = (name, file, pos, mode, extra = {}) => n(name, 'n8n-nodes-base.code', 2,
  Object.assign({ jsCode: code(file) }, mode ? { mode } : {}), pos, extra);
const telegramHttp = (name, tokenExpr, pos) => n(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: `=https://api.telegram.org/bot{{ ${tokenExpr} }}/{{ $json.method }}`,
  sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
  options: { batching: { batch: { batchSize: 1, batchInterval: 350 } }, response: { response: { neverError: true } }, timeout: 20000 },
}, pos, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 });
const gemini = (name, keyExpr, pos) => n(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ $json.model }}:generateContent',
  sendHeaders: true,
  headerParameters: { parameters: [{ name: 'x-goog-api-key', value: `={{ ${keyExpr} }}` }] },
  sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.request) }}',
  options: { timeout: 180000 },
}, pos, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' });
// Backup model: same request, different Gemini model (config gemini_model_fallback)
const geminiBackup = (name, reqNode, keyExpr, cfgExpr, pos) => n(name, 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: `=https://generativelanguage.googleapis.com/v1beta/models/{{ ${cfgExpr}.gemini_model_fallback || 'gemini-3.5-flash-lite' }}:generateContent`,
  sendHeaders: true,
  headerParameters: { parameters: [{ name: 'x-goog-api-key', value: `={{ ${keyExpr} }}` }] },
  sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify($('${reqNode}').first().json.request) }}`,
  options: { timeout: 180000 },
}, pos, { retryOnFail: true, maxTries: 2, waitBetweenTries: 8000 });

const conn = (pairs) => {
  const c = {};
  for (const [from, to, outIdx = 0] of pairs) {
    c[from] = c[from] || { main: [] };
    while (c[from].main.length <= outIdx) c[from].main.push([]);
    c[from].main[outIdx].push({ node: to, type: 'main', index: 0 });
  }
  return c;
};
const wf = (name, nodes, connections, extraSettings = {}) => ({
  name, nodes, connections, active: false, pinData: {},
  settings: Object.assign({ executionOrder: 'v1', timezone: 'Asia/Kolkata', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' }, extraSettings),
  tags: [],
});
const CFG = "$('Load config').first().json.cfg";

// ---------- 1. Ingest ----------
const w1 = wf('Dispatch 1 · Ingest articles', [
  cron('Mon–Wed every 4h', ['0 6,10,14 * * 1-3'], [0, 0]),
  manual([0, 200]),
  pg('Load sources', "SELECT id, name, kind, url, CASE WHEN kind = 'newsdata' THEN d_cfg('newsdata_api_key', '') END AS api_key FROM sources WHERE active ORDER BY id;", [240, 100]),
  js('Build feed URLs', 'ingest_build_urls', [480, 100]),
  n('Loop feeds', 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} }, [720, 100]),
  n('Read feed', 'n8n-nodes-base.rssFeedRead', 1.2, { url: '={{ $json.feed_url }}', options: { ignoreSSL: false } }, [960, 200],
    { onError: 'continueRegularOutput', alwaysOutputData: true, retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }),
  n('News API?', 'n8n-nodes-base.if', 2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: id(), operator: { type: 'string', operation: 'equals' }, leftValue: '={{ $json.kind }}', rightValue: 'newsdata' }] },
    options: {},
  }, [960, 60]),
  n('Call news API', 'n8n-nodes-base.httpRequest', 4.2, { url: '={{ $json.feed_url }}', options: { timeout: 20000, response: { response: { neverError: true } } } },
    [1080, 60], { onError: 'continueRegularOutput', alwaysOutputData: true, retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }),
  js('Normalize items', 'ingest_normalize', [1200, 200]),
  pg('Store + dedup', 'SELECT s.r AS result, save_ingest_images($1) AS images FROM (SELECT ingest_batch($1) AS r OFFSET 0) s;', [1440, 200], '={{ $json.b64 }}'),
  pg('Feed health', "SELECT name, last_ok_at, last_error, last_counts FROM sources WHERE active ORDER BY last_error NULLS LAST, name;", [960, -60], null, { executeOnce: true }),
  pg('Broken feeds', 'SELECT feed_alerts() AS bad, d_config_json() AS cfg;', [960, -240], null, { executeOnce: true }),
  js('Build feed alert', 'feed_alert', [1200, -240]),
  telegramHttp('Alert Shreya', "$('Broken feeds').first().json.cfg.telegram_bot_token", [1440, -240]),
], conn([
  ['Mon–Wed every 4h', 'Load sources'], ['Run manually', 'Load sources'],
  ['Load sources', 'Build feed URLs'], ['Build feed URLs', 'Loop feeds'],
  ['Loop feeds', 'Feed health', 0], ['Loop feeds', 'Broken feeds', 0], ['Loop feeds', 'News API?', 1],
  ['News API?', 'Call news API', 0], ['News API?', 'Read feed', 1], ['Call news API', 'Normalize items'],
  ['Broken feeds', 'Build feed alert'], ['Build feed alert', 'Alert Shreya'],
  ['Read feed', 'Normalize items'], ['Normalize items', 'Store + dedup'], ['Store + dedup', 'Loop feeds'],
]));

// ---------- 2. Select & draft ----------
const CTXCFG = "$('Load context').first().json.ctx.config";
const w2 = wf('Dispatch 2 · Select & draft (Gemini)', [
  cron('Wednesday 15:00 IST', ['0 15 * * 3'], [0, 0]),
  manual([0, 200]),
  pg('Load context', 'SELECT build_selection_context() AS ctx;', [220, 100]),
  js('Build selection prompt', 'select_build_prompt', [440, 100]),
  gemini('Gemini · select stories', `${CTXCFG}.gemini_api_key`, [660, 100]),
  geminiBackup('Gemini · select (backup model)', 'Build selection prompt', `${CTXCFG}.gemini_api_key`, CTXCFG, [660, 300]),
  js('Validate selection', 'select_validate', [880, 100]),
  jsRaw('List stories to read', 'read_list', [1100, 300]),
  n('Fetch articles', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.url }}',
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      { name: 'Accept-Language', value: 'en-IN,en;q=0.9' } ] },
    options: { timeout: 12000, batching: { batch: { batchSize: 4, batchInterval: 200 } }, redirect: { redirect: { maxRedirects: 5 } },
      response: { response: { responseFormat: 'text', neverError: true, outputPropertyName: 'data' } } },
  }, [1320, 300], { onError: 'continueRegularOutput', alwaysOutputData: true }),
  jsRaw('Add article text', 'read_extract', [1540, 300]),
  pg('Save article text', 'SELECT save_article_texts($1) AS n;', [1760, 500], '={{ $json.texts_b64 }}', { onError: 'continueRegularOutput' }),
  gemini('Gemini · write commentary', `${CTXCFG}.gemini_api_key`, [1760, 100]),
  geminiBackup('Gemini · write (backup model)', 'Add article text', `${CTXCFG}.gemini_api_key`, CTXCFG, [1760, 300]),
  js('Merge commentary', 'select_merge', [1980, 100]),
  pg('Save draft', 'SELECT save_draft($1) AS r;', [1540, 100], '={{ $json.b64 }}'),
  js('Build Telegram messages', 'select_tg_messages', [1760, 100]),
  telegramHttp('Send to Shreya', `${CTXCFG}.telegram_bot_token`, [1980, 100]),
  js('Collect message ids', 'select_collect_ids', [2200, 100]),
  pg('Record message ids', 'SELECT record_telegram_ids($1) AS n;', [2420, 100], '={{ $json.b64 }}', { alwaysOutputData: true }),
], conn([
  ['Wednesday 15:00 IST', 'Load context'], ['Run manually', 'Load context'],
  ['Load context', 'Build selection prompt'], ['Build selection prompt', 'Gemini · select stories'],
  ['Gemini · select stories', 'Validate selection', 0], ['Gemini · select stories', 'Gemini · select (backup model)', 1],
  ['Gemini · select (backup model)', 'Validate selection'],
  ['Gemini · write commentary', 'Gemini · write (backup model)', 1], ['Gemini · write (backup model)', 'Merge commentary'], ['Validate selection', 'List stories to read'],
  ['List stories to read', 'Fetch articles'], ['Fetch articles', 'Add article text'], ['Add article text', 'Gemini · write commentary'], ['Add article text', 'Save article text'],
  ['Gemini · write commentary', 'Merge commentary', 0], ['Merge commentary', 'Save draft'],
  ['Save draft', 'Build Telegram messages'], ['Build Telegram messages', 'Send to Shreya'],
  ['Send to Shreya', 'Collect message ids'], ['Collect message ids', 'Record message ids'],
]));

// ---------- 3. Telegram review ----------
const SELFTEST_PATH = process.env.SELFTEST_PATH || 'dispatch-selftest';
const TESTSEND_PATH = process.env.TESTSEND_PATH || 'dispatch-testsend';
const w3 = wf('Dispatch 3 · Telegram review bot', [
  n('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.2, { updates: ['message', 'callback_query'], additionalFields: {} }, [0, 100],
    { credentials: TG, webhookId: id() }),
  pg('Load config', 'SELECT d_config_json() AS cfg;', [220, 100]),
  js('Decide action', 'review_decide', [440, 100]),
  n('Fetch link', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.fetch_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }] },
    options: { timeout: 8000, response: { response: { responseFormat: 'text', neverError: true, outputPropertyName: 'data' } } },
  }, [550, 260], { onError: 'continueRegularOutput', alwaysOutputData: true }),
  jsRaw('Page info', 'review_pageinfo', [660, 260]),
  pg('Apply action', 'SELECT review_apply_more($1) AS r;', [660, 100], '={{ $json.b64 }}'),
  js('Render replies', 'review_render', [880, 100]),
  telegramHttp('Telegram API', `${CFG}.telegram_bot_token`, [1100, 100]),
  jsRaw('Is self-test?', 'selftest_trigger', [660, -80]),
  jsRaw('Is test send?', 'testsend_trigger', [660, -240]),
  n('Start test send', 'n8n-nodes-base.httpRequest', 4.2, {
    url: `=https://newss.app.n8n.cloud/webhook/${TESTSEND_PATH}`, options: { timeout: 10000, response: { response: { neverError: true } } },
  }, [880, -240], { onError: 'continueRegularOutput' }),
  n('Voice note?', 'n8n-nodes-base.if', 2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: id(), operator: { type: 'boolean', operation: 'true', singleValue: true },
        leftValue: "={{ (() => { const m = $('Telegram Trigger').first().json.message || {}; return !!(m.voice || m.audio) && String((m.chat || {}).id) === String($json.cfg.telegram_chat_id || '').trim(); })() }}", rightValue: '' }] },
    options: {},
  }, [330, 100]),
  n('Voice file info', 'n8n-nodes-base.httpRequest', 4.2, {
    url: "=https://api.telegram.org/bot{{ $('Load config').first().json.cfg.telegram_bot_token }}/getFile?file_id={{ ($('Telegram Trigger').first().json.message.voice || $('Telegram Trigger').first().json.message.audio).file_id }}",
    options: { timeout: 15000 },
  }, [330, 300], { retryOnFail: true, maxTries: 2, waitBetweenTries: 1500 }),
  n('Download voice', 'n8n-nodes-base.httpRequest', 4.2, {
    url: "=https://api.telegram.org/file/bot{{ $('Load config').first().json.cfg.telegram_bot_token }}/{{ $json.result.file_path }}",
    options: { timeout: 30000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, [330, 460], { retryOnFail: true, maxTries: 2, waitBetweenTries: 1500 }),
  jsRaw('Voice request', 'voice_request', [330, 620]),
  gemini('Transcribe voice', `${CFG}.gemini_api_key`, [330, 780]),
  js('Voice text', 'voice_text', [440, 620]),
  n('Start self-test', 'n8n-nodes-base.httpRequest', 4.2, {
    url: `=https://newss.app.n8n.cloud/webhook/${SELFTEST_PATH}`, options: { timeout: 10000, response: { response: { neverError: true } } },
  }, [880, -80], { onError: 'continueRegularOutput' }),
], conn([
  ['Telegram Trigger', 'Load config'], ['Load config', 'Voice note?'], ['Voice note?', 'Voice file info', 0], ['Voice note?', 'Decide action', 1],
  ['Voice file info', 'Download voice'], ['Download voice', 'Voice request'], ['Voice request', 'Transcribe voice'],
  ['Transcribe voice', 'Voice text', 0], ['Transcribe voice', 'Voice text', 1], ['Voice text', 'Decide action'],
  ['Decide action', 'Fetch link'], ['Decide action', 'Is self-test?'], ['Decide action', 'Is test send?'], ['Is test send?', 'Start test send'], ['Is self-test?', 'Start self-test'], ['Fetch link', 'Page info'], ['Page info', 'Apply action'],
  ['Apply action', 'Render replies'], ['Render replies', 'Telegram API'],
]));

// ---------- 4. Reminder ----------
const w4 = wf('Dispatch 4 · Approval reminder', [
  cron('Wed 22:00 + Thu 07:30 IST', ['0 22 * * 3', '30 7 * * 4'], [0, 100]),
  pg('Check approval', 'SELECT reminder_check() AS r, d_config_json() AS cfg;', [240, 100]),
  js('Build reminder', 'reminder_build', [480, 100]),
  telegramHttp('Remind Shreya', "$('Check approval').first().json.cfg.telegram_bot_token", [720, 100]),
], conn([
  ['Wed 22:00 + Thu 07:30 IST', 'Check approval'], ['Check approval', 'Build reminder'], ['Build reminder', 'Remind Shreya'],
]));

// ---------- 5. Sender ----------
const w5 = wf('Dispatch 5 · Send approved issue (Brevo)', [
  cron('Every 10 minutes', ['*/10 * * * *'], [0, 200]),
  pg('Finalize finished issues', 'SELECT finalize_sends() AS r, d_config_json() AS cfg;', [240, 0]),
  js('Sent summary', 'sender_notify', [480, 0]),
  telegramHttp('Notify Shreya', "$('Finalize finished issues').first().json.cfg.telegram_bot_token", [720, 0]),
  pg('Claim batch', 'SELECT claim_delivery_batch() AS r, d_config_json() AS cfg;', [240, 300]),
  js('Render emails', 'sender_render', [480, 300]),
  n('Send email', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: 'https://api.brevo.com/v3/smtp/email',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify(Object.assign({ sender: { name: $('Claim batch').first().json.cfg.sender_name, email: $('Claim batch').first().json.cfg.sender_email }, to: [{ email: $json.to }], subject: $json.subject, htmlContent: $json.html, headers: { 'List-Unsubscribe': '<' + $json.unsub + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, tags: ['dispatch', 'issue-' + $json.issue_no] }, $('Claim batch').first().json.cfg.reply_to ? { replyTo: { email: $('Claim batch').first().json.cfg.reply_to } } : {})) }}",
    options: { batching: { batch: { batchSize: 1, batchInterval: 150 } }, timeout: 30000 },
  }, [720, 300], { credentials: BREVO, onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 }),
  js('Delivery result', 'sender_result', [960, 300], 'runOnceForEachItem'),
  pg('Record result', 'SELECT delivery_results($1) AS r;', [1200, 300], '={{ $json.b64 }}'),
], conn([
  ['Every 10 minutes', 'Finalize finished issues'], ['Every 10 minutes', 'Claim batch'],
  ['Finalize finished issues', 'Sent summary'], ['Sent summary', 'Notify Shreya'],
  ['Claim batch', 'Render emails'], ['Render emails', 'Send email'],
  ['Send email', 'Delivery result', 0], ['Send email', 'Delivery result', 1],
  ['Delivery result', 'Record result'],
]));

// ---------- 6. Unsubscribes + bounces ----------
const w6 = wf('Dispatch 6 · Unsubscribes & bounces', [
  n('Unsubscribe link', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'dispatch-unsubscribe', responseMode: 'responseNode', options: {} }, [0, 0], { webhookId: id() }),
  n('Unsubscribe one-click (POST)', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'dispatch-unsubscribe', responseMode: 'responseNode', options: {} }, [0, -160], { webhookId: id() }),
  pg('Unsubscribe', "SELECT unsubscribe_token($1) AS r, d_config_json() AS cfg;", [240, 0], "={{ String($json.query.t || 'none').replace(/[^a-f0-9]/gi, '') || 'none' }}"),
  js('Confirmation page', 'unsub_page', [480, 0]),
  n('Respond', 'n8n-nodes-base.respondToWebhook', 1.1, {
    respondWith: 'text', responseBody: '={{ $json.html }}',
    options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } },
  }, [720, 0]),
  cron('Every 30 minutes', ['*/30 * * * *'], [0, 300]),
  n('Fetch bounces & replies', 'n8n-nodes-base.gmail', 2.1, {
    resource: 'message', operation: 'getAll', returnAll: false, limit: 50, simple: false,
    filters: { q: 'newer_than:7d -from:me -in:sent (from:mailer-daemon OR from:postmaster OR subject:("Delivery Status Notification" OR Undeliverable OR "Mail delivery failed" OR "Returned mail") OR subject:unsubscribe OR (subject:Dispatch unsubscribe))', readStatus: 'both' },
    options: {},
  }, [240, 300], { credentials: GMAIL }),
  js('Classify', 'inbound_classify', [480, 300]),
  pg('Update subscribers', 'SELECT process_inbound($1) AS r;', [720, 300], '={{ $json.b64 }}'),
], conn([
  ['Unsubscribe link', 'Unsubscribe'], ['Unsubscribe one-click (POST)', 'Unsubscribe'], ['Unsubscribe', 'Confirmation page'], ['Confirmation page', 'Respond'],
  ['Every 30 minutes', 'Fetch bounces & replies'], ['Fetch bounces & replies', 'Classify'], ['Classify', 'Update subscribers'],
]));

// ---------- 7. Error alerts ----------
const w7 = wf('Dispatch 0 · Error alerts', [
  n('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, {}, [0, 100]),
  pg('Load config', 'SELECT d_config_json() AS cfg;', [240, 100]),
  js('Build alert', 'error_build', [480, 100]),
  telegramHttp('Alert Shreya', `${CFG}.telegram_bot_token`, [720, 100]),
], conn([['Error Trigger', 'Load config'], ['Load config', 'Build alert'], ['Build alert', 'Alert Shreya']]));


// ---------- 7. Website endpoints (sign-up + archive) ----------
const CORS = { entries: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Content-Type', value: 'application/json; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }] };
const w8 = wf('Dispatch 7 · Website (sign-up + archive)', [
  n('Sign-up', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'dispatch-subscribe', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 0], { webhookId: id() }),
  n('Parse sign-up', 'n8n-nodes-base.code', 2, { jsCode: `const toB64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
let b = $input.first().json.body;
if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
b = b || {};
return [{ json: { b64: toB64({ email: String(b.email || '').slice(0, 200), name: String(b.name || '').slice(0, 80), source: String(b.source || 'site').slice(0, 30) }) } }];` }, [220, 0]),
  pg('Save subscriber', 'SELECT web_subscribe($1) AS r;', [440, 0], '={{ $json.b64 }}'),
  n('Reply sign-up', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify($json.r) }}', options: { responseHeaders: CORS } }, [660, 0]),
  n('Stats', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'dispatch-stats', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 480], { webhookId: id() }),
  pg('Load stats', "SELECT CASE WHEN $1 <> 'none' AND $1 = d_cfg('dashboard_key', '') THEN stats_json() ELSE jsonb_build_object('error', 'unauthorized') END AS r;", [220, 480], "={{ String($json.query.key || '').replace(/[^A-Za-z0-9_-]/g, '') || 'none' }}"),
  n('Reply stats', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify($json.r) }}', options: { responseHeaders: CORS } }, [440, 480]),
  n('Archive', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'dispatch-archive', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 240], { webhookId: id() }),
  pg('Load archive', 'SELECT web_archive(12) AS r;', [220, 240]),
  n('Reply archive', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify($json.r) }}', options: { responseHeaders: CORS } }, [440, 240]),
  n('Issue page', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'dispatch-issue', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 720], { webhookId: id() }),
  pg('Load issue', 'SELECT web_issue($1::int) AS r;', [220, 720], "={{ parseInt(String($json.query.n || '').replace(/[^0-9]/g, ''), 10) || 0 }}"),
  n('Reply issue', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify($json.r) }}', options: { responseHeaders: CORS } }, [440, 720]),
  n('Pipeline', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'dispatch-pipeline', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 960], { webhookId: id() }),
  pg('Load pipeline', "SELECT CASE WHEN $1 <> 'none' AND $1 = d_cfg('dashboard_key', '') THEN pipeline_json() ELSE jsonb_build_object('error', 'unauthorized') END AS r;", [220, 960], "={{ String($json.query.key || '').replace(/[^A-Za-z0-9_-]/g, '') || 'none' }}"),
  n('Reply pipeline', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify($json.r) }}', options: { responseHeaders: CORS } }, [440, 960]),
  // public "This week's news" strip on the website (headlines only, no reader data)
  n('News', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'dispatch-news', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 1440], { webhookId: id() }),
  pg('Load news', "SELECT jsonb_build_object('updated', now(), 'week_count', (SELECT count(*) FROM articles WHERE week_start = d_week_start(d_now()) AND status <> 'duplicate' AND NOT coalesce(demo, false)), 'items', coalesce((SELECT jsonb_agg(jsonb_build_object('title', s.title, 'url', s.url, 'source', s.source_name, 'image', s.image_url, 'at', s.fetched_at) ORDER BY s.rk) FROM (SELECT a.*, row_number() OVER (ORDER BY a.week_start DESC, (a.image_url IS NOT NULL) DESC, a.fetched_at DESC) AS rk FROM articles a WHERE a.week_start >= d_week_start(d_now()) - 7 AND a.status <> 'duplicate' AND NOT coalesce(a.demo, false) AND length(a.title) > 12 ORDER BY rk LIMIT 24) s), '[]'::jsonb)) AS r;", [220, 1440]),
  n('Reply news', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify($json.r) }}', options: { responseHeaders: CORS } }, [440, 1440]),
  n('Suggest a story', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'dispatch-suggest', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 1200], { webhookId: id() }),
  jsRaw('Check suggestion', 'suggest_parse', [220, 1200]),
  n('Fetch suggested page', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.fetch_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }] },
    options: { timeout: 8000, redirect: { redirect: { maxRedirects: 4 } }, response: { response: { responseFormat: 'text', neverError: true, outputPropertyName: 'data' } } },
  }, [440, 1200], { onError: 'continueRegularOutput', alwaysOutputData: true }),
  jsRaw('Read page title', 'suggest_title', [660, 1200]),
  pg('Save suggestion', 'SELECT web_suggest($1) AS r, d_config_json() AS cfg;', [880, 1200], '={{ $json.b64 }}'),
  n('Reply suggestion', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify({ ok: $json.r.ok, message: $json.r.message }) }}', options: { responseHeaders: CORS } }, [1100, 1100]),
  jsRaw('Tell Shreya?', 'suggest_notify', [1100, 1300]),
  telegramHttp('Tell Shreya', "$('Save suggestion').first().json.cfg.telegram_bot_token", [1320, 1300]),
], conn([
  ['Issue page', 'Load issue'], ['Load issue', 'Reply issue'],
  ['Pipeline', 'Load pipeline'], ['Load pipeline', 'Reply pipeline'], ['News', 'Load news'], ['Load news', 'Reply news'],
  ['Suggest a story', 'Check suggestion'], ['Check suggestion', 'Fetch suggested page'], ['Fetch suggested page', 'Read page title'],
  ['Read page title', 'Save suggestion'], ['Save suggestion', 'Reply suggestion'], ['Save suggestion', 'Tell Shreya?'], ['Tell Shreya?', 'Tell Shreya'],
  ['Sign-up', 'Parse sign-up'], ['Parse sign-up', 'Save subscriber'], ['Save subscriber', 'Reply sign-up'],
  ['Archive', 'Load archive'], ['Load archive', 'Reply archive'],
  ['Stats', 'Load stats'], ['Load stats', 'Reply stats'],
]));


// ---------- 8. Tuesday preview ----------
const w9 = wf('Dispatch 8 · Tuesday preview', [
  cron('Tuesday 18:00 IST', ['0 18 * * 2'], [0, 100]),
  pg('Trending so far', 'SELECT tuesday_preview() AS r, d_config_json() AS cfg;', [240, 100]),
  js('Build preview', 'tuesday_build', [480, 100]),
  telegramHttp('Send preview', "$('Trending so far').first().json.cfg.telegram_bot_token", [720, 100]),
], conn([['Tuesday 18:00 IST', 'Trending so far'], ['Trending so far', 'Build preview'], ['Build preview', 'Send preview']]));

// ---------- 9. Brevo email events (opens, clicks, bounces, unsubscribes) ----------
const EVENTS_PATH = process.env.EVENTS_PATH || 'dispatch-brevo-events';
const w10 = wf('Dispatch 9 · Email events (Brevo)', [
  n('Brevo event', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: EVENTS_PATH, responseMode: 'responseNode', options: {} }, [0, 100], { webhookId: id() }),
  jsRaw('Parse event', 'events_parse', [220, 100]),
  pg('Record event', 'SELECT record_email_events($1) AS r;', [440, 100], '={{ $json.b64 }}'),
  n('OK', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: 'ok', options: {} }, [660, 100]),
], conn([['Brevo event', 'Parse event'], ['Parse event', 'Record event'], ['Record event', 'OK']]));

// ---------- 10. Self-test (started by /selftest in Telegram) ----------
// TG_HOOK_URL / TG_SECRET: the Telegram Trigger's production URL and secret token
// (n8n uses "<workflowId>_<triggerNodeId>" as the secret).
const w11 = wf('Dispatch 10 · Self-test (from Telegram)', [
  n('Self-test request', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: SELFTEST_PATH, responseMode: 'onReceived', options: {} }, [0, 100], { webhookId: id() }),
  pg('Load config', 'SELECT d_config_json() AS cfg;', [200, 100]),
  pg('Pick a news link', "SELECT url FROM articles WHERE week_start = d_week_start(d_now()) AND NOT coalesce(pinned,false) AND status = 'new' AND url NOT LIKE '%news.google.com%' ORDER BY fetched_at DESC LIMIT 1;", [400, 100], null, { alwaysOutputData: true }),
  jsRaw('Build test messages', 'selftest_build', [600, 100]),
  n('Send to bot', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: process.env.TG_HOOK_URL || 'https://YOUR-N8N/webhook/TELEGRAM-TRIGGER-ID/webhook',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'X-Telegram-Bot-Api-Secret-Token', value: process.env.TG_SECRET || 'WORKFLOWID_TRIGGERNODEID' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 6000 } }, response: { response: { neverError: true, fullResponse: true } }, timeout: 20000 },
  }, [800, 100]),
  n('Let the bot reply', 'n8n-nodes-base.wait', 1.1, { amount: 20 }, [1000, 100], { webhookId: id() }),
  pg('Unpin test link', "UPDATE articles SET pinned = false, pinned_note = null WHERE pinned AND pinned_note ILIKE '%self-test%' RETURNING id;", [1200, 100], null, { alwaysOutputData: true, executeOnce: true }),
  jsRaw('Build report', 'selftest_report', [1400, 100]),
  telegramHttp('Send report', "$('Load config').first().json.cfg.telegram_bot_token", [1600, 100]),
], conn([['Self-test request', 'Load config'], ['Load config', 'Pick a news link'], ['Pick a news link', 'Build test messages'],
  ['Build test messages', 'Send to bot'], ['Send to bot', 'Let the bot reply'], ['Let the bot reply', 'Unpin test link'],
  ['Unpin test link', 'Build report'], ['Build report', 'Send report']]));

// ---------- 11. Test send (started by "testsend" in Telegram): emails the draft to Shreya only ----------
const w12 = wf('Dispatch 11 · Test send (from Telegram)', [
  n('Test send request', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: TESTSEND_PATH, responseMode: 'onReceived', options: {} }, [0, 100], { webhookId: id() }),
  pg('Load draft', 'SELECT test_send_payload() AS p;', [220, 100]),
  js('Build test email', 'testsend_build', [440, 100]),
  n('Send test email', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: 'https://api.brevo.com/v3/smtp/email', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ $json.skip ? '{}' : JSON.stringify({ sender: { name: $('Load draft').first().json.p.cfg.sender_name, email: $('Load draft').first().json.p.cfg.sender_email }, to: [{ email: $json.to }], subject: $json.subject, htmlContent: $json.html, tags: ['dispatch-test'] }) }}",
    options: { timeout: 30000, response: { response: { neverError: true, fullResponse: true } } },
  }, [660, 100], { credentials: BREVO }),
  n('Tell Shreya', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: "=https://api.telegram.org/bot{{ $('Load draft').first().json.p.cfg.telegram_bot_token }}/sendMessage",
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify(Object.assign({}, $('Build test email').first().json.tg, ($('Build test email').first().json.skip || String($json.statusCode).startsWith('2')) ? {} : { text: '📧 Test email failed: ' + String(($json.body && $json.body.message) || $json.statusCode).slice(0, 200) })) }}",
    options: { timeout: 20000, response: { response: { neverError: true } } },
  }, [880, 100]),
], conn([['Test send request', 'Load draft'], ['Load draft', 'Build test email'], ['Build test email', 'Send test email'], ['Send test email', 'Tell Shreya']]));

// ---------- 12. Article pictures (og:image for the dashboard) ----------
const w13 = wf('Dispatch 12 · Article pictures', [
  cron('Mon–Thu every 3h', ['20 7,10,13,16,19 * * 1-4'], [0, 0]),
  manual([0, 200]),
  pg('Articles without pictures', 'SELECT id, url FROM articles_needing_images(60);', [240, 100]),
  n('Fetch article pages', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.url }}',
    sendHeaders: true,
    headerParameters: { parameters: [
      { name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      { name: 'Accept-Language', value: 'en-IN,en;q=0.9' } ] },
    options: { timeout: 10000, batching: { batch: { batchSize: 6, batchInterval: 300 } }, redirect: { redirect: { maxRedirects: 5 } },
      response: { response: { responseFormat: 'text', neverError: true, outputPropertyName: 'data' } } },
  }, [480, 100], { onError: 'continueRegularOutput', alwaysOutputData: true }),
  jsRaw('Find pictures', 'images_extract', [720, 100]),
  pg('Save pictures', 'SELECT save_article_images($1) AS r;', [960, 100], '={{ $json.b64 }}'),
], conn([['Mon–Thu every 3h', 'Articles without pictures'], ['Run manually', 'Articles without pictures'],
  ['Articles without pictures', 'Fetch article pages'], ['Fetch article pages', 'Find pictures'], ['Find pictures', 'Save pictures']]));

// ---------- 13. Talk (website) ----------
// The dashboard's Talk page: same commands, same database functions and same replies as the Telegram bot.
const w14 = wf('Dispatch 13 · Talk (website)', [
  n('Talk', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'dispatch-talk', responseMode: 'responseNode', options: { allowedOrigins: '*' } }, [0, 100], { webhookId: id() }),
  pg('Load config', 'SELECT d_config_json() AS cfg;', [200, 100]),
  jsRaw('Telegram Trigger', 'talk_update', [400, 100]),
  n('Allowed?', 'n8n-nodes-base.if', 2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: id(), operator: { type: 'boolean', operation: 'false', singleValue: true }, leftValue: '={{ !!$json._stop }}', rightValue: '' }] },
    options: {},
  }, [600, 100]),
  n('Refuse', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseCode: 401,
    responseBody: "={{ JSON.stringify({ ok: false, error: $json._stop }) }}", options: { responseHeaders: CORS } }, [800, 300]),
  n('Voice?', 'n8n-nodes-base.if', 2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: id(), operator: { type: 'boolean', operation: 'true', singleValue: true }, leftValue: '={{ !!$json._audio }}', rightValue: '' }] },
    options: {},
  }, [800, 100]),
  jsRaw('Voice request', 'talk_voice', [1000, 260]),
  gemini('Transcribe voice', `${CFG}.gemini_api_key`, [1200, 260]),
  js('Voice text', 'voice_text', [1400, 260]),
  js('Decide action', 'review_decide', [1600, 100]),
  n('Fetch link', 'n8n-nodes-base.httpRequest', 4.2, {
    url: '={{ $json.fetch_url }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' }] },
    options: { timeout: 8000, response: { response: { responseFormat: 'text', neverError: true, outputPropertyName: 'data' } } },
  }, [1800, 100], { onError: 'continueRegularOutput', alwaysOutputData: true }),
  jsRaw('Page info', 'review_pageinfo', [2000, 100]),
  pg('Apply action', 'SELECT review_apply_more($1) AS r;', [2200, 100], '={{ $json.b64 }}'),
  js('Render replies', 'review_render', [2400, 100]),
  jsRaw('Website reply', 'talk_reply', [2600, 0]),
  n('Reply', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ JSON.stringify($json) }}', options: { responseHeaders: CORS } }, [2800, 0]),
  jsRaw('Telegram edits', 'talk_sync', [2600, 200]),
  telegramHttp('Update Telegram cards', `${CFG}.telegram_bot_token`, [2800, 200]),
  jsRaw('Is self-test?', 'selftest_trigger', [1800, -120]),
  n('Start self-test', 'n8n-nodes-base.httpRequest', 4.2, {
    url: `=https://newss.app.n8n.cloud/webhook/${SELFTEST_PATH}`, options: { timeout: 10000, response: { response: { neverError: true } } },
  }, [2000, -120], { onError: 'continueRegularOutput' }),
  jsRaw('Is test send?', 'testsend_trigger', [1800, -280]),
  n('Start test send', 'n8n-nodes-base.httpRequest', 4.2, {
    url: `=https://newss.app.n8n.cloud/webhook/${TESTSEND_PATH}`, options: { timeout: 10000, response: { response: { neverError: true } } },
  }, [2000, -280], { onError: 'continueRegularOutput' }),
], conn([
  ['Talk', 'Load config'], ['Load config', 'Telegram Trigger'], ['Telegram Trigger', 'Allowed?'],
  ['Allowed?', 'Voice?', 0], ['Allowed?', 'Refuse', 1],
  ['Voice?', 'Voice request', 0], ['Voice?', 'Decide action', 1],
  ['Voice request', 'Transcribe voice'], ['Transcribe voice', 'Voice text', 0], ['Transcribe voice', 'Voice text', 1], ['Voice text', 'Decide action'],
  ['Decide action', 'Fetch link'], ['Decide action', 'Is self-test?'], ['Decide action', 'Is test send?'],
  ['Is self-test?', 'Start self-test'], ['Is test send?', 'Start test send'],
  ['Fetch link', 'Page info'], ['Page info', 'Apply action'], ['Apply action', 'Render replies'],
  ['Render replies', 'Website reply'], ['Website reply', 'Reply'], ['Render replies', 'Telegram edits'], ['Telegram edits', 'Update Telegram cards'],
]));

const out = path.join(ROOT, 'workflows');
fs.mkdirSync(out, { recursive: true });
const files = { '0-error-alerts.json': w7, '1-ingest.json': w1, '2-select-and-draft.json': w2, '3-telegram-review.json': w3,
  '4-approval-reminder.json': w4, '5-send-approved-issue.json': w5, '6-unsubscribes-and-bounces.json': w6, '7-website.json': w8, '8-tuesday-preview.json': w9, '9-email-events.json': w10, '10-self-test.json': w11, '11-test-send.json': w12, '12-article-pictures.json': w13, '13-talk-website.json': w14 };
for (const [f, w] of Object.entries(files)) fs.writeFileSync(path.join(out, f), JSON.stringify(w, null, 2));
console.log('wrote', Object.keys(files).join(', '));
module.exports = { files };
