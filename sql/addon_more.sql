-- =====================================================================
-- Add-ons 2-5 (run after addon_voice.sql and addon_pipeline_view.sql). Safe to re-run.
--  2. Voice guide: "voice" shows it, "voicerule <rule>" adds a house rule
--  3. Full-article reading: the text Gemini read is saved; "read 3" shows it
--  4. Suggest a story: readers suggest links on the website; Shreya
--     sees them with "suggestions", pins one with "take 12", drops with "skip 12"
--  5. Tracking: all of the above feeds the Control Room dashboard
-- =====================================================================

ALTER TABLE articles ADD COLUMN IF NOT EXISTS full_text text;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- payload: {"<article id>": "<extracted text>", ...}
CREATE OR REPLACE FUNCTION save_article_texts(b64 text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE articles a SET full_text = left(e.value, 4000), read_at = d_now()
    FROM jsonb_each_text(coalesce(d_b64json(b64), '{}'::jsonb)) e
   WHERE e.key ~ '^[0-9]+$' AND a.id = e.key::bigint AND length(e.value) >= 200;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- Reader suggestions (website form)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reader_suggestions (
  id          serial PRIMARY KEY,
  url         text NOT NULL,
  url_hash    text NOT NULL,
  title       text,
  note        text,
  name        text,
  email       text,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','taken','skipped')),
  week_start  date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS reader_suggestions_week_uq ON reader_suggestions (url_hash, week_start);
CREATE INDEX IF NOT EXISTS reader_suggestions_status_idx ON reader_suggestions (status, created_at);

-- payload: {url, title?, note?, name?, email?, website?(honeypot)}
CREATE OR REPLACE FUNCTION web_suggest(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p     jsonb := coalesce(d_b64json(b64), '{}'::jsonb);
  v_url text  := btrim(left(coalesce(p->>'url', ''), 600));
  v_em  text  := nullif(lower(btrim(left(coalesce(p->>'email', ''), 200))), '');
  v_hash text;
  ts    timestamptz := d_now();
  today int;
  rid   int;
BEGIN
  IF coalesce(p->>'website', '') <> '' THEN                 -- bots fill the hidden field
    RETURN jsonb_build_object('ok', true, 'message', 'Thanks! Shreya will take a look.');
  END IF;
  IF v_url !~* '^https?://[^\s/$.?#][^\s]{3,}$' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please paste a full link (starting with https://).');
  END IF;
  IF v_url ~* '(the-dispatch-india\.vercel\.app|localhost|127\.0\.0\.1)' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please share a link to a news story.');
  END IF;
  IF v_em IS NOT NULL AND v_em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'That email doesn''t look right. Leave it blank if you prefer.');
  END IF;
  SELECT count(*) INTO today FROM reader_suggestions WHERE created_at > ts - interval '1 day';
  IF today >= 60 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'We''ve had a lot of suggestions today. Please try again tomorrow.');
  END IF;
  IF v_em IS NOT NULL AND (SELECT count(*) FROM reader_suggestions WHERE email = v_em AND created_at > ts - interval '1 day') >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Thanks! You''ve sent 3 today, which is the daily limit.');
  END IF;

  v_hash := md5(lower(regexp_replace(v_url, '[?#].*$', '')));
  IF EXISTS (SELECT 1 FROM articles WHERE (url_hash = md5(v_url) OR url = v_url) AND status = 'published') THEN
    RETURN jsonb_build_object('ok', true, 'message', 'Good eye! That story already ran in a past issue.');
  END IF;
  INSERT INTO reader_suggestions (url, url_hash, title, note, name, email, week_start)
  VALUES (v_url, v_hash, nullif(btrim(left(coalesce(p->>'title', ''), 300)), ''),
          nullif(btrim(left(coalesce(p->>'note', ''), 400)), ''), nullif(btrim(left(coalesce(p->>'name', ''), 80)), ''),
          v_em, d_week_start(ts))
  ON CONFLICT (url_hash, week_start) DO NOTHING
  RETURNING id INTO rid;
  IF rid IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'message', 'Thanks! Someone already suggested that one this week.');
  END IF;
  RETURN jsonb_build_object('ok', true, 'message', 'Thanks! Shreya reads every suggestion before Wednesday''s draft.',
    -- tell Shreya about the first few each day; the rest wait for "suggestions"
    'notify', today < 8,
    'suggestion', (SELECT jsonb_build_object('id', id, 'url', url, 'title', title, 'note', note, 'name', name)
                     FROM reader_suggestions WHERE id = rid),
    'open_count', (SELECT count(*) FROM reader_suggestions WHERE status = 'new'));
END $$;

CREATE OR REPLACE FUNCTION open_suggestions(lim int DEFAULT 10) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'url', url, 'title', title, 'note', note, 'name', name,
                                               'at', created_at) ORDER BY created_at DESC), '[]')
    FROM (SELECT * FROM reader_suggestions WHERE status = 'new' AND created_at > d_now() - interval '21 days'
           ORDER BY created_at DESC LIMIT lim) s
