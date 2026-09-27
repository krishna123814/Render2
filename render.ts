// render.ts — ORDER-BOOK-ONLY WebSocket proxy (Render2, alag Render account/IP par deploy)
//
// PURPOSE: Isme SIRF ek kaam hai — BTC option order-book (Market Depth) ka
// live WebSocket relay. Kuch aur nahi (na mark/trade/spot snapshot feeds,
// na REST-forward, na trade/order placement) — jaanbujhkar minimal rakha
// hai, kyunki is deployment ka ek-matra role sirf depth WS hai, baaki sab
// (option-chain snapshot, REST forward, trade module) purane engine
// (main.ts) se hi chalta rahega.
//
// Client: wss://<is-service-ka-URL>/ws/depth?symbol=BTC-260926-84000-C
//
// Andar kya hota hai (Binance ka official local-order-book algorithm):
//   1. Client connect hote hi is symbol ke liye Binance eoptions diff-depth
//      WS stream (nbstream.binance.com) khulta hai (on-demand, per-symbol).
//   2. Saath hi ek REST snapshot (/eapi/v1/depth) liya jaata hai — sirf
//      order-book bootstrap ke liye zaroori, koi doosra REST use nahi hai.
//   3. Snapshot + diff events merge karke accurate book (bids/asks) memory
//      mein maintain hoti hai.
//   4. Connected browsers ko har DEPTH_PUSH_MS mein ek baar top-N rows
//      push hoti hain (bandwidth-saver — upstream book real-time hai,
//      push throttled hai).
//   5. Jab last client hat jaaye, DEPTH_IDLE_STOP_MS baad upstream feed
//      khud band ho jaati hai (memory/Binance-load free).
//
// Env vars (sab optional):
//   PORT   (Render khud deta hai)

// ── Config ────────────────────────────────────────────────────────────────
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const EAPI = "https://eapi.binance.com";

const nowMs = () => Date.now();

// ── Binance ban/rate-limit tracking (dashboard ke liye — main.ts jaisa) ────
// Is service ka Binance ko ek hi REST call hai: depth-snapshot bootstrap
// (loadSnapshot() neeche). Wahi call agar 429 (rate-limit) ya 418 (IP ban)
// khaaye, to yahan capture hota hai — taaki dashboard (/ ya /health) par
// saaf dikhe "Binance ban/limit-cross ho raha hai", jaisa main.ts karta hai.
interface LimitEvent {
  captured_at_ms: number;
  endpoint: string;
  status: number;
  retry_after_sec: number | null;
  binance_code: number | null;
  binance_msg: string | null;
}
let bnIpBanned = false;
let bnIpBanSince = 0;
let lastLimitEvent: LimitEvent | null = null;

// 429/418 milte hi: (a) ban-flag set/clear, (b) exact error (code/msg/
// retry-after) capture karta hai lastLimitEvent mein — dashboard isi ko
// padhta hai.
function noteBnLimitEvent(endpoint: string, resp: Response, bodyText: string): void {
  const ra = parseInt(resp.headers.get("retry-after") ?? "", 10);
  const retryAfterSec = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 1800) : null;

  let binanceCode: number | null = null;
  let binanceMsg: string | null = null;
  try {
    const j = JSON.parse(bodyText);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      if (Number.isFinite(Number(j.code))) binanceCode = Number(j.code);
      if (typeof j.msg === "string") binanceMsg = j.msg.slice(0, 300);
    }
  } catch { /* body JSON nahi tha — koi baat nahi, status/headers to mil gaye */ }

  lastLimitEvent = {
    captured_at_ms: nowMs(), endpoint, status: resp.status,
    retry_after_sec: retryAfterSec, binance_code: binanceCode, binance_msg: binanceMsg,
  };

  if (resp.status === 418) {
    if (!bnIpBanned) { bnIpBanned = true; bnIpBanSince = nowMs(); }
  }
  console.log(
    `[limit-event] ${endpoint} HTTP ${resp.status} — code:${binanceCode} msg:"${binanceMsg}" ` +
    `retry-after:${retryAfterSec ?? "n/a"}s`,
  );
}
function noteBnOk(): void {
  bnIpBanned = false;   // koi bhi successful Binance call ban-flag clear kar sakti hai
}
function lastLimitEventReport(): (LimitEvent & { age_ms: number }) | null {
  if (!lastLimitEvent) return null;
  return { ...lastLimitEvent, age_ms: nowMs() - lastLimitEvent.captured_at_ms };
}

// ── Depth order-book relay (per-symbol, snapshot+diff, 3s throttle push) ──
interface DepthRow { price: number; volume: number; ord: number }
const DEPTH_PUSH_MS = 3000;          // browser ko push karne ka interval (bandwidth-saver)
const DEPTH_IDLE_STOP_MS = 15_000;   // itni der koi client na ho to upstream feed band
const DEPTH_LEVELS = 10;             // top-N levels har side (bids/asks)

function depthApplySide(map: Map<string, number>, rows: [string, string][] | undefined) {
  for (const row of rows || []) {
    const price = String(parseFloat(row[0]));
    const qty = parseFloat(row[1]);
    if (!qty) map.delete(price); else map.set(price, qty);
  }
}

