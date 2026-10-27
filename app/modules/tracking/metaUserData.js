const crypto = require("crypto");

// Builds Conversions API user_data following Meta's customer information
// parameter rules: personal fields are normalized then SHA-256 hashed; fbp, fbc,
// IP and user agent are sent as-is. Missing fields are omitted, never invented.

const SHA256 = /^[a-f0-9]{64}$/;

const sha256 = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value);
  // Already hashed (e.g. a stored outbox payload) — don't hash twice.
  if (SHA256.test(text)) return text;
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
};

const normalizeEmail = (value) => {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
};

// Bangladesh mobiles: 01XXXXXXXXX / 1XXXXXXXXX / +8801XXXXXXXXX → 8801XXXXXXXXX.
const normalizePhone = (value) => {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^01\d{9}$/.test(digits)) digits = `88${digits}`;
  else if (/^1\d{9}$/.test(digits)) digits = `880${digits}`;
  return /^8801\d{9}$/.test(digits) ? digits : undefined;
};

// Lowercase, letters only. Unicode letters and marks (e.g. Bangla) are kept.
const normalizeNamePart = (value) => {
  const part = String(value || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
  return part || undefined;
};

// "MD. Mohsin Kabir" → fn "md", ln "kabir"; a single word is only a first name.
const splitName = (fullName) => {
  const words = String(fullName || "").trim().split(/\s+/).map(normalizeNamePart).filter(Boolean);
  if (!words.length) return {};
  return words.length === 1 ? { fn: words[0] } : { fn: words[0], ln: words[words.length - 1] };
};

const normalizeCity = (value) => {
  const city = String(value || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  // The checkout's "inside"/"outside" Dhaka choice is a delivery zone, not a city.
  if (!city || ["inside", "outside", "insidedhaka", "outsidedhaka"].includes(city)) return undefined;
  return city;
};

const normalizeZip = (value) => {
  const zip = String(value || "").trim().toLowerCase().replace(/\s/g, "");
  return /^[a-z0-9-]{3,10}$/.test(zip) ? zip : undefined;
};

const normalizeFbp = (value) => {
  const fbp = String(value || "").trim();
  return /^fb\.\d\.\d+\.\d+$/.test(fbp) ? fbp : undefined;
};

const normalizeFbc = (value) => {
  const fbc = String(value || "").trim();
  return /^fb\.\d\.\d+\.[\w-]+$/.test(fbc) && fbc.length <= 500 ? fbc : undefined;
};

const asArray = (value) => (value ? [value] : undefined);

/**
 * @param {object} input raw customer data: email, phone, name or firstName/lastName,
 *   city, state, zip, country (ISO-2), externalId, fbp, fbc, ipAddress, userAgent
 */
const buildUserData = (input = {}) => {
  const names = input.firstName || input.lastName
    ? { fn: normalizeNamePart(input.firstName), ln: normalizeNamePart(input.lastName) }
    : splitName(input.name);
  const country = String(input.country || "").trim().toLowerCase();
  const userData = {
    em: asArray(sha256(normalizeEmail(input.email))),
    ph: asArray(sha256(normalizePhone(input.phone))),
    fn: asArray(sha256(names.fn)),
    ln: asArray(sha256(names.ln)),
    ct: asArray(sha256(normalizeCity(input.city))),
    st: asArray(sha256(normalizeCity(input.state))),
    zp: asArray(sha256(normalizeZip(input.zip))),
    country: asArray(sha256(/^[a-z]{2}$/.test(country) ? country : undefined)),
    external_id: asArray(sha256(input.externalId ? String(input.externalId).trim() : undefined)),
    fbp: normalizeFbp(input.fbp),
    fbc: normalizeFbc(input.fbc),
    client_ip_address: input.ipAddress || undefined,
    client_user_agent: input.userAgent ? String(input.userAgent).slice(0, 500) : undefined,
  };
  return Object.fromEntries(Object.entries(userData).filter(([, value]) => value !== undefined));
};

module.exports = {
  buildUserData,
  sha256,
  normalizeEmail,
  normalizePhone,
  normalizeNamePart,
  splitName,
  normalizeFbp,
  normalizeFbc,
};
