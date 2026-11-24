// Pulse server — watches crypto news, rumors, Asia headlines, whale moves and
// prices every minute, stores them, and pushes new ones to the phone over a
// WebSocket the instant they show up.
import { DurableObject } from "cloudflare:workers";
import { TIPS } from "./tips.js";

// ---------------------------------------------------------------- sources --
// every = how often (in minutes) the source is checked. Breaking channels go
// every minute; big news sites every 2–3; Reddit every 5 so it doesn't block us.
export const SOURCES = [
  // Breaking + rumors. "rumor: true" = unconfirmed chatter; the rest are fast headline relays.
  { id: "watcherguru", name: "Watcher Guru", cat: "rumor", type: "tg", channel: "WatcherGuru", every: 1 },
  { id: "unfolded", name: "unfolded.", cat: "rumor", type: "tg", channel: "unfolded", every: 1 },
  { id: "phoenix", name: "PhoenixNews", cat: "rumor", type: "tg", channel: "PhoenixNewsImportant", every: 1 },
  { id: "ct_tg", name: "Cointelegraph Flash", cat: "rumor", type: "tg", channel: "cointelegraph", every: 1 },
  // Asia / China
  { id: "wu", name: "Wu Blockchain", cat: "asia", type: "tg", channel: "wublockchainenglish", every: 1 },
  { id: "binance", name: "Binance", cat: "asia", type: "tg", channel: "binance_announcements", every: 1 },
  { id: "okx", name: "OKX", cat: "asia", type: "okx", every: 2 },
  // Whales
  { id: "whale", name: "Whale Alert", cat: "whale", type: "tg", channel: "whale_alert_io", every: 1 },
  // Major news
  { id: "coindesk", name: "CoinDesk", cat: "news", type: "feed", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", every: 2 },
  { id: "cointelegraph", name: "Cointelegraph", cat: "news", type: "feed", url: "https://cointelegraph.com/rss", every: 2 },
  { id: "theblock", name: "The Block", cat: "news", type: "feed", url: "https://www.theblock.co/rss.xml", every: 3 },
  { id: "decrypt", name: "Decrypt", cat: "news", type: "feed", url: "https://decrypt.co/feed", every: 3 },
  { id: "blockworks", name: "Blockworks", cat: "news", type: "feed", url: "https://blockworks.com/feed", every: 3 },
  { id: "cryptoslate", name: "CryptoSlate", cat: "news", type: "feed", url: "https://cryptoslate.com/feed/", every: 10 },
  { id: "btcmag", name: "Bitcoin Magazine", cat: "news", type: "feed", url: "https://bitcoinmagazine.com/.rss/full/", every: 3 },
  // Stock market news
  { id: "sa_cur", name: "Seeking Alpha", cat: "news", mkt: "stocks", type: "feed", url: "https://seekingalpha.com/market_currents.xml", every: 2 },
  { id: "cnbc", name: "CNBC", cat: "news", mkt: "stocks", type: "feed", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", every: 3 },
  { id: "mw", name: "MarketWatch", cat: "news", mkt: "stocks", type: "feed", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", every: 3 },
  { id: "benzinga", name: "Benzinga", cat: "news", mkt: "stocks", type: "feed", url: "https://www.benzinga.com/feed", every: 3 },
  { id: "nasdaq", name: "Nasdaq", cat: "news", mkt: "stocks", type: "feed", url: "https://www.nasdaq.com/feed/rssoutbound?category=Markets", every: 5 },
  { id: "fjuice", name: "FinancialJuice", cat: "rumor", mkt: "stocks", type: "tg", channel: "FinancialJuice", every: 1 },
];

const DEFAULT_SETTINGS = {
  watchlist: ["BTC", "ETH", "SOL", "XRP", "DOGE"],
  stocks: ["SPY", "NVDA", "TSLA", "AAPL", "COIN"],
  movePct: 3, // alert when a coin moves this % …
  moveMin: 15, // … within this many minutes
  whaleMinUsd: 25_000_000, // skip whale transfers smaller than this
  bells: true, // stock market open/close alerts
};

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36 PulseReader/1.0";
const DAY = 86_400_000;

// ------------------------------------------------------------- the worker --
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/" ) {
      return cors(json({ app: "Pulse", ok: true, hint: "Open the Pulse app and paste this address in." }));
    }
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      const r = await env.ASSETS.fetch(req);
      const out = new Response(r.body, r);
      out.headers.set("Cache-Control", "no-cache");
      return out;
    }
    const isPublic = url.pathname === "/api/health";
    if (!isPublic) {
      if (!env.APP_KEY) return cors(json({ error: "APP_KEY secret is not set on the server" }, 500));
      const key = req.headers.get("X-Key") || url.searchParams.get("key");
      if (key !== env.APP_KEY) return cors(json({ error: "wrong key" }, 401));
    }
    const res = await hub(env).fetch(req);
    return res.status === 101 ? res : cors(res);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(hub(env).fetch("https://hub/tick", { method: "POST" }));
  },
};

const hub = (env) => env.HUB.get(env.HUB.idFromName("main"));

