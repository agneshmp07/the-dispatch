-- =====================================================================
-- Add-on features (run after schema.sql + addon_web.sql). Safe to re-run.
--  * Shreya's story suggestions via Telegram (pinned candidates)
--  * weekly intro + sponsor slot
--  * /alternates (runners-up) with one-tap add
--  * broken-feed alerts, Tuesday preview
--  * Brevo email events (opens, clicks, bounces, unsubscribes) + stats
-- =====================================================================

ALTER TABLE articles ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS pinned_note text;
ALTER TABLE issues   ADD COLUMN IF NOT EXISTS intro text;
ALTER TABLE issues   ADD COLUMN IF NOT EXISTS sponsor jsonb;
ALTER TABLE sources  ADD COLUMN IF NOT EXISTS last_alerted_at timestamptz;

CREATE TABLE IF NOT EXISTS email_events (
  id          bigserial PRIMARY KEY,
  event       text NOT NULL,
  email       text,
  message_id  text,
  issue_no    int,
  link        text,
  ts          timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_events_issue_idx ON email_events (issue_no, event);
CREATE UNIQUE INDEX IF NOT EXISTS email_events_dedupe ON email_events (event, coalesce(message_id,''), coalesce(email,''), coalesce(link,''), coalesce(ts, 'epoch'::timestamptz));

INSERT INTO sources (name, kind, url, active) VALUES ('Shreya''s picks', 'rss', 'manual://shreya-picks', false)
ON CONFLICT (url) DO NOTHING;

-- ---------------------------------------------------------------------
-- Shreya suggests a story (link sent to the Telegram bot)
-- payload: {url, title?, summary?, note?}
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION suggest_story(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_url   text := btrim(coalesce(p->>'url',''));
  v_title text := nullif(btrim(left(coalesce(p->>'title',''), 400)), '');
  v_hash  text;
  a       articles%ROWTYPE;
  src     int;
  ts      timestamptz := d_now();
BEGIN
  IF v_url !~* '^https?://' THEN
    RETURN jsonb_build_object('ok', false, 'type', 'suggest', 'message', 'That doesn''t look like a link.');
  END IF;
  v_hash := md5(coalesce(nullif(p->>'canon',''), v_url));
  SELECT * INTO a FROM articles WHERE url_hash = v_hash OR url = v_url LIMIT 1;
  IF FOUND THEN
    IF a.status = 'published' THEN
      RETURN jsonb_build_object('ok', false, 'type', 'suggest', 'message', 'That story already went out in a previous issue.');
    END IF;
    UPDATE articles SET pinned = true, pinned_note = coalesce(nullif(p->>'note',''), pinned_note),
           status = CASE WHEN status = 'duplicate' THEN 'new' ELSE status END, fetched_at = greatest(fetched_at, ts)
     WHERE id = a.id RETURNING * INTO a;
  ELSE
    SELECT id INTO src FROM sources WHERE url = 'manual://shreya-picks';
    INSERT INTO articles (url, url_hash, title, title_norm, summary, source_id, source_name, published_at,
                          fetched_at, week_start, status, pinned, pinned_note)
    VALUES (v_url, v_hash, coalesce(v_title, v_url), d_norm_title(coalesce(v_title, v_url)),
            left(p->>'summary', 1200), src, coalesce(nullif(p->>'site',''), 'Shreya''s pick'), ts, ts,
            d_week_start(ts), 'new', true, nullif(p->>'note',''))
    RETURNING * INTO a;
  END IF;
  RETURN jsonb_build_object('ok', true, 'type', 'suggest', 'title', a.title,
    'message', 'Saved. It''s guaranteed a spot in the next draft.',
    'pinned_count', (SELECT count(*) FROM articles WHERE pinned AND status <> 'published'
                       AND fetched_at > coalesce((SELECT max(created_at) FROM issues WHERE status <> 'cancelled'), 'epoch')));
END $$;

-- ---------------------------------------------------------------------
-- Telegram review entry point: new commands, then the original logic
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_apply(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p    jsonb := d_b64json(b64);
  t    text  := p->>'type';
  chat text  := coalesce(p->>'chat_id','');
  iss  issues%ROWTYPE;
  it   issue_items%ROWTYPE;
  n    int;
BEGIN
  -- free text: pending edit > link suggestion > guidance
  IF t = 'text' THEN
    IF EXISTS (SELECT 1 FROM bot_state WHERE chat_id = chat AND pending_action = 'edit') THEN
      RETURN review_apply_core(encode(convert_to((p || '{"type":"edit_text"}')::text, 'UTF8'), 'base64'));
    ELSIF coalesce(p->>'url','') <> '' THEN
      RETURN suggest_story(p);
    ELSE
      RETURN review_apply_core(encode(convert_to((p || '{"type":"edit_text"}')::text, 'UTF8'), 'base64'));
    END IF;
  END IF;

  IF t = 'suggest' THEN RETURN suggest_story(p); END IF;

  IF t IN ('set_intro','sponsor','nosponsor','alternates','add_alt') THEN
    SELECT * INTO iss FROM issues WHERE status = 'in_review' ORDER BY week_start DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'There''s no draft in review right now.');
    END IF;
  END IF;

  IF t = 'set_intro' THEN
    UPDATE issues SET intro = nullif(btrim(left(p->>'text', 600)), '') WHERE id = iss.id;
    RETURN jsonb_build_object('ok', true, 'type', t, 'message', 'Intro updated.', 'view', issue_view(iss.id));
  ELSIF t = 'sponsor' THEN
    UPDATE issues SET sponsor = jsonb_build_object('text', left(p->>'text', 400), 'url', nullif(p->>'url','')) WHERE id = iss.id;
    RETURN jsonb_build_object('ok', true, 'type', t, 'message', 'Sponsor block added to this issue.', 'view', issue_view(iss.id));
  ELSIF t = 'nosponsor' THEN
    UPDATE issues SET sponsor = NULL WHERE id = iss.id;
    RETURN jsonb_build_object('ok', true, 'type', t, 'message', 'Sponsor block removed.', 'view', issue_view(iss.id));
  ELSIF t = 'alternates' THEN
    RETURN jsonb_build_object('ok', true, 'type', t, 'issue_id', iss.id, 'alternates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('item_id', ii.id, 'topic', ii.topic, 'title', a.title, 'source', a.source_name,
                                          'reason', ii.reason) ORDER BY ii.alt_rank)
        FROM issue_items ii JOIN articles a ON a.id = ii.article_id
       WHERE ii.issue_id = iss.id AND ii.state = 'alternate'), '[]'));
  ELSIF t = 'add_alt' THEN
    SELECT * INTO it FROM issue_items WHERE id = (p->>'item_id')::int AND issue_id = iss.id AND state = 'alternate' FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'That runner-up is no longer available.');
    END IF;
    SELECT coalesce(max(position), 0) + 1 INTO n FROM issue_items WHERE issue_id = iss.id AND position IS NOT NULL;
    UPDATE issue_items SET state = 'proposed', position = n, alt_rank = NULL, updated_at = d_now() WHERE id = it.id;
    RETURN jsonb_build_object('ok', true, 'type', t, 'message', format('Added as #%s', n),
      'item', (SELECT x FROM jsonb_array_elements(issue_view(iss.id)->'items') x WHERE (x->>'item_id')::int = it.id),
      'view', issue_view(iss.id));
  ELSIF t = 'stats' THEN
    RETURN jsonb_build_object('ok', true, 'type', t, 'stats', stats_json());
  ELSIF t = 'clear_demo' THEN
    RETURN jsonb_build_object('ok', true, 'type', t, 'cleared', demo_clear());
  END IF;

  RETURN review_apply_core(b64);
