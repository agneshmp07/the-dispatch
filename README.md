# The Dispatch: newsletter intelligence & delivery pipeline

An n8n + Postgres + Gemini + Telegram + Brevo pipeline that does the reading,
shortlisting and first-draft commentary for Shreya's weekly newsletter, while
she keeps editorial control. **Nothing is ever emailed without her explicit
confirmation in Telegram.**

```
 Mon–Wed 06/10/14:00 IST     Wed 15:00 IST            Wed eve → Thu          Thu 08:00 IST →
┌───────────────────┐   ┌──────────────────────┐   ┌──────────────────┐   ┌─────────────────────┐
│ 1 · Ingest        │──▶│ 2 · Select & draft   │──▶│ 3 · Telegram     │──▶│ 5 · Send (Brevo)    │
│ RSS + Google News │   │ Gemini pass 1: pick  │   │ Keep/Swap/Edit/  │   │ batches, daily cap, │
│ dedup in Postgres │   │ 8–10, ≥3 topics      │   │ Drop → Approve → │   │ retries, resumes    │
│ (URL + headline)  │   │ Gemini pass 2: write │   │ Confirm          │   │ next day if capped  │
└───────────────────┘   │ commentary in voice  │   └──────────────────┘   └─────────────────────┘
                        └──────────────────────┘    4 · Reminder Wed 22:00 + Thu 07:30 (never sends)
 6 · Unsubscribe link + Gmail bounce/"unsubscribe"-reply processing (every 30 min)
 0 · Error alerts → Telegram (any workflow failure)
```

## What's in this folder

| Path | What it is |
|---|---|
| `workflows/*.json` | The 12 n8n workflows (import into n8n) |
| `site/` | Website (`index.html`) and stats dashboard (`dashboard.html`) for Vercel |
| `sql/schema.sql` | Tables + all business logic as Postgres functions (safe to re-run) |
| `sql/seed.sql` | Config values + starter news sources |
| `style_guide.md` | Template for Shreya's voice; it gets pasted into the `config` table |
| `src/` | Source of the Code-node logic + `build.js` that generates the workflows |
| `test/e2e.test.js` | 118-check end-to-end simulation (real Postgres, mocked APIs) |

## How each requirement is met

| Requirement | How |
|---|---|
| Ingest Mon–Wed from RSS + news queries | Workflow 1, cron `0 6,10,14 * * 1-3` IST. Sources table holds RSS feeds and Google News search queries (keyless, query-based). Feed failures are logged per source and never stop the run. |
| Store every article, no duplicates within the week | `articles` table. Exact dupes: canonical URL hash (tracking params stripped). Near dupes: trigram headline similarity **plus** a shared subject entity, so "Jar raises Series B led by Tiger Global" and "Kuku FM raises Series B led by Tiger Global" are *not* merged. Duplicates are kept and counted as **coverage**, which signals how widely a story was reported. |
| …and none covered in the last 4 newsletters | At ingest (42-day lookback) and again at selection: candidates similar to any story in the last 4 issues are excluded, and those headlines are also given to Gemini so it can catch the same story under a different headline. |
| Gemini editorial pass: 8–10 stories, high signal-to-noise, ≥3 topics | Workflow 2, pass 1 with a JSON schema and a fixed topic taxonomy. The output is **validated and repaired** in code: bad IDs dropped, trimmed or topped up to 8–10, topics swapped in from alternates until there are ≥3. It also returns 6 ranked alternates for swaps. |
| 2–3 lines of commentary in Shreya's voice | Pass 2 uses the style guide, recent published commentary and **her last 8 edits (AI draft vs her final)**, so the voice improves every week. |
| Delivered via Telegram by Wednesday evening | One message per story with buttons: ✅ Keep · 🔁 Swap (instant: alternates are pre-written) · ✏️ Edit (reply with new text) · 🗑 Drop / ↩️ Restore. Then *Review final draft* → **Confirm & schedule send**. |
| Never sends autonomously | Emails are queued only by the Confirm button. `/unapprove` withdraws approval before sending starts. The bot ignores everyone except Shreya's chat ID. |
| Reminder if not confirmed by Wed 10 PM | Workflow 4 at Wed 22:00 (and a last call Thu 07:30). It only sends a Telegram message. |
| Formatted email Thursday morning | Workflow 5 checks every 10 min and starts at Thu 08:00 IST. It sends personalised HTML, one email per subscriber, with a one-click unsubscribe link. |
| Handle unsubscribes & Gmail bounces gracefully | Unsubscribe webhook page; Gmail poll parses bounce notices (hard = suspend immediately, soft = after 3 strikes) and "unsubscribe" replies. Quoted footers and promo emails are ignored. Gmail messages are de-duplicated, and anyone who leaves after approval is skipped. Failed sends retry up to 3×. |