$$;

-- ---------------------------------------------------------------------
-- Voice guide helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION voice_rule_add(rule text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  g    text := d_cfg('style_guide', '');
  r    text := btrim(regexp_replace(left(coalesce(rule, ''), 300), '\s+', ' ', 'g'));
  head text := '## Shreya''s house rules';
  n    int;
BEGIN
  IF length(r) < 4 THEN
    RETURN jsonb_build_object('ok', false, 'type', 'voice_rule', 'message', 'Add the rule after the word, e.g. "voicerule never call a funding round a success".');
  END IF;
  IF position(head IN g) = 0 THEN g := rtrim(g, E' \n\t\r') || E'\n\n' || head; END IF;
  n := (SELECT count(*) FROM regexp_matches(substr(g, position(head IN g)), E'\n- ', 'g'));
  IF n >= 30 THEN
    RETURN jsonb_build_object('ok', false, 'type', 'voice_rule', 'message', 'You already have 30 house rules. Ask me to tidy them up first.');
  END IF;
  g := rtrim(g, E' \n\t\r') || E'\n- ' || r;
  INSERT INTO config (key, value) VALUES ('style_guide', g) ON CONFLICT (key) DO UPDATE SET value = excluded.value;
  RETURN jsonb_build_object('ok', true, 'type', 'voice_rule', 'rule', r, 'rules', n + 1);
END $$;

CREATE OR REPLACE FUNCTION voice_summary() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('ok', true, 'type', 'voice_show',
    'guide_chars', length(d_cfg('style_guide', '')),
    'stance', substring(d_cfg('style_guide', '') from '## My stance\n([\s\S]*?)\n## '),
    'rules', coalesce((SELECT jsonb_agg(m[1]) FROM regexp_matches(
               coalesce(substring(d_cfg('style_guide', '') from '## Shreya''s house rules\n([\s\S]*)$'), ''), E'- ([^\n]+)', 'g') m), '[]'),
    'edits', (SELECT count(*) FROM issue_items WHERE edited),
    'edit_rate', (SELECT round(100.0 * count(*) FILTER (WHERE ii.edited) / nullif(count(*), 0))
                    FROM issue_items ii JOIN issues i ON i.id = ii.issue_id
                   WHERE ii.state = 'kept' AND i.status = 'sent' AND NOT coalesce(i.demo, false)))
$$;

-- ---------------------------------------------------------------------
-- Telegram: new commands, then the existing numbered/normal handling
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION review_apply_more(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p   jsonb := d_b64json(b64);
  t   text  := p->>'type';
  k   int   := nullif(p->>'n', '')::int;
  s   reader_suggestions%ROWTYPE;
  r   jsonb;
BEGIN
  IF t = 'read_story' THEN
    SELECT jsonb_build_object('ok', true, 'type', t, 'position', ii.position, 'title', a.title, 'url', a.url,
             'source', a.source_name, 'full_text', a.full_text, 'summary', a.summary, 'commentary', ii.final_commentary)
      INTO r
      FROM issue_items ii JOIN articles a ON a.id = ii.article_id
     WHERE ii.issue_id = (SELECT id FROM issues WHERE NOT coalesce(demo, false) AND status <> 'cancelled'
                           ORDER BY week_start DESC LIMIT 1)
       AND ii.position = k AND ii.state IN ('proposed','kept','dropped')
     LIMIT 1;
    RETURN coalesce(r, jsonb_build_object('ok', false, 'type', t,
      'message', format('There''s no story #%s in the latest draft.', coalesce(k::text, '?'))));
  ELSIF t = 'suggestions' THEN
    RETURN jsonb_build_object('ok', true, 'type', t, 'list', open_suggestions(10));
  ELSIF t IN ('take_suggestion', 'skip_suggestion') THEN
    SELECT * INTO s FROM reader_suggestions WHERE id = k;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', format('No reader suggestion #%s. Send "suggestions" to see the list.', coalesce(k::text, '?')));
    END IF;
    IF s.status <> 'new' THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', format('Suggestion #%s was already %s.', k, s.status));
    END IF;
    IF t = 'skip_suggestion' THEN
      UPDATE reader_suggestions SET status = 'skipped', handled_at = d_now() WHERE id = k;
      RETURN jsonb_build_object('ok', true, 'type', t, 'id', k, 'left', (SELECT count(*) FROM reader_suggestions WHERE status = 'new'));
    END IF;
    r := suggest_story(jsonb_build_object('url', s.url, 'title', s.title,
           'note', concat_ws(' ', 'Reader suggestion' || coalesce(' from ' || s.name, '') || '.', s.note), 'site', 'Reader pick'));
    IF coalesce((r->>'ok')::boolean, false) THEN
      UPDATE reader_suggestions SET status = 'taken', handled_at = d_now() WHERE id = k;
    END IF;
    RETURN r || jsonb_build_object('type', t, 'id', k);
  ELSIF t = 'voice_show' THEN
    RETURN voice_summary();
  ELSIF t = 'voice_rule' THEN
    RETURN voice_rule_add(p->>'text');
  END IF;
  RETURN review_apply_numbered(b64);
END $$;

-- Tuesday preview also mentions open reader suggestions
CREATE OR REPLACE FUNCTION tuesday_preview() RETURNS jsonb
LANGUAGE sql AS $$
  WITH c AS (SELECT build_selection_context() AS ctx)
  SELECT jsonb_build_object(
    'candidate_count', (ctx->>'candidate_count')::int,
    'pinned', (SELECT coalesce(jsonb_agg(x->>'title'), '[]') FROM jsonb_array_elements(ctx->'candidates') x WHERE (x->>'pinned')::boolean),
    'top', (SELECT coalesce(jsonb_agg(x ORDER BY (x->>'coverage')::int DESC, x->>'published_at' DESC), '[]') FROM (
              SELECT x FROM jsonb_array_elements(ctx->'candidates') x
               ORDER BY (x->>'coverage')::int DESC, x->>'published_at' DESC LIMIT 6) s),
    'reader_suggestions', (SELECT count(*) FROM reader_suggestions WHERE status = 'new' AND created_at > d_now() - interval '21 days'))
  FROM c
$$;

-- ---------------------------------------------------------------------
-- Dashboard: what was read in full, reader suggestions, voice rules
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pipeline_more() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH cur AS (SELECT i.* FROM issues i WHERE i.week_start = d_week_start(d_now()) AND NOT coalesce(i.demo, false) LIMIT 1)
  SELECT jsonb_build_object(
    'reading', jsonb_build_object(
      'read', (SELECT count(*) FROM issue_items ii JOIN articles a ON a.id = ii.article_id, cur
                WHERE ii.issue_id = cur.id AND a.full_text IS NOT NULL),
      'shortlist', (SELECT count(*) FROM issue_items ii, cur WHERE ii.issue_id = cur.id),
      'texts', coalesce((SELECT jsonb_object_agg(a.id::text, left(a.full_text, 2500))
                FROM issue_items ii JOIN articles a ON a.id = ii.article_id, cur
               WHERE ii.issue_id = cur.id AND a.full_text IS NOT NULL), '{}')),
    'suggestions', jsonb_build_object(
      'open', (SELECT count(*) FROM reader_suggestions WHERE status = 'new'),
      'taken', (SELECT count(*) FROM reader_suggestions WHERE status = 'taken'),
      'week', (SELECT count(*) FROM reader_suggestions WHERE week_start = d_week_start(d_now())),
      'list', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'url', url, 'title', title, 'note', note,
                         'name', name, 'status', status, 'at', created_at) ORDER BY created_at DESC)
                FROM (SELECT * FROM reader_suggestions ORDER BY created_at DESC LIMIT 30) s), '[]')),
    'voice_rules', coalesce((SELECT jsonb_agg(m[1]) FROM regexp_matches(
               coalesce(substring(d_cfg('style_guide', '') from '## Shreya''s house rules\n([\s\S]*)$'), ''), E'- ([^\n]+)', 'g') m), '[]'))
$$;

CREATE OR REPLACE FUNCTION pipeline_json() RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT pipeline_core() || pipeline_extras() || pipeline_more() $$;
