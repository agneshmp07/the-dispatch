-- =====================================================================
-- Seed config + sources. Edit the values marked  <-- CHANGE  then run.
-- Re-running is safe: existing keys are left untouched (ON CONFLICT DO NOTHING).
-- To change a value later:  UPDATE config SET value='...' WHERE key='...';
-- =====================================================================

INSERT INTO config (key, value) VALUES
  -- secrets / identity -------------------------------------------------
  ('gemini_api_key',      'PASTE_GEMINI_KEY'),          -- <-- CHANGE
  ('telegram_bot_token',  'PASTE_BOT_TOKEN'),           -- <-- CHANGE (from @BotFather)
  ('telegram_chat_id',    'PASTE_SHREYA_CHAT_ID'),      -- <-- CHANGE (only this chat can control the bot)
  ('public_base_url',     'https://newss.app.n8n.cloud'), -- your n8n URL (no trailing slash)
  ('sender_name',         'Shreya | The Dispatch'),
  ('reply_to',            ''),                          -- optional
  -- models ------------------------------------------------------------
  ('gemini_model_select', 'gemini-3.8-flash'),
  ('gemini_model_write',  'gemini-3.8-flash'),
  -- editorial rules ---------------------------------------------------
  ('min_stories',         '8'),
  ('max_stories',         '10'),
  ('min_topics',          '3'),
  ('num_alternates',      '6'),
  ('topics', 'Funding & VC|Policy & Regulation|Fintech|AI & Deep Tech|Consumer & D2C|E-commerce & Quick Commerce|SaaS & Enterprise|Mobility & EV|Climate & Energy|Health & Edtech|IPOs & Public Markets|People, Layoffs & Governance|Ecosystem & Trends'),
  ('style_guide',         'See style_guide.md: paste its contents here with the setup guide''s command.'),
  ('edit_examples',       '8'),
  -- dedup -------------------------------------------------------------
  ('dedup_threshold',     '0.55'),   -- trigram similarity of normalised titles (0..1)
  ('max_article_age_days','10'),
  ('max_candidates',      '250'),
  -- delivery ----------------------------------------------------------
  ('send_time_ist',       '08:00'),  -- Thursday send time
  ('daily_send_cap',      '450'),    -- Gmail: ~500/day personal, ~2000/day Workspace. Keep headroom.
  ('send_batch_size',     '40'),     -- per 10-minute tick
  ('max_send_attempts',   '3'),
  ('soft_bounce_limit',   '3'),
  ('issue_number_start',  '105'),    -- <-- CHANGE: number of the next issue
  ('newsletter_name',     'The Dispatch'),
  ('newsletter_tagline',  'The Indian startup ecosystem, curated weekly.'),
  ('clock_override',      '')        -- testing only: e.g. 2026-10-14 15:00+05:30
ON CONFLICT (key) DO NOTHING;

-- Sources. kind='rss' = normal feed; kind='gnews' = Google News search query
-- (the url column holds the query; the workflow builds the RSS URL, no API key needed).
INSERT INTO sources (name, kind, url) VALUES
  ('Inc42',               'rss',   'https://inc42.com/feed/'),
  ('Entrackr',            'rss',   'https://entrackr.com/feed/'),
  ('YourStory',           'rss',   'https://yourstory.com/feed'),
  ('MediaNama',           'rss',   'https://www.medianama.com/feed/'),
  ('ET Tech',             'rss',   'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms'),
  ('ET Startups',         'rss',   'https://economictimes.indiatimes.com/tech/startups/rssfeeds/78570550.cms'),
  ('Mint Companies',      'rss',   'https://www.livemint.com/rss/companies'),
  ('TechCrunch India',    'rss',   'https://techcrunch.com/tag/india/feed/'),
  ('Rest of World',       'rss',   'https://restofworld.org/feed/latest/'),
  ('GN: startup funding', 'gnews', 'Indian startup raises funding'),
  ('GN: startup policy',  'gnews', 'India startup regulation RBI SEBI MeitY'),
  ('GN: layoffs/IPO',     'gnews', 'Indian startup IPO OR layoffs OR shutdown'),
  ('GN: deep tech',       'gnews', 'India AI startup OR deeptech OR semiconductor startup'),
  ('GN: D2C/q-commerce',  'gnews', 'India D2C OR quick commerce startup')
ON CONFLICT (url) DO NOTHING;

-- Business sources added after go-live (paywalled outlets via Google News site: searches)
UPDATE sources SET url = 'https://entrackr.com/rss' WHERE name = 'Entrackr';
UPDATE sources SET url = 'India startup policy' WHERE name = 'GN: startup policy';
INSERT INTO sources (name, kind, url) VALUES
  ('The Ken',                         'rss',   'https://the-ken.com/feed/'),
  ('GN: The Ken',                     'gnews', 'site:the-ken.com'),
  ('GN: The Morning Context',         'gnews', 'site:themorningcontext.com'),
  ('GN: VCCircle',                    'gnews', 'site:vccircle.com'),
  ('GN: Fortune India',               'gnews', 'site:fortuneindia.com startup OR business'),
  ('GN: Business Standard companies', 'gnews', 'site:business-standard.com startup OR funding OR IPO'),
  ('GN: Moneycontrol',                'gnews', 'site:moneycontrol.com startup OR business OR IPO'),
  ('GN: Forbes India',                'gnews', 'site:forbesindia.com'),
  ('ET Industry',                     'rss',   'https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms'),
  ('ET Markets',                      'rss',   'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms'),
  ('BusinessLine Companies',          'rss',   'https://www.thehindubusinessline.com/companies/feeder/default.rss'),
  ('GN: India business deals',        'gnews', 'India acquisition OR merger OR stake sale company')
ON CONFLICT (url) DO NOTHING;
