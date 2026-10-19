# Animal/Token Trend Detection Pipeline — Project Summary v3

**Last updated:** October 20, 2026 (v3, re-checked against the current `src/index.js`; originally written September 23, 2026; supersedes v2)
**Purpose:** Full context for continuing this project in a new chat session.

**A note on confidence levels in this doc:** every claim is labeled **✅ VERIFIED** (real evidence exists — logs, test output, or direct confirmation), **⚠️ IMPLEMENTED, UNVERIFIED** (code is deployed but not yet proven end-to-end in production), **🔬 THEORY** (a reasoned explanation, not proven), or **💡 PROPOSED, NOT BUILT** (an idea discussed, no code written). Treat unlabeled claims as suspect and re-verify them.

**What changed since v2:** the entire token pipeline was rewritten (Section 4), the single-proxy DexScreener access problem is now solved with a three-tier fallback chain (Section 5), the project gained its own daily observability system (Section 6, new), and the second Telegram bot's code is in place but **inactive unless its two secrets are set** (Section 7).

---

## 1. What This Project Is

A Cloudflare Worker that discovers crypto tokens and general web trends related to animals (or, for tokens, real market activity), classifies/filters them, and sends Telegram alerts.

**Live deployment:** `https://trends.trendy-ishan.workers.dev`
**Plan:** Cloudflare Workers **Paid** ✅ VERIFIED
**Project folder:** `C:\trends\trends`
**Deployment status:** the user confirmed on Oct 20, 2026 that the Worker is live on Cloudflare. The repo (`C:\trends\trends`) has only two git commits ("Initial commit", "version 1"), so git history cannot tell you which version is deployed or when. The Sept 23, 2026, 15:44 IST (10:14 UTC) deploy was the token-pipeline rewrite and $10k-for-everyone rule; the route chain (Section 5) and multi-bot code (Section 7) are present in the current source and are assumed deployed along with it. The one thing still unconfirmed is whether the Bot 2 secrets are set (Section 7).

---

## 2. Architecture — Unchanged from v2

### Cron triggers
```json
"triggers": { "crons": ["*/4 * * * *", "*/15 * * * *"] }
```

### `scheduled()` dispatch
```js
async scheduled(event, env, ctx) {
  if (event.cron === "*/4 * * * *") {
    await discoverTokens(env);
    if (new Date(event.scheduledTime).getUTCMinutes() % 8 === 0) {
      await discover(env);
      await discoverWire(env);
    }
  } else if (event.cron === "*/15 * * * *") {
    await confirm(env);
  }
}
```

Token discovery runs every 4 minutes. Google Trends and wire discovery run only on 4-minute cron executions aligned to an 8-minute UTC boundary; GDELT confirmation remains every 15 minutes. `discover()` (Google Trends), `discoverWire()` (BBC + Al Jazeera), and `confirm()` (GDELT) are otherwise unchanged from v2 — see that document for their code and status if needed. This version focuses on what changed: `discoverTokens()`, the DexScreener access layer, the new stats system, and Telegram delivery.

---

## 3. LLM Classifier — Unchanged Model, Changed Usage

Still Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) via `console.anthropic.com`. ✅ VERIFIED working, same `classifyIsAnimalTrend()` function as v2.

**What changed:** for tokens, Haiku is now only called on tokens that have **already cleared the $10k liquidity bar** (see Section 4). Tokens below that bar are skipped entirely and never reach the classifier — this cut token-related Haiku calls substantially, since most pending tokens never reach $10k liquidity.

---

## 4. Token Discovery Pipeline — `discoverTokens()` — Rewritten

⚠️ **IMPLEMENTED.** Verified working end-to-end via `wrangler tail` (real profiles ingested, real batched pairs lookups, real evaluations logged) as of the Sept 23 15:44 IST deploy. The **$10k-for-everyone liquidity rule specifically** has not yet been confirmed live in production — see the caveat at the end of this section.

### Design, current state (superseding v2's OR-logic design)

**The liquidity rule changed from OR to AND-with-a-label.** In v2, a token could alert either by having ≥$10k liquidity, or by being animal-themed regardless of liquidity — this was deliberate at the time, to catch cases like "Super Inu" that a pure liquidity filter would miss. In practice this let through too many low-liquidity tokens on weak animal-classifier matches (crypto slang like "bull run", "whale", "ape in" triggered false positives). **The rule is now: every token needs ≥$10k liquidity to alert, full stop.** "Animal-themed" is no longer a bypass — it's a label added to alerts that already qualify on liquidity (`"Why: real liquidity + animal-themed"` vs `"Why: real liquidity"`).

