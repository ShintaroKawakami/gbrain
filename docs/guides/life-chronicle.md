# Life Chronicle: automatic timeline events

**Say to your agent:** *"What happened in my meetings last Tuesday?"*

**Say to your agent:** *"Turn off automatic event extraction."*

**Say to your agent:** *"Extract events from my older meeting notes."*

When you save a meeting, conversation or calendar page, gbrain turns it into
timeline events (`life/events/` pages plus a day-by-day projection) so
`gbrain day <date>`, `gbrain since <date>` and `gbrain on-this-day` can answer
"what happened". This runs automatically and is **on by default**. Each
eligible page costs one paid chat call.

To turn it off:

```bash
gbrain config set auto_chronicle false
```

Unsetting the key restores the default, which is on. Use `set ... false` to
opt out.

## What qualifies

A page is extracted automatically when all of these hold:

- Its type is `meeting`, `conversation` or `calendar-event`, or its slug starts
  with `meetings/`, `conversations/`, `cal/` or `calendar/`.
- Its body has at least 80 characters. Dream-generated pages, diary pages
  (`life/diary/`) and event pages themselves are never extracted.
- It was written or changed after this release activated on the brain. History
  is never swept automatically.
- Its own date (frontmatter `date`, `start` or an authored effective date) is
  within `chronicle.auto_recent_days` (default 30). Undated pages count as
  recent.
- A calendar invite has ended. An invite for next week is picked up once its
  end time passes, with no edit needed. An ended invite is not proof that you
  attended; its events carry `kind: meeting`, `captured_via:
  life-chronicle:auto` and a link to the invite page.
- The writer is not confined. Slug-bound, delegated or namespace-restricted
  clients, and grants without `extract_facts`, never trigger extraction.
- The sync did not run with `--no-extract`. A remote sync never extracts.

The page must also stay unchanged for `chronicle.auto_settle_seconds` (default
180) so a note written in several passes is extracted once.

## Cost and limits

| Setting | Default | What it does |
|---|---|---|
| `auto_chronicle` | on (unset) | `gbrain config set auto_chronicle false` turns automatic extraction off. |
| `chronicle.job_budget_usd` | `0.25` | Cap for one page's extraction call. This is a per-call cap, not a daily budget. |
| `chronicle.auto_daily_limit` | `200` | Automatic extraction calls per rolling 24 hours, across every writer. Retries count. |
| `chronicle.auto_recent_days` | `30` | How old a page's own date may be for automatic extraction. |
| `chronicle.auto_settle_seconds` | `180` | How long a page must stay unchanged before extraction. |
| `chronicle.judge_max_tokens` | `4000` | Output-token cap for one extraction call. |

`gbrain config set` refuses values outside each range and names the range. A
value already stored out of range falls back to its default, and doctor warns
(`chronicle_config_invalid`).

The worst case per day is `auto_daily_limit` x `job_budget_usd`, so $50 at the
defaults for a priced model. Typical pages cost far less. If gbrain has no price
for your chat model, the default cap cannot apply: extraction warns and runs,
still limited by the daily call count. If you set `chronicle.job_budget_usd`
yourself, an unpriced model refuses with `no_pricing`; register its price with
`gbrain pricing set` (see [spend controls](../operations/spend-controls.md)).

Page text is sent to the configured chat provider. Events derived from a private
page stay private to remote callers, including after the page is renamed or
purged.

## Check that it works

1. Write a meeting page. Its write receipt carries
   `chronicle_backstop: { "pending": "next_cycle", "daily_remaining": <n> }`.
   A skip carries `chronicle_backstop: { "skipped": "<code>", "why": ..., "fix": ... }`
   (codes below). Ordinary notes have no `chronicle_backstop` field.
2. Wait for the next autopilot cycle, or run the phase now (paid):
   ```bash
   gbrain dream --phase chronicle
   ```
   On PGLite this is how pending pages run when autopilot is not running.
3. Read the day back:
   ```bash
   gbrain day 2026-04-03
   ```

`gbrain doctor` reports the `auto_chronicle` check: whether it is on, 24 h use
of the daily limit and the largest writer's share, 7-day outcomes and spend
(priced dollars, unpriced calls and calls without a cost record are listed
apart), pending pages and the command that runs them.

## After upgrading

Automatic extraction turned on by default in this release. Until you answer,
doctor shows `auto_chronicle_default_on` (info) and the advisor shows the same
finding with `ask_user: true`. The agent relays the cost to you, then records
your answer:

```bash
gbrain config set auto_chronicle true    # keep it
gbrain config set auto_chronicle false   # opt out
```

A brain that already had `auto_chronicle true` sees the notice too, because
that setting had no effect before this release.

## History: backfill on request

Older pages are extracted only when you ask. Backfill is paid, so preview it
first and agree to the cost:

