-- =====================================================================
-- Demo data: fake subscribers + 6 fake past issues with engagement.
-- * Every fake row is flagged demo = true; emails are @example.com
--   (a reserved domain that can never receive mail).
-- * Fake subscribers are never emailed (deliveries for them are skipped).
-- * Fake issues never appear on the public website, never count as
--   "last 4 newsletters" for de-duplication, and don't affect real
--   issue numbering.
-- Load:   SELECT demo_seed();      Remove:  SELECT demo_clear();
-- (or type "cleardemo" to the Telegram bot)
-- =====================================================================

ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
ALTER TABLE issues      ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
ALTER TABLE articles    ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;

-- Safety: demo subscribers are skipped by the sender
CREATE OR REPLACE FUNCTION demo_skip_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pending' AND EXISTS (SELECT 1 FROM subscribers s WHERE s.id = NEW.subscriber_id AND s.demo) THEN
    NEW.status := 'skipped';
    NEW.last_error := 'demo subscriber';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS demo_skip_delivery ON deliveries;
CREATE TRIGGER demo_skip_delivery BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION demo_skip_delivery();

-- Real issue numbers ignore demo issues
CREATE OR REPLACE FUNCTION demo_issue_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.issue_no IS NULL AND NEW.issue_no IS NOT NULL AND NOT NEW.demo THEN
    NEW.issue_no := coalesce((SELECT max(issue_no) FROM issues WHERE NOT demo AND id <> NEW.id),
                             coalesce(d_cfg('issue_number_start','1'),'1')::int - 1) + 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS demo_issue_number ON issues;
CREATE TRIGGER demo_issue_number BEFORE UPDATE OF issue_no ON issues FOR EACH ROW EXECUTE FUNCTION demo_issue_number();

-- Dedup lookback ignores demo issues
CREATE OR REPLACE FUNCTION recent_issue_ids(n int DEFAULT 4) RETURNS SETOF int
LANGUAGE sql STABLE AS $$
  SELECT id FROM issues
   WHERE status IN ('approved','sending','sent') AND NOT demo
     AND week_start < d_week_start(d_now())
   ORDER BY week_start DESC LIMIT n
$$;

-- Public website never shows demo data
CREATE OR REPLACE FUNCTION web_archive(lim int DEFAULT 12) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'newsletter', d_cfg('newsletter_name','The Dispatch'),
    'tagline', d_cfg('newsletter_tagline',''),
    'subscribers', (SELECT count(*) FROM subscribers WHERE status = 'active' AND NOT demo),
    'issues', coalesce((
      SELECT jsonb_agg(x ORDER BY (x->>'issue_no')::int DESC) FROM (
        SELECT jsonb_build_object(
          'issue_no', i.issue_no, 'week_start', i.week_start, 'sent_at', i.sent_at, 'intro', i.intro,
          'stories', (SELECT jsonb_agg(jsonb_build_object('topic', ii.topic, 'title', a.title,
                                       'url', a.url, 'source', a.source_name,
                                       'commentary', ii.final_commentary) ORDER BY ii.position)
                        FROM issue_items ii JOIN articles a ON a.id = ii.article_id
                       WHERE ii.issue_id = i.id AND ii.state = 'kept')) x
          FROM issues i WHERE i.status = 'sent' AND NOT i.demo
         ORDER BY i.week_start DESC LIMIT lim) s), '[]'::jsonb)
  )
$$;

CREATE OR REPLACE FUNCTION demo_clear() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE ns int; ni int; ne int;
BEGIN
  DELETE FROM email_events WHERE email LIKE '%@example.com' OR message_id LIKE 'demo-%';
  GET DIAGNOSTICS ne = ROW_COUNT;
  DELETE FROM issues WHERE demo;            -- cascades to issue_items + deliveries
  GET DIAGNOSTICS ni = ROW_COUNT;
  DELETE FROM articles WHERE demo;
  DELETE FROM subscribers WHERE demo;
  GET DIAGNOSTICS ns = ROW_COUNT;
  RETURN jsonb_build_object('subscribers', ns, 'issues', ni, 'events', ne);
END $$;

