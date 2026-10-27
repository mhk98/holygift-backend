// Durable queue for server-side Meta events that must not be lost (Purchase).
// One row per pixel + event_id; the unique index makes a repeated enqueue a no-op,
// so an order can never produce a second Purchase for the same pixel.
module.exports = (sequelize, DataTypes) => {
  const MetaEventOutbox = sequelize.define(
    "MetaEventOutbox",
    {
      Id:            { type: DataTypes.INTEGER(10), primaryKey: true, autoIncrement: true, allowNull: false },
      pixelRowId:    { type: DataTypes.INTEGER(10), allowNull: false },
      eventId:       { type: DataTypes.STRING(128), allowNull: false },
      eventName:     { type: DataTypes.STRING(64), allowNull: false },
      // The Meta event with user_data already hashed; no access token.
      payload:       { type: DataTypes.JSON, allowNull: false },
      status:        { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending" },
      attempts:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      nextAttemptAt: { type: DataTypes.DATE, allowNull: false },
      lockedUntil:   { type: DataTypes.DATE, allowNull: true },
      lastError:     { type: DataTypes.STRING(500), allowNull: true },
      sentAt:        { type: DataTypes.DATE, allowNull: true },
    },
    {
      timestamps: true,
      indexes: [
        { unique: true, fields: ["pixelRowId", "eventId"] },
        { fields: ["status", "nextAttemptAt"] },
      ],
    },
  );
  return MetaEventOutbox;
};
