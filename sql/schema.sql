-- =====================================================================
-- The Dispatch: newsletter intelligence & delivery pipeline
-- Postgres schema + business logic (Postgres 14+; Supabase/Neon OK)
--
-- n8n workflows call these functions. Complex payloads are passed as
-- base64-encoded JSON so commas/quotes never break query parameters.
-- All calendar logic uses Asia/Kolkata (IST).
-- Safe to re-run: tables use IF NOT EXISTS, functions use OR REPLACE.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id              serial PRIMARY KEY,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'rss' CHECK (kind IN ('rss','gnews')),
  url             text NOT NULL UNIQUE,
  active          boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  last_counts     jsonb
);

CREATE TABLE IF NOT EXISTS articles (
  id            bigserial PRIMARY KEY,
  url           text NOT NULL,
  url_hash      text NOT NULL UNIQUE,
  title         text NOT NULL,
  title_norm    text NOT NULL,
  entities      text[] NOT NULL DEFAULT '{}',
  summary       text,
  source_id     int REFERENCES sources(id) ON DELETE SET NULL,
  source_name   text,
  published_at  timestamptz,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  week_start    date NOT NULL,
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','duplicate','published')),
  duplicate_of  bigint REFERENCES articles(id) ON DELETE SET NULL
);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS entities text[] NOT NULL DEFAULT '{}';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS pinned_note text;
CREATE INDEX IF NOT EXISTS articles_week_idx   ON articles (week_start, status);
CREATE INDEX IF NOT EXISTS articles_fetched_idx ON articles (fetched_at);
CREATE INDEX IF NOT EXISTS articles_title_trgm ON articles USING gin (title_norm gin_trgm_ops);

CREATE TABLE IF NOT EXISTS issues (
  id               serial PRIMARY KEY,
  week_start       date NOT NULL UNIQUE,
  issue_no         int,
  status           text NOT NULL DEFAULT 'in_review'
                   CHECK (status IN ('in_review','approved','sending','sent','cancelled')),
  model            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_at      timestamptz,
  send_started_at  timestamptz,
  sent_at          timestamptz,
  reminder_sent_at timestamptz,
  stats            jsonb
);

CREATE TABLE IF NOT EXISTS issue_items (
  id                serial PRIMARY KEY,
  issue_id          int NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  article_id        bigint NOT NULL REFERENCES articles(id),
  position          int,                -- order in the newsletter (null for alternates)
  alt_rank          int,                -- order among alternates
  topic             text NOT NULL,
  reason            text,               -- Gemini's selection rationale
  ai_commentary     text,               -- what Gemini drafted
  final_commentary  text,               -- what Shreya approved (edits land here)
  edited            boolean NOT NULL DEFAULT false,
  state             text NOT NULL
                    CHECK (state IN ('proposed','kept','dropped','swapped_out','alternate')),
  telegram_msg_id   bigint,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, article_id)
);

