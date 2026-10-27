const { Op } = require("sequelize");
const db = require("../../../models");
const FacebookPixelService = require("../facebookPixel/facebookPixel.service");

// Meta Conversions API delivery. Browsing events (PageView, ViewContent,
// AddToCart, InitiateCheckout) are sent straight away with a short in-memory
// retry; Purchase goes through the MetaEventOutbox table so it survives Meta
// outages, restarts and several backend instances sharing the database.

// Graph API versions are retired roughly two years after release; override with
// META_GRAPH_API_VERSION when Meta deprecates this one.
const graphVersion = () => process.env.META_GRAPH_API_VERSION || "v23.0";

const REQUEST_TIMEOUT_MS = 10_000;
const LIVE_RETRY_DELAYS_MS = [500, 2000];
const OUTBOX_MAX_ATTEMPTS = 8;
const OUTBOX_LOCK_MS = 60_000;
// Meta rejects events with an event_time older than 7 days.
const MAX_EVENT_AGE_S = 7 * 24 * 60 * 60 - 3600;
// Meta error codes that are temporary (unknown, service, rate limits).
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Privacy-safe structured log: ids and status only, never tokens or customer data.
const log = (level, fields) => console[level](JSON.stringify({ scope: "meta_capi", ...fields }));

const shortError = (value) => String(value || "Unknown error").replace(/access_token=[^&\s]+/g, "access_token=***").slice(0, 500);

/**
 * Sends events to one pixel. Returns { ok, retryable, status, eventsReceived, fbtraceId, error }.
 * The token goes in the POST body, never in the URL.
 */
