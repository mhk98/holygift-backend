const { Op } = require("sequelize");

// Dependencies are injectable so the scheduler can be tested without a live DB.
// `pendingWhere` picks the rows still moving with the courier; scratch cards
// reuse this worker with their own condition.
const createCourierSyncWorker = ({
  Order,
  service,
  logger = console,
  intervalMs = 300000,
  // Courier APIs rate limit per account, so space the lookups out.
  delayMs = 400,
  now = Date.now,
  entityLabel = "order",
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pendingWhere = { status: { [Op.in]: ["in_courier", "on_hold"] } },
}) => {
  let timer;
  let active;
  let stopped = false;
  let cursor = 0;
  let retryAt = 0;
  let rateLimitCount = 0;

  const sweep = async () => {
    while (!stopped) {
      const orders = await Order.findAll({
        attributes: ["Id", "courier"],
        where: {
          Id: { [Op.gt]: cursor },
          ...pendingWhere,
          courier: { [Op.in]: ["Steadfast", "Pathao"] },
        },
        order: [["Id", "ASC"]],
        limit: 100,
      });
      if (!orders.length) { cursor = 0; break; }
      for (const order of orders) {
        if (stopped) break;
        try {
          const sync = String(order.courier).toLowerCase() === "steadfast"
            ? service.syncSteadfastStatusInDB : service.syncPathaoStatusInDB;
          await sync(order.Id, { automatic: true });
          rateLimitCount = 0;
        } catch (error) {
          // Keep the cursor before this row, and resume it after the cooldown.
          if (error?.statusCode === 429) {
            rateLimitCount = Math.min(rateLimitCount + 1, 20);
            const cooldownMs = Math.max(Number(error.retryAfterMs) || 0,
              Math.min(intervalMs * 2 ** (rateLimitCount - 1), 3600000));
            retryAt = now() + cooldownMs;
            logger.warn(`Courier sync paused at ${entityLabel} ${order.Id} (${order.courier}): rate limited; retry no earlier than ${new Date(retryAt).toISOString()}`);
            return;
          }
          logger.warn(`Courier sync failed for ${entityLabel} ${order.Id}: ${error.message}`);
        }
        cursor = order.Id;
        if (delayMs > 0) await wait(delayMs);
      }
    }
  };

  const run = () => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    if (now() < retryAt) return Promise.resolve();
    active = sweep().catch((error) => {
      logger.error(`Courier sync failed: ${error.message}`);
    }).finally(() => { active = null; });
    return active;
  };

  return {
    run,
    start() {
      if (timer || stopped) return;
      void run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
};

module.exports = { createCourierSyncWorker };
