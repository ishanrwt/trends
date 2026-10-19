// ---- Global settings ----

const SCRAPEDO_DAILY_CAP = 30;       // max Scrape.do fallback attempts per UTC day (~900/month, under the free 1,000)
const SCRAPINGANT_DAILY_CAP = 300;   // max ScrapingAnt fallback attempts per UTC day (~9,000/month, under the free 10,000)
const TOKEN_SNAPSHOT_CAP = 2000;     // max token addresses remembered in tokenSnapshot
const STATS_TTL_SECONDS = 14 * 24 * 60 * 60; // keep daily stats for 14 days
const CYCLE_LOG_CAP = 400;           // per-day cycle log entries (a full day is about 360 cycles)
const MOMENTUM_WINDOWS = ["m5", "h1", "h6"];
const MAX_MOMENTUM_CHECKS = 8;
const MIN_LIQUIDITY_USD = 10000;     // minimum liquidity for any token alert, from either source
const CG_MONTHLY_CAP = 9800;         // max CoinGecko calls per UTC month (free plan allows 10,000)
const CG_MAX_POOL_AGE_HOURS = 24;    // CoinGecko trending pools older than this are ignored
const CG_COUNTER_TTL_SECONDS = 40 * 24 * 60 * 60; // monthly call counter outlives its month by about 10 days
// Counters added after launch; older days' stats don't contain them, so reports default them to 0.
const LATE_COUNTER_DEFAULTS = {
  token_momentum_fail: 0,
  cg_ok: 0,
  cg_fail: 0,
  cg_skipped_cap: 0,
  cg_pools_seen: 0,
  cg_passed: 0,
  cg_alerts: 0
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/debug/candidates") {
      const list = await env.TREND_STATE.list({ prefix: "candidate:" });
      const results = [];
      for (const k of list.keys) {
        const raw = await env.TREND_STATE.get(k.name);
        results.push(raw ? JSON.parse(raw) : { key: k.name, error: "empty" });
      }
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/debug/stats") {
      const list = await env.TREND_STATE.list({ prefix: "stats:" });
      const days = {};
      for (const k of list.keys) {
        const raw = await env.TREND_STATE.get(k.name);
        if (!raw) continue;
        const { log, ...counters } = JSON.parse(raw);
        days[k.name.slice("stats:".length)] = { ...LATE_COUNTER_DEFAULTS, ...counters };
      }
      const cgMonth = new Date().toISOString().slice(0, 7);
      return Response.json(
        {
          scrapedoDailyCap: SCRAPEDO_DAILY_CAP,
          scrapingantDailyCap: SCRAPINGANT_DAILY_CAP,
          coingecko: { month: cgMonth, callsThisMonth: await getCgMonthCount(env, cgMonth), monthlyCap: CG_MONTHLY_CAP },
          days
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if (url.pathname === "/debug/report") {
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      const raw = await env.TREND_STATE.get(`stats:${day}`);
      if (!raw) {
        return Response.json({ day, error: "No data for this day (days are UTC, format YYYY-MM-DD)." }, { status: 404 });
      }
      const cgMonth = day.slice(0, 7);
      const cgUsage = { month: cgMonth, callsThisMonth: await getCgMonthCount(env, cgMonth), monthlyCap: CG_MONTHLY_CAP };
      return Response.json(buildDayReport(day, JSON.parse(raw), cgUsage), { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/debug/probe") {
      const dexUrl = "https://api.dexscreener.com/token-profiles/latest/v1";
      const targets = {
        dex_direct: { url: dexUrl },
        scrapedo: {
          url: `https://api.scrape.do/?token=${encodeURIComponent(env.SCRAPEDO_TOKEN)}&url=${encodeURIComponent(dexUrl)}`,
        },
        scrapingant: {
          url: `https://api.scrapingant.com/v2/general?browser=false&url=${encodeURIComponent(dexUrl)}&x-api-key=${encodeURIComponent(env.SCRAPINGANT_KEY)}`,
        },
      };
      const out = {};
      if (env.COINGECKO_API_KEY) {
        targets.coingecko = {
          url: "https://api.coingecko.com/api/v3/onchain/networks/solana/new_pools",
          headers: { "x-cg-demo-api-key": env.COINGECKO_API_KEY },
        };
      } else {
        out.coingecko = { skipped: "no key" };
      }
      for (const [name, t] of Object.entries(targets)) {
        const t0 = Date.now();
        try {
          const res = await fetch(t.url, {
            headers: { accept: "application/json", ...(t.headers || {}) },
            signal: AbortSignal.timeout(20000),
          });
          const body = await res.text();
          out[name] = { status: res.status, ms: Date.now() - t0, preview: body.slice(0, 200) };
        } catch (err) {
          out[name] = { error: String(err), ms: Date.now() - t0 };
        }
      }
      return Response.json(out, { headers: { "Cache-Control": "no-store" } });
    }

    return new Response("Trend agent worker is running. Use the scheduled handler for real work.");
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "*/4 * * * *") {
      await discoverTokens(env);
      if (new Date(event.scheduledTime).getUTCMinutes() % 8 === 0) {
        await discover(env);
        await discoverWire(env);
      }
    } else if (event.cron === "*/15 * * * *") {
      await confirm(env);
    } else {
      console.error("Unrecognized cron pattern:", event.cron);
    }
  }
};

// ---- Junk filtering (Google Trends only) ----

function isLikelyJunk(term) {
  const t = term.trim();
  if (t.length < 3) return true;
  if (/^\d+$/.test(t)) return true;
  if (t === "%s") return true;
  if (/^[\w.&'-]+\s+(vs\.?|@)\s+[\w.&'-]+$/i.test(t)) return true;
  if (/^[\w.&'-]+ - [\w.&'-]+$/i.test(t)) return true;
  if (/\b(schedule|roster|depth chart|standings)\b/i.test(t)) return true;
  return false;
}

// ---- LLM classification: is this animal-related? ----

async function classifyIsAnimalTrend(term, env) {
  const prompt = `Is the following term likely related to an animal in any way — a specific animal, an animal-themed creative work (movie, show, meme, mascot), animal-related news, or a cryptocurrency token named or branded after an animal — even if it's a proper noun, title, slang, or creative spelling that doesn't literally contain a standard animal word? Respond with only one word: YES or NO.\n\nTerm: "${term}"`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        temperature: 0,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!res.ok) {
      console.error(`[classify] Anthropic API returned status ${res.status} for "${term}"`);
      return false;
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || "").trim().toUpperCase();
    return text.startsWith("YES");
  } catch (err) {
    console.error(`[classify] Anthropic API fetch failed for "${term}":`, err);
    return false;
  }
}