class DepthBook {
  clients = new Set<WebSocket>();
  ws: WebSocket | null = null;
  bidsMap = new Map<string, number>();
  asksMap = new Map<string, number>();
  lastU: number | null = null;
  snapshotId = 0;
  // deno-lint-ignore no-explicit-any
  buffer: any[] = [];
  snapshotReady = false;
  connecting = false;
  // deno-lint-ignore no-explicit-any
  pushTimer: any = null;
  // deno-lint-ignore no-explicit-any
  idleTimer: any = null;
  // deno-lint-ignore no-explicit-any
  retryTimer: any = null;
  failCount = 0;
  lastUpdateTs = 0;
  status: "idle" | "connecting" | "live" | "error" = "idle";
  lastError: string | null = null;
  // (NAYA) pinned=true wale book ko kabhi idle-stop nahi hota — boot-time
  // ATM auto-pin (neeche dekho) isi flag se apna book "always on" rakhta
  // hai, chahe koi browser client connect ho ya na ho.
  pinned = false;

  // (NAYA — REST-poll fallback) Jab WS gateway (nbstream.binance.com) is
  // network/region se hi unreachable ho (raw-probe confirmed: 404/1006,
  // docs-verified sahi path ke baavjood — yeh WS-gateway-level ya geo-
  // routing block hai, code ka bug nahi), to har retry par WS hang hote
  // rehna client ko hamesha "error/no data" dikhata rehta hai jabki REST
  // (eapi.binance.com) reliably kaam kar raha hai. FAIL_THRESHOLD_FOR_REST
  // consecutive WS fails ke baad hum REST polling shuru kar dete hain taaki
  // client ko kam se kam (thoda stale, ~REST_POLL_MS purana) order-book data
  // milta rahe. WS reconnect background mein alag/dheeme cadence par chalta
  // rehta hai — agar wo kabhi succeed ho jaaye (onopen fire ho), REST-poll
  // turant band ho jaata hai aur live WS le leta hai.
  usingRestPoll = false;
  // deno-lint-ignore no-explicit-any
  restPollTimer: any = null;
  source: "ws" | "rest-poll" = "ws";

  // (PORTED from main.ts, 2026-09-27) Exact root-cause diagnostics. Purpose:
  // har failure ko do buckets mein clearly separate karna —
  //  (A) network/IP-level block: nbstream.binance.com se TCP/TLS handshake
  //      hi complete nahi ho raha (onopen kabhi fire nahi hota)
  //  (B) stream-level drop: handshake ho gaya tha (onopen fire hua), phir
  //      baad mein close hua — yeh alag problem hai (rate-limit/idle-timeout/
  //      symbol issue), network block nahi.
  // REST (eapi.binance.com) alag domain hai isliye uska apna success/fail
  // track karte hain — agar REST OK hai par WS fail, to yeh confirm karta hai
  // ki block specifically WS gateway (nbstream) ke liye hai.
  restOk: boolean | null = null;         // null = abhi test nahi hua
  restLastError: string | null = null;
  restLastOkTs = 0;
  wsOpenedThisAttempt = false;           // is attempt mein onopen fire hua?
  everConnectedOk = false;               // process life mein kabhi bhi onopen fire hua?
  connectStartTs = 0;
  openedAtTs = 0;
  lastCloseCode: number | null = null;
  lastCloseReason = "";
  lastCloseWasClean: boolean | null = null;
  lastErrorEventInfo: string | null = null;
  // deno-lint-ignore no-explicit-any
  hsTimeoutTimer: any = null;

  // (NAYA 2026-09-27 — WS RE-ENABLED) Root-cause nikla: "@depth1000" koi
  // valid Binance Options stream-name hi nahi hai (docs-verified) — isliye
  // hamesha 404 aata tha, kisi IP-block ki wajah se nahi. Sahi documented
  // diff-depth stream-names do hain: "@depth@100ms" aur "@depth@500ms".
  // Dono try karte hain (alternate karke, har handshake-fail ke baad agla),
  // taaki pata chale Binance is symbol ke liye kaunsa accept karta hai.
  streamVariants: string[] = ["@depth@100ms", "@depth@500ms"];
  streamVariantIdx = 0;
  activeStreamVariant: string | null = null;   // is attempt mein try ho raha hai
  workingStreamVariant: string | null = null;  // jo variant se onopen fire hua tha

  constructor(public symbol: string) {}