const postEvents = async (pixel, events, { testEventCode } = {}) => {
  const url = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(pixel.pixelsId)}/events`;
  const body = { data: events, access_token: pixel.accessToken };
  if (testEventCode) body.test_event_code = testEventCode;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) {
      return { ok: true, status: res.status, eventsReceived: data.events_received, fbtraceId: data.fbtrace_id };
    }
    const code = Number(data.error?.code);
    return {
      ok: false,
      retryable: res.status >= 500 || res.status === 429 || TRANSIENT_META_CODES.has(code) || Boolean(data.error?.is_transient),
      status: res.status,
      fbtraceId: data.error?.fbtrace_id,
      error: shortError(data.error?.error_user_msg || data.error?.message || `HTTP ${res.status}`),
    };
  } catch (error) {
    return { ok: false, retryable: true, status: 0, error: shortError(error.name === "TimeoutError" ? "Request to Meta timed out" : error.message) };
  }
};

// Success is recorded at most once a minute per pixel so browsing events don't
// turn into a database write each.
const lastSuccessWrite = new Map();
const recordResult = async (pixel, result) => {
  try {
    if (result.ok) {
      const last = lastSuccessWrite.get(pixel.Id) || 0;
      if (Date.now() - last < 60_000) return;
      lastSuccessWrite.set(pixel.Id, Date.now());
      await FacebookPixelService.recordDelivery(pixel.Id, { ok: true });
    } else {
      await FacebookPixelService.recordDelivery(pixel.Id, { ok: false, error: result.error });
    }
  } catch {
    // Health bookkeeping must never break delivery.
  }
};

const sendWithRetry = async (pixel, events, delays = LIVE_RETRY_DELAYS_MS) => {
  let result;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    result = await postEvents(pixel, events);
    if (result.ok || !result.retryable) break;
    if (attempt < delays.length) await wait(delays[attempt]);
  }
  await recordResult(pixel, result);
  return result;
};

/** Browsing events: every active pixel, fire-and-forget for the caller. */
const dispatchLive = async (event) => {
  const pixels = await FacebookPixelService.getActiveForDelivery();
  await Promise.all(pixels.map(async (pixel) => {
    const result = await sendWithRetry(pixel, [event]);
    if (!result.ok) {
      log("warn", { pixelId: pixel.pixelsId, eventName: event.event_name, eventId: event.event_id, status: result.status, error: result.error });
    }
  }));
};

// ---------------------------------------------------------------------------
// Outbox (Purchase)
// ---------------------------------------------------------------------------

const Outbox = () => db.metaEventOutbox;

/**
 * Queues an event for every active pixel. A repeated call with the same
 * event_id (retry, double submit, second worker) adds nothing.
 */
const enqueue = async (event) => {
  const pixels = await FacebookPixelService.getActiveForDelivery();
  if (!pixels.length) return 0;
  const now = new Date();
  await Outbox().bulkCreate(
    pixels.map((pixel) => ({
      pixelRowId: pixel.Id,
      eventId: event.event_id,
      eventName: event.event_name,
      payload: event,
      status: "pending",
      nextAttemptAt: now,
    })),
    { ignoreDuplicates: true },
  );
  setImmediate(() => { processOutbox().catch(() => {}); });
  return pixels.length;
};

const backoffMs = (attempts) => Math.min(30_000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000);

// Claims a row so only one worker sends it, even across backend instances.
const claim = async (row) => {
  const now = new Date();
  const [count] = await Outbox().update(
    { lockedUntil: new Date(now.getTime() + OUTBOX_LOCK_MS) },
    {
      where: {
        Id: row.Id,
        status: "pending",
        [Op.or]: [{ lockedUntil: null }, { lockedUntil: { [Op.lt]: now } }],
      },
    },
  );
  return count === 1;
};

const deliverRow = async (row, pixelsById) => {
  const pixel = pixelsById.get(row.pixelRowId);
  if (!pixel) {
    // Pixel disabled or deleted after the event was queued.
    await row.update({ status: "skipped", lockedUntil: null, lastError: "Pixel is disabled or deleted" });
    return;
  }
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  if (Math.floor(Date.now() / 1000) - Number(payload.event_time) > MAX_EVENT_AGE_S) {
    await row.update({ status: "failed", lockedUntil: null, lastError: "Event is older than Meta's 7-day limit" });
    return;
  }

  const result = await postEvents(pixel, [payload]);
  await recordResult(pixel, result);
  const attempts = row.attempts + 1;
  if (result.ok) {
    await row.update({ status: "sent", attempts, sentAt: new Date(), lockedUntil: null, lastError: null });
    return;
  }
  const giveUp = !result.retryable || attempts >= OUTBOX_MAX_ATTEMPTS;
  await row.update({
    status: giveUp ? "failed" : "pending",
    attempts,
    lockedUntil: null,
    lastError: result.error,
    nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
  });
  log("warn", { pixelId: pixel.pixelsId, eventName: row.eventName, eventId: row.eventId, attempts, status: result.status, error: result.error, gaveUp: giveUp });
};

let processing = null;
const processOutbox = async () => {
  if (processing) return processing;
  processing = (async () => {
    const rows = await Outbox().findAll({
      where: {
        status: "pending",
        nextAttemptAt: { [Op.lte]: new Date() },
        [Op.or]: [{ lockedUntil: null }, { lockedUntil: { [Op.lt]: new Date() } }],
      },
      order: [["nextAttemptAt", "ASC"]],
      limit: 50,
    });
    if (!rows.length) return;
    const pixels = await FacebookPixelService.getActiveForDelivery();
    const pixelsById = new Map(pixels.map((pixel) => [pixel.Id, pixel]));
    for (const row of rows) {
      if (!(await claim(row))) continue;
      try {
        await deliverRow(row, pixelsById);
      } catch (error) {
        await row.update({ lockedUntil: null, lastError: shortError(error.message) }).catch(() => {});
      }
    }
  })().finally(() => { processing = null; });
  return processing;
};

const createOutboxWorker = ({ intervalMs = 30_000 } = {}) => {
  let timer;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        processOutbox().catch((error) => log("error", { error: shortError(error.message) }));
      }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      await processing?.catch(() => {});
    },
  };
};

module.exports = { postEvents, dispatchLive, enqueue, processOutbox, createOutboxWorker, graphVersion };
