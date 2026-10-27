const { Op } = require("sequelize");
const paginationHelpers = require("../../../helpers/paginationHelper");
const db = require("../../../models");
const ApiError = require("../../../error/ApiError");
const { encrypt, decrypt, mask } = require("../../../helpers/secretBox");
const M = () => db.facebookPixel;

const ACTIVE = "Active";

// Admin-facing shape: the access token is never sent back, only a masked tail.
const toAdminPixel = (row) => {
  const plain = row.get ? row.get({ plain: true }) : row;
  const { metaAccessToken, ...rest } = plain;
  return { ...rest, hasAccessToken: Boolean(metaAccessToken), accessTokenMasked: mask(metaAccessToken) };
};

// A blank token on update keeps the saved one, so admins never have to re-enter
// it; sending a new value rotates it.
const normalizePayload = (data = {}, { existingToken } = {}) => {
  const pixelsId = String(data.pixelsId || "").trim();
  const newToken = String(data.metaAccessToken || "").trim();
  if (!/^\d{10,20}$/.test(pixelsId)) throw new ApiError(400, "A valid numeric Meta Pixel ID is required");
  if (!newToken && !existingToken) throw new ApiError(400, "Meta access token is required");
  if (newToken && (newToken.length < 20 || /\s/.test(newToken))) throw new ApiError(400, "Meta access token looks invalid");
  const testEventId = String(data.testEventId || "").trim();
  if (testEventId && !/^[A-Za-z0-9_-]{3,64}$/.test(testEventId)) throw new ApiError(400, "Test event code looks invalid");
  return {
    pixelsId,
    metaAccessToken: newToken ? encrypt(newToken) : existingToken,
    testEventId: testEventId || null,
    status: data.status === false || data.status === "Inactive" ? "Inactive" : ACTIVE,
  };
};

const ensureUnique = async (pixelsId, excludeId) => {
  const where = { pixelsId };
  if (excludeId) where.Id = { [Op.ne]: excludeId };
  if (await M().findOne({ where })) throw new ApiError(409, "This Meta Pixel ID already exists");
};

const insertIntoDB = async (data) => {
  const payload = normalizePayload(data);
  await ensureUnique(payload.pixelsId);
  return toAdminPixel(await M().create(payload));
};

const getAllFromDB = async (filters, options) => {
  const { page, limit, skip } = paginationHelpers.calculatePagination(options);
  const { searchTerm } = filters || {};
  const where = searchTerm ? { pixelsId: { [Op.like]: `%${searchTerm}%` } } : {};
  const [data, count] = await Promise.all([
    M().findAll({ where, offset: skip, limit, paranoid: true, order: [["createdAt", "DESC"]] }),
    M().count({ where }),
  ]);
  return { meta: { count, page, limit }, data: data.map(toAdminPixel) };
};

const getActiveFromDB = async () =>
  M().findAll({ where: { status: ACTIVE }, paranoid: true, order: [["createdAt", "DESC"]] });

// Server-side only: active pixels with their decrypted token for the Conversions API.
const getActiveForDelivery = async () => {
  const rows = await getActiveFromDB();
  return rows.flatMap((row) => {
    try {
      const accessToken = decrypt(row.metaAccessToken);
      return accessToken ? [{ Id: row.Id, pixelsId: row.pixelsId, accessToken, testEventId: row.testEventId }] : [];
    } catch (error) {
      console.error(JSON.stringify({ scope: "meta_capi", pixelId: row.pixelsId, error: "Access token could not be decrypted" }));
      return [];
    }
  });
};

// Browser config: pixel IDs only.
const getPublicFromDB = async () => {
  const rows = await getActiveFromDB();
  return rows.map((row) => ({ pixelsId: row.pixelsId }));
};

const updateOneFromDB = async (id, payload) => {
  const row = await M().findOne({ where: { Id: id } });
  if (!row) throw new ApiError(404, "Pixel not found");
  const current = row.get({ plain: true });
  const data = normalizePayload({ ...current, metaAccessToken: "", ...payload }, { existingToken: current.metaAccessToken });
  await ensureUnique(data.pixelsId, row.Id);
  await row.update(data);
  return toAdminPixel(row);
};

const deleteIdFromDB = async (id) => {
  const row = await M().findOne({ where: { Id: id } });
  if (!row) throw new ApiError(404, "Pixel not found");
  await row.destroy();
  return { deleted: true };
};

const recordDelivery = async (id, { ok, error }) => {
  const now = new Date();
  await M().update(
    ok ? { lastSuccessAt: now } : { lastErrorAt: now, lastError: String(error || "").slice(0, 500) },
    { where: { Id: id }, silent: true },
  );
};

/**
 * Sends one PageView test event with the Test Event Code so it shows up under
 * Events Manager → Test events. Works for an inactive pixel too, so a
 * configuration can be checked before it is switched on.
 */
const testConnection = async (id, { testEventCode } = {}) => {
  const row = await M().findOne({ where: { Id: id } });
  if (!row) throw new ApiError(404, "Pixel not found");
  const code = String(testEventCode || row.testEventId || "").trim();
  if (!code) throw new ApiError(400, "Add a Test Event Code (Events Manager → Test events) to run a test");
  let accessToken;
  try {
    accessToken = decrypt(row.metaAccessToken);
  } catch {
    throw new ApiError(500, "Saved access token cannot be decrypted; enter the token again");
  }
  if (!accessToken) throw new ApiError(400, "No access token saved for this pixel");

  // Loaded here to avoid a require cycle with the CAPI service.
  const { postEvents } = require("../tracking/metaCapi.service");
  const event = {
    event_name: "PageView",
    event_time: Math.floor(Date.now() / 1000),
    event_id: `test_${row.Id}_${Date.now()}`,
    action_source: "website",
    event_source_url: process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "https://holygift.xyz",
    user_data: { client_user_agent: "HolyGift-Admin-Connection-Test", client_ip_address: "127.0.0.1" },
  };
  const result = await postEvents({ pixelsId: row.pixelsId, accessToken }, [event], { testEventCode: code });
  await recordDelivery(row.Id, result).catch(() => {});
  return {
    ok: result.ok,
    pixelId: row.pixelsId,
    testEventCode: code,
    eventsReceived: result.eventsReceived ?? 0,
    fbtraceId: result.fbtraceId || null,
    error: result.ok ? null : result.error,
  };
};

module.exports = {
  insertIntoDB,
  getAllFromDB,
  getActiveFromDB,
  getActiveForDelivery,
  getPublicFromDB,
  updateOneFromDB,
  deleteIdFromDB,
  recordDelivery,
  testConnection,
};
