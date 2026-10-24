// Some MySQL/MariaDB drivers return JSON columns as serialized strings.
const normalizeCrossProducts = (value) => {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((product) => product && Number.isSafeInteger(Number(product.Id))
    && Number(product.Id) > 0 && typeof product.name === "string")
    .map((product) => ({ Id: Number(product.Id), name: product.name }));
};

module.exports = { normalizeCrossProducts };
