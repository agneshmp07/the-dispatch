-- =====================================================================
-- Add-on: website sign-ups + public archive (run after schema.sql)
-- =====================================================================

-- payload: {email, name?, source?}
CREATE OR REPLACE FUNCTION web_subscribe(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p   jsonb := d_b64json(b64);
  em  text  := lower(btrim(coalesce(p->>'email','')));
  nm  text  := nullif(btrim(left(coalesce(p->>'name',''), 80)), '');
  s   subscribers%ROWTYPE;
BEGIN
  IF em !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' OR length(em) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please enter a valid email address.');
  END IF;
  SELECT * INTO s FROM subscribers WHERE lower(email) = em;
  IF FOUND THEN
    IF s.status = 'active' THEN
      RETURN jsonb_build_object('ok', true, 'message', 'You''re already subscribed. See you Thursday!');
    END IF;
    -- returning reader (unsubscribed/bounced) -> re-activate
    UPDATE subscribers SET status = 'active', status_reason = 'resubscribed via web',
           bounce_count = 0, updated_at = d_now() WHERE id = s.id;
    RETURN jsonb_build_object('ok', true, 'message', 'Welcome back! You''re subscribed again.');
  END IF;
  INSERT INTO subscribers (email, name, status_reason) VALUES (em, nm, 'web: ' || coalesce(p->>'source','site'));
  RETURN jsonb_build_object('ok', true, 'message', 'You''re in! The next issue lands Thursday morning.');
END $$;

-- Public archive: sent issues with their stories (no subscriber data)
CREATE OR REPLACE FUNCTION web_archive(lim int DEFAULT 12) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'newsletter', d_cfg('newsletter_name','The Dispatch'),
    'tagline', d_cfg('newsletter_tagline',''),
    'subscribers', (SELECT count(*) FROM subscribers WHERE status = 'active'),
    'issues', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'issue_no')::int DESC) FROM (
        SELECT jsonb_build_object(
          'issue_no', i.issue_no, 'week_start', i.week_start, 'sent_at', i.sent_at,
          'stories', (SELECT jsonb_agg(jsonb_build_object('topic', ii.topic, 'title', a.title,
                                       'url', a.url, 'source', a.source_name,
                                       'commentary', ii.final_commentary) ORDER BY ii.position)
                        FROM issue_items ii JOIN articles a ON a.id = ii.article_id
                       WHERE ii.issue_id = i.id AND ii.state = 'kept')) x
          FROM issues i WHERE i.status = 'sent'
         ORDER BY i.week_start DESC LIMIT lim) s), '[]'::jsonb)
  )
$$;