END $$;

-- ---------------------------------------------------------------------
-- Broken feeds: sources failing with no success in 36h, alerted max once/day
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION feed_alerts() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  WITH bad AS (
    UPDATE sources SET last_alerted_at = d_now()
     WHERE active AND last_error IS NOT NULL
       AND (last_ok_at IS NULL OR last_ok_at < d_now() - interval '36 hours')
       AND (last_alerted_at IS NULL OR last_alerted_at < d_now() - interval '24 hours')
    RETURNING name, left(last_error, 120) AS err)
  SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'error', err)), '[]') INTO r FROM bad;
  RETURN r;
END $$;

-- ---------------------------------------------------------------------
-- Tuesday preview: what's trending so far this week
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tuesday_preview() RETURNS jsonb
LANGUAGE sql AS $$
  WITH c AS (SELECT build_selection_context() AS ctx)
  SELECT jsonb_build_object(
    'candidate_count', (ctx->>'candidate_count')::int,
    'pinned', (SELECT coalesce(jsonb_agg(x->>'title'), '[]') FROM jsonb_array_elements(ctx->'candidates') x WHERE (x->>'pinned')::boolean),
    'top', (SELECT coalesce(jsonb_agg(x ORDER BY (x->>'coverage')::int DESC, x->>'published_at' DESC), '[]') FROM (
              SELECT x FROM jsonb_array_elements(ctx->'candidates') x
               ORDER BY (x->>'coverage')::int DESC, x->>'published_at' DESC LIMIT 6) s))
  FROM c
$$;