```bash
gbrain chronicle-backfill --since 2026-09-01 --limit 50 --dry-run
gbrain chronicle-backfill --since 2026-09-01 --limit 50 --yes
```

`--since` filters on the page's last update, not its own date. Re-running is
safe: content already extracted is not paid for again.

## Skip and failure codes

Write receipts, doctor and the advisor use these codes. `decision` codes come
from the write; `execution` codes come from the chronicle phase. Values in angle
brackets are filled in with real values on each surface.

<!-- chronicle-reasons:begin -->
| Code | Stage | Meaning | Fix | Who acts | Consent |
|---|---|---|---|---|---|
| `auto_chronicle_off` | decision | Automatic event extraction is off on this brain by choice (`gbrain config set auto_chronicle false`). | — | — | — |
| `auto_chronicle_invalid` | decision | auto_chronicle holds a value that is neither true nor false, so it reads as off. | `gbrain config set auto_chronicle true` | agent | paid |
| `slug_bound_client` | decision | The writer is confined (slug-bound, delegated or namespace-restricted), so its writes never trigger extraction into life/events/. | `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --yes` (preview: `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --dry-run`) | host_admin | paid |
| `operation_bound_client` | decision | The writer's grant lists operations without extract_facts, the permission that covers derived extraction. | `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --yes` (preview: `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --dry-run`) | host_admin | paid |
| `no_extract` | decision | The sync ran with extraction turned off (--no-extract, or a remote sync, which never extracts). | `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --yes` (preview: `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --dry-run`) | agent | paid |
| `history` | decision | The page's own date is more than 30 days old (chronicle.auto_recent_days); history is extracted only on request. | `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --yes` (preview: `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --dry-run`) | agent | paid |
| `not_yet_happened` | decision | The calendar event has not ended yet; it is picked up automatically after its end time, with no edit needed. | — | — | — |
| `too_short` | decision | The page body is under 80 characters, too short to hold events. | — | — | — |
| `dream_generated` | decision | Dream-generated pages are never mined for events. | — | — | — |
| `no_write_decision` | discovery | This revision has no recorded write decision (written by an older binary or before this release activated), so only a trusted backfill extracts it. | `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --yes` (preview: `gbrain chronicle-backfill --source <source> --since <YYYY-MM-DD> --limit 50 --dry-run`) | agent | paid |
| `not_chronicle_shaped` | decision | The page is no longer a meeting, conversation or calendar page, so the events extracted from it were retired. | — | — | — |
| `already_extracted` | decision | This exact content was already extracted; its events are current, so no new call is made. | — | — | — |
| `superseded` | execution | A newer revision replaced this content before extraction ran; the newer revision carries its own decision. | — | — | — |
| `daily_limit` | execution | The automatic daily limit (chronicle.auto_daily_limit = 200 calls per rolling 24 hours) is used up; pending pages wait for a free slot. | `gbrain config set chronicle.auto_daily_limit 400` | agent | paid |
| `judge_llm_unavailable` | execution | No chat provider is configured on the brain host, so extraction cannot run. | — | user | credentials |
| `no_pricing` | execution | chronicle.job_budget_usd was set explicitly, and gbrain has no price for <provider:model>, so the cap cannot be enforced. | `gbrain pricing set <provider:model> --input <usd-per-1M-input-tokens> --output <usd-per-1M-output-tokens> --source <pricing-page-url>` | agent | — |
| `budget_exhausted` | execution | The extraction call cost more than chronicle.job_budget_usd allows for one page. | `gbrain config set chronicle.job_budget_usd 0.50` | agent | paid |
| `judge_chat_error` | execution | The chat provider returned an error; the page retries with backoff. | — | provider | — |
| `judge_truncated` | execution | The extraction output hit chronicle.judge_max_tokens and was cut off, so nothing was written. | `gbrain config set chronicle.judge_max_tokens 8000` | agent | paid |
| `judge_parse_failed` | execution | The extraction output had no parseable JSON array, so nothing was written; the page retries on a later run. | — | — | — |
| `malformed_proposal` | execution | A proposed event failed validation, so the whole batch was rejected and nothing was written; the page retries on a later run. | — | — | — |
| `publish_error` | execution | Publishing the events failed; nothing from this attempt replaced the previous events, and the page retries on a later run. | — | — | — |
| `judge_refused` | execution | The chat model refused or filtered the page; no events were written. | — | — | — |
| `page_missing` | execution | The page was deleted before extraction ran. | — | — | — |
| `no_events` | execution | Extraction read the page and found no events. | — | — | — |
| `no_chat_provider` | phase | No chat provider is configured on the brain host, so the chronicle phase made no calls. | — | user | credentials |
<!-- chronicle-reasons:end -->

Don't hand-write `life/events/` pages: extraction owns them and retires events
the page no longer supports. Edit the meeting page instead.