**Known tradeoff of this change:** tokens still on a pump.fun-style bonding curve report $0 liquidity on DexScreener even with heavy 24h volume (one real example seen: a token with $117k 24h volume, $0 liquidity). These can now never alert, animal-themed or not. This was an explicit, accepted tradeoff, not an oversight.

**Batched liquidity lookups.** Previously: 1 pairs request per pending token (up to 15/cycle). Now: pending tokens are grouped by chain and looked up in batches of up to 30 addresses per DexScreener `/tokens/v1/` request, cutting request volume by roughly 80–90% depending on queue size.

**Real token names.** DexScreener's profiles feed doesn't include a name/symbol — only the pairs endpoint does (`baseToken.name`, `baseToken.symbol`). Alerts and classification now use the real name once the batched pairs lookup returns it, instead of the first 100 characters of the marketing description. This also fixed the original "Super Inu" scenario properly: the classifier now sees the real token name, not just whatever prose happened to be in the profile description.

**No-pair retry, bounded.** A token with zero trading pairs yet is rechecked for up to `MAX_NO_PAIR_CHECKS = 6` cycles, then dropped, rather than being evaluated once at $0 and discarded (v2 bug) or retried forever.

**Momentum filter, bounded.** After passing the $10k liquidity requirement, the same highest-liquidity pair must have positive finite `m5`, `h1`, and `h6` price changes before Haiku classification. A failed window is logged and increments the pending token's `momentumChecks`; it is retried on later cycles and removed after 8 failed momentum checks. The daily `token_momentum_fail` counter is exposed through `/debug/stats` and `/debug/report`.

**Snapshot capped.** `tokenSnapshot` (the "have we seen this address before" list) is capped at `TOKEN_SNAPSHOT_CAP = 2000` addresses, trimmed oldest-first, never trimming an address still present in the live feed. This prevents the unbounded KV-value growth v2 was at risk of.

**Behaviors confirmed in code but not previously documented:**
- **One strike on liquidity.** A token that is looked up successfully but has <$10k liquidity is **deleted from the pending queue immediately** and is never rechecked. Because its address is already in `tokenSnapshot`, it will not be re-queued either. A token that adds liquidity a few minutes later is therefore lost. (The no-pair and momentum cases get bounded retries.)
- **Lookup failures retry without limit** until the 3-hour `MAX_AGE_MS` expiry.
- **Unknown-chain tokens** (no `chainId` in the profile) are dropped on sight.
- **Classifier fails closed.** `classifyIsAnimalTrend()` returns `false` on any Anthropic API error or non-2xx response, so an outage or bad API key silently produces zero animal labels/alerts for trends and wire items (token alerts still send, just without the animal label). Look for `[classify] Anthropic API...` errors in logs if animal alerts stop.
- **Trend/wire pacing.** Each Haiku call on the trends and wire paths is followed by a 4.5s pause (`paceClassify`); wire processing is capped at 15 new headlines per cycle.
- **GDELT confirm** requires ≥3 articles in 24h, checks at most 40 pending candidates per cycle (5.5s spacing), and expires candidates after 3h.

### Current constants
```js
const TOKEN_CAP = 30;               // pending tokens evaluated per cycle
const BATCH_SIZE = 30;              // DexScreener's max addresses per /tokens/v1/ request
const MIN_LIQUIDITY_USD = 10000;    // required for every alert, no exceptions
const MAX_AGE_MS = 3 * 60 * 60 * 1000;   // pending tokens expire after 3h unevaluated
const MAX_NO_PAIR_CHECKS = 6;       // retries for tokens with no pairs yet at a 4-minute cadence
const MAX_MOMENTUM_CHECKS = 8;      // retries for tokens that fail momentum
const TOKEN_SNAPSHOT_CAP = 2000;
```

### Caveat — confirm the new rule is actually live
A large `/debug/candidates` dump pulled mid-session showed several sub-$10k, animal-themed "confirmed" alerts — but every one of those had a `confirmedAt` timestamp *before* the 15:44 IST deploy, so they're artifacts of the old OR-logic code, not evidence the new rule is broken. **If starting a fresh session, don't trust `/debug/candidates` alone to judge whether the $10k rule is enforced** — it's a full cumulative history with no time filtering, spanning multiple versions of this code back to mid-September. Cross-check against `/debug/report?day=YYYY-MM-DD` (Section 6), which is timestamped per-alert and only reflects the current deployed logic.

