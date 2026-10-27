const jwt = require("jsonwebtoken");
const db = require("../../../models");
const ApiError = require("../../../error/ApiError");
const { getClientIp } = require("../../utils/clientIp");
const FacebookPixelService = require("../facebookPixel/facebookPixel.service");
const MetaCapi = require("./metaCapi.service");
const { buildUserData } = require("./metaUserData");

// Meta Pixel + Conversions API. The browser fires PageView, ViewContent,
// AddToCart and InitiateCheckout itself and posts the same event_id here for the
// server copy. Purchase is never accepted from the browser: it is built from the
// saved order (see buildPurchaseEvent) when the order is created.

const BROWSER_EVENTS = new Set(["PageView", "ViewContent", "AddToCart", "InitiateCheckout"]);
const CURRENCY = "BDT";
const MAX_ITEMS = 50;

const siteUrl = () => (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://holygift.xyz").replace(/\/$/, "");

const getPublicConfig = async () => ({ metaPixels: await FacebookPixelService.getPublicFromDB() });

// ---------------------------------------------------------------------------
// Input sanitising (the tracking endpoint is public)
// ---------------------------------------------------------------------------

const text = (value, max) => {
  const str = String(value ?? "").trim();
  return str ? str.slice(0, max) : undefined;
};
const amount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1e8 ? Math.round(n * 100) / 100 : undefined;
};
const quantity = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : undefined;
};
const contentId = (value) => {
  const id = text(value, 64);
  return id && /^[\w.-]+$/.test(id) ? id : undefined;
};

const eventSourceUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString().slice(0, 1000) : undefined;
  } catch {
    return undefined;
  }
};

const sanitizeContents = (contents) =>
  (Array.isArray(contents) ? contents : []).slice(0, MAX_ITEMS).flatMap((item) => {
    const id = contentId(item?.id);
    const qty = quantity(item?.quantity) || 1;
    if (!id) return [];
    const price = amount(item?.item_price);
    return [{ id, quantity: qty, ...(price !== undefined ? { item_price: price } : {}) }];
  });

const sanitizeCustomData = (eventName, raw = {}) => {
  if (eventName === "PageView") return undefined;
  const contents = sanitizeContents(raw.contents);
  const contentIds = contents.length
    ? contents.map((item) => item.id)
    : (Array.isArray(raw.content_ids) ? raw.content_ids : []).slice(0, MAX_ITEMS).map(contentId).filter(Boolean);
  const data = {
    content_type: "product",
    content_ids: contentIds.length ? contentIds : undefined,
    contents: contents.length ? contents : undefined,
    content_name: text(raw.content_name, 200),
    content_category: text(raw.content_category, 100),
    value: amount(raw.value),
    currency: CURRENCY,
    num_items: eventName === "InitiateCheckout"
      ? contents.reduce((sum, item) => sum + item.quantity, 0) || undefined
      : undefined,
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
};

// ---------------------------------------------------------------------------
// Customer identity (only from a verified customer token, never from the body)
// ---------------------------------------------------------------------------

const getCustomerFromRequest = async (req) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const verified = jwt.verify(token, process.env.TOKEN_SECRET);
    const user = await db.user.findOne({
      where: { Id: verified.Id },
      attributes: ["Id", "FirstName", "LastName", "Email", "Phone", "City", "PostalCode", "Country", "role", "status"],
      raw: true,
    });
    if (!user || String(user.role || "").toLowerCase() !== "user" || user.status === "Inactive") return null;
    return user;
  } catch {
    return null;
  }
};

const customerMatchData = (customer) => customer ? {
  externalId: `customer_${customer.Id}`,
  email: customer.Email,
  phone: customer.Phone,
  firstName: customer.FirstName,
  lastName: customer.LastName,
  city: customer.City,
  zip: customer.PostalCode,
  country: customer.Country && /^[a-z]{2}$/i.test(customer.Country) ? customer.Country : "bd",
} : {};

// ---------------------------------------------------------------------------
// Browser events
// ---------------------------------------------------------------------------

const trackEvent = async (payload = {}, req) => {
  const eventName = String(payload.eventName || "").trim();
  if (!BROWSER_EVENTS.has(eventName)) throw new ApiError(400, "Unsupported tracking event");
  const eventId = String(payload.eventId || "").trim();
  if (!/^[\w.:-]{8,128}$/.test(eventId)) throw new ApiError(400, "A valid eventId is required");

  const customer = await getCustomerFromRequest(req);
  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: eventSourceUrl(payload.eventSourceUrl) || siteUrl(),
    user_data: buildUserData({
      ...customerMatchData(customer),
      fbp: payload.attribution?.fbp,
      fbc: payload.attribution?.fbc,
      ipAddress: getClientIp(req),
      userAgent: req.headers["user-agent"],
    }),
    custom_data: sanitizeCustomData(eventName, payload.customData),
  };
  if (!event.custom_data) delete event.custom_data;

  // The browser does not wait for Meta; failures are retried and logged server-side.
  MetaCapi.dispatchLive(event).catch(() => {});
  return { accepted: true };
};

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