// ------------------------------------------------------------ the hub DO --
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
    // The phone can send "ping" to check the line without waking the server.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items(
      id TEXT PRIMARY KEY, src TEXT, src_name TEXT, cat TEXT, title TEXT, summary TEXT,
      url TEXT, ts INTEGER, seen INTEGER, coins TEXT, mood TEXT, usd REAL, pct REAL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS items_seen ON items(seen)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS items_ts ON items(ts)`);
    try { this.sql.exec("ALTER TABLE items ADD COLUMN tkey TEXT"); } catch {}
    try { this.sql.exec("ALTER TABLE items ADD COLUMN mkt TEXT"); } catch {}

    this.sql.exec(`CREATE INDEX IF NOT EXISTS items_tkey ON items(tkey)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sources(
      id TEXT PRIMARY KEY, last_run INTEGER, last_ok INTEGER, last_err TEXT, err_at INTEGER,
      etag TEXT, lastmod TEXT, total INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS prices(ts INTEGER, sym TEXT, price REAL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS prices_sym ON prices(sym, ts)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS briefs(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, data TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS paper_pos(sym TEXT PRIMARY KEY, qty REAL, cost REAL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS paper_trades(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, sym TEXT, side TEXT, qty REAL, price REAL, usd REAL)`);
    for (const col of ["note TEXT", "p24 REAL", "p7 REAL"]) { try { this.sql.exec(`ALTER TABLE paper_trades ADD COLUMN ${col}`); } catch {} }
  }

  getKV(k, fallback = null) {
    const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray()[0];
    return r ? JSON.parse(r.v) : fallback;
  }
  setKV(k, v) {
    this.sql.exec("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, JSON.stringify(v));
  }
  settings() {
    return { ...DEFAULT_SETTINGS, ...this.getKV("settings", {}) };
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/ws" || p === "/api/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "hello", ts: Date.now(), settings: this.settings() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/tick") return json(await this.tick());
    if (p === "/api/tick" && req.method === "POST") return json(await this.tick(true));

    if (p === "/api/feed") {
      const since = Number(url.searchParams.get("since") || 0);
      const limit = Math.min(Number(url.searchParams.get("limit") || 150), 400);
      const cat = url.searchParams.get("cat");
      let q = "SELECT * FROM items WHERE seen > ?";
      const args = [since];
      if (cat) { q += " AND cat = ?"; args.push(cat); }
      q += since ? " ORDER BY seen ASC LIMIT ?" : " ORDER BY ts DESC LIMIT ?";
      args.push(limit);
      const items = this.sql.exec(q, ...args).toArray().map(rowToItem);
      return json({ now: Date.now(), items, settings: this.settings() });
    }

    if (p === "/api/settings") {
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const cur = this.settings();
        const next = { ...cur };
        if (Array.isArray(body.watchlist)) {
          next.watchlist = [...new Set(body.watchlist.map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean))].slice(0, 25);
        }
        if (Array.isArray(body.stocks)) {
          next.stocks = [...new Set(body.stocks.map((s) => String(s).toUpperCase().replace(/[^A-Z0-9.\-^]/g, "")).filter(Boolean))].slice(0, 20);
        }
        if (body.movePct != null) next.movePct = clamp(Number(body.movePct), 0.5, 50);
        if (body.moveMin != null) next.moveMin = clamp(Math.round(Number(body.moveMin)), 1, 240);
        if (body.bells != null) next.bells = !!body.bells;
        if (body.whaleMinUsd != null) next.whaleMinUsd = clamp(Number(body.whaleMinUsd), 0, 1e12);
        this.setKV("settings", next);
        this.broadcast({ type: "settings", settings: next });
        if (JSON.stringify(cur.stocks) !== JSON.stringify(next.stocks)) {
          this.ctx.waitUntil((async () => { for (let i = 0; i < 14; i++) await this.scanEarnings(i).catch(() => {}); })());
        }
        return json({ ok: true, settings: next });
      }
      return json(this.settings());
    }

    if (p === "/api/briefs") {
      const rows = this.sql.exec("SELECT id, ts, data FROM briefs ORDER BY id DESC LIMIT 12").toArray();
      return json({ briefs: rows.map((r) => ({ id: r.id, ts: r.ts, ...JSON.parse(r.data) })), next: nextBriefAt(Date.now()) });
    }
    if (p === "/api/briefs/new" && req.method === "POST") {
      const last = this.sql.exec("SELECT ts FROM briefs ORDER BY id DESC LIMIT 1").toArray()[0];
      if (last && Date.now() - last.ts < 10 * 60_000 && url.searchParams.get("force") !== "1") return json({ error: "A briefing was just made — try again in a few minutes" }, 429);
      try { return json({ ok: true, brief: await this.makeBrief() }); }
      catch (e) { return json({ error: "Briefing failed: " + (e.message || e) }, 500); }
    }

    if (p === "/api/tips") {
      return json({ lesson: this.getKV("lesson"), library: TIPS, earnings: this.upcomingEarnings(Date.now()), report: this.getKV("report") });
    }
    if (p === "/api/lesson/new" && req.method === "POST") {
      try { return json({ ok: true, lesson: await this.makeLesson(true) }); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (p === "/api/report/new" && req.method === "POST") {
      try { return json({ ok: true, report: await this.makeReport(Date.now(), true) }); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (p === "/api/earnings/scan" && req.method === "POST") {
      for (let i = 0; i < 14; i++) await this.scanEarnings(i).catch(() => {});
      return json({ earnings: this.upcomingEarnings(Date.now()) });
    }
    if (p === "/api/bells/test" && req.method === "POST") {
      const at = Date.parse(url.searchParams.get("at") || "") || Date.now();
      await this.marketBells(at, this.settings());
      await this.earningsAlerts(at, nyTime(at), this.settings());
      return json({ ok: true, items: this.sql.exec("SELECT title, summary FROM items WHERE src='bell' ORDER BY seen DESC LIMIT 4").toArray() });
    }
    if (p === "/api/quotes") {
      const syms = (url.searchParams.get("syms") || "").toUpperCase().split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
      return json({ quotes: await this.stockQuotes(syms, url.searchParams.get("spark") === "1") });
    }
    if (p === "/api/stocksearch") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ results: [] });
      const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`, { headers: { "User-Agent": UA } });
      const j = await r.json().catch(() => ({}));
      const results = (j.quotes || []).filter((x) => ["EQUITY", "ETF"].includes(x.quoteType) && /^[A-Z.\-]+$/.test(x.symbol) && !x.symbol.includes("."))
        .map((x) => ({ sym: x.symbol, name: x.shortname || x.longname || x.symbol, type: x.quoteType, exch: x.exchDisp }));
      return json({ results });
    }

    if (p === "/api/paper") return json(await this.paperState());
    if (p === "/api/paper/reset" && req.method === "POST") {
      this.sql.exec("DELETE FROM paper_pos"); this.sql.exec("DELETE FROM paper_trades"); this.setKV("snapshots", {});
      this.setKV("paperCash", 10000);
      return json(await this.paperState());
    }
    if (p === "/api/paper/trade" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      try { return json(await this.paperTrade(b)); }
      catch (e) { return json({ error: e.message || String(e) }, 400); }
    }

    if (p === "/api/health") {
      const rows = this.sql.exec("SELECT * FROM sources").toArray();
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      const count = this.sql.exec("SELECT COUNT(*) AS n FROM items").one().n;
      return json({
        ok: true,
        now: Date.now(),
        lastTick: this.getKV("lastTick"),
        items: count,
        listeners: this.ctx.getWebSockets().length,
        sources: SOURCES.map((s) => {
          const r = byId[s.id] || {};
          return {
            id: s.id, name: s.name, cat: s.cat,
            lastOk: r.last_ok || null, lastRun: r.last_run || null,
            error: r.err_at && (!r.last_ok || r.err_at > r.last_ok) ? r.last_err : null,
            total: r.total || 0,
          };
        }),
      });
    }
    return json({ error: "not found" }, 404);
  }

  // ---- WebSocket lifecycle (hibernation API: no cost while idle) ----
  webSocketMessage(ws, msg) {
    if (msg === "hello") ws.send(JSON.stringify({ type: "hello", ts: Date.now() }));
  }
  webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
  }
  webSocketError() {}

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  // ---- the minute-by-minute check ----
  async tick(force = false) {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const settings = this.settings();
    const states = Object.fromEntries(this.sql.exec("SELECT * FROM sources").toArray().map((r) => [r.id, r]));

    // Spread the work out: each source runs on its own beat, staggered by position.
    const due = SOURCES.filter((s, i) => force || (minute + i) % s.every === 0);

    const results = await Promise.allSettled([
      this.checkPrices(settings, now),
      ...due.map((s) => this.runSource(s, states[s.id], settings, now)),
    ]);

    const fresh = [];
    for (const r of results) if (r.status === "fulfilled" && Array.isArray(r.value)) fresh.push(...r.value);
    fresh.sort((a, b) => a.ts - b.ts);

    if (fresh.length) this.broadcast({ type: "items", items: fresh });
    // Heartbeat every minute keeps the phone's connection alive and lets it
    // know the line is still good.
    this.broadcast({ type: "hb", ts: now });

    // Stock market bells (opening/closing) with your stocks' moves
    if (settings.bells !== false) this.ctx.waitUntil(this.marketBells(now, settings).catch(() => {}));

    // Daily jobs (New York time)
    {
      const ny = nyTime(now);
      // earnings calendar: refresh one day of the next two weeks every 10 minutes
      if (new Date(now).getUTCMinutes() % 10 === 7) this.ctx.waitUntil(this.scanEarnings(this.nextScanIdx()).catch(() => {}));
      // earnings heads-ups at 6:00 PM (tomorrow) and 8:30 AM (today)
      if (settings.bells !== false) this.ctx.waitUntil(this.earningsAlerts(now, ny, settings).catch(() => {}));
      // score practice trades after 24h / 7 days (hourly)
      if (new Date(now).getUTCMinutes() === 13) this.ctx.waitUntil(this.scoreTrades(now).catch(() => {}));
      // nightly account snapshot for the weekly report
      if (ny.min === 23 * 60 + 50) this.ctx.waitUntil(this.snapshot(now, ny).catch(() => {}));
      // weekly report card: Sunday 6:00 PM
      if (ny.dow === "Sun" && ny.min === 18 * 60) this.ctx.waitUntil(this.makeReport(now).catch(() => {}));
      // today's lesson: 7:10 AM
      if (ny.min === 7 * 60 + 10 && this.getKV("lessonDate") !== ny.date) this.ctx.waitUntil(this.makeLesson().catch((e) => this.setKV("lessonError", String(e.message || e))));
    }

    // AI briefing at 6am, 12pm, 6pm and midnight Eastern-ish (every 6h UTC: 23,5,11,17)
    if (new Date(now).getUTCMinutes() === 3 && [5, 11, 17, 23].includes(new Date(now).getUTCHours())) {
      this.ctx.waitUntil(this.makeBrief().catch((e) => this.setKV("briefError", String(e.message || e))));
    }

    // Housekeeping once an hour
    if (minute % 60 === 0) {
      this.sql.exec("DELETE FROM items WHERE seen < ?", now - 7 * DAY);
      this.sql.exec("DELETE FROM prices WHERE ts < ?", now - 26 * 3_600_000);
      this.sql.exec("DELETE FROM briefs WHERE ts < ?", now - 14 * DAY);
    }
    this.setKV("lastTick", now);
    return { ok: true, checked: due.map((s) => s.id), fresh: fresh.length };
  }

  async runSource(src, state, settings, now) {
    const firstRun = !state || !state.last_ok;
    const headers = { "User-Agent": UA, Accept: "*/*" };
    if (state?.etag) headers["If-None-Match"] = state.etag;
    if (state?.lastmod) headers["If-Modified-Since"] = state.lastmod;

    let url = src.url;
    if (src.type === "tg") url = `https://t.me/s/${src.channel}`;
    if (src.type === "okx") url = "https://www.okx.com/api/v5/support/announcements";

    try {
      const res = await fetch(url, { headers, cf: { cacheTtl: 0 } });
      if (res.status === 304) { this.markOk(src.id, now, state?.etag, state?.lastmod, 0); return []; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();

      let raw;
      if (src.type === "tg") raw = parseTelegram(body, src.channel);
      else if (src.type === "okx") raw = parseOkx(body);
      else raw = parseFeed(body);

      if (!raw.length) throw new Error("no posts found");

      const out = [];
      for (const r of raw) {
        if (!r.title || !r.url) continue;
        const item = enrich(src, r, settings, now);
        if (!item) continue;
        const exists = this.sql.exec("SELECT 1 FROM items WHERE id=?", item.id).toArray().length;
        if (exists) continue;
        // Same headline from another outlet (e.g. Cointelegraph's channel + its website)? Skip it.
        const tkey = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
        if (tkey.length > 20 && this.sql.exec("SELECT 1 FROM items WHERE tkey=? AND seen > ?", tkey, now - 2 * DAY).toArray().length) continue;
        this.sql.exec(
          "INSERT INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct,tkey,mkt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url,
          item.ts, item.seen, item.coins.join(","), item.mood, item.usd ?? null, null, tkey, item.mkt || null
        );
        // Don't blast the phone with a source's whole back-catalog the first
        // time we see it, or with anything that's already old news.
        if (!firstRun && now - item.ts < 3 * 3_600_000) out.push(item);
      }
      this.markOk(src.id, now, res.headers.get("ETag"), res.headers.get("Last-Modified"), out.length);
      return out;
    } catch (e) {
      this.sql.exec(
        `INSERT INTO sources(id,last_run,last_err,err_at) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run, last_err=excluded.last_err, err_at=excluded.err_at`,
        src.id, now, String(e.message || e).slice(0, 200), now
      );
      return [];
    }
  }

  markOk(id, now, etag, lastmod, added) {
    this.sql.exec(
      `INSERT INTO sources(id,last_run,last_ok,etag,lastmod,total) VALUES(?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run, last_ok=excluded.last_ok,
         etag=excluded.etag, lastmod=excluded.lastmod, total=sources.total+excluded.total`,
      id, now, now, etag || null, lastmod || null, added
    );
  }


  // ---- AI news briefing (personalized: what each story means for YOUR positions) ----
  async makeBrief() {
    if (!this.env.AI) throw new Error("AI binding missing");
    const now = Date.now();
    const settings = this.settings();
    const watchCoins = settings.watchlist || [], watchStocks = settings.stocks || [];

    // Live Paper holdings (with current value)
    const paper = await this.paperState().catch(() => ({ positions: [], cash: 0 }));
    const held = {};
    for (const p of paper.positions) held[p.sym.replace(/^STK:/, "")] = { usd: p.worth, pnlPct: p.pnlPct, stock: p.sym.startsWith("STK:") };
    const mySyms = new Set([...watchCoins, ...watchStocks, ...Object.keys(held)]);

    const rows = this.sql.exec(
      "SELECT id, src_name, cat, title, url, coins, mood, usd, mkt, ts FROM items WHERE ts > ? AND cat NOT IN ('price','brief') ORDER BY ts DESC LIMIT 160",
      now - 6 * 3_600_000
    ).toArray();

    // Price moves for context
    const syms = [...new Set(["BTC", "ETH", ...watchCoins])].slice(0, 10);
    const moves = [];
    for (const sym of syms) {
      const cur = this.sql.exec("SELECT price FROM prices WHERE sym=? ORDER BY ts DESC LIMIT 1", sym).toArray()[0];
      const d1 = this.sql.exec("SELECT price FROM prices WHERE sym=? AND ts <= ? ORDER BY ts DESC LIMIT 1", sym, now - 24 * 3_600_000).toArray()[0]
        || this.sql.exec("SELECT price FROM prices WHERE sym=? ORDER BY ts ASC LIMIT 1", sym).toArray()[0];
      const h6 = this.sql.exec("SELECT price FROM prices WHERE sym=? AND ts <= ? ORDER BY ts DESC LIMIT 1", sym, now - 6 * 3_600_000).toArray()[0];
      if (cur) moves.push({ sym, price: cur.price, chg24: d1 ? ((cur.price - d1.price) / d1.price) * 100 : null, chg6: h6 ? ((cur.price - h6.price) / h6.price) * 100 : null });
    }
    const tone = { positive: rows.filter((r) => r.mood === "bull").length, negative: rows.filter((r) => r.mood === "bear").length, total: rows.length };

    // ---- Tag every story in code (deterministic): TRADEABLE if it touches your stuff ----
    // Drop near-duplicates: the same story from different outlets
    const STOP = new Set("the a an to of in on for and as is its it at by with from new just now after over into amid us".split(" "));
    const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
    const kept = [];
    const uniq = rows.filter((r) => {
      const w = words(r.title); if (!w.size) return false;
      for (const k of kept) { let inter = 0; for (const x of w) if (k.has(x)) inter++; if (inter / Math.min(w.size, k.size) >= 0.5) return false; }
      kept.push(w); return true;
    });
    const NAMES = {
      BTC: "bitcoin", ETH: "ethereum|\\bether\\b", SOL: "solana", XRP: "xrp|ripple", DOGE: "dogecoin", ADA: "cardano", BONK: "\\bbonk\\b", WIF: "dogwifhat", FLOKI: "\\bfloki\\b",
      PEPE: "\\bpepe\\b", SHIB: "shiba inu", LINK: "chainlink", AVAX: "avalanche", SUI: "\\bsui\\b", LTC: "litecoin", TRUMP: "\\$trump|trump coin|trump memecoin",
      NVDA: "nvidia", TSLA: "tesla", AAPL: "\\bapple\\b", COIN: "coinbase", SPY: "s&p 500|s&p500", QQQ: "nasdaq 100|nasdaq-100", MSFT: "microsoft", AMZN: "amazon",
      GOOGL: "google|alphabet", META: "\\bmeta\\b", AMD: "\\bamd\\b", PLTR: "palantir", MSTR: "microstrategy|saylor", HOOD: "robinhood", NFLX: "netflix", DELL: "\\bdell\\b", IBIT: "ishares bitcoin",
    };
    const touches = (r) => {
      // Match on the HEADLINE only (summaries mention coins in passing and cause false tags)
      const out = new Set();
      const low = r.title.toLowerCase();
      for (const sym of mySyms) {
        if (out.has(sym)) continue;
        if (sym.length >= 2 && new RegExp(`(^|[^A-Za-z0-9])\\$?${sym}([^A-Za-z0-9]|$)`).test(r.title)) out.add(sym);
        else if (NAMES[sym] && new RegExp(NAMES[sym]).test(low)) out.add(sym);
      }
      return [...out];
    };
    const describe = (sym) => {
      const h = held[sym];
      if (h) return `${sym} (you HOLD $${Math.round(h.usd).toLocaleString("en-US")} in Paper, ${h.pnlPct >= 0 ? "up" : "down"} ${Math.abs(h.pnlPct).toFixed(1)}%)`;
      return `${sym} (on your watchlist, you don't hold it)`;
    };
    const tradeable = uniq.filter((r) => touches(r).length).slice(0, 10);
    const background = uniq.filter((r) => !touches(r).length && r.cat !== "whale").slice(0, 14);

    const tList = tradeable.map((r, i) => `T${i + 1}. [${r.src_name}] ${r.title}\n    Touches: ${touches(r).map(describe).join("; ")}`).join("\n");
    const bList = background.map((r, i) => `B${i + 1}. [${r.src_name}] ${r.title}`).join("\n");
    const prices = moves.map((m) => `${m.sym}: $${m.price.toFixed(m.price < 1 ? 5 : 2)}${m.chg6 != null ? `, ${m.chg6.toFixed(1)}% over 6h` : ""}`).join("\n");
    const holdLine = Object.keys(held).length ? Object.entries(held).map(([s, h]) => `${s} $${Math.round(h.usd)}`).join(", ") : "nothing (all cash)";

    const system = `You are the news editor for Pulse, a crypto and stock news app. The reader is a beginner who practices with fake money in a "Paper" account.
For each story you write ONE "What it means for you" line in plain words (max 35 words).
Rules you must follow:
- For TRADEABLE stories (T#): name the coin/stock it touches and say whether the reader holds it in Paper (with the dollar amount given) or only watches it. Then say which way the story COULD push the price and WHY, e.g. "Strategy buying more BTC means a big buyer adding demand, which can push the price up; you hold $2,000 of BTC in Paper." Use "could" or "can" — never "will".
- If the effect on price is unclear or mixed, say so plainly ("Mixed for BTC: ... but ...") instead of forcing a direction. Don't claim a direction the headline doesn't support.
- Only mention the coins/stocks listed in that story's "Touches" line — don't bring up the reader's other holdings.
- For BACKGROUND stories (B#): start with "No direct impact on you —" then one short reason it is still news.
- If the story is about something the reader can't buy at all (only available in one country/region, institutions only, huge minimums like $5M, private deals), say that plainly, e.g. "You can't buy this — it's Hong Kong-only."
- If a T# story is really about such an off-limits product and only mentions the coin in passing (e.g. a Hong Kong-only bitcoin fund), mark it "tag":"background" and start its line with "You can't buy this —".
- NEVER tell the reader to buy, sell, hold, trade, enter or exit anything. NEVER give price targets. Explain the connection only.
- Only use facts from the headline and the position info given. Don't invent numbers.`;
    const user = `Reader's Paper holdings: ${holdLine}
Crypto watchlist: ${watchCoins.join(", ")}
Stock watchlist: ${watchStocks.join(", ")}
Prices now:
${prices || "(none)"}

TRADEABLE stories (touch the reader's coins/stocks):
${tList || "(none)"}

BACKGROUND stories (industry news):
${bList || "(none)"}

Return JSON with:
- headline: under 12 words, about what matters most for the reader's positions
- summary: 2 sentences naming the specific events that matter most for the reader's holdings (no generic filler like "prices could go up or down")
- tradeable: one entry per T# story: {"id":"T1","tag":"tradeable","impact":"..."} (tag "background" only for off-limits products, see rules)
- background: pick the 4 most important B# stories only: {"id":"B3","impact":"No direct impact on you — ..."}`;

    const schema = {
      type: "object",
      properties: {
        headline: { type: "string" }, summary: { type: "string" },
        tradeable: { type: "array", items: { type: "object", properties: { id: { type: "string" }, tag: { type: "string", enum: ["tradeable", "background"] }, impact: { type: "string" } }, required: ["id", "tag", "impact"] } },
        background: { type: "array", items: { type: "object", properties: { id: { type: "string" }, impact: { type: "string" } }, required: ["id", "impact"] } },
      },
      required: ["headline", "summary", "tradeable", "background"],
    };
    const res = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: 2200, temperature: 0.25,
    });
    let data = res?.response;
    if (typeof data === "string") { const m = data.match(/\{[\s\S]*\}/); data = JSON.parse(m ? m[0] : data); }
    if (!data || !data.headline) throw new Error("model returned nothing usable");

    // Safety net: drop any sentence that turns into trade advice.
    const advice = /\b(you should|we recommend|i recommend|consider (buying|selling|adding|trimming)|good time to (buy|sell)|(buy|sell) (now|the dip|more)|take profits?|price target|will (rise|fall|reach|hit|go up|go down|drop|climb))\b/i;
    const scrub = (t) => String(t || "").replace(/^\s*what it means for you\s*[:\-—]\s*/i, "").split(/(?<=[.!?])\s+/).filter((x) => !advice.test(x)).join(" ").trim();
    const byId = (list, prefix, arr) => Object.fromEntries((arr || []).map((x) => [String(x.id || "").toUpperCase(), scrub(x.impact)]).filter(([k, v]) => k.startsWith(prefix) && v));
    const tImp = byId(tradeable, "T", data.tradeable), bImp = byId(background, "B", data.background);
    const demoted = new Set((data.tradeable || []).filter((x) => x.tag === "background" && /can.?t buy|not available|institution|only available|-only/i.test(x.impact || "")).map((x) => String(x.id).toUpperCase()));
    // Second pass: anything the model skipped gets its own short request so every story has a real line.
    const missing = tradeable.map((r, i) => `T${i + 1}`).filter((id) => !tImp[id]);
    if (missing.length) {
      try {
        const mList = missing.map((id) => { const r = tradeable[Number(id.slice(1)) - 1]; return `${id}. [${r.src_name}] ${r.title}\n    Touches: ${touches(r).map(describe).join("; ")}`; }).join("\n");
        const res2 = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: [{ role: "system", content: system }, { role: "user", content: `Write the "What it means for you" line for EACH of these ${missing.length} stories. Every id must appear.\n\n${mList}\n\nReturn JSON: {"tradeable":[{"id":"T#","tag":"tradeable","impact":"..."}]}` }],
          response_format: { type: "json_schema", json_schema: { type: "object", properties: { tradeable: schema.properties.tradeable }, required: ["tradeable"] } },
          max_tokens: 1400, temperature: 0.2,
        });
        let d2 = res2?.response; if (typeof d2 === "string") { const m = d2.match(/\{[\s\S]*\}/); d2 = JSON.parse(m ? m[0] : d2); }
        Object.assign(tImp, byId(tradeable, "T", d2?.tradeable));
        for (const x of d2?.tradeable || []) if (x.tag === "background" && /can.?t buy|not available|institution|only available|-only/i.test(x.impact || "")) demoted.add(String(x.id).toUpperCase());
      } catch {}
    }

    const story = (r, tag, impact) => {
      const syms = touches(r);
      return {
        tag, title: r.title, src: r.src_name, url: r.url || "", ts: r.ts, mood: r.mood || "",
        touches: syms.map((sym) => ({ sym, held: !!held[sym], usd: held[sym] ? Math.round(held[sym].usd) : null, stock: watchStocks.includes(sym) || !!held[sym]?.stock })),
        impact,
      };
    };
    const stories = [], offLimits = [];
    tradeable.forEach((r, i) => {
      const imp = tImp[`T${i + 1}`];
      if (imp && demoted.has(`T${i + 1}`)) { offLimits.push(story(r, "background", imp)); return; }
      // Fallback line if the model skipped one — still about the reader's position, no direction claim.
      const fb = `Touches ${touches(r).map((s) => held[s] ? `${s}, which you hold ($${Math.round(held[s].usd).toLocaleString("en-US")} in Paper)` : `${s}, which you watch`).join(" and ")}.`;
      stories.push(story(r, "tradeable", imp || fb));
    });
    const bgStories = [];
    background.forEach((r, i) => { const imp = bImp[`B${i + 1}`]; if (imp) bgStories.push(story(r, "background", imp)); });

    const out = {
      v: 2,
      headline: scrub(data.headline) || "Market briefing",
      summary: scrub(data.summary),
      stories, bigPicture: [...offLimits, ...bgStories].slice(0, 5),
      holdings: Object.entries(held).map(([sym, h]) => ({ sym, usd: Math.round(h.usd), pnlPct: h.pnlPct })),
      account: { value: paper.value, pnl: paper.pnl, pnlPct: paper.pnlPct, cash: paper.cash },
      moves, tone, count: rows.length,
      // keep older app versions working
      sections: [
        ...(stories.length ? [{ title: "For your positions", bullets: stories.map((x) => `${x.title} — ${x.impact}`).slice(0, 5) }] : []),
        ...(bgStories.length || offLimits.length ? [{ title: "Big picture", bullets: [...offLimits, ...bgStories].slice(0, 5).map((x) => `${x.title} — ${x.impact}`) }] : []),
      ],
      coins: [],
    };

    this.sql.exec("INSERT INTO briefs(ts, data) VALUES(?, ?)", now, JSON.stringify(out));
    const id = this.sql.exec("SELECT last_insert_rowid() AS id").one().id;
    const brief = { id, ts: now, ...out };
    const item = { id: `brief:${id}`, src: "brief", srcName: "Pulse briefing", cat: "brief", title: out.headline, summary: out.summary, url: "", ts: now, seen: now, coins: [...new Set(stories.flatMap((x) => x.touches.map((t) => t.sym)))], mood: "", usd: null, pct: null };
    this.sql.exec("INSERT INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct,tkey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url, item.ts, item.seen, item.coins.join(","), "", null, null, null);
    this.broadcast({ type: "brief", brief });
    this.broadcast({ type: "items", items: [item] });
    return brief;
  }

  // ---- earnings calendar (Nasdaq) ----
  nextScanIdx() { const i = (this.getKV("earnIdx", 0) + 1) % 14; this.setKV("earnIdx", i); return i; }
  async scanEarnings(offset) {
    const d = new Date(Date.now() + offset * DAY);
    const ny = nyTime(d.getTime());
    if (ny.dow === "Sat" || ny.dow === "Sun") return;
    const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${ny.date}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!r.ok) return;
    const rows = (await r.json())?.data?.rows || [];
    const cal = this.getKV("earnCal", {});
    // drop old entries for this date, then add
    for (const [k, v] of Object.entries(cal)) if (v.date === ny.date || v.date < nyTime(Date.now()).date) delete cal[k];
    const mine = new Set(this.settings().stocks || []);
    for (const row of rows) {
      if (!row.symbol || !mine.has(row.symbol)) continue;
      cal[`${row.symbol}:${ny.date}`] = { sym: row.symbol, name: row.name, date: ny.date, time: row.time === "time-pre-market" ? "before the open" : row.time === "time-after-hours" ? "after the close" : "time not set", eps: row.epsForecast || "" };
    }
    this.setKV("earnCal", cal);
  }
  upcomingEarnings(now) {
    const stocks = new Set(this.settings().stocks || []);
    const today = nyTime(now).date;
    return Object.values(this.getKV("earnCal", {})).filter((e) => stocks.has(e.sym) && e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  }
  async earningsAlerts(now, ny, settings) {
    const slots = [{ key: "eve", at: 18 * 60, when: "tomorrow" }, { key: "morn", at: 8 * 60 + 30, when: "today" }];
    const sent = this.getKV("earnSent", {});
    for (const sl of slots) {
      if (ny.min < sl.at || ny.min > sl.at + 4) continue;
      const target = sl.when === "today" ? ny.date : nyTime(now + DAY).date;
      const list = this.upcomingEarnings(now).filter((e) => e.date === target);
      for (const e of list) {
        const id = `${e.sym}:${e.date}:${sl.key}`;
        if (sent[id]) continue;
        sent[id] = now;
        const item = { id: `earn:${id}`, src: "earn", srcName: "Earnings", cat: "price", mkt: "stocks",
          title: `📅 ${e.sym} reports earnings ${sl.when} ${e.time}`,
          summary: `${e.name}${e.eps ? ` · analysts expect ${e.eps} per share` : ""}. Stocks often jump or drop sharply right after earnings.`,
          url: `https://finance.yahoo.com/quote/${e.sym}`, ts: now, seen: now, coins: [e.sym], mood: "", usd: null, pct: null };
        this.sql.exec("INSERT OR IGNORE INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct,mkt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url, item.ts, item.seen, e.sym, "", null, null, "stocks");
        this.broadcast({ type: "items", items: [item] });
      }
    }
    for (const k of Object.keys(sent)) if (now - sent[k] > 10 * DAY) delete sent[k];
    this.setKV("earnSent", sent);
  }

  // ---- trade scorecard ----
  async scoreTrades(now) {
    const due = this.sql.exec("SELECT id, ts, sym FROM paper_trades WHERE (p24 IS NULL AND ts <= ?) OR (p7 IS NULL AND ts <= ?) LIMIT 60", now - DAY, now - 7 * DAY).toArray();
    if (!due.length) return;
    const prices = await this.spot([...new Set(due.map((t) => t.sym))]);
    for (const t of due) {
      const pr = prices[t.sym]; if (!pr) continue;
      if (t.ts <= now - DAY) this.sql.exec("UPDATE paper_trades SET p24 = COALESCE(p24, ?) WHERE id = ?", pr, t.id);
      if (t.ts <= now - 7 * DAY) this.sql.exec("UPDATE paper_trades SET p7 = COALESCE(p7, ?) WHERE id = ?", pr, t.id);
    }
  }

  // ---- weekly report card ----
  async snapshot(now, ny) {
    const st = await this.paperState();
    const spy = (await this.stockQuotes(["SPY"], false)).SPY?.price || null;
    const snaps = this.getKV("snapshots", {});
    snaps[ny.date] = { value: st.value, spy, ts: now };
    for (const k of Object.keys(snaps).sort().slice(0, -60)) delete snaps[k];
    this.setKV("snapshots", snaps);
  }
  // S&P 500 (SPY) price at a past moment, from Yahoo's hourly chart
  async spyAt(ts) {
    const cache = this.getKV("spyAt", {});
    const k = String(Math.floor(ts / 3_600_000));
    if (cache[k]) return cache[k];
    const p1 = Math.floor(ts / 1000) - 5 * 86400, p2 = Math.floor(Date.now() / 1000);
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${p1}&period2=${p2}&interval=1h`, { headers: { "User-Agent": UA } });
    const res = (await r.json().catch(() => null))?.chart?.result?.[0];
    if (!res) return null;
    const t = res.timestamp || [], c = res.indicators?.quote?.[0]?.close || [];
    let price = null;
    for (let i = 0; i < t.length; i++) { if (c[i] == null) continue; if (t[i] * 1000 <= ts) price = c[i]; else { if (price == null) price = c[i]; break; } }
    if (price) { cache[k] = price; this.setKV("spyAt", cache); }
    return price;
  }
  async makeReport(now, manual = false) {
    const st = await this.paperState();
    const spy = (await this.stockQuotes(["SPY"], false)).SPY?.price || null;
    const snaps = this.getKV("snapshots", {});
    const keys = Object.keys(snaps).sort();
    const weekAgo = nyTime(now - 7 * DAY).date;
    let baseKey = keys.filter((k) => k <= weekAgo).pop() || keys[0];
    let base = baseKey ? snaps[baseKey] : null;
    let sinceTs = base?.ts;
    // No usable snapshot yet: measure from when you started trading.
    if (!base || !base.spy) {
      const first = this.sql.exec("SELECT MIN(ts) AS t FROM paper_trades").one().t || now;
      base = { value: 10000, spy: await this.spyAt(first) };
      baseKey = null; sinceTs = first;
    }
    const you = base.value ? ((st.value - base.value) / base.value) * 100 : 0;
    const mkt = base.spy && spy ? ((spy - base.spy) / base.spy) * 100 : null;
    const trades = this.sql.exec("SELECT * FROM paper_trades WHERE ts > ?", now - 7 * DAY).toArray();
    const scored = this.sql.exec("SELECT side, price, p24 FROM paper_trades WHERE p24 IS NOT NULL AND ts > ?", now - 8 * DAY).toArray();
    const right = scored.filter((t) => (t.side === "buy" ? t.p24 > t.price : t.p24 < t.price)).length;
    const best = st.positions.length ? st.positions.reduce((a, b) => (b.pnlPct > a.pnlPct ? b : a)) : null;
    const worst = st.positions.length ? st.positions.reduce((a, b) => (b.pnlPct < a.pnlPct ? b : a)) : null;
    const beat = mkt == null ? null : you > mkt;
    const report = {
      ts: now, since: baseKey || "start", sinceTs, days: Math.max(0, (now - (sinceTs || now)) / DAY), value: st.value, you, mkt, beat, trades: trades.length,
      calls: scored.length, right,
      best: best ? { sym: best.sym.replace("STK:", ""), pct: best.pnlPct } : null,
      worst: worst ? { sym: worst.sym.replace("STK:", ""), pct: worst.pnlPct } : null,
    };
    this.setKV("report", report);
    const fmt = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`;
    const title = mkt == null ? `📊 Week report: your practice account ${fmt(you)}` : `📊 Week report: you ${fmt(you)} vs S&P 500 ${fmt(mkt)}`;
    const summary = `${beat == null ? "" : beat ? "You beat the market this week. " : "The market beat you this week — that's normal, most pros lose to it too. "}${trades.length} trade${trades.length === 1 ? "" : "s"}${scored.length ? `, ${right} of ${scored.length} calls right after 24h` : ""}.`;
    const item = { id: `report:${now}`, src: "report", srcName: "Report card", cat: "brief", title, summary, url: "", ts: now, seen: now, coins: [], mood: beat ? "bull" : beat === false ? "bear" : "", usd: null, pct: null };
    this.sql.exec("INSERT OR IGNORE INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url, item.ts, item.seen, "", item.mood, null, null);
    if (!manual) this.broadcast({ type: "items", items: [item] });
    return report;
  }

  // ---- today's lesson (AI, tied to real headlines) ----
  async makeLesson(manual = false) {
    if (!this.env.AI) throw new Error("AI binding missing");
    const now = Date.now(), ny = nyTime(now);
    const topics = ["why prices react to news", "earnings season", "market cap vs price", "risk and position size", "diversification and correlation", "how interest rates move markets", "reading a whale alert", "pre-market and overnight gaps", "the difference between a rumor and confirmed news", "ETFs and index funds", "volatility", "stablecoins", "chasing and FOMO", "how regulation news affects crypto", "sector moves (when one stock drags its peers)"];
    const topic = topics[(Math.floor(now / DAY) + (manual ? Math.floor(Math.random() * 7) : 0)) % topics.length];
    const heads = this.sql.exec("SELECT src_name, title FROM items WHERE ts > ? AND cat IN ('news','rumor','asia') ORDER BY ts DESC LIMIT 40", now - DAY).toArray()
      .map((r) => `- ${r.src_name}: ${r.title}`).join("\n").slice(0, 5000);
    const system = `You teach investing basics to a beginner who learns best from real examples. Write one short lesson on the given topic, using ONE real headline from the list as the example.
Rules: plain words, no jargon without explaining it. NEVER tell the reader to buy, sell or hold anything, never predict prices, never call something a good or bad investment. Teach the concept and what to watch for. Only use facts from the headline you pick.`;
    const schema = { type: "object", properties: { title: { type: "string" }, example: { type: "string" }, lesson: { type: "string" }, watch: { type: "string" }, practice: { type: "string" } }, required: ["title", "example", "lesson", "watch", "practice"] };
    const res = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "system", content: system }, { role: "user", content: `Topic: ${topic}\n\nToday's headlines:\n${heads || "(quiet day)"}\n\nReturn JSON: title (under 10 words), example (the headline you used, one sentence), lesson (3-4 sentences), watch (one sentence: what to keep an eye on), practice (one sentence: a no-risk way to try this in the Paper tab with fake money, without saying which way to bet).` }],
      response_format: { type: "json_schema", json_schema: schema }, max_tokens: 700, temperature: 0.4,
    });
    let d = res?.response; if (typeof d === "string") { const m = d.match(/\{[\s\S]*\}/); d = JSON.parse(m ? m[0] : d); }
    if (!d?.title) throw new Error("model returned nothing usable");
    const advice = /\b(you should (buy|sell)|we recommend|consider (buying|selling)|good time to (buy|sell)|(buy|sell) (now|the dip)|price target|will (rise|fall|reach|hit))\b/i;
    const scrub = (t) => String(t || "").split(/(?<=[.!?])\s+/).filter((x) => !advice.test(x)).join(" ");
    const lesson = { ts: now, date: ny.date, topic, title: scrub(d.title) || topic, example: scrub(d.example), lesson: scrub(d.lesson), watch: scrub(d.watch), practice: scrub(d.practice) };
    this.setKV("lesson", lesson); this.setKV("lessonDate", ny.date);
    if (!manual) {
      const item = { id: `lesson:${ny.date}`, src: "lesson", srcName: "Today's lesson", cat: "brief", title: `💡 ${lesson.title}`, summary: lesson.lesson, url: "", ts: now, seen: now, coins: [], mood: "", usd: null, pct: null };
      this.sql.exec("INSERT OR IGNORE INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url, item.ts, item.seen, "", "", null, null);
      this.broadcast({ type: "items", items: [item] });
    }
    return lesson;
  }

  // ---- market bells ----
  async marketBells(now, settings) {
    const ny = nyTime(now);
    const day = marketDay(ny);
    if (!day) return;
    const events = [
      { key: "pre15", at: day.open - 15, kind: "pre" },
      { key: "open", at: day.open, kind: "open" },
      { key: "close15", at: day.close - 15, kind: "warn" },
      { key: "close", at: day.close, kind: "close" },
    ];
    const sent = this.getKV("bells", {});
    for (const ev of events) {
      const id = `${ny.date}:${ev.key}`;
      if (sent[id] || ny.min < ev.at || ny.min > ev.at + 4) continue;
      sent[id] = now;
      const stocks = (settings.stocks || []).slice(0, 8);
      const qs = stocks.length ? await this.stockQuotes(stocks, false) : {};
      const moves = stocks.map((s) => qs[s]).filter((q) => q?.price && q.prev).map((q) => ({ sym: q.sym, pct: ((q.price - q.prev) / q.prev) * 100 }));
      const line = moves.map((m) => `${m.sym} ${m.pct >= 0 ? "+" : "−"}${Math.abs(m.pct).toFixed(1)}%`).join(" · ");
      const half = day.close < 960 ? " (early close today)" : "";
      const t = {
        pre: [`🔔 Stock market opens in 15 minutes${half}`, line ? `Pre-market: ${line}` : "Get ready — 9:30 AM ET open."],
        open: ["🔔 The stock market is open", line ? `Your stocks so far: ${line}` : "Regular trading has started."],
        warn: [`⏳ Stock market closes in 15 minutes`, line ? `Today so far: ${line}` : "Last call for today's session."],
        close: ["🔕 The stock market is closed", line ? `Today: ${line}. Crypto keeps trading 24/7.` : "See you tomorrow. Crypto keeps trading 24/7."],
      }[ev.kind];
      const best = moves.length ? moves.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a)) : null;
      const item = { id: `bell:${id}`, src: "bell", srcName: "Market bell", cat: "price", mkt: "stocks", title: t[0], summary: t[1], url: "", ts: now, seen: now, coins: moves.map((m) => m.sym), mood: "", usd: null, pct: null };
      this.sql.exec("INSERT OR IGNORE INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct,mkt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url, item.ts, item.seen, item.coins.join(","), "", null, null, "stocks");
      this.broadcast({ type: "items", items: [item] });
      void best;
    }
    // keep the log small
    for (const k of Object.keys(sent)) if (now - sent[k] > 3 * DAY) delete sent[k];
    this.setKV("bells", sent);
  }

  // ---- stocks (Yahoo Finance chart data; ~15 min delayed for some exchanges) ----
  async stockQuote(sym, spark) {
    this.qcache ??= new Map();
    const hit = this.qcache.get(sym);
    if (hit && Date.now() - hit.at < 20_000 && (!spark || hit.q.spark)) return hit.q;
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=true`, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    if (!res) return null;
    const m = res.meta;
    const closes = (res.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
    const now = Date.now() / 1000, reg = m.currentTradingPeriod?.regular;
    const state = reg && now >= reg.start && now < reg.end ? "open" : (m.currentTradingPeriod?.pre && now >= m.currentTradingPeriod.pre.start && now < m.currentTradingPeriod.pre.end) ? "pre" : (m.currentTradingPeriod?.post && now >= m.currentTradingPeriod.post.start && now < m.currentTradingPeriod.post.end) ? "after" : "closed";
    const price = closes.length && state !== "closed" ? closes[closes.length - 1] : m.regularMarketPrice;
    const q = { sym, name: m.shortName || m.longName || sym, price, prev: m.chartPreviousClose ?? m.previousClose, state, spark: spark ? closes.slice(-80) : undefined };
    this.qcache.set(sym, { at: Date.now(), q });
    return q;
  }
  async stockQuotes(syms, spark) {
    const out = {};
    await Promise.all(syms.map(async (s) => { try { const q = await this.stockQuote(s, spark); if (q) out[s] = q; } catch {} }));
    return out;
  }

  // ---- paper trading (fake money, real prices) ----
  async spot(syms) {
    const out = {};
    const stocks = syms.filter((s) => s.startsWith("STK:")), coins = syms.filter((s) => !s.startsWith("STK:"));
    if (coins.length) {
      const res = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD", { headers: { "User-Agent": UA } });
      const rates = (await res.json())?.data?.rates || {};
      for (const s of coins) { const r = Number(rates[s]); if (r) out[s] = 1 / r; }
    }
    if (stocks.length) {
      const q = await this.stockQuotes(stocks.map((s) => s.slice(4)), false);
      for (const s of stocks) if (q[s.slice(4)]?.price) out[s] = q[s.slice(4)].price;
    }
    return out;
  }
  async paperState() {
    const cash = this.getKV("paperCash", 10000);
    const pos = this.sql.exec("SELECT * FROM paper_pos WHERE qty > 0").toArray();
    const trades = this.sql.exec("SELECT * FROM paper_trades ORDER BY id DESC LIMIT 60").toArray();
    const prices = pos.length ? await this.spot(pos.map((p) => p.sym)) : {};
    let value = cash;
    const positions = pos.map((p) => {
      const price = prices[p.sym] ?? p.cost / p.qty;
      const worth = p.qty * price;
      value += worth;
      return { sym: p.sym, qty: p.qty, cost: p.cost, price, worth, pnl: worth - p.cost, pnlPct: ((worth - p.cost) / p.cost) * 100 };
    }).sort((a, b) => b.worth - a.worth);
    const sells = trades.filter((t) => t.side === "sell").length;
    return { start: 10000, cash, value, pnl: value - 10000, pnlPct: ((value - 10000) / 10000) * 100, positions, trades, tradeCount: this.sql.exec("SELECT COUNT(*) AS n FROM paper_trades").one().n, sells };
  }
  async paperTrade({ sym, side, usd, all, note }) {
    sym = String(sym || "").toUpperCase().replace(/[^A-Z0-9:.\-]/g, "");
    if (!sym) throw new Error("Pick a coin");
    if (side !== "buy" && side !== "sell") throw new Error("Pick buy or sell");
    const price = (await this.spot([sym]))[sym];
    if (!price) throw new Error(`No live price for ${sym}`);
    let cash = this.getKV("paperCash", 10000);
    const pos = this.sql.exec("SELECT * FROM paper_pos WHERE sym=?", sym).toArray()[0] || { sym, qty: 0, cost: 0 };
    let qty, amount;
    if (side === "buy") {
      amount = all ? cash : Number(usd);
      if (!(amount > 0)) throw new Error("Enter an amount");
      if (amount > cash + 0.005) throw new Error(`You only have $${cash.toFixed(2)} cash`);
      amount = Math.min(amount, cash);
      qty = amount / price;
      cash -= amount;
      pos.qty += qty; pos.cost += amount;
    } else {
      if (!(pos.qty > 0)) throw new Error(`You don't own any ${sym}`);
      qty = all ? pos.qty : Math.min(pos.qty, Number(usd) / price);
      if (!(qty > 0)) throw new Error("Enter an amount");
      if (!all && Number(usd) / price > pos.qty * 1.0001) throw new Error(`You only have $${(pos.qty * price).toFixed(2)} of ${sym}`);
      amount = qty * price;
      const costPart = pos.cost * (qty / pos.qty);
      pos.qty -= qty; pos.cost -= costPart;
      if (pos.qty < 1e-12) { pos.qty = 0; pos.cost = 0; }
      cash += amount;
    }
    this.setKV("paperCash", cash);
    this.sql.exec("INSERT INTO paper_pos(sym, qty, cost) VALUES(?,?,?) ON CONFLICT(sym) DO UPDATE SET qty=excluded.qty, cost=excluded.cost", sym, pos.qty, pos.cost);
    this.sql.exec("INSERT INTO paper_trades(ts, sym, side, qty, price, usd, note) VALUES(?,?,?,?,?,?,?)", Date.now(), sym, side, qty, price, amount, note ? String(note).slice(0, 280) : null);
    return { ok: true, fill: { sym, side, qty, price, usd: amount }, state: await this.paperState() };
  }

  // ---- price moves ----
  async checkPrices(settings, now) {
    const res = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD", { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const rates = (await res.json())?.data?.rates || {};
    const alerts = [];
    const lastAlerts = this.getKV("lastAlerts", {});
    for (const sym of settings.watchlist) {
      const rate = Number(rates[sym]);
      if (!rate) continue;
      const price = 1 / rate;
      this.sql.exec("INSERT INTO prices(ts,sym,price) VALUES(?,?,?)", now, sym, price);
      const past = this.sql.exec(
        "SELECT price, ts FROM prices WHERE sym=? AND ts <= ? ORDER BY ts DESC LIMIT 1",
        sym, now - settings.moveMin * 60_000
      ).toArray()[0];
      if (!past) continue;
      const pct = ((price - past.price) / past.price) * 100;
      if (Math.abs(pct) < settings.movePct) continue;
      const last = lastAlerts[sym];
      const dir = pct > 0 ? "up" : "down";
      // One alert per coin per 30 min, unless it flips direction.
      if (last && now - last.ts < 30 * 60_000 && last.dir === dir) continue;
      lastAlerts[sym] = { ts: now, dir };
      const item = {
        id: `price:${sym}:${now}`, src: "price", srcName: "Price alert", cat: "price",
        title: `${sym} ${pct > 0 ? "▲ up" : "▼ down"} ${Math.abs(pct).toFixed(1)}% in ${settings.moveMin} min`,
        summary: `Now ${fmtUsd(price)} (was ${fmtUsd(past.price)})`,
        url: `https://www.coinbase.com/price/${sym.toLowerCase()}`,
        ts: now, seen: now, coins: [sym], mood: pct > 0 ? "bull" : "bear", usd: price, pct,
      };
      this.sql.exec(
        "INSERT INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url,
        item.ts, item.seen, sym, item.mood, price, pct
      );
      alerts.push(item);
    }
    // Stocks: only while the US market is open
    const stocks = settings.stocks || [];
    if (stocks.length && usMarketOpen(now)) {
      const qs = await this.stockQuotes(stocks, false);
      for (const sym of stocks) {
        const q = qs[sym]; if (!q?.price || q.state !== "open") continue;
        const key = "STK:" + sym;
        this.sql.exec("INSERT INTO prices(ts,sym,price) VALUES(?,?,?)", now, key, q.price);
        const past = this.sql.exec("SELECT price FROM prices WHERE sym=? AND ts <= ? ORDER BY ts DESC LIMIT 1", key, now - settings.moveMin * 60_000).toArray()[0];
        if (!past) continue;
        const pct = ((q.price - past.price) / past.price) * 100;
        if (Math.abs(pct) < settings.movePct) continue;
        const last = lastAlerts[key], dir = pct > 0 ? "up" : "down";
        if (last && now - last.ts < 30 * 60_000 && last.dir === dir) continue;
        lastAlerts[key] = { ts: now, dir };
        const item = {
          id: `price:${key}:${now}`, src: "price", srcName: "Price alert", cat: "price", mkt: "stocks",
          title: `${sym} ${pct > 0 ? "▲ up" : "▼ down"} ${Math.abs(pct).toFixed(1)}% in ${settings.moveMin} min`,
          summary: `Now ${fmtUsd(q.price)} (was ${fmtUsd(past.price)})`,
          url: `https://finance.yahoo.com/quote/${sym}`, ts: now, seen: now, coins: [sym], mood: pct > 0 ? "bull" : "bear", usd: q.price, pct,
        };
        this.sql.exec("INSERT INTO items(id,src,src_name,cat,title,summary,url,ts,seen,coins,mood,usd,pct,mkt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          item.id, item.src, item.srcName, item.cat, item.title, item.summary, item.url, item.ts, item.seen, sym, item.mood, q.price, pct, "stocks");
        alerts.push(item);
      }
    }
    this.setKV("lastAlerts", lastAlerts);
    return alerts;
  }
}

