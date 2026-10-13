-- =====================================================================
-- Add-on: keyed news API (NewsData.io) as an extra ingestion source,
-- plus Telegram-only setup ("newskey <key>") and test sends.
-- =====================================================================
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE sources ADD CONSTRAINT sources_kind_check CHECK (kind IN ('rss','gnews','newsdata'));

INSERT INTO config (key, value) VALUES ('newsdata_api_key', ''), ('test_email', '')
ON CONFLICT (key) DO NOTHING;

INSERT INTO sources (name, kind, url) VALUES
  ('API: Indian startups & funding', 'newsdata', 'startup OR funding OR unicorn OR "series a"'),
  ('API: fintech, policy & IPOs',    'newsdata', 'fintech OR RBI OR SEBI OR IPO')
ON CONFLICT (url) DO NOTHING;

CREATE OR REPLACE FUNCTION review_apply_numbered(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p    jsonb := d_b64json(b64);
  t    text  := p->>'type';
  pos  int;
  iid  int;
  r    jsonb;
  k    text;
BEGIN
  IF t = 'set_news_key' THEN
    k := btrim(coalesce(p->>'key',''));
    IF k !~ '^[A-Za-z0-9_-]{16,80}$' THEN
      RETURN jsonb_build_object('ok', false, 'type', t, 'message', 'That doesn''t look like a NewsData API key. Send: newskey YOUR_KEY');
    END IF;
    UPDATE config SET value = k WHERE key = 'newsdata_api_key';
    RETURN jsonb_build_object('ok', true, 'type', t, 'masked', left(k, 4) || '…' || right(k, 3),
      'sources', (SELECT count(*) FROM sources WHERE kind = 'newsdata' AND active));
  END IF;

  IF p ? 'position' AND coalesce(p->>'item_id','') = '' THEN
    pos := (p->>'position')::int;
    SELECT ii.id INTO iid
      FROM issue_items ii
      JOIN issues i ON i.id = ii.issue_id
     WHERE i.id = (SELECT id FROM issues WHERE status = 'in_review' AND NOT coalesce(demo,false) ORDER BY week_start DESC LIMIT 1)
       AND ii.position = pos AND ii.state IN ('proposed','kept','dropped')
     LIMIT 1;
    IF iid IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'type', t,
        'message', format('There''s no story #%s in the current draft. Send "status" to see the draft.', pos));
    END IF;
    p := p || jsonb_build_object('item_id', iid);

    IF t = 'edit_with_text' THEN
      r := review_apply(encode(convert_to((p || '{"type":"edit_start"}')::text, 'UTF8'), 'base64'));
      IF NOT coalesce((r->>'ok')::boolean, false) THEN RETURN r; END IF;
      RETURN review_apply(encode(convert_to((p - 'item_id' || '{"type":"edit_text"}')::text, 'UTF8'), 'base64'));
    END IF;
  END IF;
  RETURN review_apply(encode(convert_to(p::text, 'UTF8'), 'base64'));
END $$;

-- What a test send needs: the current draft (or approved issue) and where to send it
CREATE OR REPLACE FUNCTION test_send_payload() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'cfg', d_config_json(),
    'to', coalesce(nullif(d_cfg('test_email',''), ''), nullif(d_cfg('reply_to',''), ''), d_cfg('sender_email','')),
    'view', (SELECT issue_view(id) FROM issues WHERE status IN ('in_review','approved') AND NOT coalesce(demo,false)
              ORDER BY week_start DESC LIMIT 1))
$$;