CREATE OR REPLACE FUNCTION demo_seed(n_subs int DEFAULT 2200) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  firsts text[] := ARRAY['Aarav','Vivaan','Aditya','Arjun','Rohan','Kabir','Ishaan','Reyansh','Vihaan','Krishna','Siddharth','Rahul','Karthik','Nikhil','Varun','Aniket','Pranav','Harsh','Yash','Dev',
                         'Ananya','Diya','Saanvi','Aadhya','Ishita','Priya','Sneha','Kavya','Meera','Riya','Neha','Pooja','Tanvi','Shruti','Nandini','Aishwarya','Lakshmi','Divya','Sanya','Zara',
                         'Imran','Farhan','Ayesha','Sana','Joseph','Maria','Gurpreet','Harpreet','Tenzin','Anil'];
  lasts  text[] := ARRAY['Sharma','Verma','Iyer','Nair','Reddy','Menon','Gupta','Agarwal','Mehta','Shah','Patel','Desai','Kulkarni','Joshi','Rao','Pillai','Banerjee','Chatterjee','Das','Bose',
                         'Singh','Kaur','Malhotra','Kapoor','Khanna','Bhat','Hegde','Shetty','Naidu','Chopra','Khan','Qureshi','DSouza','Fernandes','Mathew','Thomas','Mishra','Tiwari','Pandey','Saxena'];
  topics text[] := ARRAY['Funding & VC','Policy & Regulation','Fintech','AI & Deep Tech','Consumer & D2C','E-commerce & Quick Commerce',
                         'SaaS & Enterprise','Mobility & EV','Climate & Energy','Health & Edtech','IPOs & Public Markets','People, Layoffs & Governance','Ecosystem & Trends'];
  sources text[] := ARRAY['Inc42','Entrackr','The Ken','ET Tech','Moneycontrol','YourStory','Mint','Business Standard','VCCircle','The Morning Context'];
  heads text[] := ARRAY[
    'PaisaLoop raises $40M Series B to expand UPI credit lines','KiranaKart turns EBITDA positive in 14 cities','Regulator floats draft rules for account aggregators',
    'VoltRide to set up 2,000 battery-swap stations by 2027','MedSetu acquires diagnostics startup LabNow','CloudDesk crosses $50M ARR on US mid-market push',
    'AgriLink lays off 18% of staff after funding crunch','GreenGrid wins state solar tender worth Rs 900 Cr','TutorTree pivots from K-12 to upskilling',
    'Nimbus AI launches Indic voice model for banks','Quickbasket cuts delivery promise to 8 minutes','FinNest files DRHP for Rs 2,400 Cr IPO',
    'StayEasy co-founder steps down amid board rift','Seed funding hits 3-year low, says new report','RupeeRail gets payment aggregator licence',
    'ByteBazaar raises $15M from global SaaS fund','CarbonKart signs first export deal for green steel','DocPlus launches AI triage in tier-2 hospitals',
    'LoanLeaf posts first profitable quarter','Fashionista D2C brand acquired by FMCG major','ShipFast raises debt to fund EV fleet',
    'Govt proposes angel tax rollback for startups','KhetiPay partners with 3 rural banks','DataNest opens Bengaluru R&D hub, to hire 400',
    'MetroMove pauses bike-taxi ops in two states','EduSpark merges with rival SkillBridge','InsureIt valuation doubles in down market',
    'ChipVeda tapes out first indigenous edge AI chip','FreshCart exits three cities to focus on profitability','HomeHub raises $22M led by growth fund',
    'SEBI tightens rules on finfluencer partnerships','SolarSaathi crosses 1 lakh rooftop installs','WorkGrid launches payroll for gig workers',
    'TravelTrunk IPO subscribed 38 times','ClinicCloud founder on building for Bharat','PetPal raises seed round from angel network',
    'VentureCo closes $300M fund for early-stage India bets','GameVerse cuts 120 jobs after real-money gaming tax','Neobank Saffron hits 5M users',
    'B2B marketplace TradeKart eyes profitability by FY27','Data protection rules: what startups must change','AutoNova unveils Rs 6 lakh electric hatchback',
    'Q3 funding report: AI startups take 31% share','LegalEase raises $8M for AI contract review','SnackStory D2C brand enters 10,000 stores',
    'PayLater startup CreditWave shuts down','Nutrition startup FitRoot raises Series A','Unicorn count stalls at 117 for third quarter',
    'BatteryBay sets up recycling plant in Pune','CampusHire raises $6M to fix graduate hiring','QuickCommerce price war: who blinks first',
    'SpaceSutra launches second private satellite','Founders turn to venture debt as equity dries up','Co-living operator HiveHome raises $12M'];
  comms text[] := ARRAY[
    'The interesting bit is not the round size but who led it: a sign that later-stage money is finally coming back to this category.',
    'Unit economics are the real story here. If this holds for two more quarters, expect copycats by the summer.',
    'Read this one closely if you are building anything that touches lending. The fine print matters more than the headline.',
    'A small deal on paper, but it tells you where incumbents think the next decade of growth is.',
    'This is the third such move in a month. The pattern is now clear: profitability over reach.',
    'Worth watching how competitors respond. The last time someone tried this, it triggered a price war.'];
  iss_ids int[] := '{}';
  wk date; sent timestamptz; iid int; ino int; i int; j int; aid bigint; nitems int;
  base_no int := coalesce(d_cfg('issue_number_start','105'),'105')::int - 6;
  open_p numeric; h int := 0;