CREATE TABLE IF NOT EXISTS subscribers (
  id            serial PRIMARY KEY,
  email         text NOT NULL,
  name          text,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','unsubscribed','bounced')),
  status_reason text,
  bounce_count  int NOT NULL DEFAULT 0,
  unsub_token   text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_email_uq ON subscribers (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_token_uq ON subscribers (unsub_token);

CREATE TABLE IF NOT EXISTS deliveries (
  id            bigserial PRIMARY KEY,
  issue_id      int NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  subscriber_id int NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts      int NOT NULL DEFAULT 0,
  claimed_at    timestamptz,
  sent_at       timestamptz,
  gmail_id      text,
  last_error    text,
  UNIQUE (issue_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS deliveries_status_idx ON deliveries (status, issue_id);
CREATE INDEX IF NOT EXISTS deliveries_sent_idx   ON deliveries (sent_at);

CREATE TABLE IF NOT EXISTS bot_state (
  chat_id         text PRIMARY KEY,
  pending_action  text,
  pending_item_id int,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processed_emails (
  gmail_id     text PRIMARY KEY,
  kind         text NOT NULL,
  email        text,
  detail       text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION d_cfg(k text, dflt text DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT value FROM config WHERE key = k), dflt)
$$;

-- "now", overridable for testing via config key clock_override
CREATE OR REPLACE FUNCTION d_now() RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(d_cfg('clock_override'), '')::timestamptz, now())
$$;

-- Monday (IST) of the week containing ts
CREATE OR REPLACE FUNCTION d_week_start(ts timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT date_trunc('week', ts AT TIME ZONE 'Asia/Kolkata')::date
$$;

CREATE OR REPLACE FUNCTION d_norm_title(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Two headlines are about the same story only if they share their subject
-- entity (when both have any). Stops "X raises Series B led by Tiger Global" and
-- "Y raises Series B led by Tiger Global" from being merged.
CREATE OR REPLACE FUNCTION d_same_entities(a text[], b text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  -- the headline's subject (first entity) must appear in the other headline
  SELECT coalesce(cardinality(a),0) = 0 OR coalesce(cardinality(b),0) = 0
      OR a[1] = ANY(b) OR b[1] = ANY(a)
$$;

CREATE OR REPLACE FUNCTION d_b64json(b64 text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT convert_from(decode(b64, 'base64'), 'UTF8')::jsonb
$$;

-- Config as a single JSON object (read by every workflow)
CREATE OR REPLACE FUNCTION d_config_json() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM config
$$;

-- ---------------------------------------------------------------------
-- 1. INGESTION + DEDUPLICATION
-- payload: {source_id, error?, items:[{url,title,summary,published_at}]}
--   * exact dupes: same canonical URL (url_hash) -> skipped
--   * near dupes: title trigram similarity >= dedup_threshold against
--     anything fetched in the last 42 days (covers this week AND the
--     previous four weeks' newsletters) -> stored as 'duplicate'
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ingest_batch(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p          jsonb := d_b64json(b64);
  src_id     int   := nullif(p->>'source_id','')::int;
  src_name   text;
  thr        real  := coalesce(d_cfg('dedup_threshold','0.55'),'0.55')::real;
  ts         timestamptz := d_now();
  it         jsonb;
  v_url      text; v_title text; v_norm text; v_hash text; v_pub timestamptz;
  v_ent      text[];
  dup_id     bigint;
  n_in int := 0; n_new int := 0; n_dup int := 0; n_seen int := 0; n_old int := 0;
  max_age    int := coalesce(d_cfg('max_article_age_days','10'),'10')::int;
BEGIN
  SELECT name INTO src_name FROM sources WHERE id = src_id;

  IF p ? 'error' AND coalesce(p->>'error','') <> '' THEN
    UPDATE sources SET last_fetched_at = ts, last_error = left(p->>'error', 500) WHERE id = src_id;
    RETURN jsonb_build_object('source_id', src_id, 'error', p->>'error');
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p->'items','[]'::jsonb)) LOOP
    n_in := n_in + 1;
    v_url   := nullif(btrim(it->>'url'), '');
    v_title := nullif(btrim(it->>'title'), '');
    CONTINUE WHEN v_url IS NULL OR v_title IS NULL;
    v_norm := d_norm_title(v_title);
    CONTINUE WHEN length(v_norm) < 12;               -- junk / empty titles
    v_hash := md5(coalesce(nullif(it->>'canon',''), v_url));
    v_ent  := coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(it->'entities','[]'::jsonb))), '{}');
    BEGIN
      v_pub := nullif(it->>'published_at','')::timestamptz;
    EXCEPTION WHEN others THEN v_pub := NULL;
    END;
    IF v_pub IS NOT NULL AND v_pub < ts - make_interval(days => max_age) THEN
      n_old := n_old + 1; CONTINUE;                  -- stale item lingering in a feed
    END IF;

    IF EXISTS (SELECT 1 FROM articles WHERE url_hash = v_hash) THEN
      n_seen := n_seen + 1; CONTINUE;
    END IF;

    -- near-duplicate search (same story, different outlet / headline tweak)
    SELECT a.id INTO dup_id
      FROM articles a
     WHERE a.fetched_at > ts - interval '42 days'
       AND a.title_norm % v_norm
       AND similarity(a.title_norm, v_norm) >= thr
       AND d_same_entities(a.entities, v_ent)
     ORDER BY (a.status = 'published') DESC, similarity(a.title_norm, v_norm) DESC
     LIMIT 1;
    -- always point at the canonical (root) article
    IF dup_id IS NOT NULL THEN
      SELECT coalesce(duplicate_of, id) INTO dup_id FROM articles WHERE id = dup_id;
    END IF;

    INSERT INTO articles (url, url_hash, title, title_norm, entities, summary, source_id, source_name,
                          published_at, fetched_at, week_start, status, duplicate_of)
    VALUES (v_url, v_hash, left(v_title, 400), v_norm, v_ent, left(it->>'summary', 1200), src_id,
            coalesce(nullif(it->>'source_name',''), src_name), v_pub, ts, d_week_start(ts),
            CASE WHEN dup_id IS NULL THEN 'new' ELSE 'duplicate' END, dup_id)
    ON CONFLICT (url_hash) DO NOTHING;

    IF dup_id IS NULL THEN n_new := n_new + 1; ELSE n_dup := n_dup + 1; END IF;
  END LOOP;

  UPDATE sources
     SET last_fetched_at = ts, last_ok_at = ts, last_error = NULL,
         last_counts = jsonb_build_object('in', n_in, 'new', n_new, 'dup', n_dup, 'seen', n_seen, 'old', n_old)
   WHERE id = src_id;

  RETURN jsonb_build_object('source_id', src_id, 'in', n_in, 'new', n_new,
                            'duplicate', n_dup, 'already_seen', n_seen, 'too_old', n_old);
END $$;

-- ---------------------------------------------------------------------
-- 2. SELECTION CONTEXT (input to Gemini)
-- Candidates = this week's unique articles that are NOT similar to any
-- story in the last four issues. coverage = how many outlets ran it
-- (low coverage is a hint for "under-reported").
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recent_issue_ids(n int DEFAULT 4) RETURNS SETOF int
LANGUAGE sql STABLE AS $$
  SELECT id FROM issues
   WHERE status IN ('approved','sending','sent')
     AND week_start < d_week_start(d_now())
   ORDER BY week_start DESC LIMIT n
$$;

CREATE OR REPLACE FUNCTION build_selection_context() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  wk        date := d_week_start(d_now());
  thr       real := coalesce(d_cfg('dedup_threshold','0.55'),'0.55')::real;
  lim       int  := coalesce(d_cfg('max_candidates','250'),'250')::int;
  existing  issues%ROWTYPE;
  cands     jsonb;
  recent    jsonb;
  edits     jsonb;
  voice     jsonb;
BEGIN
  SELECT * INTO existing FROM issues WHERE week_start = wk;

  WITH covered AS (
    SELECT a.id, a.title_norm, a.url_hash, a.entities
      FROM issue_items ii JOIN articles a ON a.id = ii.article_id
     WHERE ii.issue_id IN (SELECT recent_issue_ids(4))
       AND ii.state IN ('proposed','kept')
  ), cand AS (
    SELECT a.*,
           1 + (SELECT count(*) FROM articles d WHERE d.duplicate_of = a.id) AS coverage
      FROM articles a
     WHERE ((a.status = 'new'
       -- everything fetched since the previous issue was drafted (so stories
       -- fetched after last Wednesday's selection roll into this week)
       AND a.fetched_at > coalesce((SELECT max(created_at) FROM issues WHERE week_start < wk),
                                   (wk - 7)::timestamptz)
       AND coalesce(a.published_at, a.fetched_at)
           > d_now() - make_interval(days => coalesce(d_cfg('max_article_age_days','10'),'10')::int))
       -- Shreya's own picks (sent via Telegram) are always candidates until published
       OR (a.pinned AND a.status <> 'published'
           AND a.fetched_at > coalesce((SELECT max(created_at) FROM issues WHERE week_start < wk),
                                       (wk - 7)::timestamptz)))
       AND NOT EXISTS (SELECT 1 FROM covered c
                        WHERE c.url_hash = a.url_hash
                           OR (c.title_norm % a.title_norm AND similarity(c.title_norm, a.title_norm) >= thr
                               AND d_same_entities(c.entities, a.entities)))
       AND NOT EXISTS (SELECT 1 FROM covered c                 -- its canonical twin was covered
                        JOIN articles d ON d.duplicate_of = a.id
                        WHERE c.id = d.id)
     ORDER BY a.pinned DESC, coalesce(a.published_at, a.fetched_at) DESC
     LIMIT lim
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'title', title, 'source', source_name, 'url', url,
           'summary', left(coalesce(summary,''), 400),
           'published_at', published_at, 'coverage', coverage, 'pinned', pinned,
           'note', pinned_note) ORDER BY id), '[]')
    INTO cands FROM cand;

  SELECT coalesce(jsonb_agg(jsonb_build_object('week', i.week_start, 'topic', ii.topic, 'title', a.title)
                            ORDER BY i.week_start DESC, ii.position), '[]')
    INTO recent
    FROM issue_items ii JOIN issues i ON i.id = ii.issue_id JOIN articles a ON a.id = ii.article_id
   WHERE ii.issue_id IN (SELECT recent_issue_ids(4)) AND ii.state IN ('proposed','kept');

  -- Shreya's edits = the best teaching signal for voice
  SELECT coalesce(jsonb_agg(x), '[]') INTO edits FROM (
    SELECT jsonb_build_object('title', a.title, 'draft', ii.ai_commentary, 'shreya_final', ii.final_commentary) x
      FROM issue_items ii JOIN articles a ON a.id = ii.article_id JOIN issues i ON i.id = ii.issue_id
     WHERE ii.edited AND i.status IN ('approved','sending','sent')
     ORDER BY ii.updated_at DESC LIMIT coalesce(d_cfg('edit_examples','8'),'8')::int) s;

  SELECT coalesce(jsonb_agg(x), '[]') INTO voice FROM (
    SELECT jsonb_build_object('title', a.title, 'commentary', ii.final_commentary) x
      FROM issue_items ii JOIN articles a ON a.id = ii.article_id
     WHERE ii.issue_id IN (SELECT recent_issue_ids(2)) AND ii.state IN ('proposed','kept')
     ORDER BY ii.issue_id DESC, ii.position LIMIT 12) s;

  RETURN jsonb_build_object(
    'week_start', wk,
    'existing_status', existing.status,
    'existing_issue_id', existing.id,
    'candidate_count', jsonb_array_length(cands),
    'candidates', cands,
    'recent_coverage', recent,
    'edit_examples', edits,
    'voice_samples', voice,
    'config', d_config_json()
  );
END $$;

-- ---------------------------------------------------------------------
-- 3. SAVE DRAFT
-- payload: {week_start, model, picks:[{article_id,topic,reason,commentary}],
--           alternates:[{article_id,topic,reason,commentary}]}
-- Re-running for the same week replaces an in_review draft; refuses to
-- touch an approved/sent issue.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION save_draft(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p   jsonb := d_b64json(b64);
  wk  date  := (p->>'week_start')::date;
  iss issues%ROWTYPE;
BEGIN
  SELECT * INTO iss FROM issues WHERE week_start = wk FOR UPDATE;
  IF FOUND AND iss.status NOT IN ('in_review','cancelled') THEN
    RAISE EXCEPTION 'Issue for week % is already %; refusing to overwrite', wk, iss.status;
  END IF;
  IF FOUND THEN
    DELETE FROM issue_items WHERE issue_id = iss.id;
    UPDATE issues SET status = 'in_review', model = p->>'model', created_at = d_now(), intro = p->>'intro',
                      reminder_sent_at = NULL, approved_at = NULL
     WHERE id = iss.id RETURNING * INTO iss;
  ELSE
    INSERT INTO issues (week_start, status, model, created_at, intro)
    VALUES (wk, 'in_review', p->>'model', d_now(), p->>'intro') RETURNING * INTO iss;
  END IF;

  INSERT INTO issue_items (issue_id, article_id, position, topic, reason, ai_commentary, final_commentary, state)
  SELECT iss.id, (x->>'article_id')::bigint, o::int, x->>'topic', x->>'reason',
         x->>'commentary', x->>'commentary', 'proposed'
    FROM jsonb_array_elements(p->'picks') WITH ORDINALITY AS t(x, o);

  INSERT INTO issue_items (issue_id, article_id, alt_rank, topic, reason, ai_commentary, final_commentary, state)
  SELECT iss.id, (x->>'article_id')::bigint, o::int, x->>'topic', x->>'reason',
         x->>'commentary', x->>'commentary', 'alternate'
    FROM jsonb_array_elements(coalesce(p->'alternates','[]')) WITH ORDINALITY AS t(x, o)
  ON CONFLICT (issue_id, article_id) DO NOTHING;

  RETURN issue_view(iss.id);
END $$;

-- Full JSON view of an issue (used by Telegram rendering + email rendering)
CREATE OR REPLACE FUNCTION issue_view(p_issue int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'issue', to_jsonb(i),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'item_id', ii.id, 'article_id', a.id, 'position', ii.position, 'topic', ii.topic,
               'title', a.title, 'url', a.url, 'source', a.source_name, 'reason', ii.reason,
               'commentary', ii.final_commentary, 'edited', ii.edited, 'state', ii.state,
               'telegram_msg_id', ii.telegram_msg_id)
             ORDER BY ii.position)
        FROM issue_items ii JOIN articles a ON a.id = ii.article_id
       WHERE ii.issue_id = i.id AND ii.state IN ('proposed','kept','dropped')), '[]'),
    'alternates_left', (SELECT count(*) FROM issue_items WHERE issue_id = i.id AND state = 'alternate'),
    'active_count', (SELECT count(*) FROM issue_items WHERE issue_id = i.id AND state IN ('proposed','kept')),
    'pending_count', (SELECT count(*) FROM issue_items WHERE issue_id = i.id AND state = 'proposed'),
    'topic_count', (SELECT count(DISTINCT topic) FROM issue_items WHERE issue_id = i.id AND state IN ('proposed','kept')),
    'active_subscribers', (SELECT count(*) FROM subscribers WHERE status = 'active'),
    'send_at', ((i.week_start + 3)::timestamp + coalesce(d_cfg('send_time_ist','08:00'),'08:00')::time)
               AT TIME ZONE 'Asia/Kolkata'
  )
  FROM issues i WHERE i.id = p_issue
$$;

-- payload: [{item_id, message_id}]
CREATE OR REPLACE FUNCTION record_telegram_ids(b64 text) RETURNS int
LANGUAGE sql AS $$
  WITH x AS (SELECT (e->>'item_id')::int item_id, (e->>'message_id')::bigint msg
               FROM jsonb_array_elements(d_b64json(b64)) e
              WHERE e->>'item_id' IS NOT NULL AND e->>'message_id' IS NOT NULL)
  UPDATE issue_items ii SET telegram_msg_id = x.msg FROM x WHERE ii.id = x.item_id
  RETURNING 1
$$;

-- ---------------------------------------------------------------------
-- 4. TELEGRAM REVIEW ACTIONS
-- payload: {type, chat_id, item_id?, issue_id?, text?}
-- types: keep | drop | restore | swap | edit_start | edit_text | cancel |
--        request_approve | confirm | unapprove | status | preview
-- returns {ok, type, message, item?, swapped_out?, view}
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_apply_core(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p        jsonb := d_b64json(b64);
  t        text  := p->>'type';
  chat     text  := coalesce(p->>'chat_id','');
  v_item   issue_items%ROWTYPE;
  v_alt    issue_items%ROWTYPE;
  iss      issues%ROWTYPE;
  st       bot_state%ROWTYPE;
  v_txt    text;
  n        int;
  v_out    jsonb;
  active_topics text[];
BEGIN
  IF t = 'noop' THEN
    RETURN jsonb_build_object('ok', true, 'type', t);
  END IF;

  -- resolve the issue we're acting on
  IF p ? 'item_id' AND p->>'item_id' IS NOT NULL THEN
    SELECT * INTO v_item FROM issue_items WHERE id = (p->>'item_id')::int;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'Story not found.'); END IF;
    SELECT * INTO iss FROM issues WHERE id = v_item.issue_id FOR UPDATE;
  ELSIF p ? 'issue_id' AND p->>'issue_id' IS NOT NULL THEN
    SELECT * INTO iss FROM issues WHERE id = (p->>'issue_id')::int FOR UPDATE;
  ELSE
    SELECT * INTO iss FROM issues ORDER BY week_start DESC LIMIT 1 FOR UPDATE;
  END IF;

  IF t = 'edit_text' THEN
    SELECT * INTO st FROM bot_state WHERE chat_id = chat;
    IF st.pending_action IS DISTINCT FROM 'edit' THEN
      RETURN jsonb_build_object('ok', false, 'type', t,
        'message', 'Tap ✏️ Edit on a story first, then send the new commentary. /help for commands.');
    END IF;
    SELECT * INTO v_item FROM issue_items WHERE id = st.pending_item_id;
    SELECT * INTO iss FROM issues WHERE id = v_item.issue_id FOR UPDATE;
  END IF;

  IF iss.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'No newsletter draft exists yet.');
  END IF;

  -- read-only actions
  IF t IN ('status','preview') THEN
    RETURN jsonb_build_object('ok', true, 'type', t, 'view', issue_view(iss.id));
  END IF;

  IF t = 'cancel' THEN
    DELETE FROM bot_state WHERE chat_id = chat;
    RETURN jsonb_build_object('ok', true, 'type', t, 'message', 'Cancelled.', 'view', issue_view(iss.id));
  END IF;

  IF t = 'unapprove' THEN
    IF iss.status <> 'approved' THEN
      RETURN jsonb_build_object('ok', false, 'type', t,
        'message', format('Can''t unapprove: issue is %s.', iss.status));
    END IF;
    DELETE FROM deliveries WHERE issue_id = iss.id AND status = 'pending';
    UPDATE issues SET status = 'in_review', approved_at = NULL, issue_no = NULL WHERE id = iss.id;
    RETURN jsonb_build_object('ok', true, 'type', t,
      'message', 'Approval withdrawn. Nothing will be sent until you confirm again.', 'view', issue_view(iss.id));
  END IF;

  -- everything below mutates the draft: must be in review
  IF iss.status <> 'in_review' THEN
    RETURN jsonb_build_object('ok', false, 'type', t,
      'message', format('This draft is locked (status: %s).%s', iss.status,
                        CASE WHEN iss.status = 'approved' THEN ' Send /unapprove to reopen it.' ELSE '' END));
  END IF;

  IF t IN ('keep','drop','restore','swap','edit_start') AND v_item.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'Story not found.');
  END IF;
  IF t IN ('keep','drop','restore','swap','edit_start','edit_text')
     AND v_item.state NOT IN ('proposed','kept','dropped') THEN
    RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'That story was already swapped out.');
  END IF;

  IF t = 'keep' OR t = 'restore' THEN
    UPDATE issue_items SET state = 'kept', updated_at = d_now() WHERE id = v_item.id;
    v_out := jsonb_build_object('message', format('#%s kept ✅', v_item.position));

  ELSIF t = 'drop' THEN
    UPDATE issue_items SET state = 'dropped', updated_at = d_now() WHERE id = v_item.id;
    v_out := jsonb_build_object('message', format('#%s dropped', v_item.position));

  ELSIF t = 'swap' THEN
    -- topics of the other active stories
    SELECT array_agg(DISTINCT topic) INTO active_topics FROM issue_items
     WHERE issue_id = iss.id AND state IN ('proposed','kept') AND id <> v_item.id;
    -- prefer an alternate that keeps >= 3 topics; then a new topic; then rank
    SELECT * INTO v_alt FROM issue_items
     WHERE issue_id = iss.id AND state = 'alternate'
     ORDER BY (coalesce(array_length(array(SELECT DISTINCT unnest(coalesce(active_topics,'{}') || topic)),1),0) >= 3) DESC,
              (topic = ANY(coalesce(active_topics,'{}'))) ASC,
              alt_rank
     LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'type', t,
        'message', 'No alternates left for this week. Use 🗑 Drop or ✏️ Edit instead.');
    END IF;
    UPDATE issue_items SET state = 'swapped_out', telegram_msg_id = NULL, updated_at = d_now()
     WHERE id = v_item.id;
    UPDATE issue_items SET state = 'proposed', position = v_item.position, alt_rank = NULL,
                           telegram_msg_id = v_item.telegram_msg_id, updated_at = d_now()
     WHERE id = v_alt.id;
    v_out := jsonb_build_object('message', format('#%s swapped 🔁', v_item.position),
                                'swapped_in_item_id', v_alt.id, 'swapped_out_item_id', v_item.id);
    v_item.id := v_alt.id;

  ELSIF t = 'edit_start' THEN
    INSERT INTO bot_state (chat_id, pending_action, pending_item_id, updated_at)
    VALUES (chat, 'edit', v_item.id, d_now())
    ON CONFLICT (chat_id) DO UPDATE SET pending_action = 'edit', pending_item_id = v_item.id, updated_at = d_now();
    v_out := jsonb_build_object('message', format('Send the new commentary for #%s', v_item.position));

  ELSIF t = 'edit_text' THEN
    v_txt := btrim(coalesce(p->>'text',''));
    IF length(v_txt) < 10 THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'That looks too short. Send the full commentary, or /cancel.');
    END IF;
    UPDATE issue_items SET final_commentary = left(v_txt, 1500), edited = (left(v_txt,1500) IS DISTINCT FROM ai_commentary),
                           state = 'kept', updated_at = d_now()
     WHERE id = v_item.id;
    DELETE FROM bot_state WHERE chat_id = chat;
    v_out := jsonb_build_object('message', format('#%s updated ✏️ and kept', v_item.position));

  ELSIF t = 'request_approve' THEN
    SELECT count(*) INTO n FROM issue_items WHERE issue_id = iss.id AND state IN ('proposed','kept');
    IF n = 0 THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'Every story is dropped; nothing to send.');
    END IF;
    v_out := jsonb_build_object('message', 'Preview ready');

  ELSIF t = 'confirm' THEN
    SELECT count(*) INTO n FROM issue_items WHERE issue_id = iss.id AND state IN ('proposed','kept');
    IF n = 0 THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'Every story is dropped; nothing to send.');
    END IF;
    -- pending (untouched) stories are approved as-is by the explicit confirm
    UPDATE issue_items SET state = 'kept', updated_at = d_now() WHERE issue_id = iss.id AND state = 'proposed';
    -- re-number positions 1..n to close gaps left by drops
    WITH o AS (SELECT id, row_number() OVER (ORDER BY position) rn FROM issue_items
                WHERE issue_id = iss.id AND state = 'kept')
    UPDATE issue_items ii SET position = o.rn FROM o WHERE ii.id = o.id;
    UPDATE issues
       SET status = 'approved', approved_at = d_now(),
           issue_no = coalesce((SELECT max(issue_no) FROM issues WHERE id <> iss.id),
                               coalesce(d_cfg('issue_number_start','1'),'1')::int - 1) + 1
     WHERE id = iss.id;
    INSERT INTO deliveries (issue_id, subscriber_id)
    SELECT iss.id, s.id FROM subscribers s WHERE s.status = 'active'
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM bot_state WHERE chat_id = chat;
    v_out := jsonb_build_object('message', format('Approved. Queued for %s subscribers.', n), 'queued', n);
  ELSE
    RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'Unknown action.');
  END IF;

  RETURN v_out || jsonb_build_object(
    'ok', true, 'type', t,
    'item', (SELECT x FROM jsonb_array_elements(issue_view(iss.id)->'items') x
              WHERE (x->>'item_id')::int = v_item.id),
    'view', issue_view(iss.id));