async function paceClassify() {
  await new Promise(resolve => setTimeout(resolve, 4500));
}

// ---- Discovery: Google Trends ----

async function discover(env) {
  const GEO = "US";
  const url = `https://trends.google.com/trending/rss?geo=${GEO}`;

  let response;
  try {
    response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  } catch (err) {
    console.error("Fetch to Google Trends RSS failed:", err);
    return;
  }

  if (!response.ok) {
    console.error("Google Trends RSS returned status:", response.status);
    return;
  }

  const xml = await response.text();
  const titleMatches = [...xml.matchAll(/<title>(.*?)<\/title>/g)];
  const currentTerms = new Set(
    titleMatches.slice(1).map(m => m[1].trim()).filter(Boolean)
  );

  if (currentTerms.size === 0) {
    console.error("Parsed 0 terms from RSS — feed format may have changed. Raw snippet:", xml.slice(0, 300));
    return;
  }

  const lastSnapshotRaw = await env.TREND_STATE.get(`snapshot:${GEO}`);
  const lastTerms = new Set(lastSnapshotRaw ? JSON.parse(lastSnapshotRaw) : []);
  const newTerms = [...currentTerms].filter(term => !lastTerms.has(term));

  const keptTerms = newTerms.filter(term => !isLikelyJunk(term));
  const filteredCount = newTerms.length - keptTerms.length;

  const animalTerms = [];
  for (const term of keptTerms) {
    const isAnimal = await classifyIsAnimalTrend(term, env);
    if (isAnimal) animalTerms.push(term);
    await paceClassify();
  }

  console.log(`[discover] Checked ${currentTerms.size} terms, found ${newTerms.length} new, kept ${keptTerms.length} (filtered ${filteredCount} junk), ${animalTerms.length} animal-related`);

  for (const term of animalTerms) {
    const key = `candidate:US:${term}`;
    const discoveredAt = new Date().toISOString();
    await env.TREND_STATE.put(key, JSON.stringify({
      term,
      type: "trend",
      geo: GEO,
      status: "pending",
      discoveredAt
    }), {
      metadata: { status: "pending", discoveredAt }
    });
  }

  await env.TREND_STATE.put(`snapshot:${GEO}`, JSON.stringify([...currentTerms]));
}

// ---- Discovery: wire feeds (BBC + Al Jazeera) ----

function extractRssItemTitles(xml) {
  const itemBlocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return itemBlocks
    .map(block => {
      const m = block[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      return m ? m[1].trim() : null;
    })
    .filter(Boolean);
}

async function discoverWire(env) {
  const FEEDS = [
    { name: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" }
  ];
  const WIRE_CAP = 15;

  const currentHeadlines = new Map();

  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        console.error(`[discoverWire] ${feed.name} returned status ${res.status}`);
        continue;
      }
      const xml = await res.text();
      const titles = extractRssItemTitles(xml);
      for (const title of titles) {
        if (!currentHeadlines.has(title)) currentHeadlines.set(title, feed.name);
      }
    } catch (err) {
      console.error(`[discoverWire] Fetch failed for ${feed.name}:`, err);
    }
  }

  if (currentHeadlines.size === 0) {
    console.log("[discoverWire] No headlines parsed this cycle.");
    return;
  }

  const lastSnapshotRaw = await env.TREND_STATE.get("wireSnapshot");

  if (!lastSnapshotRaw) {
    await env.TREND_STATE.put("wireSnapshot", JSON.stringify([...currentHeadlines.keys()]));
    console.log(`[discoverWire] Cold start — seeded ${currentHeadlines.size} headlines, no alerts this cycle.`);
    return;
  }

  const lastHeadlines = new Set(JSON.parse(lastSnapshotRaw));
  const newHeadlines = [...currentHeadlines.keys()].filter(title => !lastHeadlines.has(title));
  const toProcess = newHeadlines.slice(0, WIRE_CAP);

  console.log(`[discoverWire] Checked ${currentHeadlines.size} headlines, found ${newHeadlines.length} new${newHeadlines.length > WIRE_CAP ? ` (processing ${WIRE_CAP})` : ""}`);

  let animalCount = 0;
  for (const headline of toProcess) {
    const source = currentHeadlines.get(headline);
    const isAnimal = await classifyIsAnimalTrend(headline, env);
    if (isAnimal) {
      animalCount++;
      const key = `wirecandidate:${headline.slice(0, 150)}`;
      await env.TREND_STATE.put(key, JSON.stringify({
        term: headline,
        source,
        status: "confirmed",
        discoveredAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString()
      }));
      await sendWireAlert(env, headline, source);
    }
    await paceClassify();
  }

  console.log(`[discoverWire] ${animalCount} of ${toProcess.length} new headlines were animal-related`);

  await env.TREND_STATE.put("wireSnapshot", JSON.stringify([...currentHeadlines.keys()]));
}

// ---- Daily route stats (read once per cycle, written once per cycle) ----

