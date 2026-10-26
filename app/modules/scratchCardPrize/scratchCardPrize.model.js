module.exports = (sequelize, DataTypes) => {
  const ScratchCardPrize = sequelize.define(
    "ScratchCardPrize",
    {
      Id:        { type: DataTypes.INTEGER(10), primaryKey: true, autoIncrement: true, allowNull: false },
      // Stored on each claim as ScratchCard.prize, so it fits that column.
      name:      { type: DataTypes.STRING(64),  allowNull: false },
      // Bangla label shown on the storefront form and track page.
      nameBn:    { type: DataTypes.STRING(128), allowNull: true },
      // Optional icon; without one the storefront draws a built-in icon.
      image:     { type: DataTypes.STRING,      allowNull: true },
      sortOrder: { type: DataTypes.INTEGER,     allowNull: false, defaultValue: 0 },
      status:    { type: DataTypes.STRING(32),  allowNull: false, defaultValue: "Active" },
      deletedAt: { type: DataTypes.DATE,        allowNull: true },
    },
    { timestamps: true, paranoid: true }
  );
  return ScratchCardPrize;
};