  addClient(ws: WebSocket) {
    this.clients.add(ws);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!this.connecting && !this.usingRestPoll) this.start();
    if (!this.pushTimer) this.pushTimer = setInterval(() => this.pushToClients(), DEPTH_PUSH_MS);
  }
  removeClient(ws: WebSocket) {
    this.clients.delete(ws);
    if (this.clients.size === 0 && !this.pinned && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.stop(), DEPTH_IDLE_STOP_MS);
    }
  }
  start() {
    // (2026-09-27 — WS RE-ENABLED) Pehle "@depth1000" (invalid stream-name)
    // ki wajah se hamesha 404 aata tha, isliye WS permanently disable karke
    // sirf REST-poll rakha gaya tha. Ab sahi stream-names try karte hain.
    // REST-poll turant bhi start karte hain (parallel safety-net) — jab tak
    // WS handshake successful nahi hota, client ko REST se data milta rahega;
    // WS khulte hi (onopen) REST-poll khud band ho jaata hai (dekho connectUpstream).
    this.connecting = false;
    this.status = "connecting";
    this.startRestPoll();
    this.connectUpstream();
  }
  stop() {
    if (this.pushTimer) { clearInterval(this.pushTimer); this.pushTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.hsTimeoutTimer) { clearTimeout(this.hsTimeoutTimer); this.hsTimeoutTimer = null; }
    if (this.restPollTimer) { clearInterval(this.restPollTimer); this.restPollTimer = null; }
    this.usingRestPoll = false;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.connecting = false;
    this.status = "idle";
    this.snapshotReady = false;
    this.bidsMap.clear(); this.asksMap.clear();
    this.lastU = null; this.buffer = [];
    depthBooks.delete(this.symbol);
  }
  async loadSnapshot() {
    try {
      const r = await fetch(
        `${EAPI}/eapi/v1/depth?symbol=${encodeURIComponent(this.symbol)}&limit=20`,
        { signal: AbortSignal.timeout(8000) },
      );
      const bodyText = await r.text();
      if (r.status === 429 || r.status === 418) noteBnLimitEvent("/eapi/v1/depth", r, bodyText);
      else if (r.ok) noteBnOk();
      // deno-lint-ignore no-explicit-any
      let d: any = null;
      try { d = JSON.parse(bodyText); } catch { /* ignore parse fail below */ }
      if (!r.ok || !d || (!d.bids && !d.asks)) {
        this.restOk = false;
        this.restLastError = r.status === 418
          ? `Binance IP-ban (418)`
          : r.status === 429
          ? `Binance rate-limit (429)`
          : `Snapshot fail — HTTP ${r.status}`;
        this.lastError = r.status === 418
          ? `Binance IP-ban (418) — order-book paused, auto-retry hoga`
          : r.status === 429
          ? `Binance rate-limit (429) — order-book paused, auto-retry hoga`
          : `Snapshot fail — HTTP ${r.status}`;
        this.status = "error";
        this.retryTimer = setTimeout(() => this.loadSnapshot().then(() => this.connectUpstream()), 3000);
        return;
      }
      this.restOk = true;
      this.restLastError = null;
      this.restLastOkTs = nowMs();
      this.bidsMap = new Map(); this.asksMap = new Map();
      depthApplySide(this.bidsMap, d.bids);
      depthApplySide(this.asksMap, d.asks);
      this.snapshotId = d.lastUpdateId || 0;
      this.lastU = null;
      const buffered = this.buffer; this.buffer = [];
      this.snapshotReady = true;
      this.lastUpdateTs = nowMs();
      for (const ev of buffered) this.applyEvent(ev);
    } catch (e) {
      this.restOk = false;
      this.restLastError = `Snapshot error: ${e}`;
      this.lastError = `Snapshot error: ${e}`;
      this.status = "error";
      this.retryTimer = setTimeout(() => this.loadSnapshot().then(() => this.connectUpstream()), 3000);
    }
  }
  connectUpstream() {
    this.connecting = false;
    this.connectStartTs = nowMs();
    this.wsOpenedThisAttempt = false;
    let ws: WebSocket;
    // Do valid stream-names mein se ek is attempt ke liye try karte hain.
    const variant = this.streamVariants[this.streamVariantIdx % this.streamVariants.length];
    this.activeStreamVariant = variant;
    try {
      // (FIX 2026-09-27) "@depth1000" invalid tha (docs mein exist hi nahi
      // karta, isliye 404 aata tha). Sahi diff-depth stream-name:
      // "<symbol>@depth@100ms" ya "<symbol>@depth@500ms" — dono U/u/pu
      // wale format mein hote hain, isi class ke applyEvent() se match.
      ws = new WebSocket(`wss://nbstream.binance.com/eoptions/ws/${this.symbol}${variant}`);
    } catch (e) {
      this.lastError = `Upstream WS connect threw (constructor level, DNS/URL issue ho sakta hai): ${e}`;
      this.status = "error";
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    // (PORTED from main.ts) Handshake timeout. Agar 8 second mein onopen
    // nahi aaya, socket TCP/TLS level par hi atka hai — yeh application-level
    // reject nahi hai, isliye is case ko alag se pehchanna zaroori hai
    // (network/firewall/IP-block ka sabse strong signal).
    if (this.hsTimeoutTimer) { clearTimeout(this.hsTimeoutTimer); this.hsTimeoutTimer = null; }
    this.hsTimeoutTimer = setTimeout(() => {
      if (this.ws !== ws || this.wsOpenedThisAttempt) return;
      this.status = "error";
      this.lastError =
        `[HANDSHAKE-HANG] nbstream.binance.com se 8s mein bhi TCP/TLS connect complete nahi hua (onopen kabhi nahi aaya). ` +
        `REST (eapi.binance.com) status: ${
          this.restOk === true
            ? "OK — " + Math.round((nowMs() - this.restLastOkTs) / 1000) + "s pehle kaam kiya"
            : this.restOk === false
            ? "yeh bhi FAIL — " + this.restLastError
            : "abhi test nahi hua"
        }. ` +
        (this.restOk === true
          ? "→ Diagnosis: REST (eapi.binance.com) chal raha hai lekin WS gateway (nbstream.binance.com) ka connect hang ho raha hai — yeh WS-specific block/firewall hai, general Render→Binance network issue nahi."
          : "→ Diagnosis: REST bhi fail hai, isliye yeh general Render→Binance egress/network issue lagta hai, sirf WS ka nahi.") +
        ` Retry ho raha hai…`;
      try { ws.close(); } catch { /* ignore */ }
    }, 8000);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsOpenedThisAttempt = true;
      this.everConnectedOk = true;
      this.workingStreamVariant = this.activeStreamVariant;
      this.openedAtTs = nowMs();
      if (this.hsTimeoutTimer) { clearTimeout(this.hsTimeoutTimer); this.hsTimeoutTimer = null; }
      this.status = "live";
      this.source = "ws";
      this.lastError = null;
      this.lastErrorEventInfo = null;
      this.failCount = 0;
      this.stopRestPoll();
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      // deno-lint-ignore no-explicit-any
      let ev: any;
      try { ev = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      const d = ev && ev.data ? ev.data : ev;
      if (!d || d.u == null) return;
      if (!this.snapshotReady) { this.buffer.push(d); return; }
      this.applyEvent(d);
    };
    ws.onerror = (e: Event) => {
      // deno-lint-ignore no-explicit-any
      const ee = e as any;
      this.lastErrorEventInfo = (ee && ee.message) ? String(ee.message) : `event type: ${e.type || "unknown"}`;
      try { ws.close(); } catch { /* ignore */ }
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      if (this.hsTimeoutTimer) { clearTimeout(this.hsTimeoutTimer); this.hsTimeoutTimer = null; }
      this.ws = null;
      this.status = "error";
      this.lastCloseCode = ev.code;
      this.lastCloseReason = ev.reason || "";
      this.lastCloseWasClean = ev.wasClean;

      const restNote = this.restOk === true
        ? "REST (eapi.binance.com) OK hai"
        : this.restOk === false
        ? "REST bhi fail — " + this.restLastError
        : "REST abhi test nahi hua";

      if (!this.wsOpenedThisAttempt) {
        // Handshake kabhi complete hi nahi hua — agli baar doosra stream-
        // name variant try karo (ho sakta hai is symbol/tier ke liye 100ms
        // allowed na ho par 500ms ho, ya vice-versa).
        this.streamVariantIdx++;
        // Handshake kabhi complete hi nahi hua (onopen fire hi nahi hua) —
        // yeh network/IP-block ka strong signal hai, kyunki ev.code = 0 ka
        // matlab hai koi application-level close-frame nahi mila, TCP-level
        // hi reset/refuse/drop hua.
        const ms = nowMs() - this.connectStartTs;
        this.lastError =
          `[HANDSHAKE-FAIL] Upstream WS band ho gaya BEFORE onopen — ${ms}ms mein hi close (code ${ev.code}` +
          (ev.reason ? `, reason: ${ev.reason}` : ", server ne koi reason nahi bheja") +
          `, wasClean: ${ev.wasClean}). ${restNote}. ` +
          (this.restOk === true
            ? "→ Diagnosis: REST kaam kar raha hai par WS handshake reject/drop ho raha hai — yeh confirm karta hai ki block specifically nbstream.binance.com (WS gateway) ke liye hai, Binance ki taraf se ho sakta hai (cloud/datacenter IP block) ya Render ka outbound WS firewall."
            : "→ Diagnosis: REST bhi fail ho raha hai — general network/egress block lagta hai, sirf WS ka nahi.") +
          (this.lastErrorEventInfo ? ` onerror detail: ${this.lastErrorEventInfo}.` : "") +
          ` Retry ho raha hai…`;
      } else {
        // Connect successful hua tha (onopen fire hua), phir baad mein drop
        // hua — yeh ALAG problem hai: network block nahi (connection ek baar
        // ban chuka tha), balki stream-level issue (idle timeout, rate-limit,
        // ya Binance ne stream reset kiya).
        const secOpen = this.openedAtTs ? Math.round((nowMs() - this.openedAtTs) / 1000) : null;
        this.lastError =
          `[STREAM-DROP] Upstream WS successfully connect hua tha, phir ${secOpen != null ? secOpen + "s baad" : ""} band ho gaya ` +
          `(code ${ev.code}${ev.reason ? `, reason: ${ev.reason}` : ""}, wasClean: ${ev.wasClean}). ` +
          `→ Diagnosis: yeh network/IP block NAHI hai (handshake pehle successful ho chuka tha) — likely idle-timeout, Binance-side stream reset, ya rate-limit hai. Retry ho raha hai…`;
      }
      this.scheduleRetry();
    };
  }
  // deno-lint-ignore no-explicit-any
  applyEvent(ev: any) {
    if (this.lastU == null) {
      if (ev.u < this.snapshotId + 1) return;                 // purana, ignore
      if (ev.U > this.snapshotId + 1) {
        // Gap — khud REST se resync kar leta hai.
        this.snapshotReady = false;
        this.loadSnapshot();
        return;
      }
    } else if (ev.u <= this.lastU) {
      return;                                                  // purana/duplicate
    } else if (ev.U > this.lastU + 1) {
      this.snapshotReady = false;
      this.loadSnapshot();
      return;
    }
    depthApplySide(this.bidsMap, ev.b);
    depthApplySide(this.asksMap, ev.a);
    this.lastU = ev.u;
    this.lastUpdateTs = nowMs();
  }
  scheduleRetry() {
    this.failCount++;
    // (2026-09-27 — WS RE-ENABLED) REST-poll safety-net ke saath WS retry —
    // agar REST-poll kisi wajah se ruk gaya ho (jaise pehle band kar diya
    // gaya tha), use wapas start karo taaki WS retry ke dauraan bhi data
    // aata rahe. Exponential backoff (cap 15s) se WS dobara try karte hain.
    if (!this.usingRestPoll) this.startRestPoll();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const delay = Math.min(500 * Math.pow(1.6, Math.min(this.failCount, 10)), 15000);
    this.retryTimer = setTimeout(() => this.connectUpstream(), delay);
  }
  // REST se seedha depth snapshot poll karke bidsMap/asksMap replace karta
  // hai (diff-merge nahi — har poll ek fresh full snapshot hai, isliye
  // gap/resync ka koi risk nahi). Har 1s mein 1 baar — WS PERMANENTLY
  // DISABLED (user request), yehi ek-matra data-path hai.
  startRestPoll() {
    this.usingRestPoll = true;
    this.source = "rest-poll";
    const REST_POLL_MS = 1000;
    const poll = async () => {
      try {
        const r = await fetch(
          `${EAPI}/eapi/v1/depth?symbol=${encodeURIComponent(this.symbol)}&limit=20`,
          { signal: AbortSignal.timeout(6000) },
        );
        const bodyText = await r.text();
        if (r.status === 429 || r.status === 418) noteBnLimitEvent("/eapi/v1/depth (poll)", r, bodyText);
        else if (r.ok) noteBnOk();
        // deno-lint-ignore no-explicit-any
        let d: any = null;
        try { d = JSON.parse(bodyText); } catch { /* ignore */ }
        if (r.ok && d && (d.bids || d.asks)) {
          this.bidsMap = new Map(); this.asksMap = new Map();
          depthApplySide(this.bidsMap, d.bids);
          depthApplySide(this.asksMap, d.asks);
          this.restOk = true;
          this.restLastError = null;
          this.restLastOkTs = nowMs();
          this.lastUpdateTs = nowMs();
          this.status = "live";
          this.lastError =
            `[REST-POLL] WS disabled hai (user request) — har ${REST_POLL_MS}ms mein REST se depth-snapshot aa raha hai.`;
        } else {
          this.restOk = false;
          this.restLastError = `Poll fail — HTTP ${r.status}`;
          this.status = "error";
          this.lastError = `[REST-POLL] Poll fail — HTTP ${r.status}: ${this.restLastError}`;
        }
      } catch (e) {
        this.restOk = false;
        this.restLastError = `Poll error: ${e}`;
        this.status = "error";
        this.lastError = `[REST-POLL] Poll error: ${e}`;
      }
    };
    poll(); // turant ek baar
    this.restPollTimer = setInterval(poll, REST_POLL_MS);
  }
  stopRestPoll() {
    if (this.restPollTimer) { clearInterval(this.restPollTimer); this.restPollTimer = null; }
    this.usingRestPoll = false;
  }
  topRows(map: Map<string, number>, desc: boolean): DepthRow[] {
    const arr: DepthRow[] = [];
    map.forEach((qty, price) => arr.push({ price: parseFloat(price), volume: qty, ord: 0 }));
    arr.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
    return arr.slice(0, DEPTH_LEVELS);
  }
  pushToClients() {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({
      symbol: this.symbol,
      bids: this.topRows(this.bidsMap, true),
      asks: this.topRows(this.asksMap, false),
      status: this.status,
      source: this.source,  // "ws" (real-time) ya "rest-poll" (fallback, ~4s stale)
      // Frontend dropdown ke liye — status "error" ho to error text bhi
      // saath bhejte hain (jaise "Binance IP-ban (418)..."), taaki app-side
      // Order Book dropdown me exact wajah dikhe, sirf "live" na dikhe.
      error: this.status === "error" ? this.lastError : null,
      ip_banned: bnIpBanned,
      // (PORTED from main.ts) Structured diagnosis fields — chart.html iski
      // wajah se ab ek chhota "Render ↔ Binance diagnosis" box dikha sakta
      // hai, sirf ek lambi error-string parse kiye bina.
      diag: {
        rest_ok: this.restOk,
        rest_last_error: this.restLastError,
        ws_ever_opened: this.everConnectedOk,
        last_close_code: this.lastCloseCode,
        last_close_reason: this.lastCloseReason,
        last_close_clean: this.lastCloseWasClean,
        fail_count: this.failCount,
        stream_variant_tried: this.activeStreamVariant,
        stream_variant_working: this.workingStreamVariant,
      },
      ts: nowMs(),
    });
    for (const c of this.clients) {
      try { c.send(payload); } catch { /* client gone — onclose cleans up */ }
    }
  }
}