## What's live (as of 12 Oct 2026)
| Piece | Where |
|---|---|
| n8n workflows 0–9 | newss.app.n8n.cloud (all published) |
| Database | Neon Postgres (`sql/schema.sql` + `seed.sql` + `addon_web.sql` + `addon_features.sql`) |
| Email sending | Brevo transactional API (credential *Brevo API*), List-Unsubscribe + one-click |
| Open/click/bounce tracking | Brevo webhook → workflow 9 → `email_events` table |
| Website (sign-up + archive) | https://the-dispatch-india.vercel.app |
| Stats dashboard | https://the-dispatch-india.vercel.app/dashboard.html#key=DASHBOARD_KEY (key is in `config.dashboard_key`) |

## Workflows
| # | Name | When |
|---|---|---|
| 0 | Error alerts | any failure → Telegram |
| 1 | Ingest articles | Mon–Wed 06/10/14:00 IST; alerts you in Telegram if a feed has been broken 36h+ |
| 2 | Select & draft | Wed 15:00 IST; reads the full articles before writing; falls back to `gemini_model_fallback` if the main model fails; writes a 2-line intro |
| 3 | Telegram review bot | always on |
| 4 | Approval reminder | Wed 22:00 + Thu 07:30 (never sends email) |
| 5 | Send approved issue (Brevo) | from Thu 08:00 IST, only after Confirm |
| 6 | Unsubscribes & bounces | unsubscribe page + one-click POST + Gmail reply/bounce parsing |
| 7 | Website | sign-up, archive and stats endpoints |
| 8 | Tuesday preview | Tue 18:00 IST: "here's what's shaping up" |
| 9 | Email events (Brevo) | delivered / opened / clicked / bounced / unsubscribed / spam |
| 11 | Test send | started by `testsend` in Telegram: emails the draft to Shreya only |
| 10 | Self-test | started by `/selftest` in Telegram (needs `TG_HOOK_URL`/`TG_SECRET` at build time; the secret is `<workflow3Id>_<telegramTriggerNodeId>`) |

## Telegram commands (Shreya)
- **Paste any link** during the week → it's pinned and guaranteed a spot in the next draft (text after the link becomes your note to the AI).
- `/alternates` → runners-up, each with an ➕ Add button.
- `/intro your text` → set this week's opener (Gemini drafts one; this overrides it).
- `/sponsor text | link` → adds a "Sponsored" block; `/nosponsor` removes it.
- `/stats` → subscribers, last issue's opens/clicks, broken sources.
- `/selftest` → checks the whole bot in ~40 seconds: it sends itself /help, /alternates, /stats and a news link, then posts a ✅/❌ report. The test link is unpinned afterwards.
- 🎙 **Voice notes**: send a voice note instead of typing ("drop 3", "swap 5", "edit 2: …", "intro …", "approve"). Gemini transcribes it, the bot replies with what it heard, then acts. Approving still needs the Confirm button.
- **Numbered story actions** (typed or spoken): `keep 1`, `drop 3`, `swap 5`, `restore 3`, `edit 2` or `edit 2: new commentary`.
- `testsend` → emails the current draft, formatted exactly like the real issue, to Shreya's own inbox only (subscribers get nothing).
- `newskey YOUR_KEY` → connects the NewsData.io news API (free key from newsdata.io). The bot deletes the message so the key doesn't stay in the chat.
- `cleardemo` → deletes all demo data (fake subscribers, issues, opens/clicks). Do this before importing the real list.
- `read 3` → the full article text Gemini read before writing story 3's commentary (or a note that it was paywalled and the summary was used).
- `voice` → Shreya's voice guide at a glance, her house rules and how often she edits Gemini. `voicerule never call a valuation an achievement` (or "voice rule: …") adds a house rule that Gemini follows from the next draft.
- `suggestions` → links readers sent from the website. `take 12` pins one for the next draft; `skip 12` dismisses it. The first 8 suggestions each day also ping Shreya directly.
- `/status` `/preview` `/approve` `/unapprove` `/cancel` `/help`.
- Per-story buttons: ✅ Keep · 🔁 Swap · ✏️ Edit · 🗑 Drop / ↩️ Restore. Nothing sends until **Confirm & schedule send**.

## Issue pages
Every sent issue gets a public page at `https://the-dispatch-india.vercel.app/issue/<number>` with share buttons (WhatsApp, LinkedIn, X, copy link) and previous/next links. The archive links to these pages, each email has a "View in browser" link, and the Telegram "sent" message includes the shareable link. Data comes from `web_issue(n)` (`sql/addon_issue_pages.sql`) via the `dispatch-issue` webhook in workflow 7. Demo issues are never shown.

## News API
Besides RSS feeds and Google News queries, workflow 1 reads NewsData.io (a keyed news API) for two queries (`sql/addon_newsapi.sql`). Those sources are skipped until a key is set with `newskey`. A bad key shows up as a broken-source alert in Telegram.

