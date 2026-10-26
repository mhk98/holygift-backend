const catchAsync   = require("../../../shared/catchAsync");
const sendResponse = require("../../../shared/sendResponse");
const Service      = require("./scratchCardPrize.service");

const insertIntoDB = catchAsync(async (req, res) => {
  const result = await Service.insertIntoDB(req.body, req.file);
  sendResponse(res, { statusCode: 201, success: true, message: "Prize created", data: result });
});

const getAllFromDB = catchAsync(async (req, res) => {
  const result = await Service.getAllFromDB();
  sendResponse(res, { statusCode: 200, success: true, message: "Prizes fetched", data: result });
});

const getPublicFromDB = catchAsync(async (req, res) => {
  const result = await Service.getPublicFromDB();
  sendResponse(res, { statusCode: 200, success: true, message: "Prizes fetched", data: result });
});

const updateOneFromDB = catchAsync(async (req, res) => {
  const result = await Service.updateOneFromDB(req.params.id, req.body, req.file);
  sendResponse(res, { statusCode: 200, success: true, message: "Prize updated", data: result });
});

const deleteIdFromDB = catchAsync(async (req, res) => {
  const result = await Service.deleteIdFromDB(req.params.id);
  sendResponse(res, { statusCode: 200, success: true, message: "Prize deleted", data: result });
});

module.exports = { insertIntoDB, getAllFromDB, getPublicFromDB, updateOneFromDB, deleteIdFromDB };
