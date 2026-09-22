/**
 * wake-velyx Worker — Telegram webhook → GitHub Actions wake dispatch.
 *
 * Deploy on Cloudflare Workers (free tier: 100k req/day).
 * Secrets (register in the CF dashboard):
 *   TELEGRAM_BOT_TOKEN      — bot token (same one the Hermes gateway uses)
 *   TELEGRAM_WEBHOOK_SECRET — secret_token passed to setWebhook (on_stop.sh)
 *   WAKE_DISPATCH_TOKEN     — GitHub PAT with "Actions: Write" on
 *                             rodorin-lab/wake-velyx (repository_dispatch)
 * Optional var:
 *   ALLOWED_USER_IDS        — comma-separated Telegram user IDs.
 *                             Defaults to the studio owner.
 *
 * Flow per Telegram update:
 *   1. Validate X-Telegram-Bot-Api-Secret-Token (reject everyone else: 403).
 *   2. Updates from non-allowlisted senders are consumed silently (200).
 *   3. First delivery of an allowlisted update:
 *        a. repository_dispatch → wakes the studio (idempotent workflow)
 *        b. ack message to the sender ("waking up, will auto-process")
 *   4. Respond 503 for allowlisted updates so Telegram KEEPS RETRYING.
 *      When the studio comes up, the Hermes gateway calls
 *      deleteWebhook(drop_pending_updates=False) — the still-pending update
 *      is released to getUpdates and the gateway processes the ORIGINAL
 *      message natively, in order, with full media support.
 *      (If Telegram gives up retrying before the gateway is up, the ack
 *      told the user; they can resend — hourly wake is the backstop.)
 *
 * Dedupe: retry deliveries are recognized via the Cache API (best-effort,
 * stateless) so the ack and dispatch fire once per update.
 */

const GITHUB_REPO = "rodorin-lab/wake-velyx";
const DISPATCH_EVENT = "wake-velyx";
const DEFAULT_ALLOWED = "5180295927"; // studio owner's Telegram user ID

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check for uptime monitors
    if (request.method === "GET") {
      return new Response("wake-velyx worker alive\n", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

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
  },
};