const purchaseEventId = (order) => `purchase_order_${order.Id}`;

const parseMeta = (note) => {
  if (note && typeof note === "object") return note;
  try { return JSON.parse(note || "{}") || {}; } catch { return {}; }
};

/**
 * Purchase data from the saved order (server-priced items). Revenue policy:
 * value = product total − coupon/discount; delivery charge is excluded.
 */
const buildPurchaseData = (order) => {
  const meta = parseMeta(order.note);
  const items = Array.isArray(meta.items) ? meta.items : [];
  const contents = items.slice(0, MAX_ITEMS).flatMap((item) => {
    const id = contentId(item.id);
    const qty = quantity(item.qty) || 1;
    const price = amount(item.price) || 0;
    return id ? [{ id, quantity: qty, item_price: price }] : [];
  });
  const productTotal = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.qty) || 0), 0);
  const value = Math.max(0, Math.round((productTotal - (Number(meta.discount) || 0)) * 100) / 100);
  return {
    eventId: purchaseEventId(order),
    order_id: String(order.orderId || order.Id),
    content_type: "product",
    content_ids: contents.map((item) => item.id),
    contents,
    content_name: text(items.map((item) => item.name).filter(Boolean).join(", "), 200),
    num_items: contents.reduce((sum, item) => sum + item.quantity, 0),
    value,
    currency: CURRENCY,
  };
};

const buildPurchaseEvent = (order, customer = null) => {
  const meta = parseMeta(order.note);
  const tracking = meta.tracking || {};
  const account = customerMatchData(customer);
  const { eventId, ...customData } = buildPurchaseData(order);
  return {
    event_name: "Purchase",
    // The conversion happens now, even when an earlier draft row becomes the order.
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: eventSourceUrl(tracking.eventSourceUrl) || siteUrl(),
    user_data: buildUserData({
      // The order's own details win; the logged-in account only fills the gaps.
      externalId: account.externalId,
      email: account.email,
      zip: account.zip,
      phone: order.customerPhone || account.phone,
      name: order.customerName,
      city: order.customerDistrict || account.city,
      country: account.country || "bd",
      fbp: tracking.fbp,
      fbc: tracking.fbc,
      ipAddress: order.ipAddress,
      userAgent: tracking.userAgent,
    }),
    custom_data: customData,
  };
};

/** Queues the order's single Purchase for every active pixel; repeats are no-ops. */
const enqueuePurchase = async (order) => {
  const plain = order.get ? order.get({ plain: true }) : order;
  const customerUserId = Number(parseMeta(plain.note).tracking?.customerUserId) || null;
  const customer = customerUserId
    ? await db.user.findOne({
      where: { Id: customerUserId },
      attributes: ["Id", "FirstName", "LastName", "Email", "Phone", "City", "PostalCode", "Country"],
      raw: true,
    })
    : null;
  await MetaCapi.enqueue(buildPurchaseEvent(plain, customer));
};

/**
 * Server-controlled attribution saved with the order: the browser's fbp/fbc and
 * page URL (validated) plus the request's user agent and the verified customer.
 */
const buildOrderTracking = async (clientTracking = {}, req) => {
  const customer = await getCustomerFromRequest(req);
  const keep = (key) => text(clientTracking[key], 500);
  return Object.fromEntries(Object.entries({
    fbp: keep("fbp"),
    fbc: keep("fbc"),
    ttp: keep("ttp"),
    ttclid: keep("ttclid"),
    gclid: keep("gclid"),
    gbraid: keep("gbraid"),
    wbraid: keep("wbraid"),
    landingPageId: clientTracking.landingPageId,
    eventSourceUrl: eventSourceUrl(clientTracking.eventSourceUrl),
    userAgent: text(req.headers["user-agent"], 500),
    customerUserId: customer?.Id,
  }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
};

module.exports = {
  getPublicConfig,
  trackEvent,
  buildPurchaseData,
  buildPurchaseEvent,
  enqueuePurchase,
  buildOrderTracking,
  purchaseEventId,
  sanitizeCustomData,
};