const depthBooks = new Map<string, DepthBook>();
function getOrCreateDepthBook(symbol: string): DepthBook {
  let b = depthBooks.get(symbol);
  if (!b) { b = new DepthBook(symbol); depthBooks.set(symbol, b); }
  return b;
}

// ── Boot-time ATM auto-pin (testing/debug convenience) ─────────────────────
// PURPOSE: App khole/test kiye bina bhi is proxy ka WS khud check ho sake —
// boot par REST se current ATM strike (nearest expiry, spot ke sabse
// paas wala CALL strike) nikaal ke uska DepthBook "pinned" mark kar dete
// hain, taaki koi bhi browser client connect na ho tab bhi uska upstream
// WS chalta rahe. `/health` (ya `/`) khol ke seedha status/diag dekh sakte
// ho — koi app/browser step chahiye hi nahi.
// Agar koi real browser client isi symbol ke liye connect kare, to wahi
// ek shared book use hoga (extra WS nahi khulega) — normal client-tracking
// (clients.size) alag se chalti rehti hai, sirf idle-stop is book par
// kabhi nahi lagta (dekho DepthBook.pinned).
const PIN_ATM_ON_BOOT = (Deno.env.get("PIN_ATM_ON_BOOT") ?? "true").toLowerCase() !== "false";
const PIN_REFRESH_MS = 5 * 60 * 1000; // itni der mein dobara check — expiry roll-over / naya ATM shift