---

## 5. DexScreener Access — Three-Tier Fallback Chain (Solved)

### Root cause — now ✅ VERIFIED, not just theory
v2 treated the DexScreener/proxy failures as a working theory (Cloudflare Bot Management distrusting datacenter IPs). Direct evidence has since confirmed the actual mechanism: a `/debug/probe` hit against both DexScreener and GeckoTerminal (unrelated services) returned **instant 429s in 4–5ms**, both carrying Cloudflare's own rate-limit error code (`error code: 1015`), both exiting through the same Cloudflare datacenter (same `cf-ray` suffix). Sub-5ms responses mean the requests never reached either origin — they were rejected at Cloudflare's edge. This is **IP-based rate limiting on shared Cloudflare Workers egress IPs**, not bot fingerprinting. It also explains why it's intermittent: the shared rate-limit bucket empties and refills, and which egress IP/location a given cron cycle draws from varies.

### Current chain: direct → Scrape.do → ScrapingAnt
Each tier is only attempted if the one before it failed (or already hit its own daily cap that cycle), and each has its own daily cap to keep usage inside free-tier limits:

```js
const SCRAPEDO_DAILY_CAP = 30;       // ~900/month, under Scrape.do's free 1,000
const SCRAPINGANT_DAILY_CAP = 300;   // ~9,000/month, under ScrapingAnt's free 10,000
```

**Tier 1 — direct fetch.** ✅ VERIFIED works intermittently (confirmed via probe returning clean 200s, and via real cron cycles in `wrangler tail`). Free, no credits, but unreliable minute to minute.

**Tier 2 — Scrape.do.** ✅ VERIFIED working (`/debug/probe` returned 200 with real DexScreener JSON; also confirmed via real cron usage hitting its 30/day cap in production). URL-passthrough style: `https://api.scrape.do/?token=...&url=<encoded target>`. Costs 1 credit/call on regular (non-residential) IPs — residential (`&super=true`) was tested and also works, but isn't needed since regular already succeeds, and residential costs 10x the credits.

**Tier 3 — ScrapingAnt.** ✅ VERIFIED working — confirmed via a direct `curl` test against the real DexScreener profiles endpoint, which returned genuine, well-formed token profile JSON. Same URL-passthrough style: `https://api.scrapingant.com/v2/general?browser=false&url=<encoded target>&x-api-key=...`. **The `browser=false` parameter is load-bearing** — without it, ScrapingAnt renders with a full headless browser by default, costing 10 credits/call instead of 1, for no benefit on a plain JSON API.

**Not pursued / abandoned:**
- A self-hosted Vercel relay was explored as a middle tier (direct → your own relay → Scrape.do) and fully built (relay code, host/path allowlisting, shared-secret auth, probe integration) — then explicitly rolled back at the user's request in favor of keeping the chain to two paid-provider fallbacks. No Vercel code remains in the project.
- GeckoTerminal (keyless) — ✅ VERIFIED to also hit the same shared-IP 429 wall from Cloudflare Workers. A CoinGecko Demo API key was discussed as a way around this (quota tied to key, not IP) but never actually obtained or tested. 💡 Still on the table as a distinct token-discovery *source* (not just an access method) if DexScreener itself ever becomes untenable — it returns real-time new-pool data including liquidity and real names in one call, unlike DexScreener's two-step profile+pairs flow.
- ScraperAPI ($49/mo minimum, no usable free tier) and ScrapingBee/ZenRows (similar minimums) were ruled out on cost.

**Details confirmed in code:**
- Direct fetch has an 8s timeout; Scrape.do and ScrapingAnt have 20s timeouts.
- After a direct **429**, direct is skipped for the rest of that cron cycle (`run.directBlocked`).
- The daily caps count **attempts, not successful credits** — a failed Scrape.do/ScrapingAnt call still counts toward the cap. `scrapedo_ok`/`scrapingant_ok` are the real credits used.
- `/debug/probe` calls Scrape.do and ScrapingAnt directly and does **not** count against the daily caps (see Section 6 warning).
- Every provider response is decoded with `res.text()` (UTF-8) then `JSON.parse`; the code never sets an encoding explicitly, which is relevant to the mojibake issue in Section 8.

### Observability into route usage
`run.stats` per UTC day tracks `direct_ok/fail`, `scrapedo_attempts/ok/fail/skipped_cap`, `scrapingant_attempts/ok/fail/skipped_cap`, and `token_momentum_fail`. Visible via `/debug/stats` and the richer `/debug/report` (Section 6).

