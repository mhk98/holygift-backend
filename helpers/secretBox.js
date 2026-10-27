const crypto = require("crypto");

// Encrypts third-party secrets (e.g. Meta access tokens) before they are stored.
// TRACKING_SECRET_KEY is 32 bytes as 64 hex chars or base64. Without it, values
// are stored as-is so existing installs keep working until the key is set.
const PREFIX = "enc:v1:";
let warned = false;

const getKey = () => {
  const raw = String(process.env.TRACKING_SECRET_KEY || "").trim();
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TRACKING_SECRET_KEY must be 32 bytes (64 hex chars or base64)");
  return key;
};

const isEncrypted = (value) => typeof value === "string" && value.startsWith(PREFIX);

const encrypt = (plain) => {
  if (plain === null || plain === undefined || plain === "") return plain;
  if (isEncrypted(plain)) return plain;
  const key = getKey();
  if (!key) {
    if (!warned) {
      console.warn("TRACKING_SECRET_KEY is not set; access tokens are stored unencrypted");
      warned = true;
    }
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
};

const decrypt = (stored) => {
  if (!isEncrypted(stored)) return stored;
  const key = getKey();
  if (!key) throw new Error("TRACKING_SECRET_KEY is required to read an encrypted secret");
  const [iv, tag, data] = stored.slice(PREFIX.length).split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};

// "••••1a2b" — enough for an admin to tell tokens apart without revealing them.
const mask = (stored) => {
  if (!stored) return null;
  try {
    const plain = decrypt(stored);
    return plain ? `••••${plain.slice(-4)}` : null;
  } catch {
    return "•••• (unreadable)";
  }
};

module.exports = { encrypt, decrypt, isEncrypted, mask };
