module.exports = (sequelize, DataTypes) => {
  const FacebookPixel = sequelize.define("FacebookPixel", {
    Id:              { type: DataTypes.INTEGER(10), primaryKey: true, autoIncrement: true, allowNull: false },
    pixelsId:        { type: DataTypes.STRING, allowNull: false },
    // Encrypted with helpers/secretBox; never returned to any client.
    metaAccessToken: { type: DataTypes.TEXT, allowNull: true },
    testEventId:     { type: DataTypes.STRING, allowNull: true },
    status:          { type: DataTypes.STRING(32), allowNull: false, defaultValue: "Active" },
    // Conversions API delivery health shown in the admin panel (no customer data).
    lastSuccessAt:   { type: DataTypes.DATE, allowNull: true },
    lastErrorAt:     { type: DataTypes.DATE, allowNull: true },
    lastError:       { type: DataTypes.STRING(500), allowNull: true },
    deletedAt:       { type: DataTypes.DATE, allowNull: true },
  }, { timestamps: true, paranoid: true });
  return FacebookPixel;
};