---

## 6. Daily Observability — New in this version (`/debug/report`, `/debug/stats`)

Not present in v2 at all. Added specifically so pipeline health and alert timing can be evaluated after the fact, across a chat session boundary, without relying on `wrangler tail` (which has proven unreliable — see below) or manually eyeballing a giant `/debug/candidates` dump.

### `/debug/stats`
Plain per-day counters: cycles run, profiles fetch success/fail, route usage (direct/Scrape.do/ScrapingAnt), Scrape.do/ScrapingAnt credits used and cap-skip counts, momentum failures, and total alerts. Backed by `stats:<YYYY-MM-DD>` KV keys with a 14-day TTL (`STATS_TTL_SECONDS`).

### `/debug/report?day=YYYY-MM-DD` (defaults to today)
The richer view. Built from a per-cycle log capped at `CYCLE_LOG_CAP = 400` entries/day (token discovery runs about 360 cycles per day at 4-minute intervals, so this rarely truncates). Computes:

- **Cron gaps** — stretches >9 minutes between logged cycles (catches missed 4-minute token-discovery runs and outages like the earlier Cloudflare platform incident).
- **Possible missed windows** — cycles where *every* token in the profiles feed was new (i.e., the feed fully turned over since the last successful check), meaning some tokens may have appeared and scrolled off unseen in between.
- **Per-alert timing**, the number that actually answers "how late is this alert":
  - `queueToAlertMin` — pipeline's own delay, from when the Worker first saw the token to when it alerted.
  - `launchToAlertMin` — real-world delay, from the token's first trading pair being created (DexScreener's `pairCreatedAt`) to the alert. This is the number that matters for the "40 minutes late" complaint from earlier — most of that lateness turned out to be DexScreener's own profile feed lagging real launch time by 30–60 minutes, not the pipeline.
  - Both summarized as median/p90/max across the day.
- Route usage and Scrape.do/ScrapingAnt credit spend for the day.

⚠️ **IMPLEMENTED, UNVERIFIED in production** — built and unit-tested locally (cold start, fallback routing, total outage, full feed turnover, injected cron gap all produced correct report output), but not yet confirmed against a real full day of production traffic in this thread.

### `/debug/candidates` and `/debug/probe`
- `/debug/candidates` lists every `candidate:` KV record (full history, no date filter). It does one KV `get` per key and does not paginate, so it stops at KV's 1,000-key list limit.
- `/debug/probe` makes one live request each to DexScreener direct, Scrape.do and ScrapingAnt, returning status, latency and a 200-char body preview.
- ⚠️ **None of the `/debug/*` endpoints require authentication.** Anyone who finds the worker URL can read alert history and stats, and can hit `/debug/probe` repeatedly to burn Scrape.do/ScrapingAnt credits outside the daily caps. 💡 Proposed fix, not built: require a secret header or query token on `/debug/*`.

