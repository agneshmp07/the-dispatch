-- =====================================================================
-- Add-on: article pictures for the dashboard. Safe to re-run.
--  * feeds / news API that carry an image: saved at ingest (save_ingest_images)
--  * everything else: workflow "Dispatch 11 · Article pictures" reads the
--    page's og:image a few times a day (articles_needing_images / save_article_images)
-- =====================================================================
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS image_checked_at timestamptz;

CREATE OR REPLACE FUNCTION d_clean_image(u text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN u ~* '^https://[a-z0-9.-]+\.[a-z]{2,}/[^\s"''<>]{3,}$' AND length(u) <= 800
               AND u !~* '(logo|favicon|sprite|placeholder|default[-_]?image|blank\.gif|1x1|pixel)'
              THEN u END
$$;

-- same payload as ingest_batch: {source_id, items:[{url, canon, image?}]}
CREATE OR REPLACE FUNCTION save_ingest_images(b64 text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE articles a SET image_url = d_clean_image(it->>'image'), image_checked_at = d_now()
    FROM jsonb_array_elements(coalesce(d_b64json(b64)->'items', '[]'::jsonb)) it
   WHERE a.url_hash = md5(coalesce(nullif(it->>'canon', ''), it->>'url'))
     AND a.image_url IS NULL AND d_clean_image(it->>'image') IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- newest first, draft stories first; Google News links can't be opened, so they're skipped
CREATE OR REPLACE FUNCTION articles_needing_images(lim int DEFAULT 60) RETURNS TABLE (id bigint, url text)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.url FROM articles a
   WHERE a.week_start >= d_week_start(d_now()) - 7
     AND a.image_url IS NULL AND a.image_checked_at IS NULL
     AND a.url ~* '^https?://' AND a.url !~* '^https?://news\.google\.'
     AND NOT coalesce(a.demo, false)
   ORDER BY EXISTS (SELECT 1 FROM issue_items ii WHERE ii.article_id = a.id) DESC,
            (a.status = 'duplicate'), a.fetched_at DESC
   LIMIT lim
$$;

-- payload: [{id, image}] (image may be empty: we still mark it checked)
CREATE OR REPLACE FUNCTION save_article_images(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE found int; tried int;
BEGIN
  WITH x AS (SELECT (e->>'id')::bigint AS id, d_clean_image(e->>'image') AS img
               FROM jsonb_array_elements(coalesce(d_b64json(b64), '[]'::jsonb)) e
              WHERE e->>'id' ~ '^[0-9]+$')
  UPDATE articles a SET image_url = coalesce(a.image_url, x.img), image_checked_at = d_now()
    FROM x WHERE a.id = x.id;
  GET DIAGNOSTICS tried = ROW_COUNT;
  SELECT count(*) INTO found FROM jsonb_array_elements(coalesce(d_b64json(b64), '[]'::jsonb)) e
   WHERE d_clean_image(e->>'image') IS NOT NULL;
  RETURN jsonb_build_object('tried', tried, 'found', found);
END $$;

-- dashboard: pictures for this week's articles and the draft
CREATE OR REPLACE FUNCTION pipeline_images() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  -- an article without its own picture borrows one from the same story at another outlet
  SELECT jsonb_build_object('images', coalesce((SELECT jsonb_object_agg(id::text, image_url) FROM (
      SELECT a.id, coalesce(a.image_url, (SELECT b.image_url FROM articles b
                                           WHERE b.image_url IS NOT NULL AND b.id <> a.id
                                             AND (b.id = a.duplicate_of OR b.duplicate_of = a.id
                                                  OR (a.duplicate_of IS NOT NULL AND b.duplicate_of = a.duplicate_of))
                                           LIMIT 1)) AS image_url, a.fetched_at FROM articles a
       WHERE (a.week_start = d_week_start(d_now())
              OR a.id IN (SELECT ii.article_id FROM issue_items ii JOIN issues i ON i.id = ii.issue_id
                           WHERE i.week_start = d_week_start(d_now())))
       ORDER BY a.fetched_at DESC LIMIT 600) s WHERE image_url IS NOT NULL), '{}'))
$$;

CREATE OR REPLACE FUNCTION pipeline_json() RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT pipeline_core() || pipeline_extras() || pipeline_more() || pipeline_images() $$;
