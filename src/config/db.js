const { Pool } = require("pg");
const dotenv = require("dotenv");

dotenv.config();

function shouldUseSsl(connectionString) {
  const sslMode = String(process.env.PGSSLMODE || "").toLowerCase();
  if (["disable", "false", "off"].includes(sslMode)) return false;
  if (["require", "true", "on"].includes(sslMode)) return { rejectUnauthorized: false };
  if (process.env.NODE_ENV === "production") return { rejectUnauthorized: false };

  try {
    const { hostname } = new URL(connectionString);
    const isLocalDatabase = ["localhost", "127.0.0.1", "::1"].includes(hostname);
    return isLocalDatabase ? false : { rejectUnauthorized: false };
  } catch (_err) {
    return false;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: shouldUseSsl(process.env.DATABASE_URL),
});

module.exports = { pool };