let pinnedSymbol: string | null = null;
let pinnedBook: DepthBook | null = null;
let pinPickError: string | null = null;
let pinLastPickTs = 0;
let pinLastPickSpot: number | null = null;
let pinLastPickExpiry: string | null = null;

// deno-lint-ignore no-explicit-any
async function pickAtmCallSymbol(): Promise<{ symbol: string; spot: number; expiry: string } | null> {
  try {
    const infoResp = await fetch(`${EAPI}/eapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(8000) });
    const infoBodyText = await infoResp.text();
    // (FIX 2026-09-27) Pehle yahan noteBnLimitEvent/noteBnOk kabhi call nahi
    // hota tha — isliye top-level "ip_banned" flag sirf depth-poll calls se
    // update hota tha, exchangeInfo/index se nahi. Isse confusing dikhta
    // tha: "ip_banned:false" jabki pick_error mein "HTTP 418" saaf dikh
    // raha ho. Ab yahan bhi wahi shared tracking use karte hain taaki
    // "ip_banned" hamesha SACH reflect kare, chahe ban kisi bhi endpoint
    // (depth-poll, exchangeInfo, ya index) ki call se lagा ho.
    if (infoResp.status === 429 || infoResp.status === 418) noteBnLimitEvent("/eapi/v1/exchangeInfo", infoResp, infoBodyText);
    else if (infoResp.ok) noteBnOk();
    if (!infoResp.ok) { pinPickError = `exchangeInfo HTTP ${infoResp.status}`; return null; }
    // deno-lint-ignore no-explicit-any
    let info: any = null;
    try { info = JSON.parse(infoBodyText); } catch { pinPickError = "exchangeInfo response JSON parse fail"; return null; }
    // deno-lint-ignore no-explicit-any
    const btcCalls: any[] = (info.optionSymbols || []).filter(
      // deno-lint-ignore no-explicit-any
      (s: any) => s.underlying === "BTCUSDT" && s.side === "CALL",
    );
    if (!btcCalls.length) { pinPickError = "Koi BTCUSDT CALL option symbol nahi mila (exchangeInfo response)"; return null; }

    const nowT = nowMs();
    const futureExpiries = [...new Set(btcCalls.map((s) => Number(s.expiryDate)))]
      .filter((e) => e > nowT)
      .sort((a, b) => a - b);
    if (!futureExpiries.length) { pinPickError = "Koi future (non-expired) expiry nahi mila"; return null; }
    const nearestExpiry = futureExpiries[0];

    const idxResp = await fetch(`${EAPI}/eapi/v1/index?underlying=BTCUSDT`, { signal: AbortSignal.timeout(8000) });
    const idxBodyText = await idxResp.text();
    if (idxResp.status === 429 || idxResp.status === 418) noteBnLimitEvent("/eapi/v1/index", idxResp, idxBodyText);
    else if (idxResp.ok) noteBnOk();
    if (!idxResp.ok) { pinPickError = `index price HTTP ${idxResp.status}`; return null; }
    // deno-lint-ignore no-explicit-any
    let idxData: any = null;
    try { idxData = JSON.parse(idxBodyText); } catch { pinPickError = "index response JSON parse fail"; return null; }
    const spot = parseFloat(idxData.indexPrice);
    if (!Number.isFinite(spot)) { pinPickError = "index price parse fail — response mein indexPrice missing/invalid"; return null; }

    const candidates = btcCalls.filter((s) => Number(s.expiryDate) === nearestExpiry);
    // Spot ke sabse paas wala ek hi strike (ATM) — sorted by |strike - spot|.
    // deno-lint-ignore no-explicit-any
    const sorted = [...candidates].sort(
      (a: any, b: any) => Math.abs(parseFloat(a.strikePrice) - spot) - Math.abs(parseFloat(b.strikePrice) - spot),
    );
    const best = sorted[0];
    pinPickError = null;
    return {
      symbol: best.symbol,
      spot,
      expiry: new Date(nearestExpiry).toISOString(),
    };
  } catch (e) {
    pinPickError = `pick error: ${e}`;
    return null;
  }
}

async function ensurePinnedAtm() {
  const picked = await pickAtmCallSymbol();
  pinLastPickTs = nowMs();
  if (!picked) return;
  pinLastPickSpot = picked.spot;
  pinLastPickExpiry = picked.expiry;

  // ── Symbol (ATM, spot ke sabse paas) ─────────────────────────────────
  if (!(pinnedSymbol === picked.symbol && pinnedBook && depthBooks.get(pinnedSymbol) === pinnedBook)) {
    // Symbol badal gaya (naya ATM strike ya expiry roll-over) — purane book
    // ko un-pin karo (agar koi real client use kar raha ho to wo apni normal
    // idle-lifecycle se chalta rahega, warna khud idle-stop ho jaayega).
    if (pinnedBook) pinnedBook.pinned = false;
    pinnedSymbol = picked.symbol;
    pinnedBook = getOrCreateDepthBook(picked.symbol);
    pinnedBook.pinned = true;
    if (!pinnedBook.connecting && !pinnedBook.usingRestPoll) pinnedBook.start();
    console.log(`[atm-pin] symbol=${picked.symbol} spot=${picked.spot} expiry=${picked.expiry}`);
  }
}

if (PIN_ATM_ON_BOOT) {
  ensurePinnedAtm();
  setInterval(ensurePinnedAtm, PIN_REFRESH_MS);
}

// ── RAW WS-handshake diagnostic (manual TLS socket, NO Deno WebSocket API) ──
// PURPOSE: Deno/browser ka built-in `WebSocket` API jab upgrade reject hoti
// hai (400 jaisa), to sirf "Invalid status code 400" deta hai — Binance ka
// ASLI response (status line, headers, body — jisme koi explanation ho
// sakta hai) kabhi expose nahi karta (browsers/runtimes security ke liye
// isse strip kar dete hain). Ye function raw TCP+TLS socket khol ke khud
// HTTP upgrade request likhta hai aur raw response bytes padhta hai — taaki
// Binance jo bhi bhej raha ho (chahe koi body ho ya na ho), hum wo dekh
// sakein. Ye SIRF diagnostic ke liye hai — normal depth-flow (DepthBook)
// isse bilkul alag hai aur touch nahi hota.
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
async function rawWsHandshakeProbe(path: string): Promise<{
  ok: boolean;
  status_line: string | null;
  headers: string[];
  body_snippet: string | null;
  error: string | null;
  ms: number;
}> {
  const t0 = nowMs();
  let conn: Deno.TlsConn | null = null;
  try {
    conn = await Deno.connectTls({ hostname: "nbstream.binance.com", port: 443 });

    // RFC 6455: Sec-WebSocket-Key 16 random raw bytes, base64-encoded.
    const keyBytes = new Uint8Array(16);
    crypto.getRandomValues(keyBytes);
    let keyBin = "";
    for (const b of keyBytes) keyBin += String.fromCharCode(b);
    const wsKey = btoa(keyBin);

    const req =
      `GET ${path} HTTP/1.1\r\n` +
      `Host: nbstream.binance.com\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${wsKey}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `User-Agent: render-depth-diag/1.0\r\n` +
      `\r\n`;
    await conn.write(new TextEncoder().encode(req));

    // Response ke header-block (\r\n\r\n tak) padho, max ~5s ya ~4KB jo pehle aaye.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const deadline = nowMs() + 5000;
    while (total < 4096 && nowMs() < deadline) {
      const buf = new Uint8Array(1024);
      const remaining = Math.max(200, deadline - nowMs());
      const n = await Promise.race([
        conn.read(buf),
        new Promise<null>((res) => setTimeout(() => res(null), remaining)),
      ]);
      if (n === null || n === 0) break;
      chunks.push(buf.subarray(0, n));
      total += n;
      const soFar = new TextDecoder().decode(concatChunks(chunks));
      if (soFar.includes("\r\n\r\n")) break;
    }

    const text = new TextDecoder().decode(concatChunks(chunks));
    const [headerBlock, ...rest] = text.split("\r\n\r\n");
    const lines = headerBlock.split("\r\n");
    return {
      ok: true,
      status_line: lines[0] || null,
      headers: lines.slice(1),
      body_snippet: rest.join("\r\n\r\n").slice(0, 500) || null,
      error: null,
      ms: nowMs() - t0,
    };
  } catch (e) {
    return { ok: false, status_line: null, headers: [], body_snippet: null, error: String(e), ms: nowMs() - t0 };
  } finally {
    try { conn?.close(); } catch { /* ignore */ }
  }
}

// ── HTTP entrypoint ──────────────────────────────────────────────────────
async function handleHttp(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      const t = nowMs();
      return new Response(JSON.stringify({
        ok: true,
        mode: "orderbook-ws-only",
        // Binance ban/rate-limit cross ho raha hai to yahan turant dikhega.
        ip_banned: bnIpBanned,
        ip_ban_age_ms: bnIpBanned ? (t - bnIpBanSince) : null,
        last_limit_event: lastLimitEventReport(),
        // (NAYA) Boot-time ATM auto-pin ka status — app khole bina hi test
        // karne ke liye. Agar pin_error set hai, ATM-pick fail ho raha hai
        // (exchangeInfo/index REST issue) — WS connect ka issue nahi.
        atm_pin: {
          enabled: PIN_ATM_ON_BOOT,
          symbol: pinnedSymbol,
          spot: pinLastPickSpot,
          expiry: pinLastPickExpiry,
          last_pick_age_ms: pinLastPickTs ? (t - pinLastPickTs) : null,
          pick_error: pinPickError,
        },
        depth_books: [...depthBooks.entries()].map(([sym, b]) => ({
          symbol: sym,
          status: b.status,
          clients: b.clients.size,
          pinned: b.pinned,
          age_ms: b.lastUpdateTs ? t - b.lastUpdateTs : null,
          last_error: b.lastError,
          // (PORTED from main.ts) exact diagnosis — REST vs WS, handshake
          // ever complete hua ya nahi, aakhri close ka code/reason.
          diag: {
            rest_ok: b.restOk,
            rest_last_error: b.restLastError,
            ws_ever_opened: b.everConnectedOk,
            last_close_code: b.lastCloseCode,
            last_close_reason: b.lastCloseReason,
            last_close_clean: b.lastCloseWasClean,
            fail_count: b.failCount,
            source: b.source,
            using_rest_poll_fallback: b.usingRestPoll,
            // (NAYA) Yehi batayega "kaun sa kaam kar raha hai" — agar
            // stream_variant_working set hai, WS us variant se live hai;
            // null ho to abhi tak sirf REST-poll hi chal raha hai.
            stream_variant_tried: b.activeStreamVariant,
            stream_variant_working: b.workingStreamVariant,
          },
        })),
      }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    if (url.pathname === "/ws/depth") {
      const symbol = url.searchParams.get("symbol");
      if (!symbol) return new Response("symbol query param required", { status: 400 });
      if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return new Response("Expected websocket upgrade", { status: 400 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const book = getOrCreateDepthBook(symbol);
      socket.onopen = () => book.addClient(socket);
      socket.onclose = () => book.removeClient(socket);
      socket.onerror = () => book.removeClient(socket);
      return response;
    }

    // (NAYA) Raw handshake diagnostic — Binance ke 400 response ka ASLI
    // status-line/headers/body dikhata hai (jo normal WebSocket API kabhi
    // nahi deta). 4 tests ek saath: (A) bilkul bare connection, koi stream
    // nahi — sabse isolated test; (B) non-symbol stream (underlyingAsset
    // @markPrice) — depth se alag category; (C)/(D) asli symbol ke dono
    // valid depth stream-name variants (@depth@100ms, @depth@500ms) —
    // (query ?symbol= ya current ATM-pinned symbol). GET (browser se bhi
    // khol sakte ho seedha).
    if (url.pathname === "/diag/ws-raw") {
      const symbol = url.searchParams.get("symbol") || pinnedSymbol || "BTC-260928-85000-C";
      const [bare, underlying, depth100, depth500] = await Promise.all([
        rawWsHandshakeProbe("/eoptions/ws"),
        rawWsHandshakeProbe("/eoptions/ws/BTCUSDT@markPrice"),
        rawWsHandshakeProbe(`/eoptions/ws/${symbol}@depth@100ms`),
        rawWsHandshakeProbe(`/eoptions/ws/${symbol}@depth@500ms`),
      ]);
      return new Response(
        JSON.stringify(
          {
            ok: true,
            tested_at: new Date().toISOString(),
            tested_symbol: symbol,
            results: {
              bare_ws_no_stream: bare,
              underlying_markprice: underlying,
              depth_100ms_symbol: depth100,
              depth_500ms_symbol: depth500,
            },
          },
          null,
          2,
        ),
        { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }

    return new Response("Not found — /ws/depth?symbol=... use karo", { status: 404 });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Proxy failed: ${err}` }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

Deno.serve({ port: PORT }, handleHttp);
