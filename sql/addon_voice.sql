-- =====================================================================
-- Add-on: talk to the bot. Story actions by number ("drop 3",
-- "edit 2: new commentary"), typed or spoken. Wraps review_apply.
-- =====================================================================
CREATE OR REPLACE FUNCTION review_apply_numbered(b64 text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  p    jsonb := d_b64json(b64);
  t    text  := p->>'type';
  pos  int;
  iid  int;
  r    jsonb;
BEGIN
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