END $$;

-- ---------------------------------------------------------------------
-- 5. REMINDERS (Wed 22:00 IST, Thu 07:30 IST). Never sends the newsletter.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reminder_check() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  wk  date := d_week_start(d_now());
  iss issues%ROWTYPE;
BEGIN
  SELECT * INTO iss FROM issues WHERE week_start = wk;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('send', true, 'kind', 'missing',
      'text', '⚠️ No draft was generated for this week. Check the "Dispatch 2 · Select & Draft" workflow, or run it manually.');
  END IF;
  IF iss.status = 'in_review' THEN
    UPDATE issues SET reminder_sent_at = d_now() WHERE id = iss.id;
    RETURN jsonb_build_object('send', true, 'kind', 'reminder', 'issue_id', iss.id, 'view', issue_view(iss.id));
  END IF;
  RETURN jsonb_build_object('send', false, 'status', iss.status);
END $$;

-- ---------------------------------------------------------------------
-- 6. SENDING (worker ticks every 10 min). Only issues Shreya approved.
-- Respects the Gmail daily cap; resumes the next day if the cap is hit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_delivery_batch() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  ts        timestamptz := d_now();
  batch     int := coalesce(d_cfg('send_batch_size','40'),'40')::int;
  cap       int := coalesce(d_cfg('daily_send_cap','450'),'450')::int;
  sent_today int;
  room      int;
  iss       issues%ROWTYPE;
  send_at   timestamptz;
  rows      jsonb;
