-- =====================================================================
-- Add-on: read-only "control room" data for the website dashboard.
-- Everything Shreya's pipeline does this week, in one JSON document.
-- (No actions here: approving/sending stays in Telegram on purpose.)
-- =====================================================================
CREATE OR REPLACE FUNCTION pipeline_core() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH wk AS (SELECT d_week_start(d_now()) AS ws),
  cur AS (SELECT i.* FROM issues i, wk WHERE i.week_start = wk.ws AND NOT coalesce(i.demo, false) LIMIT 1),
  arts AS (
    SELECT a.*, d.title AS dup_title, d.status AS dup_status
      FROM articles a CROSS JOIN wk
      LEFT JOIN articles d ON d.id = a.duplicate_of
     WHERE a.week_start = wk.ws AND NOT coalesce(a.demo, false))
  SELECT jsonb_build_object(
    'generated_at', d_now(),
    'week_start', (SELECT ws FROM wk),
    'schedule', jsonb_build_object(
      'ingest', 'Mon–Wed at 6:00, 10:00 and 14:00 IST',
      'draft_at', ((SELECT ws FROM wk) + 2)::timestamp + time '15:00',
      'reminder_at', ((SELECT ws FROM wk) + 2)::timestamp + time '22:00',
      'send_at', ((SELECT ws FROM wk) + 3)::timestamp + coalesce(d_cfg('send_time_ist','08:00'),'08:00')::time),
    'rules', jsonb_build_object(
      'min_stories', d_cfg('min_stories','8'), 'max_stories', d_cfg('max_stories','10'),
      'min_topics', d_cfg('min_topics','3'), 'lookback_issues', 4,
      'model', d_cfg('gemini_model_select','')),
    'sources', jsonb_build_object(
      'total', (SELECT count(*) FROM sources WHERE active),
      'rss', (SELECT count(*) FROM sources WHERE active AND kind = 'rss'),
      'news_queries', (SELECT count(*) FROM sources WHERE active AND kind = 'gnews'),
      'news_api', (SELECT count(*) FROM sources WHERE active AND kind = 'newsdata'),
      'news_api_connected', d_cfg('newsdata_api_key','') <> '',
      'failing', (SELECT count(*) FROM sources WHERE active AND last_error IS NOT NULL),
      'list', coalesce((SELECT jsonb_agg(jsonb_build_object('name', name, 'kind', kind, 'ok', last_error IS NULL,
                         'error', left(last_error, 120), 'last_ok_at', last_ok_at,
                         'new_last_run', coalesce((last_counts->>'new')::int, 0)) ORDER BY (last_error IS NULL), name)
                         FROM sources WHERE active), '[]')),
    'ingest', jsonb_build_object(
      'total', (SELECT count(*) FROM arts),
      'unique', (SELECT count(*) FROM arts WHERE status <> 'duplicate'),
      'dup_this_week', (SELECT count(*) FROM arts WHERE status = 'duplicate' AND coalesce(dup_status,'') <> 'published'),
      'dup_past_issues', (SELECT count(*) FROM arts WHERE status = 'duplicate' AND dup_status = 'published'),
      'pinned', (SELECT count(*) FROM arts WHERE coalesce(pinned, false)),
      'by_day', coalesce((SELECT jsonb_agg(jsonb_build_object('day', to_char(dt, 'Dy'), 'date', dt, 'n', n) ORDER BY dt) FROM (
                  SELECT (fetched_at AT TIME ZONE 'Asia/Kolkata')::date AS dt, count(*) AS n FROM arts GROUP BY 1) s), '[]')),
    'articles', coalesce((SELECT jsonb_agg(jsonb_build_object(
                   'id', id, 'title', title, 'url', url, 'source', source_name, 'summary', left(summary, 280),
                   'published_at', published_at, 'fetched_at', fetched_at, 'pinned', coalesce(pinned, false),
                   'status', CASE WHEN status = 'duplicate' AND dup_status = 'published' THEN 'covered'
                                  WHEN status = 'duplicate' THEN 'duplicate'
                                  WHEN status = 'published' THEN 'published' ELSE 'new' END,
                   'dup_of', dup_title,
                   'picked', EXISTS (SELECT 1 FROM issue_items ii, cur WHERE ii.issue_id = cur.id AND ii.article_id = arts.id
                                      AND ii.state IN ('proposed','kept')))
                   ORDER BY fetched_at DESC) FROM (SELECT * FROM arts ORDER BY fetched_at DESC LIMIT 400) arts), '[]'),
    'draft', (SELECT issue_view(cur.id) || jsonb_build_object(
                'alternates', coalesce((SELECT jsonb_agg(jsonb_build_object('topic', ii.topic, 'title', a.title, 'url', a.url,
                                   'source', a.source_name, 'reason', ii.reason) ORDER BY ii.alt_rank)
                                 FROM issue_items ii JOIN articles a ON a.id = ii.article_id
                                WHERE ii.issue_id = cur.id AND ii.state = 'alternate'), '[]'),
                'sent_so_far', (SELECT count(*) FROM deliveries d WHERE d.issue_id = cur.id AND d.status = 'sent'),
                'queued', (SELECT count(*) FROM deliveries d WHERE d.issue_id = cur.id AND d.status IN ('pending','sending')))
              FROM cur),
    'sent_issues', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'week_start') DESC) FROM (
        SELECT jsonb_build_object('issue_no', i.issue_no, 'week_start', i.week_start, 'sent_at', i.sent_at,
                 'demo', coalesce(i.demo, false), 'intro', i.intro,
                 'recipients', (SELECT count(*) FROM deliveries d WHERE d.issue_id = i.id AND d.status = 'sent'),
                 'stories', (SELECT coalesce(jsonb_agg(jsonb_build_object('topic', ii.topic, 'title', a.title, 'url', a.url,
                               'source', a.source_name, 'commentary', ii.final_commentary) ORDER BY ii.position), '[]')
                               FROM issue_items ii JOIN articles a ON a.id = ii.article_id
                              WHERE ii.issue_id = i.id AND ii.state = 'kept')) x
          FROM issues i WHERE i.status = 'sent' ORDER BY i.week_start DESC LIMIT 12) s), '[]'),
    'readers', (SELECT jsonb_build_object(
        'active', count(*) FILTER (WHERE status = 'active'),
        'demo', count(*) FILTER (WHERE status = 'active' AND coalesce(demo, false)),
        'new_7d', count(*) FILTER (WHERE created_at > d_now() - interval '7 days'),
        'unsubscribed', count(*) FILTER (WHERE status = 'unsubscribed'),
        'bounced', count(*) FILTER (WHERE status = 'bounced')) FROM subscribers),
    'engagement', (SELECT coalesce(stats_json()->'issues', '[]'))
  )