BEGIN
  PERFORM demo_clear();
  PERFORM setseed(0.27);

  -- 1) subscribers: older base + steady weekly growth
  INSERT INTO subscribers (email, name, status, status_reason, created_at, updated_at, demo)
  SELECT lower(f) || '.' || lower(l) || g || '@example.com', f || ' ' || l, 'active',
         CASE WHEN random() < 0.12 THEN 'web: the-dispatch-india.vercel.app' ELSE 'demo import' END,
         ts, ts, true
    FROM (SELECT g, firsts[1 + floor(random() * array_length(firsts,1))::int] f,
                 lasts[1 + floor(random() * array_length(lasts,1))::int] l,
                 CASE WHEN random() < 0.78 THEN d_now() - (interval '60 days' + random() * interval '600 days')
                      ELSE d_now() - random() * interval '60 days' END ts
            FROM generate_series(1, n_subs) g) x;

  -- 2) six weekly issues, oldest first
  FOR i IN 0..5 LOOP
    -- the 6 most recent past weeks that don't already have a real issue
    SELECT w INTO wk FROM (
      SELECT d_week_start(d_now()) - k * 7 AS w FROM generate_series(1, 60) k
       WHERE NOT EXISTS (SELECT 1 FROM issues x WHERE x.week_start = d_week_start(d_now()) - k * 7)
       ORDER BY k LIMIT 6) f
     ORDER BY w LIMIT 1 OFFSET i;
    sent := ((wk + 3)::timestamp + time '08:00') AT TIME ZONE 'Asia/Kolkata';
    ino := base_no + i;
    INSERT INTO issues (week_start, issue_no, status, model, created_at, approved_at, send_started_at, sent_at, intro, demo)
    VALUES (wk, ino, 'sent', 'demo', sent - interval '42 hours', sent - interval '12 hours', sent, sent + interval '25 minutes',
            'Demo issue: a quiet week for mega-rounds, a loud one for regulators.', true)
    RETURNING id INTO iid;
    iss_ids := iss_ids || iid;

    nitems := 8 + (i % 3);
    FOR j IN 1..nitems LOOP
      h := h + 1;
      INSERT INTO articles (url, url_hash, title, title_norm, source_name, published_at, fetched_at, week_start, status, demo)
      VALUES ('https://example.com/dispatch-demo/' || h, md5('https://example.com/dispatch-demo/' || h),
              heads[1 + ((h - 1) % array_length(heads,1))], d_norm_title(heads[1 + ((h - 1) % array_length(heads,1))]),
              sources[1 + floor(random() * array_length(sources,1))::int], wk + 1, wk + 1, wk, 'published', true)
      RETURNING id INTO aid;
      INSERT INTO issue_items (issue_id, article_id, position, topic, reason, ai_commentary, final_commentary, edited, state)
      VALUES (iid, aid, j, topics[1 + ((i * 3 + j * 5) % array_length(topics,1))], 'demo',
              comms[1 + ((h - 1) % array_length(comms,1))], comms[1 + ((h - 1) % array_length(comms,1))], random() < 0.3, 'kept');
    END LOOP;

    -- deliveries to everyone active who had joined before the send
    INSERT INTO deliveries (issue_id, subscriber_id, status, attempts, claimed_at, sent_at, gmail_id)
    SELECT iid, s.id, 'sent', 1, sent, sent + random() * interval '25 minutes', 'demo-' || ino || '-' || s.id
      FROM subscribers s WHERE s.demo AND s.status = 'active' AND s.created_at < sent;

    -- engagement (slowly improving open rate)
    open_p := 0.40 + 0.015 * i;
    CREATE TEMP TABLE IF NOT EXISTS _r (sid int, email text, delivered bool, opened bool, clicked bool, unsub bool, hard bool) ON COMMIT DROP;
    TRUNCATE _r;
    INSERT INTO _r
    SELECT s.id, s.email, random() < 0.985, false, false, false, false
      FROM deliveries dl JOIN subscribers s ON s.id = dl.subscriber_id
     WHERE dl.issue_id = iid;
    UPDATE _r SET opened = random() < open_p WHERE delivered;
    UPDATE _r SET hard = random() < 0.5 WHERE NOT delivered;
    UPDATE _r SET clicked = random() < 0.24 WHERE opened;
    UPDATE _r SET unsub = random() < 0.003 WHERE delivered;

    INSERT INTO email_events (event, email, message_id, issue_no, ts)
    SELECT 'delivered', email, 'demo-' || ino || '-' || sid, ino, sent + random() * interval '30 minutes' FROM _r WHERE delivered
    UNION ALL
    SELECT 'opened', email, 'demo-' || ino || '-' || sid, ino, sent + random() * interval '72 hours' FROM _r WHERE opened
    UNION ALL
    SELECT 'unsubscribed', email, 'demo-' || ino || '-' || sid, ino, sent + random() * interval '48 hours' FROM _r WHERE unsub
    UNION ALL
    SELECT CASE WHEN hard THEN 'hard_bounce' ELSE 'soft_bounce' END, email, 'demo-' || ino || '-' || sid, ino, sent + interval '2 minutes'
      FROM _r WHERE NOT delivered
    ON CONFLICT DO NOTHING;

    -- clicks: 1-2 links each, earlier stories clicked more
    INSERT INTO email_events (event, email, message_id, issue_no, link, ts)
    SELECT 'click', r.email, 'demo-' || ino || '-' || r.sid, ino, a.url, sent + random() * interval '72 hours'
      FROM _r r
      CROSS JOIN LATERAL generate_series(1, 1 + (random() < 0.35 AND r.sid > 0)::int) k
      CROSS JOIN LATERAL (SELECT least(nitems, 1 + floor(power(random(), 1.8) * nitems)::int + (k - 1) + (r.sid % 2)) pos) p
      JOIN issue_items ii ON ii.issue_id = iid AND ii.position = p.pos
      JOIN articles a ON a.id = ii.article_id
     WHERE r.clicked
    ON CONFLICT DO NOTHING;

    UPDATE subscribers s SET status = 'unsubscribed', status_reason = 'brevo: unsubscribed', updated_at = sent + interval '1 day'
      FROM _r WHERE _r.sid = s.id AND _r.unsub;
    UPDATE subscribers s SET status = 'bounced', status_reason = 'brevo: hard_bounce', updated_at = sent
      FROM _r WHERE _r.sid = s.id AND _r.hard;
    UPDATE issues SET stats = jsonb_build_object('sent', (SELECT count(*) FROM _r), 'failed', 0) WHERE id = iid;
  END LOOP;

  RETURN jsonb_build_object(
    'subscribers', (SELECT count(*) FROM subscribers WHERE demo),
    'active', (SELECT count(*) FROM subscribers WHERE demo AND status = 'active'),
    'issues', array_length(iss_ids, 1),
    'events', (SELECT count(*) FROM email_events WHERE message_id LIKE 'demo-%'));
END $$;