-- ---------------------------------------------------------------------
-- Brevo webhook events -> email_events (+ keep the subscriber list clean)
-- payload: one Brevo event object or an array of them
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_email_events(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p jsonb := d_b64json(b64);
  e jsonb;
  ev text; em text; tagtxt text; ino int; n int := 0;
BEGIN
  IF jsonb_typeof(p) <> 'array' THEN p := jsonb_build_array(p); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p) LOOP
    ev := lower(coalesce(e->>'event', ''));
    CONTINUE WHEN ev = '';
    em := lower(nullif(e->>'email',''));
    tagtxt := coalesce(e->>'tag', '') || ' ' || coalesce((e->'tags')::text, '');
    ino := nullif(substring(tagtxt from 'issue-([0-9]+)'), '')::int;
    INSERT INTO email_events (event, email, message_id, issue_no, link, ts)
    VALUES (ev, em, e->>'message-id', ino, e->>'link',
            coalesce(to_timestamp(nullif(e->>'ts_event','')::double precision),
                     to_timestamp(nullif(e->>'ts','')::double precision), d_now()))
    ON CONFLICT DO NOTHING;
    n := n + 1;
    IF em IS NOT NULL THEN
      IF ev IN ('hard_bounce','invalid_email','blocked') THEN
        UPDATE subscribers SET status = 'bounced', status_reason = 'brevo: ' || ev, updated_at = d_now()
         WHERE lower(email) = em AND status = 'active';
      ELSIF ev = 'soft_bounce' THEN
        UPDATE subscribers SET bounce_count = bounce_count + 1,
               status = CASE WHEN bounce_count + 1 >= coalesce(d_cfg('soft_bounce_limit','3'),'3')::int THEN 'bounced' ELSE status END,
               updated_at = d_now()
         WHERE lower(email) = em AND status = 'active';
      ELSIF ev IN ('unsubscribed','spam') THEN
        UPDATE subscribers SET status = 'unsubscribed', status_reason = 'brevo: ' || ev, updated_at = d_now()
         WHERE lower(email) = em AND status = 'active';
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('recorded', n);
END $$;

-- ---------------------------------------------------------------------
-- Stats for the dashboard and /stats (aggregates only, no email addresses)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stats_json() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'generated_at', d_now(),
    'subscribers', (SELECT jsonb_build_object(
        'active',       count(*) FILTER (WHERE status = 'active'),
        'unsubscribed', count(*) FILTER (WHERE status = 'unsubscribed'),
        'bounced',      count(*) FILTER (WHERE status = 'bounced'),
        'new_7d',       count(*) FILTER (WHERE created_at > d_now() - interval '7 days'),
        'web_signups',  count(*) FILTER (WHERE status_reason LIKE 'web:%')) FROM subscribers),
    'issues', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'issue_no')::int) FROM (
        SELECT jsonb_build_object(
          'issue_no', i.issue_no, 'week_start', i.week_start, 'sent_at', i.sent_at, 'status', i.status,
          'sent', (SELECT count(*) FROM deliveries d WHERE d.issue_id = i.id AND d.status = 'sent'),
          'delivered', (SELECT count(DISTINCT email) FROM email_events e WHERE e.issue_no = i.issue_no AND e.event = 'delivered'),
          'opened', (SELECT count(DISTINCT email) FROM email_events e WHERE e.issue_no = i.issue_no AND e.event IN ('opened','unique_opened','proxy_open','unique_proxy_open')),
          'clicked', (SELECT count(DISTINCT email) FROM email_events e WHERE e.issue_no = i.issue_no AND e.event = 'click'),
          'unsubscribed', (SELECT count(DISTINCT email) FROM email_events e WHERE e.issue_no = i.issue_no AND e.event IN ('unsubscribed','spam')),
          'bounced', (SELECT count(DISTINCT email) FROM email_events e WHERE e.issue_no = i.issue_no AND e.event IN ('hard_bounce','soft_bounce','blocked','invalid_email'))) x
        FROM issues i WHERE i.status IN ('sending','sent') ORDER BY i.week_start DESC LIMIT 12) s), '[]'),
    'top_links', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT jsonb_build_object('link', e.link, 'title', coalesce(max(a.title), e.link), 'clicks', count(DISTINCT e.email)) x
          FROM email_events e LEFT JOIN articles a ON a.url = e.link
         WHERE e.event = 'click' AND e.link IS NOT NULL AND e.link NOT LIKE '%dispatch-unsubscribe%'
           AND e.issue_no = (SELECT max(issue_no) FROM email_events WHERE event = 'click')
         GROUP BY e.link ORDER BY count(DISTINCT e.email) DESC LIMIT 8) s), '[]'),
    'topics', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT jsonb_build_object('topic', ii.topic, 'clicks', count(DISTINCT e.email)) x
          FROM email_events e JOIN articles a ON a.url = e.link
          JOIN issue_items ii ON ii.article_id = a.id AND ii.state = 'kept'
         WHERE e.event = 'click' GROUP BY ii.topic ORDER BY count(DISTINCT e.email) DESC LIMIT 10) s), '[]'),
    'sources', coalesce((SELECT jsonb_agg(jsonb_build_object('name', name, 'ok', last_error IS NULL,
                     'last_ok_at', last_ok_at, 'new_last_run', coalesce((last_counts->>'new')::int, 0),
                     'error', left(last_error, 100)) ORDER BY (last_error IS NULL), name)
                FROM sources WHERE active), '[]'),
    'articles_this_week', (SELECT count(*) FROM articles WHERE week_start = d_week_start(d_now()) AND status = 'new'),
    'draft', (SELECT jsonb_build_object('status', status, 'week_start', week_start) FROM issues ORDER BY week_start DESC LIMIT 1)
  )
$$;