// --------------------------------------------------------------- parsing --
export function parseFeed(xml) {
  // Newest posts are at the top — only parse the first chunk to stay fast.
  const head = xml.slice(0, 120_000);
  let blocks = head.match(/<item[\s>][\s\S]*?<\/item>/g);
  if (!blocks) blocks = head.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  return blocks.slice(0, 30).map((b) => {
    let link = tag(b, "link");
    if (!link || !/^https?:/.test(link)) link = (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || tag(b, "guid");
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    const summary = tag(b, "description") || tag(b, "summary") || tag(b, "content");
    return { title: tag(b, "title"), url: decode(link || ""), ts: Date.parse(date) || Date.now(), summary, key: tag(b, "guid") || link };
  });
}

export function parseTelegram(html, channel) {
  // Newest posts are at the bottom of the page.
  const tail = html.slice(-160_000);
  const parts = tail.split('class="tgme_widget_message_wrap').slice(1);
  const out = [];
  for (const p of parts) {
    const post = (p.match(/data-post="([^"]+)"/) || [])[1];
    if (!post) continue;
    const m = p.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!m) continue;
    const text = clean(m[1].replace(/<br\s*\/?>/gi, "\n"));
    if (!text) continue;
    const lines = text.split("\n").map((l) => l.trim())
      .filter((l) => l && !/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(l) && !/^(📰\s*)?https?:\/\/\S+(\s+@\w+)?$/.test(l) && !/^@\w+$/.test(l) && l !== "Details");
    if (!lines.length) continue;
    const time = (p.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
    out.push({
      title: lines[0].replace(/^(?:[\p{Extended_Pictographic}\uFE0F\u200D]\s*){2,}/u, "").slice(0, 220),
      summary: lines.slice(1).join(" ").slice(0, 400),
      url: `https://t.me/${post}`,
      ts: Date.parse(time) || Date.now(),
      key: post,
      raw: text,
    });
  }
  return out;
}

export function parseOkx(body) {
  const j = JSON.parse(body);
  const details = j?.data?.[0]?.details || [];
  return details.slice(0, 20).map((d) => ({ title: d.title, url: d.url, ts: Number(d.pTime) || Date.now(), summary: d.annType ? `OKX announcement · ${d.annType.replace(/announcements-/, "").replace(/-/g, " ")}` : "OKX announcement", key: d.url }));
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  return m ? clean(m[1]) : "";
}

function clean(s) {
  let t = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  if (/&lt;\/?[a-z]/i.test(t)) t = decode(t); // feeds that escape their HTML
  return decode(t.replace(/<[^>]+>/g, " "))
    .replace(/submitted by\s+\/u\/\S+.*$/is, "")
    .replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
}

function decode(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

// --------------------------------------------------------------- enrich --
const COINS = {
  BTC: ["bitcoin", "btc"], ETH: ["ethereum", "eth", "ether"], SOL: ["solana", "sol"], XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin", "doge"], ADA: ["cardano", "ada"], BNB: ["bnb"], AVAX: ["avalanche", "avax"],
  LINK: ["chainlink"], DOT: ["polkadot"], LTC: ["litecoin", "ltc"], SHIB: ["shiba inu", "shib"],
  PEPE: ["pepe"], SUI: ["sui"], TRX: ["tron", "trx"], TON: ["toncoin"], USDT: ["tether", "usdt"],
  USDC: ["usdc"], HYPE: ["hyperliquid"], XLM: ["stellar", "xlm"], HBAR: ["hedera", "hbar"],
};
const BULL = /\b(surge|soar|rall(y|ies)|jump|spike|record high|all-time high|ath|approv|adopt|buys?|bought|inflows?|breakout|pump|bullish|partnership|launch(es|ed)?|lists?|listing|gains?)\b/i;
const BEAR = /\b(crash|plunge|tumble|drop|dump|slump|sink|hack(ed)?|exploit|stolen|drain|ban|lawsuit|sues?|charged|fraud|outflows?|liquidat|bearish|delist|halt|pauses?|bankrupt|insolven|selloff|sell-off|exposure|breach)\b/i;

export function enrich(src, r, settings, now) {
  const text = `${r.title} ${r.summary || ""} ${r.raw || ""}`;
  let usd = null;
  if (src.cat === "whale") {
    const m = text.match(/\(([\d,]+(?:\.\d+)?)\s*USD\)/i);
    usd = m ? Number(m[1].replace(/,/g, "")) : null;
    if (!usd || usd < settings.whaleMinUsd) return null;
  }
  const coins = new Set();
  const lower = ` ${text.toLowerCase()} `;
  for (const [sym, names] of Object.entries(COINS)) {
    if (names.some((n) => new RegExp(`[^a-z0-9]${n.replace(/ /g, "\\s")}[^a-z0-9]`).test(lower))) coins.add(sym);
  }
  for (const m of text.matchAll(/[$#]([A-Z][A-Z0-9]{1,9})\b/g)) coins.add(m[1]);
  for (const sym of settings.watchlist) if (new RegExp(`\\b${sym}\\b`).test(text)) coins.add(sym);
  for (const sym of settings.stocks || []) if (new RegExp(`(\\$|\\b)${sym}\\b`).test(text) && sym.length > 1) coins.add(sym);

  const titleSum = `${r.title} ${r.summary || ""}`;
  const bull = BULL.test(titleSum), bear = BEAR.test(titleSum);
  const mood = bull && !bear ? "bull" : bear && !bull ? "bear" : "";

  return {
    // Whale Alert sometimes posts the same transfer twice — dedupe on the text.
    id: `${src.id}:${hash(src.cat === "whale" ? r.title : r.key || r.url)}`,
    src: src.id, srcName: src.name, cat: src.cat,
    title: r.title.slice(0, 300),
    summary: (r.summary || "").replace(/\s+/g, " ").slice(0, 400),
    url: r.url,
    ts: Math.min(r.ts, now),
    seen: now,
    coins: [...coins].slice(0, 6),
    mood, usd, mkt: src.mkt || "",
  };
}

function rowToItem(r) {
  return {
    id: r.id, src: r.src, srcName: r.src_name, cat: r.cat, title: r.title, summary: r.summary,
    url: r.url, ts: r.ts, seen: r.seen, coins: r.coins ? r.coins.split(",") : [], mood: r.mood || "",
    usd: r.usd, pct: r.pct, mkt: r.mkt || "",
  };
}

// ---------------------------------------------------------------- utils --
// NYSE/Nasdaq holidays and 1pm early closes (2026–2027)
const MARKET_HOLIDAYS = new Set(["2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]);
const EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
function nyTime(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const hour = Number(parts.hour) % 24;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: hour * 60 + Number(parts.minute), dow: parts.weekday };
}
function marketDay(ny) {
  if (ny.dow === "Sat" || ny.dow === "Sun" || MARKET_HOLIDAYS.has(ny.date)) return null;
  return { open: 570, close: EARLY_CLOSE.has(ny.date) ? 780 : 960 };
}
function usMarketOpen(now) {
  const ny = nyTime(now), day = marketDay(ny);
  return !!day && ny.min >= day.open && ny.min < day.close;
}
function nextBriefAt(now) {
  const d = new Date(now);
  for (let i = 0; i < 30; i++) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + i, 3));
    if (t.getTime() > now && [5, 11, 17, 23].includes(t.getUTCHours())) return t.getTime();
  }
  return null;
}
function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
const clamp = (n, a, b) => (Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : a);
const fmtUsd = (n) => "$" + (n >= 100 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
function cors(res) {
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Headers", "X-Key, Content-Type");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return r;
}
