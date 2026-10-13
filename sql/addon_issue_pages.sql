-- =====================================================================
-- Add-on: a public page per sent issue (the-dispatch-india.vercel.app/issue/<n>)
-- =====================================================================
INSERT INTO config (key, value) VALUES ('site_url', 'https://the-dispatch-india.vercel.app')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION web_issue(n int) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT jsonb_build_object(
      'newsletter', d_cfg('newsletter_name','The Dispatch'),
      'issue_no', i.issue_no, 'week_start', i.week_start, 'sent_at', i.sent_at,
      'intro', i.intro, 'sponsor', i.sponsor,
      'stories', (SELECT coalesce(jsonb_agg(jsonb_build_object('topic', ii.topic, 'title', a.title, 'url', a.url,
                                  'source', a.source_name, 'commentary', ii.final_commentary) ORDER BY ii.position), '[]')
                    FROM issue_items ii JOIN articles a ON a.id = ii.article_id
                   WHERE ii.issue_id = i.id AND ii.state = 'kept'),
      'prev', (SELECT max(x.issue_no) FROM issues x WHERE x.status = 'sent' AND NOT x.demo AND x.issue_no < i.issue_no),
      'next', (SELECT min(x.issue_no) FROM issues x WHERE x.status = 'sent' AND NOT x.demo AND x.issue_no > i.issue_no))
      FROM issues i
     WHERE i.issue_no = n AND i.status = 'sent' AND NOT i.demo
     LIMIT 1), jsonb_build_object('error', 'not_found'))
$$;
