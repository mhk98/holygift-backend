const { Op } = require("sequelize");
const paginationHelpers = require("../../../helpers/paginationHelper");
const db = require("../../../models");
const Attribute = db.attribute;

const insertIntoDB = async (data) => {
  return await Attribute.create(data);
};

const getAllFromDB = async (filters, options) => {
  const { page, limit, skip } = paginationHelpers.calculatePagination(options);
  const { searchTerm, ...filterData } = filters;
  const andConditions = [];

  if (searchTerm) {
    andConditions.push({ name: { [Op.like]: `%${searchTerm}%` } });
  }

  if (Object.keys(filterData).length > 0) {
    andConditions.push({
      [Op.and]: Object.entries(filterData).map(([key, value]) => ({
        [key]: { [Op.eq]: value },
      })),
    });
  }

  const whereConditions = andConditions.length ? { [Op.and]: andConditions } : {};

  const result = await Attribute.findAll({
    where: whereConditions,
    offset: skip,
    limit,
    paranoid: true,
    order: options.sortBy && options.sortOrder
      ? [[options.sortBy, options.sortOrder.toUpperCase()]]
      : [["createdAt", "DESC"]],
  });

  const count = await Attribute.count({ where: whereConditions });

  return { meta: { count, page, limit }, data: result };
};

// Colors used to have their own menu; they now live in a "Color" attribute like any
// other option. Copies the saved colors over once (a deleted "Color" stays deleted).
const seedColorAttribute = async () => {
  if (await Attribute.count({ where: { name: "Color" }, paranoid: false })) return;
  const colors = await db.color.findAll({ attributes: ["name"], order: [["Id", "ASC"]], raw: true });
  const names = [...new Set(colors.map((color) => String(color.name || "").trim()).filter(Boolean))];
  if (names.length) await Attribute.create({ name: "Color", values: names });
};

const getAllFromDBWithoutQuery = async () => {
  return await Attribute.findAll({ paranoid: true, order: [["createdAt", "DESC"]] });
};

const getDataById = async (id) => {
  return await Attribute.findOne({ where: { Id: id } });
};

const updateOneFromDB = async (id, payload) => {
  return await Attribute.update(payload, { where: { Id: id } });
};

const deleteIdFromDB = async (id) => {
  return await Attribute.destroy({ where: { Id: id } });
};

const AttributeService = {
  insertIntoDB, getAllFromDB, getAllFromDBWithoutQuery, seedColorAttribute, getDataById, updateOneFromDB, deleteIdFromDB,
};

module.exports = AttributeService;
