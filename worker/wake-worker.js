/**
 * wake-velyx Worker — Telegram webhook → GitHub Actions wake dispatch
 * + PHASE 5 leader/heartbeat/state endpoints (KV-backed).
 *
 * Deploy on Cloudflare Workers (free tier: 100k req/day, 1k KV writes/day —
 * heartbeat every 5 min = ~288 writes/day, Local poller every 2 min = ~720
 * reads/day, both far under the free limits).
 *
 * Secrets (register in the CF dashboard):
 *   TELEGRAM_BOT_TOKEN      — bot token (same one the Hermes gateway uses)
 *   TELEGRAM_WEBHOOK_SECRET — secret_token passed to setWebhook (on_stop.sh)
 *   WAKE_DISPATCH_TOKEN     — GitHub PAT with "Actions: Write" on
 *                             rodorin-lab/wake-velyx (repository_dispatch)
 *   WAKE_ENDPOINT_SECRET    — shared secret for the PHASE 5 endpoints
 *                             (X-Wake-Secret header; held by Studio, Gentoo
 *                             Local Velyx, and kenyuu for manual curl)
 * Binding (dashboard → wake-velyx → Settings → Bindings):
 *   WAKE_KV                 — KV namespace holding leader/heartbeat state
 * Optional vars (Settings → Variables):
 *   ALLOWED_USER_IDS        — comma-separated Telegram user IDs (webhook path).
 *                             Defaults to the studio owner.
 *   STALE_MINUTES           — heartbeat staleness threshold (default 15)
 *   SILENCE_HOURS           — sleep-silence takeover threshold (default 24)
 *
 * Endpoints:
 *   GET  /            → liveness ("wake-velyx worker alive")
 *   POST /            → Telegram webhook (X-Telegram-Bot-Api-Secret-Token)
 *                       — BEHAVIOR UNCHANGED from the pre-PHASE 5 worker
 *   GET  /leader      → leader + full status (X-Wake-Secret) — Local poller reads this
 *   POST /heartbeat   → Studio: awake + leading (X-Wake-Secret)
 *   POST /sleep       → Studio on_stop: going to sleep (X-Wake-Secret)
 *   POST /wake        → dispatch GitHub Actions wake (X-Wake-Secret) — Local / manual
 *   POST /switch      → {"to":"local"|"cloud"} manual leadership (X-Wake-Secret)
 *   POST /state       → Local: {"state":"armed"|"disarmed"} (X-Wake-Secret)
 *
 * Leader rules (computed on read — all state lives in KV):
 *   override=local                          → local (manual failover; STICKS
 *                                             until /switch to=cloud reclaims)
 *   cloud_state=awake   + hb   < STALE      → cloud (normal: healthy leader)
 *   cloud_state=sleeping+ sleep< SILENCE    → cloud (normal sleep: the wake
 *                                             chain owns recovery; local must
 *                                             NOT arm — the armed webhook
 *                                             holds the pending updates)
 *   cloud_state=sleeping+ sleep≥ SILENCE    → local (wake chain failed for a
 *                                             day → takeover)
 *   else (awake, stale/missing heartbeat)   → local (cloud hung while awake)
 *   no data at all                          → cloud (fresh-install default)
 *
 * Telegram webhook flow (unchanged): validate secret → consume non-allowlisted
 * → first allowlisted delivery: repository_dispatch + ack → respond 503 so the
 * update STAYS PENDING; after resume the Hermes gateway calls
 * deleteWebhook(drop_pending_updates=False) and processes the ORIGINAL message
 * natively. No message content ever leaves Telegram's servers.
 */

const GITHUB_REPO = "rodorin-lab/wake-velyx";
const DISPATCH_EVENT = "wake-velyx";
const DEFAULT_ALLOWED = "5180295927"; // studio owner's Telegram user ID

const K = {
  CLOUD_STATE: "cloud_state", // "awake" | "sleeping"
  CLOUD_HB: "cloud_heartbeat_ts", // epoch ms of last heartbeat
  CLOUD_SLEEP: "cloud_sleep_ts", // epoch ms of last sleep notice
  LOCAL_STATE: "local_state", // "armed" | "disarmed"
  LOCAL_STATE_TS: "local_state_ts",
  OVERRIDE: "override", // "local" (manual failover) | absent
  OVERRIDE_TS: "override_ts",
  WAKE_TS: "wake_dispatch_ts", // informational
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function secretMatches(headerVal, expected) {
  if (!headerVal || !expected) return false;
  const a = new TextEncoder().encode(headerVal);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.subtle.timingSafeEqual(a, b);
  } catch {
    return headerVal === expected;
  }
}

