const { Op } = require("sequelize");
const { normalizeCrossProducts } = require("./scratchCard.crossProducts");
const { variationSalePrice } = require("../../../shared/productVariants");

// Resolve current selling prices in one query, including selections saved before prices were shown.
const withCrossProductPrices = async (cards) => {
  const normalized = cards.map((row) => { const card = typeof row.get === "function" ? row.get({ plain: true }) : row; return ({ ...card, crossProducts: normalizeCrossProducts(card.crossProducts) }); });
  const ids = [...new Set(normalized.flatMap((card) => card.crossProducts.map((product) => product.Id)))];
  if (!ids.length) return normalized;
  const variations = await require("../../../models").variation.findAll({
    where: { productId: { [Op.in]: ids } },
    attributes: ["productId", "newPrice", "oldPrice"],
  });
  const prices = new Map();
  for (const variation of variations) {
    const price = variationSalePrice(variation);
    if (!(price > 0)) continue;
    const id = Number(variation.productId);
    const range = prices.get(id);
    prices.set(id, { priceMin: Math.min(range?.priceMin ?? price, price), priceMax: Math.max(range?.priceMax ?? price, price) });
  }
  return normalized.map((card) => ({ ...card, crossProducts: card.crossProducts.map((product) => ({
    ...product, ...(prices.get(product.Id) || { priceMin: null, priceMax: null }),
  })) }));
};

const collectionTotal = (card, deliveryCharge) => {
  let total = Number(deliveryCharge);
  for (const product of card.crossProducts || []) {
    if (product.priceMin == null || product.priceMax !== product.priceMin) return null;
    total += Number(product.priceMin);
  }
  return Math.round(total * 100) / 100;
};
module.exports = { withCrossProductPrices, collectionTotal };