BEGIN
  -- recover deliveries stuck in 'sending' (crashed execution)
  UPDATE deliveries SET status = 'pending' WHERE status = 'sending' AND claimed_at < ts - interval '30 minutes';

  SELECT * INTO iss FROM issues
   WHERE status IN ('approved','sending')
   ORDER BY week_start LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', 0, 'reason', 'nothing approved'); END IF;

  send_at := ((iss.week_start + 3)::timestamp + coalesce(d_cfg('send_time_ist','08:00'),'08:00')::time) AT TIME ZONE 'Asia/Kolkata';
  IF ts < send_at THEN
    RETURN jsonb_build_object('claimed', 0, 'reason', 'waiting for send time', 'send_at', send_at);
  END IF;

  SELECT count(*) INTO sent_today FROM deliveries
   WHERE sent_at >= (date_trunc('day', ts AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata');
  room := least(batch, cap - sent_today);
  IF room <= 0 THEN
    RETURN jsonb_build_object('claimed', 0, 'reason', 'daily cap reached', 'sent_today', sent_today);
  END IF;

  IF iss.status = 'approved' THEN
    UPDATE issues SET status = 'sending', send_started_at = ts WHERE id = iss.id;
  END IF;

  WITH c AS (
    SELECT d.id FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id
     WHERE d.issue_id = iss.id AND d.status = 'pending' AND s.status = 'active'
     ORDER BY d.id LIMIT room FOR UPDATE OF d SKIP LOCKED
  ), u AS (
    UPDATE deliveries d SET status = 'sending', claimed_at = ts, attempts = attempts + 1
      FROM c WHERE d.id = c.id RETURNING d.id, d.subscriber_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('delivery_id', u.id, 'email', s.email,
                                               'name', s.name, 'unsub_token', s.unsub_token)), '[]')
    INTO rows FROM u JOIN subscribers s ON s.id = u.subscriber_id;

  -- subscribers who left after approval are skipped, not sent
  UPDATE deliveries d SET status = 'skipped' FROM subscribers s
   WHERE d.subscriber_id = s.id AND d.issue_id = iss.id AND d.status = 'pending' AND s.status <> 'active';

  RETURN jsonb_build_object('claimed', jsonb_array_length(rows), 'issue_id', iss.id,
                            'recipients', rows, 'newsletter', issue_view(iss.id));
END $$;

-- payload: [{delivery_id, ok, gmail_id?, error?}]
CREATE OR REPLACE FUNCTION delivery_results(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  max_attempts int := coalesce(d_cfg('max_send_attempts','3'),'3')::int;
  n_ok int; n_fail int;
BEGIN
  WITH r AS (SELECT (e->>'delivery_id')::bigint id, coalesce((e->>'ok')::boolean,false) ok,
                    e->>'gmail_id' gid, e->>'error' err
               FROM jsonb_array_elements(d_b64json(b64)) e)
  UPDATE deliveries d
     SET status = CASE WHEN r.ok THEN 'sent'
                       WHEN d.attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
         sent_at = CASE WHEN r.ok THEN d_now() ELSE d.sent_at END,
         gmail_id = coalesce(r.gid, d.gmail_id),
         last_error = CASE WHEN r.ok THEN NULL ELSE left(r.err, 500) END
    FROM r WHERE d.id = r.id;
  SELECT count(*) FILTER (WHERE (e->>'ok')::boolean), count(*) FILTER (WHERE NOT coalesce((e->>'ok')::boolean,false))
    INTO n_ok, n_fail FROM jsonb_array_elements(d_b64json(b64)) e;
  RETURN jsonb_build_object('sent', n_ok, 'failed', n_fail);
END $$;

-- Close out issues whose queue is drained; returns a summary to notify Shreya.
CREATE OR REPLACE FUNCTION finalize_sends() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  iss issues%ROWTYPE;
  s   jsonb;
BEGIN
  SELECT * INTO iss FROM issues i
   WHERE i.status = 'sending'
     AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.issue_id = i.id AND d.status IN ('pending','sending'))
   ORDER BY week_start LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false); END IF;

  SELECT jsonb_build_object(
           'sent',    count(*) FILTER (WHERE status = 'sent'),
           'failed',  count(*) FILTER (WHERE status = 'failed'),
           'skipped', count(*) FILTER (WHERE status = 'skipped'))
    INTO s FROM deliveries WHERE issue_id = iss.id;

  UPDATE issues SET status = 'sent', sent_at = d_now(), stats = s WHERE id = iss.id;
  -- mark published stories (and their duplicates) so they are never picked again
  UPDATE articles SET status = 'published'
   WHERE id IN (SELECT article_id FROM issue_items WHERE issue_id = iss.id AND state = 'kept');
  RETURN jsonb_build_object('finalized', true, 'issue_id', iss.id, 'issue_no', iss.issue_no, 'stats', s);