async function requireWakeSecret(request, env) {
  const header = request.headers.get("x-wake-secret") || "";
  return secretMatches(header, env.WAKE_ENDPOINT_SECRET);
}

function staleMs(env) {
  const m = parseFloat(env.STALE_MINUTES);
  return (Number.isFinite(m) && m > 0 ? m : 15) * 60_000;
}
function silenceMs(env) {
  const h = parseFloat(env.SILENCE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 3_600_000;
}

async function readLeaderState(env) {
  const kv = env.WAKE_KV;
  const [cloudState, hb, sleep, localState, localTs, ovr, ovrTs] = await Promise.all([
    kv.get(K.CLOUD_STATE),
    kv.get(K.CLOUD_HB),
    kv.get(K.CLOUD_SLEEP),
    kv.get(K.LOCAL_STATE),
    kv.get(K.LOCAL_STATE_TS),
    kv.get(K.OVERRIDE),
    kv.get(K.OVERRIDE_TS),
  ]);
  return {
    cloud_state: cloudState,
    cloud_heartbeat_ts: hb ? Number(hb) : null,
    cloud_sleep_ts: sleep ? Number(sleep) : null,
    local_state: localState,
    local_state_ts: localTs ? Number(localTs) : null,
    override: ovr,
    override_ts: ovrTs ? Number(ovrTs) : null,
  };
}

function computeLeader(st, env, now) {
  const hbAge = st.cloud_heartbeat_ts ? now - st.cloud_heartbeat_ts : null;
  const sleepAge = st.cloud_sleep_ts ? now - st.cloud_sleep_ts : null;

  if (st.override === "local") {
    return { leader: "local", reason: "manual_override" };
  }
  if (st.cloud_state === null && st.cloud_heartbeat_ts === null && st.cloud_sleep_ts === null) {
    return { leader: "cloud", reason: "no_data_default" };
  }
  if (st.cloud_state === "awake" && hbAge !== null && hbAge < staleMs(env)) {
    return { leader: "cloud", reason: "heartbeat_fresh" };
  }
  if (st.cloud_state === "sleeping" && sleepAge !== null && sleepAge < silenceMs(env)) {
    return { leader: "cloud", reason: "sleeping_normal" };
  }
  if (st.cloud_state === "sleeping") {
    return { leader: "local", reason: "sleep_silence_exceeded" };
  }
  return { leader: "local", reason: "heartbeat_stale" };
}

async function leaderStatus(env, now) {
  const st = await readLeaderState(env);
  const { leader, reason } = computeLeader(st, env, now);
  return {
    ok: true,
    leader,
    reason,
    cloud: {
      state: st.cloud_state,
      heartbeat_age_s: st.cloud_heartbeat_ts ? Math.round((now - st.cloud_heartbeat_ts) / 1000) : null,
      sleep_age_s: st.cloud_sleep_ts ? Math.round((now - st.cloud_sleep_ts) / 1000) : null,
    },
    local: {
      state: st.local_state,
      state_age_s: st.local_state_ts ? Math.round((now - st.local_state_ts) / 1000) : null,
    },
    override: st.override,
    ts: now,
  };
}

async function dispatchWake(env, source, now) {
  let dispatched = false;
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WAKE_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "wake-velyx-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: DISPATCH_EVENT,
        // NOTE: no message content — privacy. Only the trigger origin.
        client_payload: { source, ts: now },
      }),
    });
    dispatched = r.ok;
  } catch {
    dispatched = false;
  }
  try {
    if (dispatched) {
      await env.WAKE_KV.put(K.WAKE_TS, String(now));
    }
  } catch {
    /* informational only */
  }
  return dispatched;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const now = Date.now();

    // Health check for uptime monitors (unchanged)
    if (request.method === "GET" && path === "/") {
      return new Response("wake-velyx worker alive\n", { status: 200 });
    }

    // ---- PHASE 5 endpoints (X-Wake-Secret) ----

    if (request.method === "GET" && path === "/leader") {
      if (!(await requireWakeSecret(request, env))) return json(403, { ok: false, error: "forbidden" });
      if (!env.WAKE_KV) return json(503, { ok: false, error: "kv_not_bound (bind a KV namespace as WAKE_KV)" });
      try {
        return json(200, await leaderStatus(env, now));
      } catch (e) {
        return json(500, { ok: false, error: String(e) });
      }
    }

    if (request.method === "POST" && (path === "/heartbeat" || path === "/sleep" || path === "/wake" || path === "/switch" || path === "/state")) {
      if (!(await requireWakeSecret(request, env))) return json(403, { ok: false, error: "forbidden" });
      if (!env.WAKE_KV) return json(503, { ok: false, error: "kv_not_bound (bind a KV namespace as WAKE_KV)" });

      try {
        if (path === "/heartbeat") {
          await env.WAKE_KV.put(K.CLOUD_STATE, "awake");
          await env.WAKE_KV.put(K.CLOUD_HB, String(now));
          const st = await leaderStatus(env, now);
          return json(200, { ok: true, recorded: "heartbeat", ...st });
        }

        if (path === "/sleep") {
          await env.WAKE_KV.put(K.CLOUD_STATE, "sleeping");
          await env.WAKE_KV.put(K.CLOUD_SLEEP, String(now));
          return json(200, { ok: true, recorded: "sleep" });
        }

        if (path === "/wake") {
          const dispatched = await dispatchWake(env, "endpoint", now);
          return dispatched
            ? json(200, { ok: true, dispatched: true })
            : json(502, { ok: false, dispatched: false, error: "github dispatch failed (check WAKE_DISPATCH_TOKEN)" });
        }

        if (path === "/switch") {
          let body = {};
          try { body = await request.json(); } catch { /* empty body */ }
          const to = String(body.to || "");
          if (to === "local") {
            await env.WAKE_KV.put(K.OVERRIDE, "local");
            await env.WAKE_KV.put(K.OVERRIDE_TS, String(now));
          } else if (to === "cloud") {
            await env.WAKE_KV.delete(K.OVERRIDE);
            await env.WAKE_KV.delete(K.OVERRIDE_TS);
          } else {
            return json(400, { ok: false, error: 'body must be {"to":"local"} or {"to":"cloud"}' });
          }
          const st = await leaderStatus(env, now);
          return json(200, { ok: true, switched: to, ...st });
        }

        if (path === "/state") {
          let body = {};
          try { body = await request.json(); } catch { /* empty body */ }
          const state = String(body.state || "");
          if (state !== "armed" && state !== "disarmed") {
            return json(400, { ok: false, error: 'body must be {"state":"armed"|"disarmed"}' });
          }
          await env.WAKE_KV.put(K.LOCAL_STATE, state);
          await env.WAKE_KV.put(K.LOCAL_STATE_TS, String(now));
          return json(200, { ok: true, recorded: state });
        }
      } catch (e) {
        return json(500, { ok: false, error: String(e) });
      }
    }

    // ---- Telegram webhook path (unchanged behavior) ----

    if (request.method === "POST" && path === "/") {
      // 1. Telegram secret_token validation
      const headerSecret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || headerSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }

      const msg = update.message || update.edited_message;
      const allowed = (env.ALLOWED_USER_IDS || DEFAULT_ALLOWED)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const senderId = msg && msg.from ? String(msg.from.id) : null;

      // 2. Non-allowlisted / non-message updates: consume silently.
      if (!msg || (allowed.length && !allowed.includes(senderId))) {
        return new Response("ok", { status: 200 });
      }

      // 3. Dedupe retry deliveries (best-effort, stateless)
      let firstDelivery = true;
      try {
        const cache = caches.default;
        const key = new Request(`https://wake-velyx.internal/dedupe/${update.update_id}`);
        if (await cache.match(key)) {
          firstDelivery = false;
        } else {
          ctx.waitUntil(
            cache.put(key, new Response("1", { headers: { "Cache-Control": "public, max-age=3600" } }))
          );
        }
      } catch {
        /* cache unavailable → treat as first delivery (duplicate ack at worst) */
      }

      if (firstDelivery) {
        // 3a. Dispatch the wake trigger.
        let dispatched = false;
        try {
          const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.WAKE_DISPATCH_TOKEN}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "wake-velyx-worker",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event_type: DISPATCH_EVENT,
              // NOTE: no message content — privacy. Only the trigger origin.
              client_payload: { source: "telegram", update_id: update.update_id },
            }),
          });
          dispatched = r.ok;
        } catch {
          dispatched = false;
        }

        // 3b. Ack to the sender.
        const text = dispatched
          ? "⏳ スリープ中にメッセージを受信。Studioを起こしてる（2〜5分）。復帰したら元のメッセージを自動で処理するよ"
          : "⚠️ 復旧トリガーの発行に失敗。毎時23分の定期wakeで復帰予定";
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: msg.chat.id, text }),
          });
        } catch {
          /* ack is best-effort */
        }
      }

      // 4. Non-2xx → Telegram retries → update stays pending → the gateway's
      //    startup deleteWebhook releases it to getUpdates (native replay).
      return new Response("wake dispatched; retry-for-replay", { status: 503 });
    }

    if (request.method !== "POST" && request.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    return new Response("not found", { status: 404 });
  },
};