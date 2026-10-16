const router = require("express").Router();
const { ENUM_USER_ROLE } = require("../../enums/user");
const auth = require("../../middlewares/auth");
const { uploadSingle } = require("../../middlewares/upload");
const Controller = require("./scratchCard.controller");

router.get(   "/check",  Controller.checkPhone);
router.get(   "/track",  Controller.trackByPhone);
router.post(  "/submit", uploadSingle, Controller.submit);
// Agents (role created from the admin Roles page) get their own assigned
// claims only; the service enforces that.
const ADMINS = [ENUM_USER_ROLE.SUPER_ADMIN, ENUM_USER_ROLE.ADMIN];
const ADMINS_AND_AGENTS = [...ADMINS, "agent", "agents"];

router.get(   "/agents", auth(...ADMINS), Controller.getAgents);
router.post(  "/assign", auth(...ADMINS), Controller.assignToAgent);
router.post(  "/courier/sync",      auth(...ADMINS), Controller.syncCourierStatus);
router.post(  "/courier/:provider", auth(...ADMINS), Controller.sendToCourier);
router.get(   "/",       auth(...ADMINS_AND_AGENTS), Controller.getAllFromDB);
router.put(   "/:id",    auth(...ADMINS_AND_AGENTS), Controller.updateOneFromDB);
router.delete("/:id",    auth(ENUM_USER_ROLE.SUPER_ADMIN, ENUM_USER_ROLE.ADMIN), Controller.deleteIdFromDB);

module.exports = router;
