const { getWebsiteDeliveryCharge } = require("../order/orderPricing");

// The customer pays the delivery charge for a prize, so the courier collects it
// as COD. The amounts are the website's own inside/outside Dhaka charges.
const DELIVERY_AREAS = ["inside", "outside"];

// The claim form has a free-text address and no district. Dhaka anywhere in it
// counts as inside Dhaka, as the storefront treats Dhaka district; an admin can
// override a wrong guess per card (deliveryArea).
const DHAKA_PATTERN = /dhaka|ঢাকা/i;
const detectArea = (address) => (DHAKA_PATTERN.test(String(address || "")) ? "inside" : "outside");

const effectiveArea = (card) =>
  DELIVERY_AREAS.includes(card.deliveryArea) ? card.deliveryArea : detectArea(card.address);

const getDeliveryCharges = async () => {
  const [inside, outside] = await Promise.all([
    getWebsiteDeliveryCharge("dhaka"),
    getWebsiteDeliveryCharge("outside"),
  ]);
  return { inside, outside };
};

const chargeFor = (card, charges) => charges[effectiveArea(card)];

module.exports = { DELIVERY_AREAS, effectiveArea, getDeliveryCharges, chargeFor };
