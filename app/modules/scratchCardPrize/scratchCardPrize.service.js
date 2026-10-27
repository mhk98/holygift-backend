const { Op } = require("sequelize");
const db = require("../../../models");
const ApiError = require("../../../error/ApiError");
const M = () => db.scratchCardPrize;

// The prizes the storefront form offered before they were managed from the admin.
const DEFAULT_PRIZES = [
  { name: "TV",                nameBn: "টিভি" },
  { name: "Fridge",            nameBn: "ফ্রিজ" },
  { name: "Rice Cooker",       nameBn: "রাইস কুকার" },
  { name: "Induction Chula",   nameBn: "ইন্ডাকশন চুলা" },
  { name: "Luxury Wall Watch", nameBn: "লাক্সারি দেয়াল ঘড়ি" },
  { name: "Watch",             nameBn: "ঘড়ি" },
  { name: "Vacuum Flask Set",  nameBn: "ভ্যাকুয়াম ফ্লাস্ক সেট" },
];

const seedDefaultPrizes = async () => {
  if (await M().count({ paranoid: false })) return;
  await M().bulkCreate(DEFAULT_PRIZES.map((prize, index) => ({ ...prize, sortOrder: index + 1 })));
};

const ORDER = [["sortOrder", "ASC"], ["Id", "ASC"]];

// Multipart bodies arrive as strings; an empty image field keeps the current one.
const normalizePayload = (payload = {}, file, { partial = false } = {}) => {
  const data = {};
  if (!partial || payload.name !== undefined) {
    const name = String(payload.name || "").trim();
    if (!name) throw new ApiError(400, "Prize name is required");
    if (name.length > 64) throw new ApiError(400, "Prize name is too long");
    data.name = name;
  }
  if (payload.nameBn !== undefined) data.nameBn = String(payload.nameBn || "").trim() || null;
  if (payload.sortOrder !== undefined && payload.sortOrder !== "") {
    const sortOrder = Number(payload.sortOrder);
    if (!Number.isInteger(sortOrder)) throw new ApiError(400, "Invalid sort order");
    data.sortOrder = sortOrder;
  }
  if (payload.status !== undefined) {
    if (!["Active", "Inactive"].includes(payload.status)) throw new ApiError(400, "Invalid status");
    data.status = payload.status;
  }
  if (file) data.image = file.filename;
  else if (payload.removeImage === "true" || payload.removeImage === true) data.image = null;
  return data;
};

const ensureUniqueName = async (name, exceptId) => {
  if (!name) return;
  const where = { name };
  if (exceptId) where.Id = { [Op.ne]: exceptId };
  if (await M().findOne({ where })) throw new ApiError(409, "A prize with this name already exists");
};

const insertIntoDB = async (payload, file) => {
  const data = normalizePayload(payload, file);
  await ensureUniqueName(data.name);
  if (data.sortOrder === undefined) data.sortOrder = ((await M().max("sortOrder")) || 0) + 1;
  return M().create(data);
};

const getAllFromDB = async () => M().findAll({ order: ORDER });

const getPublicFromDB = async () =>
  M().findAll({
    where: { status: "Active" },
    attributes: ["Id", "name", "nameBn", "image", "sortOrder"],
    order: ORDER,
  });

// Renaming a prize does not touch claims already submitted under the old name.
const updateOneFromDB = async (id, payload, file) => {
  const row = await M().findOne({ where: { Id: id } });
  if (!row) throw new ApiError(404, "Prize not found");
  const data = normalizePayload(payload, file, { partial: true });
  await ensureUniqueName(data.name, row.Id);
  await row.update(data);
  return row;
};

// Products keep the prizes they come with as a JSON list of prize Ids; multipart
// bodies send it as a JSON string. Returns null for "no prizes".
const parsePrizeIds = (value) => {
  let list = value;
  if (typeof list === "string") {
    if (!list.trim()) return null;
    try { list = JSON.parse(list); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const ids = [...new Set(list.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  return ids.length ? ids : null;
};

// Active prizes by Id, in the shape the storefront and orders show.
const getPrizeMap = async (ids) => {
  const cleanIds = [...new Set(ids.map(Number).filter((id) => id > 0))];
  if (!cleanIds.length) return new Map();
  const rows = await M().findAll({
    where: { Id: { [Op.in]: cleanIds }, status: "Active" },
    attributes: ["Id", "name", "nameBn", "image"],
    raw: true,
  });
  return new Map(rows.map((row) => [Number(row.Id), row]));
};

const prizesFor = (prizeIds, prizeMap) =>
  (parsePrizeIds(prizeIds) || []).map((id) => prizeMap.get(id)).filter(Boolean);

const deleteIdFromDB = async (id) => {
  const row = await M().findOne({ where: { Id: id } });
  if (!row) throw new ApiError(404, "Prize not found");
  await row.destroy();
  return { deleted: true };
};

module.exports = {
  DEFAULT_PRIZES, seedDefaultPrizes, insertIntoDB, getAllFromDB, getPublicFromDB, updateOneFromDB, deleteIdFromDB,
  parsePrizeIds, getPrizeMap, prizesFor,
};
