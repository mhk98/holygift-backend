const ApiError = require("../../../error/ApiError");

// Shared by order and scratch-card requests in this server process.
const createCourierCooldown = ({ now = Date.now, baseMs = 300000, maxMs = 3600000 } = {}) => {
  const providers = new Map();
  const rateLimitError = (provider, retryAfterMs) => {
    const error = new ApiError(429, `${provider} rate limited; retry in ${Math.ceil(retryAfterMs / 1000)} seconds`);
    error.retryAfterMs = retryAfterMs;
    return error;
  };
  return {
    check(provider) {
      const remaining = (providers.get(provider)?.until || 0) - now();
      if (remaining > 0) throw rateLimitError(provider, remaining);
    },
    limited(provider, retryAfter) {
      const previous = providers.get(provider);
      const attempts = Math.min((previous?.attempts || 0) + 1, 20);
      const header = String(retryAfter ?? "").trim();
      const seconds = header ? Number(header) : NaN;
      const requestedMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now();
      const delay = Math.max(Math.min(baseMs * 2 ** (attempts - 1), maxMs), requestedMs || 0);
      const until = Math.max(previous?.until || 0, now() + delay);
      providers.set(provider, { attempts, until });
      return rateLimitError(provider, until - now());
    },
    succeeded(provider) {
      // A concurrent success must not cancel a cooldown set by another request.
      if ((providers.get(provider)?.until || 0) <= now()) providers.delete(provider);
    },
  };
};

module.exports = { createCourierCooldown };