$$;

-- ---------------------------------------------------------------------
-- v2 extras: why each article was kept/dropped, Shreya's voice and edits,
-- and the readers' side (bounces, unsubscribes, soft-bounce watch).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION d_mask_email(e text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN e IS NULL OR position('@' in e) = 0 THEN e
              ELSE left(split_part(e,'@',1), 2) || '•••@' || split_part(e,'@',2) END
$$;

CREATE OR REPLACE FUNCTION pipeline_extras() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH wk AS (SELECT d_week_start(d_now()) AS ws),
  cur AS (SELECT i.* FROM issues i, wk WHERE i.week_start = wk.ws AND NOT coalesce(i.demo, false) LIMIT 1)
  SELECT jsonb_build_object(
    'roles', coalesce((SELECT jsonb_object_agg(ii.article_id::text, jsonb_build_object(
                 'role', ii.state, 'topic', ii.topic, 'reason', ii.reason, 'position', ii.position, 'alt_rank', ii.alt_rank))
               FROM issue_items ii, cur WHERE ii.issue_id = cur.id), '{}'),
    'voice', jsonb_build_object(
      'guide', d_cfg('style_guide', ''),
      'edits', coalesce((SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('issue_no', i.issue_no, 'title', a.title, 'topic', ii.topic,
                   'before', ii.ai_commentary, 'after', ii.final_commentary, 'at', ii.updated_at) x
            FROM issue_items ii JOIN issues i ON i.id = ii.issue_id JOIN articles a ON a.id = ii.article_id
           WHERE ii.edited AND ii.ai_commentary IS DISTINCT FROM ii.final_commentary
           ORDER BY ii.updated_at DESC LIMIT 8) s), '[]'),
      'edit_rate', (SELECT round(100.0 * count(*) FILTER (WHERE ii.edited) / nullif(count(*), 0))
                      FROM issue_items ii JOIN issues i ON i.id = ii.issue_id
                     WHERE ii.state = 'kept' AND i.status = 'sent')),
    'review', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'issue_no')::int) FROM (
        SELECT jsonb_build_object('issue_no', i.issue_no, 'demo', coalesce(i.demo,false),
                 'minutes', round(extract(epoch FROM (i.approved_at - i.created_at)) / 60)) x
          FROM issues i WHERE i.approved_at IS NOT NULL ORDER BY i.week_start DESC LIMIT 8) s), '[]'),
    'audience', jsonb_build_object(
      'by_status', (SELECT jsonb_build_object(
          'active', count(*) FILTER (WHERE status = 'active'),
          'unsubscribed', count(*) FILTER (WHERE status = 'unsubscribed'),
          'bounced', count(*) FILTER (WHERE status = 'bounced'),
          'soft_watch', count(*) FILTER (WHERE status = 'active' AND bounce_count > 0),
          'spam', (SELECT count(DISTINCT email) FROM email_events WHERE event = 'spam')) FROM subscribers),
      'recent', coalesce((SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('email', d_mask_email(email), 'status', status,
                   'why', status_reason, 'at', updated_at, 'demo', coalesce(demo,false)) x
            FROM subscribers WHERE status <> 'active' ORDER BY updated_at DESC LIMIT 15) s), '[]'),
      'soft', coalesce((SELECT jsonb_agg(x) FROM (
          SELECT jsonb_build_object('email', d_mask_email(email), 'count', bounce_count, 'at', updated_at) x
            FROM subscribers WHERE status = 'active' AND bounce_count > 0
           ORDER BY bounce_count DESC, updated_at DESC LIMIT 10) s), '[]'),
      'left_7d', (SELECT count(*) FROM subscribers WHERE status <> 'active' AND updated_at > d_now() - interval '7 days')))
$$;

CREATE OR REPLACE FUNCTION pipeline_json() RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT pipeline_core() || pipeline_extras() $$;