END $$;

-- ---------------------------------------------------------------------
-- 7. UNSUBSCRIBES + BOUNCES
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION unsubscribe_token(tok text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE s subscribers%ROWTYPE;
BEGIN
  UPDATE subscribers SET status = 'unsubscribed', status_reason = 'link', updated_at = d_now()
   WHERE unsub_token = tok AND status = 'active' RETURNING * INTO s;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'email', s.email); END IF;
  RETURN jsonb_build_object('ok', EXISTS (SELECT 1 FROM subscribers WHERE unsub_token = tok), 'already', true);
END $$;

-- payload: [{gmail_id, kind: 'bounce'|'unsubscribe', email, hard?, detail}]
-- hard bounce -> bounced immediately; soft bounce -> bounced after N strikes
CREATE OR REPLACE FUNCTION process_inbound(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  e jsonb;
  soft_limit int := coalesce(d_cfg('soft_bounce_limit','3'),'3')::int;
  n_b int := 0; n_u int := 0; n_skip int := 0;
BEGIN
  FOR e IN SELECT * FROM jsonb_array_elements(d_b64json(b64)) LOOP
    INSERT INTO processed_emails (gmail_id, kind, email, detail)
    VALUES (e->>'gmail_id', e->>'kind', lower(e->>'email'), left(e->>'detail', 300))
    ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN n_skip := n_skip + 1; CONTINUE; END IF;   -- already handled
    CONTINUE WHEN coalesce(e->>'email','') = '';

    IF e->>'kind' = 'unsubscribe' THEN
      UPDATE subscribers SET status = 'unsubscribed', status_reason = 'email reply', updated_at = d_now()
       WHERE lower(email) = lower(e->>'email') AND status = 'active';
      IF FOUND THEN n_u := n_u + 1; END IF;
    ELSIF e->>'kind' = 'bounce' THEN
      UPDATE subscribers
         SET bounce_count = bounce_count + 1,
             status = CASE WHEN coalesce((e->>'hard')::boolean, false) OR bounce_count + 1 >= soft_limit
                           THEN 'bounced' ELSE status END,
             status_reason = left(coalesce(e->>'detail','bounce'), 200),
             updated_at = d_now()
       WHERE lower(email) = lower(e->>'email') AND status = 'active';
      IF FOUND THEN n_b := n_b + 1; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('bounces', n_b, 'unsubscribes', n_u, 'already_processed', n_skip);
END $$;
