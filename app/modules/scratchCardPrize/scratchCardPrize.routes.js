const router = require("express").Router();
const { ENUM_USER_ROLE } = require("../../enums/user");
const auth = require("../../middlewares/auth");
const { uploadSingle } = require("../../middlewares/upload");
const Controller = require("./scratchCardPrize.controller");

const ADMINS = [ENUM_USER_ROLE.SUPER_ADMIN, ENUM_USER_ROLE.ADMIN];

router.get(   "/public", Controller.getPublicFromDB);
// Leaders read the list for the claim filters and prize editor.
router.get(   "/",       auth(...ADMINS, ENUM_USER_ROLE.LEADER), Controller.getAllFromDB);
router.post(  "/create", auth(...ADMINS), uploadSingle, Controller.insertIntoDB);
router.put(   "/:id",    auth(...ADMINS), uploadSingle, Controller.updateOneFromDB);
router.delete("/:id",    auth(...ADMINS), Controller.deleteIdFromDB);

module.exports = router;