## Voice
`sql/addon_voice.sql` adds `review_apply_numbered()` (story actions by position). Workflow 3 routes voice notes from Shreya's chat through Telegram getFile → download → Gemini (audio in, `{transcript, command}` out) before the normal command parser.

## Add-ons 2-5 (`sql/addon_more.sql`)
- **Voice guide:** `style_guide.md` is stored in `config.style_guide` and sent to Gemini with every draft, along with Shreya's past edits. House rules added with `voicerule` are appended to it under "Shreya's house rules".
- **Full-article reading:** workflow 2 fetches the shortlisted articles (picks + runners-up), extracts the article body and gives it to Gemini before the commentary is written. The extracted text is now saved (`articles.full_text`, node "Save article text"), so Shreya can check it with `read N` and on the dashboard ("Read what Gemini read").
- **Suggest a story:** the website has a "Suggest a story" form → `dispatch-suggest` webhook in workflow 7 → page title fetched (public hosts only) → `web_suggest()` (validation, honeypot, 60/day overall and 3/day per email, one entry per link per week) → Telegram ping to Shreya. `take N` turns a suggestion into a pinned pick.
- **Tracking dashboard:** `/dashboard` (key-protected) shows the week step by step, every article with why it was kept or dropped, the draft with the text Gemini read, Shreya's voice and house rules, reader suggestions, readers, sent issues and sources. Data: `pipeline_json()` = `pipeline_core()` + `pipeline_extras()` + `pipeline_more()`.

## Article pictures (`sql/addon_images.sql`)
The dashboard shows each article's own picture. Feeds and the news API that carry an image are saved at ingest; for the rest, workflow 12 ("Article pictures", Mon–Thu every 3 hours) opens up to 60 new articles per run and reads the picture the publisher set for sharing (og:image). Google News links can't be opened, so those articles borrow the picture of the same story from another outlet when there is one, or show a quiet monogram tile.

## Talk page (website)
`/dashboard?p=talk` is a chat with the same assistant as the Telegram bot: type or tap the microphone and speak. Workflow 13 ("Talk (website)", webhook `dispatch-talk`) checks the dashboard key, turns the message into the same update the Telegram bot receives, and runs the same code and database functions (`review_decide`, `review_apply_more`, `review_render`). Voice is recorded in the browser as WAV and transcribed by Gemini. Changes made on the website also update the story cards in Telegram. The final "Confirm & schedule send" button is never offered on the website: sending is confirmed in Telegram only.

## Demo data
`sql/addon_demo.sql` adds `SELECT demo_seed();` (2,200 fake @example.com subscribers + 6 fake past issues with opens/clicks/bounces) and `SELECT demo_clear();`. Demo rows are flagged `demo = true`: they are never emailed, never shown on the public website, ignored by de-duplication, and don't affect real issue numbers.

## Sending limits
Brevo's free plan allows 300 emails/day; `daily_send_cap` is 290, so the sender
resumes the next day automatically. To send all 2,200 on Thursday morning, upgrade
to Brevo Starter and raise `daily_send_cap`. Sending from a Gmail address hurts
inbox placement; authenticate a real domain in Brevo when you have one.

## Tuning (all in the `config` table, no redeploy)
`gemini_model_select` / `gemini_model_write` / `gemini_model_fallback`,
`min_stories`, `max_stories`, `min_topics`, `topics`, `num_alternates`,
`dedup_threshold` (0.55), `send_time_ist`, `daily_send_cap`, `send_batch_size`,
`soft_bounce_limit`, `style_guide`, `dashboard_key`. Add or remove sources in the `sources` table.

## Setup from scratch (already done for this instance)
1. **Database:** create a Postgres DB (Neon free tier works). Run, in order:
   `sql/schema.sql`, `sql/seed.sql`, `sql/addon_web.sql`, `sql/addon_features.sql`.
   Then set `gemini_api_key`, `telegram_chat_id`, `public_base_url`, `style_guide`
   and `dashboard_key` in the `config` table, and import subscribers (`email,name`).
2. **Telegram:** @BotFather → `/newbot`. Message the bot; it replies with your chat ID.
3. **n8n credentials** (names must match): *Dispatch Postgres* (Postgres, SSL require),
   *Dispatch Telegram Bot* (Telegram API), *Brevo API* (Header Auth, name `api-key`),
   *Dispatch Gmail* (Gmail OAuth2, only for reply/bounce parsing).
4. **Import** `workflows/*.json`; publish 0 first and set it as each workflow's error workflow, then publish the rest.
5. **Brevo:** verify the sender, turn off API-key IP blocking (n8n Cloud has no fixed IP),
   and add a transactional webhook to `https://<n8n>/webhook/<brevo_events_path>`.
6. **Website:** deploy `site/` to Vercel (static, no build step).

## Development
```bash
node src/build.js                       # regenerate workflows/*.json from src/
PGURL=postgres://... node test/e2e.test.js   # 118-check simulation against a scratch DB
```