function emptyStats() {
  return {
    cycles: 0,
    profiles_ok: 0,
    profiles_failed: 0,
    direct_ok: 0,
    direct_fail: 0,
    scrapedo_attempts: 0,
    scrapedo_ok: 0,          // successful Scrape.do calls = credits used
    scrapedo_fail: 0,
    scrapedo_skipped_cap: 0, // times the fallback was needed but the daily cap was reached
    scrapingant_attempts: 0,
    scrapingant_ok: 0,          // successful ScrapingAnt calls = credits used
    scrapingant_fail: 0,
    scrapingant_skipped_cap: 0, // times the fallback was needed but the daily cap was reached
    token_momentum_fail: 0,
    cg_ok: 0,
    cg_fail: 0,
    cg_skipped_cap: 0,    // times the CoinGecko call was skipped because the monthly cap was reached
    cg_pools_seen: 0,
    cg_passed: 0,
    cg_alerts: 0,
    alerts: 0
  };
}

async function loadStats(env) {
  const key = `stats:${new Date().toISOString().slice(0, 10)}`;
  let stats = emptyStats();
  try {
    const raw = await env.TREND_STATE.get(key);
    if (raw) stats = { ...stats, ...JSON.parse(raw) };
  } catch (err) {
    console.error("[stats] Failed to load stats:", err);
  }
  return { key, stats };
}

async function saveStats(env, key, stats) {
  try {
    await env.TREND_STATE.put(key, JSON.stringify(stats), { expirationTtl: STATS_TTL_SECONDS });
  } catch (err) {
    console.error("[stats] Failed to save stats:", err);
  }
}

// ---- DexScreener access: direct → Scrape.do → ScrapingAnt (each fallback daily-capped) ----

