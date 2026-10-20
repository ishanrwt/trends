# Trends

Trends is a Cloudflare Worker that monitors web trends, news headlines, and newly surfaced crypto tokens. It filters and classifies candidates, verifies them where appropriate, stores state and operational statistics in Cloudflare KV, and sends qualifying alerts to Telegram.

The Worker is configured in [`wrangler.jsonc`](./wrangler.jsonc) and its scheduled and HTTP handlers are implemented in [`src/index.js`](./src/index.js).

## What it monitors

| Source | How it is used |
| --- | --- |
| Google Trends (US trending RSS) | New terms are filtered, classified for animal relevance with Claude, and queued for confirmation against GDELT coverage. |
| BBC World and Al Jazeera RSS | New headlines are classified for animal relevance and qualifying headlines are sent as alerts. |
| DexScreener token profiles | Newly seen token addresses are queued for market-data checks and eligibility filtering. |
| CoinGecko trending Solana pools | Trending pools are filtered and then checked against DexScreener before they can generate an alert. |
| GDELT | Checks pending Google Trends candidates for coverage; a candidate needs at least three articles within the query window to be confirmed. |

Token alerts require at least **$10,000 in liquidity**, a known launch time no more than **two hours** old, and positive price changes over the **5-minute, 1-hour, and 6-hour** windows. Animal classification adds context to a qualifying token alert; it does not bypass the liquidity requirement. CoinGecko candidates also need DexScreener confirmation.

The Worker uses Claude Haiku to determine whether trend terms, headlines, or eligible token names appear animal-related. DexScreener requests try the direct API first, then optional Scrape.do and ScrapingAnt fallbacks. The fallback providers have daily caps; CoinGecko usage is capped monthly.

## Scheduled jobs

The Wrangler configuration registers two cron triggers:

| Schedule (UTC) | Work |
| --- | --- |
| Every 4 minutes | Discover and evaluate tokens. On UTC minutes divisible by 8, also check Google Trends and news feeds. |
| Every 15 minutes | Recheck pending Google Trends candidates using GDELT. |

The KV namespace bound as `TREND_STATE` stores snapshots, pending work, candidate records, and daily statistics. Preserve this binding when deploying; replacing it with an empty namespace resets the Worker's stored history and discovery snapshots.

## Requirements

- Node.js and npm
- A Cloudflare account with Workers access
- Wrangler access to the account used for deployment
- A Cloudflare KV namespace configured for the `TREND_STATE` binding
- API credentials for the services you want to enable (see below)

## Get started

From the project directory:

```sh
npm ci
npm run dev
```

`npm run dev` starts Wrangler's local Worker development server. A request to `/` returns a simple running-status message; the useful work is performed by the scheduled handler.

Run the tests once with:

```sh
npm test -- --run
```

## Configuration and credentials

The names below must match the Worker bindings read by the code.

| Name | Required? | Purpose |
| --- | --- | --- |
| `TREND_STATE` | Yes | Cloudflare KV binding for snapshots, candidate state, and statistics. It is configured in Wrangler. |
| `ANTHROPIC_API_KEY` | Recommended | Calls Claude Haiku for animal classification. If unset or rejected, classification fails closed and animal-related trend/news alerts may not be produced. |
| `TELEGRAM_BOT_TOKEN` | For Telegram alerts | Bot 1 token. |
| `TELEGRAM_CHAT_ID` | For Telegram alerts | Destination for Bot 1. A chat ID is configured as a Wrangler variable in this project. |
| `SCRAPEDO_TOKEN` | Optional | First fallback provider for DexScreener requests when direct access fails. |
| `SCRAPINGANT_KEY` | Optional | Second fallback provider for DexScreener requests. |
| `COINGECKO_API_KEY` | Optional | Enables the CoinGecko trending-pools source. |
| `TELEGRAM_BOT_TOKEN_2` | Optional | Bot 2 token. |
| `TELEGRAM_CHAT_ID_2` | Optional | Bot 2 destination. Bot 2 is used only when both Bot 2 values are configured. |

Set credentials as Wrangler secrets for a deployed Worker. For example:

```sh
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put SCRAPEDO_TOKEN
npx wrangler secret put SCRAPINGANT_KEY
npx wrangler secret put COINGECKO_API_KEY
```

Only set the secrets for services you intend to use. For local development, place equivalent values in a `.dev.vars` file in the project root:

```dotenv
ANTHROPIC_API_KEY=replace-with-your-key
TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
TELEGRAM_CHAT_ID=replace-with-your-chat-id
SCRAPEDO_TOKEN=replace-with-your-token
SCRAPINGANT_KEY=replace-with-your-key
COINGECKO_API_KEY=replace-with-your-key
```

`.dev.vars` is ignored by Git. Do not commit credentials. Configure the corresponding secrets in the production Worker separately; local values are not deployed.

To enable the optional second Telegram bot, configure **both** `TELEGRAM_BOT_TOKEN_2` and `TELEGRAM_CHAT_ID_2` as secrets. Each configured bot receives alerts independently.

## Deploy

After authenticating Wrangler and confirming the KV namespace binding is configured for your Cloudflare account:

```sh
npx wrangler deploy
```

The cron triggers in the Wrangler configuration are applied with the Worker deployment. Set or update production secrets with `npx wrangler secret put NAME`; do not put secret values in `wrangler.jsonc`.

## HTTP routes

| Route | Description |
| --- | --- |
| `/` | Returns a basic Worker status message. |
| `/debug/candidates` | Returns records under the `candidate:` KV prefix. |
| `/debug/stats` | Returns daily counters and the current CoinGecko monthly usage count. |
| `/debug/report` | Returns the daily operational report for the current UTC day. |
| `/debug/report?day=YYYY-MM-DD` | Returns the report for a specific UTC day, or `404` when no data exists. |
| `/debug/probe` | Makes live connectivity checks against DexScreener and configured fallback services (and CoinGecko when its key is configured). |

**Operational security:** the `/debug/*` routes do not currently require authentication. They expose stored candidate/statistics data, and `/debug/probe` makes live third-party requests. Restrict access to the Worker or add authentication before exposing these routes to untrusted users.

## Troubleshooting

- **No Telegram alerts:** check that the bot token and chat ID for at least one bot are both configured, and inspect Worker logs for Telegram API errors.
- **No animal-related classification:** verify `ANTHROPIC_API_KEY` and check logs for `[classify]` errors. The classifier returns a negative result when the API call fails.
- **DexScreener requests failing:** inspect `/debug/stats` or `/debug/report` for route and fallback counters. Scrape.do and ScrapingAnt are optional and subject to daily caps.
- **No CoinGecko candidates:** confirm `COINGECKO_API_KEY` is set; the CoinGecko source is skipped when it is absent and is subject to a monthly request cap.
- **Unexpectedly sparse token alerts:** candidates must meet the liquidity, freshness, and momentum rules. A token without a known launch time is not considered fresh.
- **Scheduled work is not running:** confirm the Worker deployment and cron triggers in the Cloudflare dashboard. The root HTTP status response alone does not verify scheduled processing.

For production diagnosis, use Cloudflare Worker logs/Observability and the debug report. Reports use UTC dates.