### A note on `wrangler tail`
✅ VERIFIED unreliable in practice this session — logs stopped appearing in the terminal on at least one occasion while Telegram alerts kept arriving normally, meaning the Worker was healthy and only the local tail stream had dropped (likely session expiry or a dropped connection, not resolved further since Cloudflare's Observability dashboard was confirmed to have the same logs). **Prefer Cloudflare's Observability dashboard or `/debug/report` over `wrangler tail`** for anything beyond live spot-checking.

---

## 7. Telegram Delivery — Second Bot Coded, **NOT DEPLOYED**

### Bot 1 — unchanged, live
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. ✅ VERIFIED working throughout.

### Bot 2 — code is in `src/index.js`, secrets believed not set, **inactive**
⚠️ **CODE PRESENT, ACTIVATION UNCONFIRMED.** The user asked for a second, fully independent bot (own token, own chat, own secret names) rather than broadcasting to a second chat ID on the same bot. The code is in the current source and was unit-tested locally. `wrangler.jsonc` only defines `TELEGRAM_CHAT_ID` (Bot 1's chat) as a plain var; `TELEGRAM_BOT_TOKEN_2` and `TELEGRAM_CHAT_ID_2` are not defined anywhere in the repo and, per the last known state, were never set as Wrangler secrets, so only Bot 1 sends anything. Secrets can't be verified from the repo — check with `npx wrangler secret list` before assuming a second bot/chat is receiving alerts.

```js
function getTelegramRecipients(env) {
  const recipients = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    recipients.push({ bot: "bot1", token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
  }
  if (env.TELEGRAM_BOT_TOKEN_2 && env.TELEGRAM_CHAT_ID_2) {
    recipients.push({ bot: "bot2", token: env.TELEGRAM_BOT_TOKEN_2, chatId: env.TELEGRAM_CHAT_ID_2 });
  }
  return recipients;
}
```

All three alert types (`sendTelegramAlert`, `sendWireAlert`, `sendTokenAlert`) now route through a single `sendTelegramMessage(env, text, label)` helper built on top of this, sending to every configured recipient independently — one bot failing (bad token, blocked chat) doesn't block delivery to the other. This was tested locally: both bots receiving a message, bot-1-only behaving identically to the pre-existing setup, a partially-configured bot 2 (only one of its two secrets set) being skipped silently, and bot 1 failing without blocking bot 2's send.

**To actually activate bot 2:**
```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN_2
npx wrangler secret put TELEGRAM_CHAT_ID_2
npx wrangler deploy
```

---

## 8. Known Open Issues (unresolved as of this doc)

- **🔬 Mojibake in some token names.** A `/debug/candidates` dump showed a handful of token names/symbols as garbled text (classic UTF-8-read-as-wrong-encoding corruption), e.g. non-Latin scripts rendering as strings like `"σ╕üσ«ëτÜäσ«êµèñΦÇà"`. Not yet diagnosed — could originate from DexScreener's own data, or from a decoding step somewhere in the fetch chain (possibly specific to responses routed through one of the fallback providers). Cosmetic only; doesn't affect the liquidity/classification logic. Not investigated further this session.
- **💡 `candidate:*` and `wirecandidate:*` KV keys have no TTL.** Unlike `stats:*` (14-day TTL), every confirmed/pending/rejected/expired record is kept forever. **This is more than housekeeping:** `confirm()` and `/debug/candidates` call `KV.list({ prefix: "candidate:" })` with no cursor, which returns at most 1,000 keys in alphabetical order. Token alerts are stored as `candidate:TOKEN:<address>` and sort before trend candidates (`candidate:US:<term>`), so once ~1,000 `candidate:` keys accumulate, new pending trend candidates can fall outside the listed page and **silently stop being confirmed** (no error is logged). Token alert volume determines how soon this happens. Proposed fix (not built): add an `expirationTtl` (e.g. 30–90 days) when writing these keys and/or paginate the `list()` calls.
- **Stale log message.** The profiles-fetch failure message (`ingestTokenProfiles`) still says "direct and Scrape.do both failed or Scrape.do was capped" even though ScrapingAnt is now a third tier. Cosmetic.
- **Dead branch.** `sendTelegramAlert()` still has a `candidate.type === "token"` branch ("Animal-themed token confirmed…"), but token alerts now go through `sendTokenAlert()` and never pass through `confirm()`, so that branch is unreachable.
- **By design, not a bug:** `/debug/candidates` returns the full cumulative history with no date filtering, mixing output from several different versions of this code across roughly two weeks. Always check a record's own timestamp against known deploy times before treating it as evidence of current behavior — see Section 4's caveat for a concrete example of this tripping up an evaluation mid-session.

---

## 9. Immediate Next Steps (priority order)

1. **Confirm the $10k-for-everyone rule is holding in production** — pull `/debug/report?day=2026-09-23` (or the current day) and check that `alerts.list` contains nothing with liquidity under $10k, using timestamps after the 15:44 IST deploy only.
2. **Decide whether to activate Bot 2** — set the two secrets and redeploy if the second bot/chat is wanted now; otherwise leave as-is (harmless either way, since it's skipped silently when unset). Run `npx wrangler secret list` first to see what is already set.
2a. **Add a TTL to `candidate:*`/`wirecandidate:*` and paginate `list()`** before the 1,000-key limit silently breaks trend confirmation (Section 8). Consider moving this above step 3.
2b. **Protect `/debug/*`** with a secret token (Section 6).
3. **Watch Scrape.do/ScrapingAnt credit spend via `/debug/report`** over a few real days to see whether the 30/day and 300/day caps are well-calibrated, or need adjusting.
4. **Investigate the mojibake encoding issue** if it recurs in fresh alerts, since it wasn't root-caused this session.
5. **Add a TTL to `candidate:*` keys** if KV storage growth becomes a concern.
6. **If starting a fresh chat:** paste this document, then ask to see the actual current `src/index.js` rather than assuming this summary is byte-for-byte accurate — this doc describes the code's *behavior and history*, not a guaranteed line-for-line reconstruction.