async function fetchDexJson(targetUrl, env, run) {
  const fail = { success: false, data: null, route: null };
  const note = route => run.cycle?.calls.push(route);

  // 1. Direct fetch — free, works whenever the shared Cloudflare IP isn't rate-limited.
  //    After a 429 in this cycle, skip direct for the rest of the cycle (it will almost certainly 429 again).
  if (!run.directBlocked) {
    try {
      const res = await fetch(targetUrl, {
        headers: { accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data = JSON.parse(await res.text());
        run.stats.direct_ok++;
        note("direct");
        return { success: true, data, route: "direct" };
      }
      console.error(`[dex] direct returned status ${res.status}`);
      if (res.status === 429) run.directBlocked = true;
    } catch (err) {
      console.error(`[dex] direct failed: ${err.message || err}`);
    }
    run.stats.direct_fail++;
  }

  // 2. Scrape.do fallback — costs 1 credit per successful call, capped per day.
  if (env.SCRAPEDO_TOKEN && run.stats.scrapedo_attempts < SCRAPEDO_DAILY_CAP) {
    run.stats.scrapedo_attempts++;
    try {
      // Never log this URL — it contains the token.
      const scrapeUrl = `https://api.scrape.do/?token=${encodeURIComponent(env.SCRAPEDO_TOKEN)}&url=${encodeURIComponent(targetUrl)}`;
      const res = await fetch(scrapeUrl, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const data = JSON.parse(await res.text());
        run.stats.scrapedo_ok++;
        note("scrapedo");
        return { success: true, data, route: "scrapedo" };
      }
      console.error(`[dex] Scrape.do returned status ${res.status}`);
    } catch (err) {
      console.error(`[dex] Scrape.do failed: ${err.message || err}`);
    }
    run.stats.scrapedo_fail++;
  } else if (env.SCRAPEDO_TOKEN) {
    run.stats.scrapedo_skipped_cap++;
    console.error(`[dex] Scrape.do daily cap (${SCRAPEDO_DAILY_CAP}) reached — skipping to next fallback`);
  } else {
    console.error("[dex] SCRAPEDO_TOKEN is not set — skipping to next fallback");
  }

  // 3. ScrapingAnt fallback — costs 1 credit per successful call (browser=false), capped per day.
  if (env.SCRAPINGANT_KEY && run.stats.scrapingant_attempts < SCRAPINGANT_DAILY_CAP) {
    run.stats.scrapingant_attempts++;
    try {
      // Never log this URL — it contains the key.
      const antUrl = `https://api.scrapingant.com/v2/general?browser=false&url=${encodeURIComponent(targetUrl)}&x-api-key=${encodeURIComponent(env.SCRAPINGANT_KEY)}`;
      const res = await fetch(antUrl, { signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const data = JSON.parse(await res.text());
        run.stats.scrapingant_ok++;
        note("scrapingant");
        return { success: true, data, route: "scrapingant" };
      }
      console.error(`[dex] ScrapingAnt returned status ${res.status}`);
    } catch (err) {
      console.error(`[dex] ScrapingAnt failed: ${err.message || err}`);
    }
    run.stats.scrapingant_fail++;
  } else if (env.SCRAPINGANT_KEY) {
    run.stats.scrapingant_skipped_cap++;
    console.error(`[dex] ScrapingAnt daily cap (${SCRAPINGANT_DAILY_CAP}) reached — no routes left`);
  } else {
    console.error("[dex] SCRAPINGANT_KEY is not set — no routes left");
  }

  note("failed");
  return fail;
}

// ---- Daily report (served at /debug/report) ----

function summarizeMinutes(values) {
  const v = values.filter(n => typeof n === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const at = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { count: v.length, median: at(0.5), p90: at(0.9), max: v[v.length - 1] };
}

function buildDayReport(day, stats, cgUsage = null) {
  const { log = [], ...storedCounters } = stats;
  const counters = { ...LATE_COUNTER_DEFAULTS, ...storedCounters };
  const times = log.map(c => Date.parse(c.t)).sort((a, b) => a - b);

  // Token discovery runs every 4 minutes; anything over 9 minutes between logged cycles is a gap.
  const cronGaps = [];
  for (let i = 1; i < times.length; i++) {
    const minutes = (times[i] - times[i - 1]) / 60000;
    if (minutes > 9) {
      cronGaps.push({ from: new Date(times[i - 1]).toISOString(), to: new Date(times[i]).toISOString(), minutes: Math.round(minutes) });
    }
  }

  const routeUse = {};
  for (const c of log) for (const r of c.calls || []) routeUse[r] = (routeUse[r] || 0) + 1;

  const failedProfileCycles = log.filter(c => c.profiles === "failed").map(c => c.t);
  const alerts = log.flatMap(c => (c.alerts || []).map(a => ({ at: c.t, ...a })));

  return {
    day,
    note: "All times are UTC. Token discovery runs every 4 minutes (about 360 cycles per day).",
    firstCycle: times.length ? new Date(times[0]).toISOString() : null,
    lastCycle: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    cyclesLogged: log.length,
    cronGaps,
    profileFetch: {
      ok: log.length - failedProfileCycles.length,
      failed: failedProfileCycles.length,
      failedAt: failedProfileCycles
    },
    // Cycles where none of the listed tokens had been seen before: the feed fully turned over
    // since the previous successful check, so tokens may have been missed in between.
    possibleMissedWindows: log.filter(c => c.overlap === 0).map(c => c.t),
    routeUse,
    scrapedo: {
      creditsUsed: counters.scrapedo_ok || 0,
      dailyCap: SCRAPEDO_DAILY_CAP,
      timesCapBlockedFallback: counters.scrapedo_skipped_cap || 0
    },
    scrapingant: {
      creditsUsed: counters.scrapingant_ok || 0,
      dailyCap: SCRAPINGANT_DAILY_CAP,
      timesCapBlockedFallback: counters.scrapingant_skipped_cap || 0
    },
    coingecko: {
      month: cgUsage?.month ?? null,
      callsThisMonth: cgUsage?.callsThisMonth ?? null,
      monthlyCap: CG_MONTHLY_CAP,
      ok: counters.cg_ok,
      failed: counters.cg_fail,
      timesSkippedForCap: counters.cg_skipped_cap,
      poolsSeen: counters.cg_pools_seen,
      passedFilters: counters.cg_passed,
      alerts: counters.cg_alerts
    },
    alerts: {
      count: alerts.length,
      queueToAlertMinutes: summarizeMinutes(alerts.map(a => a.queueToAlertMin)),
      launchToAlertMinutes: summarizeMinutes(alerts.map(a => a.launchToAlertMin)),
      list: alerts
    },
    counters
  };
}

// ---- Discovery: new crypto tokens (DexScreener) ----

async function discoverTokens(env) {
  const { key: statsKey, stats } = await loadStats(env);
  const run = {
    stats,
    directBlocked: false,
    cycle: { t: new Date().toISOString(), profiles: "failed", checked: 0, queued: 0, overlap: null, evaluated: 0, calls: [], alerts: [] }
  };
  stats.cycles++;

  try {
    await ingestTokenProfiles(env, run);
    await evaluatePendingTokens(env, run);
    // Second source. Fully isolated: nothing it does may break the DexScreener path above or the stats save below.
    try {
      await discoverTrendingCG(env, run);
    } catch (err) {
      run.stats.cg_fail++;
      console.error("[cg] Unexpected error:", err);
    }
  } finally {
    stats.log = [...(stats.log || []), run.cycle].slice(-CYCLE_LOG_CAP);
    await saveStats(env, statsKey, stats);
  }
}

// Step 1: fetch latest profiles and queue any new token addresses
async function ingestTokenProfiles(env, run) {
  const result = await fetchDexJson("https://api.dexscreener.com/token-profiles/latest/v1", env, run);

  if (!result.success) {
    run.stats.profiles_failed++;
    console.error("[discoverTokens] Could not fetch token profiles this cycle (direct, Scrape.do, and ScrapingAnt all failed or were capped).");
    return;
  }
  run.stats.profiles_ok++;
  run.cycle.profiles = result.route;

  const profiles = Array.isArray(result.data) ? result.data : [];
  const currentAddresses = [...new Set(profiles.filter(p => p.tokenAddress).map(p => p.tokenAddress))];
  const lastSnapshotRaw = await env.TREND_STATE.get("tokenSnapshot");

  if (!lastSnapshotRaw) {
    await env.TREND_STATE.put("tokenSnapshot", JSON.stringify(currentAddresses));
    run.cycle.checked = currentAddresses.length;
    console.log(`[discoverTokens] Cold start via ${result.route} — seeded ${currentAddresses.length} tokens, no processing this cycle.`);
    return;
  }

  const lastAddresses = JSON.parse(lastSnapshotRaw);
  const lastSet = new Set(lastAddresses);

  const queued = new Set();
  for (const profile of profiles) {
    const addr = profile.tokenAddress;
    if (!addr || lastSet.has(addr) || queued.has(addr)) continue;
    queued.add(addr);

    const discoveredAt = new Date().toISOString();
    await env.TREND_STATE.put(`tokenpending:${addr}`, JSON.stringify({
      tokenAddress: addr,
      chain: profile.chainId || "unknown",
      description: (profile.description || "").trim(),
      profileUrl: profile.url,
      discoveredAt
    }), {
      metadata: { status: "pending", discoveredAt }
    });
  }

  // Keep the snapshot bounded. Addresses currently in the feed always go at the end,
  // so they're never trimmed while still listed (which would cause duplicate alerts).
  const currentSet = new Set(currentAddresses);
  const updated = [...lastAddresses.filter(a => !currentSet.has(a)), ...currentAddresses].slice(-TOKEN_SNAPSHOT_CAP);
  await env.TREND_STATE.put("tokenSnapshot", JSON.stringify(updated));

  // overlap = how many currently listed tokens we'd already seen. 0 means the whole feed turned over
  // since the last successful check, so some tokens may have come and gone unseen.
  run.cycle.checked = currentAddresses.length;
  run.cycle.queued = queued.size;
  run.cycle.overlap = currentAddresses.filter(a => lastSet.has(a)).length;

  console.log(`[discoverTokens] Profiles via ${result.route}: checked ${profiles.length}, queued ${queued.size} new (snapshot ${updated.length}/${TOKEN_SNAPSHOT_CAP})`);
}

function buildTokenClassifyText(name, symbol, description) {
  const label = name ? `${name}${symbol ? ` (${symbol})` : ""}` : "";
  const desc = (description || "").slice(0, 300);
  if (label && desc) return `${label} — ${desc}`;
  return label || desc;
}

function buildDisplayName(name, symbol, pending) {
  if (name) return `${name}${symbol ? ` (${symbol})` : ""}`;
  if (pending.description) return pending.description.slice(0, 100);
  return pending.tokenAddress;
}

function passesMomentum(pair) {
  const failed = MOMENTUM_WINDOWS
    .filter(window => {
      const value = pair?.priceChange?.[window];
      return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
    })
    .map(window => {
      const value = pair?.priceChange?.[window];
      return `${window}=${typeof value === "number" && Number.isFinite(value) ? value : "n/a"}`;
    });
  return { ok: failed.length === 0, failed };
}

function formatMomentum(pair) {
  const labels = { m5: "5m", h1: "1h", h6: "6h" };
  return MOMENTUM_WINDOWS.map(window => {
    const value = pair?.priceChange?.[window];
    const formatted = typeof value === "number" && Number.isFinite(value)
      ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`
      : "n/a";
    return `${labels[window]} ${formatted}`;
  }).join(" | ");
}

async function savePending(env, key, pending) {
  await env.TREND_STATE.put(key, JSON.stringify(pending), {
    metadata: { status: "pending", discoveredAt: pending.discoveredAt }
  });
}

// Step 2: evaluate the oldest pending tokens, with batched liquidity lookups
async function evaluatePendingTokens(env, run) {
  const TOKEN_CAP = 30;
  const BATCH_SIZE = 30;              // DexScreener accepts up to 30 addresses per tokens/v1 request
  const MAX_AGE_MS = 3 * 60 * 60 * 1000;
  const MAX_NO_PAIR_CHECKS = 6;       // preserves the existing retry window at a 4-minute cycle

  const list = await env.TREND_STATE.list({ prefix: "tokenpending:" });
  const pendingKeys = list.keys.filter(k => k.metadata?.status === "pending");

  if (pendingKeys.length === 0) {
    console.log("[discoverTokens] No pending tokens to evaluate.");
    return;
  }

  pendingKeys.sort((a, b) => new Date(a.metadata.discoveredAt) - new Date(b.metadata.discoveredAt));
  const toProcess = pendingKeys.slice(0, TOKEN_CAP);

  // Load records and drop expired ones
  const tokens = [];
  for (const keyEntry of toProcess) {
    const raw = await env.TREND_STATE.get(keyEntry.name);
    if (!raw) continue;
    const pending = JSON.parse(raw);

    const age = Date.now() - new Date(pending.discoveredAt).getTime();
    if (age > MAX_AGE_MS) {
      await env.TREND_STATE.delete(keyEntry.name);
      console.log(`[discoverTokens] "${pending.tokenAddress}" — expired after ${Math.round(age / 60000)}m, never got a clean check`);
      continue;
    }
    if (!pending.chain || pending.chain === "unknown") {
      await env.TREND_STATE.delete(keyEntry.name);
      console.log(`[discoverTokens] "${pending.tokenAddress}" — unknown chain, dropped`);
      continue;
    }
    tokens.push({ key: keyEntry.name, pending });
  }

  if (tokens.length === 0) return;
  run.cycle.evaluated = tokens.length;
  console.log(`[discoverTokens] Evaluating ${tokens.length} of ${pendingKeys.length} pending tokens`);

  // Batched market lookup, grouped by chain
  const byChain = new Map();
  for (const t of tokens) {
    if (!byChain.has(t.pending.chain)) byChain.set(t.pending.chain, []);
    byChain.get(t.pending.chain).push(t);
  }

  const market = new Map();    // lowercase address -> { liquidity, volume24h, name, symbol, pair }
  const fetchedOk = new Set(); // lowercase addresses whose batch lookup succeeded

  for (const [chain, group] of byChain) {
    for (let i = 0; i < group.length; i += BATCH_SIZE) {
      const batch = group.slice(i, i + BATCH_SIZE);
      const addrs = batch.map(t => t.pending.tokenAddress);
      const result = await fetchDexJson(`https://api.dexscreener.com/tokens/v1/${chain}/${addrs.join(",")}`, env, run);

      if (!result.success) {
        console.error(`[discoverTokens] Pairs lookup failed for ${addrs.length} ${chain} tokens — will retry next cycle`);
        continue;
      }

      const asked = new Set(addrs.map(a => a.toLowerCase()));
      for (const a of asked) fetchedOk.add(a);

      const pairs = Array.isArray(result.data) ? result.data : (result.data?.pairs || []);
      for (const pair of pairs) {
        for (const side of [pair.baseToken, pair.quoteToken]) {
          if (!side?.address) continue;
          const addr = side.address.toLowerCase();
          if (!asked.has(addr)) continue;

          const entry = market.get(addr) || { liquidity: 0, volume24h: 0, name: null, symbol: null, pairCreatedAt: null, pair: null };
          const pairLiquidity = pair.liquidity?.usd || 0;
          if (pairLiquidity >= entry.liquidity) entry.pair = pair;
          entry.liquidity = Math.max(entry.liquidity, pairLiquidity);
          entry.volume24h = Math.max(entry.volume24h, pair.volume?.h24 || 0);
          if (!entry.name && side.name) {
            entry.name = side.name;
            entry.symbol = side.symbol || null;
          }
          if (pair.pairCreatedAt && (!entry.pairCreatedAt || pair.pairCreatedAt < entry.pairCreatedAt)) {
            entry.pairCreatedAt = pair.pairCreatedAt;
          }
          market.set(addr, entry);
        }
      }
      console.log(`[discoverTokens] Pairs via ${result.route}: ${addrs.length} ${chain} tokens in 1 request`);
    }
  }

  // Decide per token.
  // Rule: every token needs at least MIN_LIQUIDITY_USD to alert. Being animal-themed is a label on
  // qualifying alerts, not a way around the liquidity requirement.
  let alertCount = 0;
  for (const { key, pending } of tokens) {
    const addrLc = pending.tokenAddress.toLowerCase();
    const pairsOk = fetchedOk.has(addrLc);
    const info = market.get(addrLc) || null;

    if (info?.name && !pending.name) {
      pending.name = info.name;
      pending.symbol = info.symbol;
    }
    const name = pending.name || null;
    const symbol = pending.symbol || null;
    const displayName = buildDisplayName(name, symbol, pending);

    // Case A: liquidity lookup failed this cycle — nothing can qualify without a liquidity number, so retry
    if (!pairsOk) {
      console.log(`[discoverTokens] "${displayName}" — liquidity unknown this cycle, will retry`);
      continue;
    }

    // Case B: lookup worked but the token has no trading pairs yet — give pools a few cycles to appear
    if (!info) {
      pending.noPairChecks = (pending.noPairChecks || 0) + 1;
      if (pending.noPairChecks >= MAX_NO_PAIR_CHECKS) {
        await env.TREND_STATE.delete(key);
        console.log(`[discoverTokens] "${displayName}" — still no trading pairs after ${pending.noPairChecks} checks, dropped`);
      } else {
        await savePending(env, key, pending);
        console.log(`[discoverTokens] "${displayName}" — no trading pairs yet (check ${pending.noPairChecks}/${MAX_NO_PAIR_CHECKS})`);
      }
      continue;
    }

    // Case C: full data available
    const hasRealLiquidity = info.liquidity >= MIN_LIQUIDITY_USD;

    if (!hasRealLiquidity) {
      console.log(`[discoverTokens] "${displayName}" — liquidity $${Math.round(info.liquidity)}, 24h volume $${Math.round(info.volume24h)}, below $${MIN_LIQUIDITY_USD} — skipped`);
      await env.TREND_STATE.delete(key);
      continue;
    }

    const momentum = passesMomentum(info.pair);
    if (!momentum.ok) {
      pending.momentumChecks = (pending.momentumChecks || 0) + 1;
      run.stats.token_momentum_fail++;
      console.log(`[discoverTokens] ${pending.tokenAddress} — momentum failed: ${momentum.failed.join(", ")} (${pending.momentumChecks}/${MAX_MOMENTUM_CHECKS})`);
      if (pending.momentumChecks >= MAX_MOMENTUM_CHECKS) {
        await env.TREND_STATE.delete(key);
      } else {
        await savePending(env, key, pending);
      }
      continue;
    }

    // Already alerted (e.g. by the CoinGecko source)? Never alert the same token twice.
    if (await env.TREND_STATE.get(`candidate:TOKEN:${pending.tokenAddress}`)) {
      console.log(`[discoverTokens] "${displayName}" — already alerted by another source, skipped`);
      await env.TREND_STATE.delete(key);
      continue;
    }

    // Only qualifying tokens get classified, so Haiku isn't called on tokens that can't alert anyway.
    const text = buildTokenClassifyText(name, symbol, pending.description);
    const isAnimal = text ? await classifyIsAnimalTrend(text, env) : false;
    console.log(`[discoverTokens] "${displayName}" — liquidity $${Math.round(info.liquidity)}, 24h volume $${Math.round(info.volume24h)}, animal-themed: ${isAnimal}`);

    const reasons = ["real liquidity"];
    if (isAnimal) reasons.push("animal-themed");
    await recordTokenAlert(env, run, pending, {
      displayName, name, symbol, url: pending.profileUrl || `https://dexscreener.com/${pending.chain}/${pending.tokenAddress}`,
      isAnimal, liquidity: info.liquidity, volume24h: info.volume24h, reasons, pairCreatedAt: info.pairCreatedAt, pair: info.pair
    });
    alertCount++;

    // Fully evaluated — remove from the pending queue
    await env.TREND_STATE.delete(key);
  }

  run.stats.alerts += alertCount;
  console.log(`[discoverTokens] ${alertCount} of ${tokens.length} evaluated tokens triggered an alert`);
}

// ---- Discovery: CoinGecko trending pools (second token source, Solana) ----

async function getCgMonthCount(env, month) {
  const raw = await env.TREND_STATE.get(`cg_calls:${month}`);
  return parseInt(raw, 10) || 0;
}

// CoinGecko sends numbers as strings and uses null for missing values; Number(null) would be 0, so map those to NaN.
function toNum(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

// Turns a trending_pools response into one entry per base token (its highest-liquidity pool).
function parseCgPools(body) {
  const includedTokens = new Map();
  for (const item of body?.included || []) {
    if (item?.id) includedTokens.set(item.id, item.attributes || {});
  }

  const rank = n => (Number.isFinite(n) ? n : -Infinity);
  const byToken = new Map();
  for (const pool of body?.data || []) {
    const attrs = pool?.attributes || {};
    const baseId = pool?.relationships?.base_token?.data?.id;
    if (!baseId) continue;

    const address = baseId.replace(/^solana_/, "");
    const token = includedTokens.get(baseId) || {};
    const nameFromPool = typeof attrs.name === "string" ? attrs.name.split(" / ")[0].trim() : "";
    const price = attrs.price_change_percentage || {};
    const h1Txns = attrs.transactions?.h1 || {};

    const parsed = {
      address,
      poolAddress: attrs.address || String(pool.id || "").replace(/^solana_/, ""),
      name: token.name || nameFromPool || null,
      symbol: token.symbol || null,
      reserveUsd: toNum(attrs.reserve_in_usd),
      createdAtMs: Date.parse(attrs.pool_created_at),
      priceChange: { m5: toNum(price.m5), h1: toNum(price.h1), h6: toNum(price.h6) },
      volume24h: toNum(attrs.volume_usd?.h24),
      buyers: toNum(h1Txns.buyers),
      sellers: toNum(h1Txns.sellers)
    };

    const existing = byToken.get(address);
    if (!existing || rank(parsed.reserveUsd) > rank(existing.reserveUsd)) byToken.set(address, parsed);
  }
  return [...byToken.values()];
}

// Returns why a CoinGecko pool doesn't qualify, or null if it does.
function cgPoolRejection(pool, now) {
  const ageMs = now - pool.createdAtMs;
  if (!Number.isFinite(ageMs) || ageMs > CG_MAX_POOL_AGE_HOURS * 60 * 60 * 1000) return "pool too old or undated";
  if (!(pool.reserveUsd >= MIN_LIQUIDITY_USD)) return "liquidity below minimum";
  const momentum = passesMomentum({ priceChange: pool.priceChange });
  if (!momentum.ok) return `momentum failed: ${momentum.failed.join(", ")}`;
  return null;
}

async function discoverTrendingCG(env, run) {
  const { stats, cycle } = run;

  if (!env.COINGECKO_API_KEY) {
    stats.cg_fail++;
    cycle.cg = "no_key";
    console.log("[cg] COINGECKO_API_KEY is not set — skipping CoinGecko trending");
    return;
  }

  // Monthly safety cap. The counter is bumped before the request, so every attempt counts.
  const month = new Date().toISOString().slice(0, 7);
  try {
    const used = await getCgMonthCount(env, month);
    if (used >= CG_MONTHLY_CAP) {
      stats.cg_skipped_cap++;
      cycle.cg = "skipped_cap";
      console.log(`[cg] Monthly cap reached (${used}/${CG_MONTHLY_CAP}) — skipping CoinGecko for the rest of ${month}`);
      return;
    }
    await env.TREND_STATE.put(`cg_calls:${month}`, String(used + 1), { expirationTtl: CG_COUNTER_TTL_SECONDS });
  } catch (err) {
    // Without a reliable counter the cap can't be enforced, so don't call.
    stats.cg_fail++;
    cycle.cg = "fail";
    console.error("[cg] Could not read/update the monthly call counter — skipping:", err.message || err);
    return;
  }

  let body;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/onchain/networks/solana/trending_pools?duration=5m&include=base_token", {
      headers: { accept: "application/json", "x-cg-demo-api-key": env.COINGECKO_API_KEY },
      signal: AbortSignal.timeout(10000)
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    body = JSON.parse(await res.text());
    if (!Array.isArray(body?.data)) throw new Error("response has no data array");
  } catch (err) {
    stats.cg_fail++;
    cycle.cg = "fail";
    console.error(`[cg] CoinGecko trending request failed: ${err.message || err}`);
    return;
  }

  stats.cg_ok++;
  cycle.cg = "ok";
  stats.cg_pools_seen += body.data.length;

  const now = Date.now();
  let passed = 0;
  let alerted = 0;
  for (const pool of parseCgPools(body)) {
    if (cgPoolRejection(pool, now)) continue;
    if (await env.TREND_STATE.get(`candidate:TOKEN:${pool.address}`)) continue; // already alerted
    passed++;

    const text = buildTokenClassifyText(pool.name, pool.symbol, "");
    const isAnimal = text ? await classifyIsAnimalTrend(text, env) : false;
    const pending = { tokenAddress: pool.address, chain: "solana", description: "", discoveredAt: new Date().toISOString() };
    const displayName = buildDisplayName(pool.name, pool.symbol, pending);
    console.log(`[cg] "${displayName}" — liquidity $${Math.round(pool.reserveUsd)}, animal-themed: ${isAnimal}`);

    const reasons = ["trending (CoinGecko)", "real liquidity"];
    if (isAnimal) reasons.push("animal-themed");
    await recordTokenAlert(env, run, pending, {
      displayName,
      name: pool.name,
      symbol: pool.symbol,
      url: `https://dexscreener.com/solana/${pool.poolAddress}`,
      isAnimal,
      liquidity: pool.reserveUsd,
      volume24h: Number.isFinite(pool.volume24h) ? pool.volume24h : null,
      reasons,
      pairCreatedAt: pool.createdAtMs,
      pair: { priceChange: pool.priceChange },
      buyers: pool.buyers,
      sellers: pool.sellers
    });
    alerted++;
  }

  stats.cg_passed += passed;
  stats.cg_alerts += alerted;
  stats.alerts += alerted;
  cycle.cgPools = body.data.length;
  cycle.cgPassed = passed;
  console.log(`[cg] ${body.data.length} trending pools, ${passed} passed filters, ${alerted} alerted`);
}

async function recordTokenAlert(env, run, pending, fields) {
  const { displayName, name, symbol, url, isAnimal, liquidity, volume24h, reasons, pairCreatedAt = null, pair, buyers = null, sellers = null } = fields;
  const now = Date.now();
  const round1 = n => Math.round(n * 10) / 10;
  const queueToAlertMin = round1((now - new Date(pending.discoveredAt).getTime()) / 60000);
  const launchToAlertMin = pairCreatedAt ? round1((now - pairCreatedAt) / 60000) : null;

  run.cycle.alerts.push({ name: displayName.slice(0, 60), reasons, queueToAlertMin, launchToAlertMin });

  await env.TREND_STATE.put(`candidate:TOKEN:${pending.tokenAddress}`, JSON.stringify({
    term: displayName,
    type: "token",
    name,
    symbol,
    chain: pending.chain,
    tokenAddress: pending.tokenAddress,
    liquidityUsd: liquidity,
    volume24hUsd: volume24h,
    isAnimal,
    url,
    status: "confirmed",
    discoveredAt: pending.discoveredAt,
    confirmedAt: new Date(now).toISOString(),
    pairCreatedAt: pairCreatedAt ? new Date(pairCreatedAt).toISOString() : null,
    queueToAlertMin,
    launchToAlertMin
  }));

  await sendTokenAlert(env, {
    name: displayName,
    chain: pending.chain,
    url,
    liquidity,
    volume24h,
    reasons,
    pair,
    buyers,
    sellers
  });
}

// ---- Confirmation: GDELT (uses KV metadata to avoid loading every candidate) ----

async function confirm(env) {
  const MIN_ARTICLES = 3;
  const MAX_AGE_MS = 3 * 60 * 60 * 1000;
  const PER_CYCLE_CAP = 40;
  const FETCH_TIMEOUT_MS = 10000;
  const MIN_SPACING_MS = 5500;

  // list() returns metadata for free — no get() needed just to filter/sort
  const list = await env.TREND_STATE.list({ prefix: "candidate:" });

  const pendingKeys = list.keys.filter(k => k.metadata?.status === "pending");

  if (pendingKeys.length === 0) {
    console.log("[confirm] No pending candidates in KV.");
    return;
  }

  pendingKeys.sort((a, b) => new Date(b.metadata.discoveredAt) - new Date(a.metadata.discoveredAt));

  const toProcessKeys = pendingKeys.slice(0, PER_CYCLE_CAP);
  const overflow = pendingKeys.length - toProcessKeys.length;

  console.log(`[confirm] Processing ${toProcessKeys.length} of ${pendingKeys.length} pending candidates${overflow > 0 ? ` (${overflow} deferred to next cycle)` : ""}`);

  for (const keyEntry of toProcessKeys) {
    const key = keyEntry.name;
    const raw = await env.TREND_STATE.get(key);
    if (!raw) continue;
    const candidate = JSON.parse(raw);

    const requestStart = Date.now();
    const age = requestStart - new Date(candidate.discoveredAt).getTime();

    if (age > MAX_AGE_MS) {
      candidate.status = "expired";
      await env.TREND_STATE.put(key, JSON.stringify(candidate), {
        metadata: { status: "expired", discoveredAt: candidate.discoveredAt }
      });
      console.log(`[confirm] "${candidate.term}" — expired (pending ${Math.round(age / 60000)}m)`);
      continue;
    }

    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(candidate.term)}&mode=artlist&format=json&maxrecords=20&timespan=24h`;

    let articleCount = 0;
    let checkSucceeded = false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(gdeltUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.status === 429) {
        console.error(`[confirm] GDELT rate-limited us for "${candidate.term}"`);
      } else if (!res.ok) {
        console.error(`[confirm] GDELT returned status ${res.status} for "${candidate.term}"`);
      } else {
        const bodyText = await res.text();
        try {
          const data = JSON.parse(bodyText);
          articleCount = (data.articles || []).length;
          checkSucceeded = true;
        } catch (parseErr) {
          console.error(`[confirm] GDELT returned non-JSON for "${candidate.term}"`);
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        console.error(`[confirm] GDELT request timed out for "${candidate.term}"`);
      } else {
        console.error(`[confirm] GDELT fetch failed for "${candidate.term}":`, err);
      }
    }

    if (checkSucceeded) {
      console.log(`[confirm] "${candidate.term}" — ${articleCount} articles`);
      if (articleCount >= MIN_ARTICLES) {
        candidate.status = "confirmed";
        candidate.articleCount = articleCount;
        candidate.confirmedAt = new Date().toISOString();
        await env.TREND_STATE.put(key, JSON.stringify(candidate), {
          metadata: { status: "confirmed", discoveredAt: candidate.discoveredAt }
        });
        await sendTelegramAlert(env, candidate);
      } else {
        candidate.status = "rejected";
        await env.TREND_STATE.put(key, JSON.stringify(candidate), {
          metadata: { status: "rejected", discoveredAt: candidate.discoveredAt }
        });
      }
    }
    // If check failed, leave status "pending" — metadata unchanged, retried next cycle

    const elapsed = Date.now() - requestStart;
    const remainingDelay = MIN_SPACING_MS - elapsed;
    if (remainingDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingDelay));
    }
  }
}

// ---- Telegram alerts ----
// Two bots can be configured, each with its own token and chat id:
//   Bot 1 (existing): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   Bot 2 (new, optional): TELEGRAM_BOT_TOKEN_2, TELEGRAM_CHAT_ID_2
// Every alert is sent to whichever of the two are configured. Bot 2 is skipped silently if its
// secrets aren't set. Each bot is sent to independently, so one failing doesn't block the other.

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

async function sendTelegramMessage(env, text, label) {
  const recipients = getTelegramRecipients(env);
  if (recipients.length === 0) {
    console.error(`[${label}] No Telegram bot configured — nothing to send to`);
    return;
  }

  await Promise.all(recipients.map(async ({ bot, token, chatId }) => {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
      });
      if (!res.ok) {
        console.error(`[${label}] Telegram send failed for ${bot}:`, res.status, await res.text());
      }
    } catch (err) {
      console.error(`[${label}] Telegram fetch failed for ${bot}:`, err);
    }
  }));
}

async function sendTelegramAlert(env, candidate) {
  let text;
  if (candidate.type === "token") {
    text = `🐾🪙 Animal-themed token confirmed: "${candidate.term}"\nChain: ${candidate.chain}\nNews articles (24h): ${candidate.articleCount}\n${candidate.url}`;
  } else {
    text = `🐾 Animal trend confirmed: "${candidate.term}"\nGeo: ${candidate.geo}\nNews articles (24h): ${candidate.articleCount}`;
  }
  await sendTelegramMessage(env, text, "confirm");
}

async function sendWireAlert(env, headline, source) {
  const text = `🐾 Animal trend (wire pickup): "${headline}"\nSource: ${source}`;
  await sendTelegramMessage(env, text, "discoverWire");
}

function formatUsd(value) {
  if (value === null || value === undefined) return "unknown";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

async function sendTokenAlert(env, { name, chain, url, liquidity, volume24h, reasons, pair, buyers, sellers }) {
  // Only sources that report buyer/seller counts (CoinGecko) get this line.
  const flowLine = Number.isFinite(buyers) && Number.isFinite(sellers) ? `\n👥 1h: ${buyers} buyers / ${sellers} sellers` : "";
  const text = `🪙 New token: ${name}\nWhy: ${reasons.join(" + ")}\nChain: ${chain}\nLiquidity: ${formatUsd(liquidity)}\n24h Volume: ${formatUsd(volume24h)}\n📈 ${formatMomentum(pair)}${flowLine}\n${url}`;
  await sendTelegramMessage(env, text, "discoverTokens");
}