const path = require("path");
const crypto = require("crypto");
const express = require("express");
const dayjs = require("dayjs");
const { pool } = require("./config/db");
const { toNumber } = require("./services/calculations");

const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/vendor/chart.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "../node_modules/chart.js/dist/chart.umd.js"));
});
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.authEnabled = true;
  next();
});

function isApiRequest(req) {
  return req.get("X-Requested-With") === "fetch" || req.accepts(["html", "json"]) === "json";
}

function getCookieSecret() {
  return process.env.COOKIE_SECRET || process.env.DATABASE_URL || "family-asset-local-secret";
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...valueParts] = part.split("=");
        return [key, decodeURIComponent(valueParts.join("=") || "")];
      })
  );
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", getCookieSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", getCookieSecret()).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.exp && Date.now() < payload.exp ? payload : null;
  } catch (_err) {
    return null;
  }
}

function setAuthCookie(res, admin) {
  const token = signSession({
    adminId: admin.id,
    email: admin.email,
    isAdmin: Boolean(admin.is_admin),
    exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
  });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `asset_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", "asset_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function safeRedirectPath(value) {
  const nextPath = String(value || "");
  return nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [method, salt, hash] = String(storedHash || "").split(":");
  if (method !== "scrypt" || !salt || !hash) return false;
  const actual = Buffer.from(crypto.scryptSync(String(password), salt, 64).toString("base64url"));
  const expected = Buffer.from(hash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function hasAdminUser() {
  const result = await pool.query("SELECT EXISTS (SELECT 1 FROM admin_users) AS exists");
  return Boolean(result.rows[0]?.exists);
}

async function findAdminByEmail(email) {
  const result = await pool.query("SELECT * FROM admin_users WHERE lower(email) = lower($1) LIMIT 1", [email]);
  return result.rows[0] || null;
}

async function findAdminById(id) {
  const result = await pool.query("SELECT * FROM admin_users WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] || null;
}

async function createAdminUser(email, password, isAdmin = false) {
  const result = await pool.query(
    `INSERT INTO admin_users (email, password_hash, is_admin)
     VALUES ($1, $2, $3)
     RETURNING id, email, is_admin`,
    [normalizeEmail(email), hashPassword(password), Boolean(isAdmin)]
  );
  return result.rows[0];
}

async function updateAdminPassword(adminId, password) {
  await pool.query(
    `UPDATE admin_users
     SET password_hash = $1, updated_at = NOW()
     WHERE id = $2`,
    [hashPassword(password), adminId]
  );
}

async function requireAuth(req, res, next) {
  if (req.path === "/healthz" || req.path === "/login" || req.path === "/admin/setup" || req.path.startsWith("/vendor/")) {
    return next();
  }

  let adminExists = false;
  try {
    adminExists = await hasAdminUser();
  } catch (err) {
    return next(err);
  }

  if (!adminExists) {
    if (isApiRequest(req)) {
      return res.status(428).json({ ok: false, message: "请先创建管理员账号" });
    }
    return res.redirect("/admin/setup");
  }

  const cookies = parseCookies(req.headers.cookie || "");
  const session = verifySession(cookies.asset_session);
  if (session) {
    try {
      const admin = await findAdminById(session.adminId);
      if (admin) {
        req.currentAdmin = {
          adminId: admin.id,
          email: admin.email,
          isAdmin: Boolean(admin.is_admin),
        };
        res.locals.currentAdmin = req.currentAdmin;
        return next();
      }
    } catch (err) {
      return next(err);
    }
  }
  if (isApiRequest(req)) {
    return res.status(401).json({ ok: false, message: "请先登录" });
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
}

app.get("/admin/setup", async (req, res, next) => {
  try {
    if (await hasAdminUser()) return res.redirect("/login");
    res.render("admin_setup", { title: "创建管理员", error: "", email: "" });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/setup", async (req, res, next) => {
  try {
    if (await hasAdminUser()) return res.redirect("/login");
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const passwordConfirm = String(req.body.password_confirm || "");

    if (!isValidEmail(email)) {
      return res.status(400).render("admin_setup", { title: "创建管理员", error: "请输入有效的邮箱地址。", email });
    }
    if (password.length < 8) {
      return res.status(400).render("admin_setup", { title: "创建管理员", error: "密码至少需要 8 位。", email });
    }
    if (password !== passwordConfirm) {
      return res.status(400).render("admin_setup", { title: "创建管理员", error: "两次输入的密码不一致。", email });
    }

    const admin = await createAdminUser(email, password, true);
    setAuthCookie(res, admin);
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});

app.get("/login", async (req, res, next) => {
  try {
    if (!(await hasAdminUser())) return res.redirect("/admin/setup");
    const cookies = parseCookies(req.headers.cookie || "");
    if (verifySession(cookies.asset_session)) return res.redirect(safeRedirectPath(req.query.next));
    res.render("login", {
      title: "登录",
      error: "",
      email: "",
      next: req.query.next || "",
    });
  } catch (err) {
    next(err);
  }
});

app.post("/login", async (req, res, next) => {
  try {
    if (!(await hasAdminUser())) return res.redirect("/admin/setup");
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const admin = await findAdminByEmail(email);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      return res.status(401).render("login", {
        title: "登录",
        error: "邮箱或密码不正确。",
        email,
        next: req.body.next || "",
      });
    }

    setAuthCookie(res, admin);
    res.redirect(safeRedirectPath(req.body.next));
  } catch (err) {
    next(err);
  }
});

app.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.redirect("/login");
});

app.use(requireAuth);

function currentUserId(req) {
  return Number(req.currentAdmin?.adminId);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function requireAdmin(req, _res, next) {
  if (!req.currentAdmin?.isAdmin) return next(httpError(403, "仅管理员可以访问"));
  next();
}

async function getAdminUsers() {
  const result = await pool.query(
    `SELECT id, email, is_admin, created_at, updated_at
     FROM admin_users
     ORDER BY is_admin DESC, id ASC`
  );
  return result.rows;
}

function validatePasswordChange({ currentPassword, newPassword, passwordConfirm }) {
  const errors = [];
  if (!currentPassword) errors.push("请输入当前密码。");
  if (String(newPassword || "").length < 8) errors.push("新密码至少需要 8 位。");
  if (newPassword !== passwordConfirm) errors.push("两次输入的新密码不一致。");
  return errors;
}

function validateNewUserPayload({ email, password, passwordConfirm }) {
  const errors = [];
  if (!isValidEmail(email)) errors.push("请输入有效的邮箱地址。");
  if (String(password || "").length < 8) errors.push("密码至少需要 8 位。");
  if (password !== passwordConfirm) errors.push("两次输入的密码不一致。");
  return errors;
}

app.get("/admin/users", requireAdmin, async (req, res, next) => {
  try {
    res.render("admin_users", {
      title: "用户管理",
      users: await getAdminUsers(),
      message: req.query.created ? "用户已创建。" : "",
      error: "",
      email: "",
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/users", requireAdmin, async (req, res, next) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const passwordConfirm = String(req.body.password_confirm || "");
  try {
    const errors = validateNewUserPayload({ email, password, passwordConfirm });
    if (errors.length) {
      return res.status(400).render("admin_users", {
        title: "用户管理",
        users: await getAdminUsers(),
        message: "",
        error: errors.join(" "),
        email,
      });
    }

    await createAdminUser(email, password, false);
    res.redirect("/admin/users?created=1");
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).render("admin_users", {
        title: "用户管理",
        users: await getAdminUsers(),
        message: "",
        error: "该邮箱已存在。",
        email,
      });
    }
    next(err);
  }
});

app.get("/account/password", (req, res) => {
  res.render("change_password", {
    title: "修改密码",
    message: "",
    error: "",
  });
});

app.post("/account/password", async (req, res, next) => {
  try {
    const currentPassword = String(req.body.current_password || "");
    const newPassword = String(req.body.new_password || "");
    const passwordConfirm = String(req.body.password_confirm || "");
    const errors = validatePasswordChange({ currentPassword, newPassword, passwordConfirm });
    if (errors.length) {
      return res.status(400).render("change_password", { title: "修改密码", message: "", error: errors.join(" ") });
    }

    const admin = await findAdminById(currentUserId(req));
    if (!admin || !verifyPassword(currentPassword, admin.password_hash)) {
      return res.status(400).render("change_password", { title: "修改密码", message: "", error: "当前密码不正确。" });
    }

    await updateAdminPassword(admin.id, newPassword);
    res.render("change_password", { title: "修改密码", message: "密码已更新。", error: "" });
  } catch (err) {
    next(err);
  }
});

async function getPeriods(userId) {
  const result = await pool.query("SELECT * FROM snapshot_periods WHERE user_id = $1 ORDER BY period_date DESC", [userId]);
  return result.rows;
}

async function getConfig(userId, includeInactive = false) {
  const itemFilter = includeInactive ? "WHERE i.user_id = $1" : "WHERE i.user_id = $1 AND i.is_active = TRUE";
  const memberFilter = includeInactive ? "WHERE user_id = $1" : "WHERE user_id = $1 AND is_active = TRUE";
  const [membersRes, itemsRes] = await Promise.all([
    pool.query(`SELECT * FROM members ${memberFilter} ORDER BY is_active DESC, id ASC`, [userId]),
    pool.query(
      `SELECT i.*, m.name AS owner_member_name
       FROM tracking_items i
       LEFT JOIN members m ON m.id = i.owner_member_id AND m.user_id = i.user_id
       ${itemFilter}
       ORDER BY i.is_active DESC, i.owner_member_id NULLS LAST, i.id ASC`,
      [userId]
    ),
  ]);

  return {
    members: membersRes.rows,
    items: itemsRes.rows,
  };
}

function parseItemIdSet(value, validItemIds) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((itemId) => Number.isInteger(itemId) && validItemIds.has(itemId))
  );
}

async function getTrendExcludedItemIds(userId) {
  const result = await pool.query("SELECT trend_excluded_item_ids FROM admin_users WHERE id = $1", [userId]);
  return result.rows[0]?.trend_excluded_item_ids || [];
}

async function saveTrendExcludedItemIds(userId, excludedItemIds) {
  await pool.query(
    `UPDATE admin_users
     SET trend_excluded_item_ids = $1::int[], updated_at = NOW()
     WHERE id = $2`,
    [excludedItemIds, userId]
  );
}

async function getLatestPeriodValues(userId, periodId) {
  const result = await pool.query(
    `SELECT v.amount, i.kind, i.asset_group, i.name, i.owner_member_id, m.name AS member_name
     FROM snapshot_values v
     JOIN snapshot_periods p ON p.id = v.period_id
     JOIN tracking_items i ON i.id = v.item_id
     LEFT JOIN members m ON m.id = i.owner_member_id AND m.user_id = i.user_id
     WHERE v.period_id = $1
       AND p.user_id = $2
       AND i.user_id = $2`,
    [periodId, userId]
  );
  return result.rows;
}

function formatDate(value) {
  return dayjs(value).format("YYYY-MM-DD");
}

async function getPeriodSnapshot(userId, periodId) {
  const [periodRes, valuesRes] = await Promise.all([
    pool.query("SELECT * FROM snapshot_periods WHERE id = $1 AND user_id = $2", [periodId, userId]),
    pool.query(
      `SELECT v.item_id, v.amount
       FROM snapshot_values v
       JOIN snapshot_periods p ON p.id = v.period_id
       JOIN tracking_items i ON i.id = v.item_id
       WHERE v.period_id = $1
         AND p.user_id = $2
         AND i.user_id = $2`,
      [periodId, userId]
    ),
  ]);
  if (!periodRes.rows.length) return null;
  return {
    period: periodRes.rows[0],
    values: Object.fromEntries(valuesRes.rows.map((row) => [Number(row.item_id), toNumber(row.amount)])),
  };
}

async function getBackupData(userId) {
  const [members, items, periods, values] = await Promise.all([
    pool.query("SELECT id, name, is_active, created_at FROM members WHERE user_id = $1 ORDER BY id ASC", [userId]),
    pool.query(
      `SELECT id, name, kind, asset_group, owner_member_id, is_active, created_at
       FROM tracking_items
       WHERE user_id = $1
       ORDER BY id ASC`,
      [userId]
    ),
    pool.query("SELECT id, period_date, stock_pnl_manual, note, created_at FROM snapshot_periods WHERE user_id = $1 ORDER BY period_date ASC", [userId]),
    pool.query(
      `SELECT v.id, v.period_id, v.item_id, v.amount, v.created_at
       FROM snapshot_values v
       JOIN snapshot_periods p ON p.id = v.period_id
       JOIN tracking_items i ON i.id = v.item_id
       WHERE p.user_id = $1
         AND i.user_id = $1
       ORDER BY v.period_id ASC, v.item_id ASC`,
      [userId]
    ),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    members: members.rows,
    trackingItems: items.rows,
    snapshotPeriods: periods.rows.map((row) => ({ ...row, period_date: formatDate(row.period_date) })),
    snapshotValues: values.rows,
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function buildSnapshotsCsv(userId) {
  const result = await pool.query(
    `SELECT
      p.period_date,
      p.note,
      p.stock_pnl_manual,
      i.name AS item_name,
      i.kind,
      i.asset_group,
      m.name AS owner_member_name,
      v.amount
     FROM snapshot_periods p
     JOIN snapshot_values v ON v.period_id = p.id
     JOIN tracking_items i ON i.id = v.item_id
     LEFT JOIN members m ON m.id = i.owner_member_id AND m.user_id = i.user_id
     WHERE p.user_id = $1
       AND i.user_id = $1
     ORDER BY p.period_date ASC, i.id ASC`
    ,
    [userId]
  );
  const rows = [["period_date", "note", "stock_pnl_manual", "item_name", "kind", "asset_group", "owner", "amount"]];
  for (const row of result.rows) {
    rows.push([
      formatDate(row.period_date),
      row.note || "",
      row.stock_pnl_manual,
      row.item_name,
      row.kind,
      row.asset_group || "",
      row.owner_member_name || "共同",
      row.amount,
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function ensureArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  return value;
}

function validateEntryPayload(body) {
  const errors = [];
  const periodDate = String(body.period_date || "").trim();
  const parsedDate = new Date(`${periodDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== periodDate) {
    errors.push("请选择有效的统计日期。");
  }

  const numericFields = Object.keys(body).filter((key) => key === "stock_pnl_manual" || key.startsWith("item_"));
  let hasNonZeroAmount = false;
  for (const field of numericFields) {
    const raw = String(body[field] ?? "").trim();
    if (raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      errors.push("金额字段只能填写数字。");
      break;
    }
    if (value !== 0) hasNonZeroAmount = true;
  }
  if (!hasNonZeroAmount) {
    errors.push("请至少填写一个非零金额，避免保存空快照。");
  }

  return errors;
}

function buildTrendAnomalies(trendData, { isMemberView }) {
  const anomalies = [];
  if (!trendData.length) return anomalies;

  if (trendData.length < 2) {
    anomalies.push({
      level: "info",
      message: "当前只有一期快照，净资产变化、总支出、隐含支出和投资净投入需要至少两期数据才能可靠计算。",
    });
  }

  if (isMemberView) {
    anomalies.push({
      level: "info",
      message: "个人视角仅统计归属该成员的科目，不分摊共同资产、共同负债；期级投资收益暂不归属到个人。",
    });
  }

  const latest = trendData[trendData.length - 1];
  const previous = trendData[trendData.length - 2] || null;
  if (!previous) return anomalies;

  if (latest.totalExpense !== null && latest.totalExpense < 0) {
    anomalies.push({
      level: "warning",
      message: "本期总支出为负，资产增长可能无法由收入和投资收益解释，请复核资产、负债、收入和投资收益录入。",
    });
  }

  if (latest.implicitExpense !== null && latest.implicitExpense < 0) {
    anomalies.push({
      level: "warning",
      message: "本期隐含支出为负，可能存在收入、投资收益、市值或资产负债录入不一致。",
    });
  }

  const previousNetAssets = previous.netAssets;
  if (previousNetAssets !== 0 && latest.periodChange !== null) {
    const netAssetChangeRate = Math.abs(latest.periodChange / previousNetAssets);
    if (Math.abs(latest.periodChange) >= 10000 && netAssetChangeRate > 0.3) {
      anomalies.push({
        level: "warning",
        message: "本期净资产较上期波动超过 30%，建议复核是否存在漏填、重复填或一次性大额变动。",
      });
    }
  }

  if (latest.stockNetFlow !== null) {
    const marketValueChange = latest.stockMarketValueChange ?? 0;
    if (Math.abs(latest.stockNetFlow) >= Math.max(Math.abs(marketValueChange) * 0.8, 10000)) {
      anomalies.push({
        level: "warning",
        message: "本期投资净投入较大，请确认是否存在追加、赎回，或投资收益、市值录入偏差。",
      });
    }
    if (latest.stockPnl === 0 && Math.abs(marketValueChange) >= 10000) {
      anomalies.push({
        level: "warning",
        message: "投资市值变化明显但本期投资收益为 0，请确认是否已录入本期投资盈亏。",
      });
    }
  }

  return anomalies;
}

async function resetSequence(client, tableName) {
  await client.query(`SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE((SELECT MAX(id) FROM ${tableName}), 1), true)`);
}

async function importBackupData(userId, data) {
  const members = ensureArray(data.members, "members");
  const items = ensureArray(data.trackingItems, "trackingItems");
  const periods = ensureArray(data.snapshotPeriods, "snapshotPeriods");
  const values = ensureArray(data.snapshotValues, "snapshotValues");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM snapshot_values v
       USING snapshot_periods p
       WHERE v.period_id = p.id
         AND p.user_id = $1`,
      [userId]
    );
    await client.query("DELETE FROM snapshot_periods WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM tracking_items WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM members WHERE user_id = $1", [userId]);

    const memberIdMap = new Map();
    for (const member of members) {
      const inserted = await client.query(
        `INSERT INTO members (user_id, name, is_active, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamp, NOW()))
         RETURNING id`,
        [userId, String(member.name || "").trim(), member.is_active !== false, member.created_at || null]
      );
      memberIdMap.set(Number(member.id), Number(inserted.rows[0].id));
    }

    const itemIdMap = new Map();
    for (const item of items) {
      const inserted = await client.query(
        `INSERT INTO tracking_items (user_id, name, kind, asset_group, owner_member_id, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamp, NOW()))
         RETURNING id`,
        [
          userId,
          String(item.name || "").trim(),
          item.kind,
          item.kind === "asset" ? item.asset_group || "other" : null,
          item.owner_member_id ? memberIdMap.get(Number(item.owner_member_id)) || null : null,
          item.is_active !== false,
          item.created_at || null,
        ]
      );
      itemIdMap.set(Number(item.id), Number(inserted.rows[0].id));
    }

    const periodIdMap = new Map();
    for (const period of periods) {
      const inserted = await client.query(
        `INSERT INTO snapshot_periods (user_id, period_date, note, stock_pnl_manual, created_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, NOW()))
         RETURNING id`,
        [userId, period.period_date, period.note || "", toNumber(period.stock_pnl_manual), period.created_at || null]
      );
      periodIdMap.set(Number(period.id), Number(inserted.rows[0].id));
    }

    for (const value of values) {
      const periodId = periodIdMap.get(Number(value.period_id));
      const itemId = itemIdMap.get(Number(value.item_id));
      if (!periodId || !itemId) continue;
      await client.query(
        `INSERT INTO snapshot_values (period_id, item_id, amount, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamp, NOW()))`,
        [periodId, itemId, toNumber(value.amount), value.created_at || null]
      );
    }

    await resetSequence(client, "members");
    await resetSequence(client, "tracking_items");
    await resetSequence(client, "snapshot_periods");
    await resetSequence(client, "snapshot_values");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function resolveOwnerMemberId(db, userId, value) {
  if (!value) return null;
  const id = Number(value);
  if (!Number.isInteger(id)) throw httpError(400, "无效的成员归属");
  const result = await db.query("SELECT id FROM members WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!result.rows.length) throw httpError(400, "无效的成员归属");
  return id;
}

app.get("/", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const config = await getConfig(userId);
    if (!config.members.length || !config.items.length) {
      return res.render("overview", {
        title: "总览",
        setupRequired: true,
        latest: null,
        stats: null,
        memberTotals: [],
        members: config.members,
        viewMode: "family",
        selectedMemberId: 0,
      });
    }

    const periods = await getPeriods(userId);
    if (!periods.length) {
      return res.render("overview", {
        title: "总览",
        setupRequired: false,
        latest: null,
        stats: null,
        memberTotals: [],
        members: config.members,
        viewMode: "family",
        selectedMemberId: 0,
      });
    }

    const latestValuesAll = await getLatestPeriodValues(userId, periods[0].id);
    const previousValuesAll = periods[1] ? await getLatestPeriodValues(userId, periods[1].id) : [];
    const viewMode = req.query.view === "member" ? "member" : "family";
    const selectedMemberId = Number(req.query.member_id || 0);
    const memberExists = config.members.some((m) => m.id === selectedMemberId);
    const effectiveViewMode = viewMode === "member" && memberExists ? "member" : "family";
    const isIncluded = (row) => {
      if (effectiveViewMode === "family") return true;
      return row.owner_member_id === selectedMemberId;
    };
    const latestValues = latestValuesAll.filter(isIncluded);
    const previousValues = previousValuesAll.filter(isIncluded);

    const latestAssets = latestValues
      .filter((row) => row.kind === "asset")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const latestLiabilities = latestValues
      .filter((row) => row.kind === "liability")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const latestIncome = latestValues
      .filter((row) => row.kind === "income")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const latestExpenseManual = latestValues
      .filter((row) => row.kind === "expense")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);

    const previousAssets = previousValues
      .filter((row) => row.kind === "asset")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const previousLiabilities = previousValues
      .filter((row) => row.kind === "liability")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);

    const householdNetAssets = latestAssets - latestLiabilities;
    const previousNetAssets = previousAssets - previousLiabilities;
    const hasPreviousPeriod = Boolean(periods[1]);
    const latestStockPnlManual = toNumber(periods[0].stock_pnl_manual);
    const periodChange = householdNetAssets - previousNetAssets;
    const totalExpense = hasPreviousPeriod ? latestIncome + latestStockPnlManual - periodChange : null;
    const implicitExpense = totalExpense === null ? null : totalExpense - latestExpenseManual;

    const memberTotals = config.members.map((member) => {
      const memberRows = latestValuesAll.filter((row) => row.owner_member_id === member.id);
      const income = memberRows
        .filter((row) => row.kind === "income")
        .reduce((acc, row) => acc + toNumber(row.amount), 0);
      const assets = memberRows
        .filter((row) => row.kind === "asset")
        .reduce((acc, row) => acc + toNumber(row.amount), 0);
      const liabilities = memberRows
        .filter((row) => row.kind === "liability")
        .reduce((acc, row) => acc + toNumber(row.amount), 0);
      return {
        member: member.name,
        totalIncome: income,
        totalAssets: assets,
        totalLiabilities: liabilities,
        netAssets: assets - liabilities,
      };
    });

    const stats = {
      householdNetAssets,
      periodChange,
      totalIncome: latestIncome,
      totalExpenseManual: latestExpenseManual,
      totalExpense,
      implicitExpense,
      stockPnlManual: latestStockPnlManual,
      totalAssets: latestAssets,
      totalLiabilities: latestLiabilities,
    };

    res.render("overview", {
      title: "总览",
      setupRequired: false,
      latest: periods[0],
      stats,
      memberTotals,
      members: config.members,
      viewMode: effectiveViewMode,
      selectedMemberId,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/backup", (_req, res) => {
  res.render("backup", { title: "备份", message: "", error: "" });
});

app.get("/backup/export.json", async (req, res, next) => {
  try {
    const data = await getBackupData(currentUserId(req));
    const filename = `family-asset-backup-${dayjs().format("YYYYMMDD-HHmmss")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
});

app.get("/backup/export.csv", async (req, res, next) => {
  try {
    const csv = await buildSnapshotsCsv(currentUserId(req));
    const filename = `family-asset-snapshots-${dayjs().format("YYYYMMDD-HHmmss")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    next(err);
  }
});

app.post("/backup/import", async (req, res) => {
  try {
    const userId = currentUserId(req);
    const raw = String(req.body.backup_json || "").trim();
    if (!raw) {
      return res.status(400).render("backup", { title: "备份", message: "", error: "请粘贴 JSON 备份内容。" });
    }
    const data = JSON.parse(raw);
    await importBackupData(userId, data);
    res.render("backup", { title: "备份", message: "备份已导入，数据已恢复。", error: "" });
  } catch (err) {
    res.status(400).render("backup", { title: "备份", message: "", error: err.message || "导入失败，请检查备份内容。" });
  }
});

app.get("/setup", async (req, res, next) => {
  try {
    const config = await getConfig(currentUserId(req), true);
    res.render("setup", { title: "Setup", config });
  } catch (err) {
    next(err);
  }
});

app.post("/setup/members", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const names = String(req.body.member_names || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (names.length) {
      await pool.query(
        `INSERT INTO members (user_id, name)
         SELECT $1, name
         FROM (
           SELECT DISTINCT ON (lower(btrim(name))) btrim(name) AS name
           FROM unnest($2::text[]) AS name
           WHERE length(btrim(name)) > 0
         ) incoming
         WHERE NOT EXISTS (
           SELECT 1 FROM members m
           WHERE m.user_id = $1
             AND lower(btrim(m.name)) = lower(btrim(incoming.name))
         )`,
        [userId, names]
      );
    }

    const config = await getConfig(userId, true);
    if (isApiRequest(req)) {
      return res.json({ ok: true, config });
    }
    res.redirect("/setup");
  } catch (err) {
    next(err);
  }
});

app.post("/setup/members/batch-save", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = currentUserId(req);
    const members = Array.isArray(req.body.members) ? req.body.members : [];
    await client.query("BEGIN");

    let updatedCount = 0;
    let deletedCount = 0;
    const skippedDeleteIds = [];

    for (const raw of members) {
      const id = Number(raw.id);
      if (!Number.isInteger(id)) continue;

      if (Boolean(raw.marked_for_delete)) {
        const usageRes = await client.query("SELECT COUNT(*)::int AS cnt FROM tracking_items WHERE owner_member_id = $1 AND user_id = $2", [id, userId]);
        const usageCount = Number(usageRes.rows[0]?.cnt || 0);
        if (usageCount > 0) {
          skippedDeleteIds.push(id);
          continue;
        }
        const delRes = await client.query("DELETE FROM members WHERE id = $1 AND user_id = $2", [id, userId]);
        if (delRes.rowCount > 0) deletedCount += 1;
        continue;
      }

      const name = String(raw.name || "").trim();
      const isActive = raw.is_active !== false;
      if (!name) continue;

      const upRes = await client.query(
        `UPDATE members
         SET name = $1, is_active = $2
         WHERE id = $3 AND user_id = $4`,
        [name, isActive, id, userId]
      );
      if (upRes.rowCount > 0) updatedCount += 1;
    }

    await client.query("COMMIT");
    const config = await getConfig(userId, true);
    return res.json({
      ok: true,
      config,
      updatedCount,
      deletedCount,
      skippedDeleteCount: skippedDeleteIds.length,
      skippedDeleteIds,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, message: "存在同名成员，请调整后再保存" });
    }
    next(err);
  } finally {
    client.release();
  }
});

app.post("/setup/items", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const itemName = String(req.body.item_name || "").trim();
    const kind = req.body.kind;
    const assetGroup = kind === "asset" ? req.body.asset_group || "other" : null;
    const ownerMemberId = await resolveOwnerMemberId(pool, userId, req.body.owner_member_id);
    const returnTo = req.body.return_to === "/entry" ? "/entry" : "/setup";

    await pool.query(
      `INSERT INTO tracking_items (user_id, name, kind, asset_group, owner_member_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, itemName, kind, assetGroup, ownerMemberId]
    );
    const config = await getConfig(userId, true);
    if (isApiRequest(req)) {
      return res.json({ ok: true, config });
    }
    res.redirect(returnTo);
  } catch (err) {
    if (err?.code === "23505") {
      if (isApiRequest(req)) {
        return res.status(409).json({ ok: false, message: "同一归属下已存在同名同分类科目" });
      }
      return res.status(409).send("同一归属下已存在同名同分类科目");
    }
    next(err);
  }
});

app.get("/api/setup-config", async (req, res, next) => {
  try {
    const config = await getConfig(currentUserId(req), true);
    res.json({ ok: true, config });
  } catch (err) {
    next(err);
  }
});

app.post("/setup/items/:id/update", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const id = Number(req.params.id);
    const itemName = String(req.body.item_name || "").trim();
    const kind = req.body.kind;
    const assetGroup = kind === "asset" ? req.body.asset_group || "other" : null;
    const ownerMemberId = await resolveOwnerMemberId(pool, userId, req.body.owner_member_id);

    const result = await pool.query(
      `UPDATE tracking_items
       SET name = $1, kind = $2, asset_group = $3, owner_member_id = $4
       WHERE id = $5 AND user_id = $6`,
      [itemName, kind, assetGroup, ownerMemberId, id, userId]
    );
    if (!result.rowCount) throw httpError(404, "科目不存在");

    const config = await getConfig(userId, true);
    if (isApiRequest(req)) {
      return res.json({ ok: true, config });
    }
    res.redirect("/setup");
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, message: "同一归属下已存在同名同分类科目" });
    }
    next(err);
  }
});

app.post("/setup/items/:id/toggle-active", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const id = Number(req.params.id);
    const active = String(req.body.active) === "true";
    const result = await pool.query("UPDATE tracking_items SET is_active = $1 WHERE id = $2 AND user_id = $3", [active, id, userId]);
    if (!result.rowCount) throw httpError(404, "科目不存在");
    const config = await getConfig(userId, true);
    if (isApiRequest(req)) {
      return res.json({ ok: true, config });
    }
    res.redirect("/setup");
  } catch (err) {
    next(err);
  }
});

app.post("/setup/items/:id/delete", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const id = Number(req.params.id);
    const usageRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM snapshot_values v
       JOIN tracking_items i ON i.id = v.item_id
       WHERE v.item_id = $1
         AND i.user_id = $2`,
      [id, userId]
    );
    const usageCount = Number(usageRes.rows[0]?.cnt || 0);
    if (usageCount > 0) {
      return res.status(409).json({
        ok: false,
        message: "该科目已有历史记录，不能删除。你可以先停用。",
      });
    }

    const result = await pool.query("DELETE FROM tracking_items WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!result.rowCount) throw httpError(404, "科目不存在");
    const config = await getConfig(userId, true);
    if (isApiRequest(req)) {
      return res.json({ ok: true, config });
    }
    res.redirect("/setup");
  } catch (err) {
    next(err);
  }
});

app.post("/setup/items/bulk-delete", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => Number(x)).filter((x) => Number.isInteger(x)) : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, message: "未选择科目" });
    }

    const usageRes = await pool.query(
      `SELECT item_id, COUNT(*)::int AS cnt
       FROM snapshot_values v
       JOIN tracking_items i ON i.id = v.item_id
       WHERE v.item_id = ANY($1::int[])
         AND i.user_id = $2
       GROUP BY item_id`,
      [ids, userId]
    );
    const blockedIds = usageRes.rows.filter((r) => Number(r.cnt) > 0).map((r) => Number(r.item_id));
    const deletableIds = ids.filter((id) => !blockedIds.includes(id));

    if (deletableIds.length) {
      await pool.query("DELETE FROM tracking_items WHERE id = ANY($1::int[]) AND user_id = $2", [deletableIds, userId]);
    }

    const config = await getConfig(userId, true);
    return res.json({
      ok: true,
      config,
      deletedCount: deletableIds.length,
      blockedCount: blockedIds.length,
      blockedIds,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/setup/items/batch-save", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = currentUserId(req);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    await client.query("BEGIN");

    const skippedDeleteIds = [];
    let updatedCount = 0;
    let deletedCount = 0;

    for (const raw of items) {
      const id = Number(raw.id);
      if (!Number.isInteger(id)) continue;
      const markedForDelete = Boolean(raw.marked_for_delete);

      if (markedForDelete) {
        const usageRes = await client.query(
          `SELECT COUNT(*)::int AS cnt
           FROM snapshot_values v
           JOIN tracking_items i ON i.id = v.item_id
           WHERE v.item_id = $1
             AND i.user_id = $2`,
          [id, userId]
        );
        const usageCount = Number(usageRes.rows[0]?.cnt || 0);
        if (usageCount > 0) {
          skippedDeleteIds.push(id);
          continue;
        }
        const delRes = await client.query("DELETE FROM tracking_items WHERE id = $1 AND user_id = $2", [id, userId]);
        if (delRes.rowCount > 0) deletedCount += 1;
        continue;
      }

      const kind = String(raw.kind || "").trim();
      const name = String(raw.name || "").trim();
      const ownerMemberId = await resolveOwnerMemberId(client, userId, raw.owner_member_id);
      const isActive = raw.is_active !== false;
      const assetGroup = kind === "asset" ? String(raw.asset_group || "other").trim() : null;
      if (!name || !["asset", "liability", "income", "expense"].includes(kind)) continue;

      const upRes = await client.query(
        `UPDATE tracking_items
         SET name = $1, kind = $2, asset_group = $3, owner_member_id = $4, is_active = $5
         WHERE id = $6 AND user_id = $7`,
        [name, kind, assetGroup, ownerMemberId, isActive, id, userId]
      );
      if (upRes.rowCount > 0) updatedCount += 1;
    }

    await client.query("COMMIT");
    const config = await getConfig(userId, true);
    return res.json({
      ok: true,
      config,
      updatedCount,
      deletedCount,
      skippedDeleteCount: skippedDeleteIds.length,
      skippedDeleteIds,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, message: "存在同名冲突，请调整后再保存" });
    }
    next(err);
  } finally {
    client.release();
  }
});

app.post("/setup/templates/basic", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const membersRes = await pool.query("SELECT id, name FROM members WHERE user_id = $1 ORDER BY id ASC", [userId]);
    const members = membersRes.rows;

    const commonItems = [
      { name: "招商银行", kind: "asset", asset_group: "cash", owner_member_id: null },
      { name: "农业银行", kind: "asset", asset_group: "cash", owner_member_id: null },
      { name: "投资账户", kind: "asset", asset_group: "investment", owner_member_id: null },
      { name: "公积金余额", kind: "asset", asset_group: "housing_fund", owner_member_id: null },
      { name: "房贷", kind: "liability", asset_group: null, owner_member_id: null },
      { name: "信用卡应还", kind: "liability", asset_group: null, owner_member_id: null },
      { name: "家庭总支出", kind: "expense", asset_group: null, owner_member_id: null },
    ];

    const memberItems = members.flatMap((member) => [
      { name: "工资收入", kind: "income", asset_group: null, owner_member_id: member.id },
      { name: "奖金收入", kind: "income", asset_group: null, owner_member_id: member.id },
    ]);

    const templateItems = [...commonItems, ...memberItems];
    for (const item of templateItems) {
      await pool.query(
        `INSERT INTO tracking_items (user_id, name, kind, asset_group, owner_member_id)
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (
           SELECT 1 FROM tracking_items i
           WHERE i.user_id = $1
             AND i.is_active = TRUE
             AND lower(btrim(i.name)) = lower(btrim($2))
             AND i.kind = $3
             AND COALESCE(i.owner_member_id, 0) = COALESCE($5::int, 0)
         )`,
        [userId, item.name, item.kind, item.asset_group, item.owner_member_id]
      );
    }

    const config = await getConfig(userId, true);
    if (isApiRequest(req)) {
      return res.json({ ok: true, config });
    }
    res.redirect("/setup");
  } catch (err) {
    next(err);
  }
});

app.get("/entry", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const selectedPeriodId = Number(req.query.period_id || 0);
    const copyFromId = Number(req.query.copy_from || 0);
    const sourcePeriodId = selectedPeriodId || copyFromId;
    const selectedSnapshot = sourcePeriodId ? await getPeriodSnapshot(userId, sourcePeriodId) : null;
    const config = await getConfig(userId, Boolean(selectedSnapshot));
    if (!config.members.length || !config.items.length) {
      return res.redirect("/setup");
    }
    const periods = await getPeriods(userId);
    res.render("entry", {
      title: "录入",
      periods,
      defaultDate: selectedSnapshot && selectedPeriodId ? formatDate(selectedSnapshot.period.period_date) : dayjs().format("YYYY-MM-DD"),
      config,
      selectedPeriod: selectedSnapshot?.period || null,
      entryValues: selectedSnapshot?.values || {},
      entryNote: selectedSnapshot?.period?.note || "",
      stockPnlManual: selectedSnapshot ? toNumber(selectedSnapshot.period.stock_pnl_manual) : 0,
      isCopyMode: Boolean(copyFromId && selectedSnapshot),
      errors: [],
    });
  } catch (err) {
    next(err);
  }
});

app.post("/entry", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = currentUserId(req);
    const validationErrors = validateEntryPayload(req.body);
    if (validationErrors.length) {
      const config = await getConfig(userId, true);
      const periods = await getPeriods(userId);
      return res.status(400).render("entry", {
        title: "录入",
        periods,
        defaultDate: req.body.period_date || dayjs().format("YYYY-MM-DD"),
        config,
        selectedPeriod: null,
        entryValues: Object.fromEntries(
          config.items.map((item) => [Number(item.id), toNumber(req.body[`item_${item.id}`])])
        ),
        entryNote: req.body.note || "",
        stockPnlManual: toNumber(req.body.stock_pnl_manual),
        isCopyMode: false,
        errors: validationErrors,
      });
    }

    const periodDate = req.body.period_date;
    const note = req.body.note || "";

    await client.query("BEGIN");

    const periodRes = await client.query(
      `INSERT INTO snapshot_periods (user_id, period_date, note, stock_pnl_manual)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, period_date)
       DO UPDATE SET
         note = EXCLUDED.note,
         stock_pnl_manual = EXCLUDED.stock_pnl_manual
       RETURNING id, period_date`,
      [userId, periodDate, note, toNumber(req.body.stock_pnl_manual)]
    );
    const period = periodRes.rows[0];

    const config = await getConfig(userId, true);
    for (const item of config.items) {
      const field = `item_${item.id}`;
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) continue;
      await client.query(
        `INSERT INTO snapshot_values (period_id, item_id, amount)
         VALUES ($1, $2, $3)
         ON CONFLICT (period_id, item_id)
        DO UPDATE SET
          amount = EXCLUDED.amount`,
        [period.id, item.id, toNumber(req.body[field])]
      );
    }

    await client.query("COMMIT");
    res.redirect("/trends");
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

app.post("/entry/periods/:id/delete", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).send("无效的周期 ID");
    }
    const result = await pool.query("DELETE FROM snapshot_periods WHERE id = $1 AND user_id = $2", [id, userId]);
    if (!result.rowCount) throw httpError(404, "周期不存在");
    res.redirect("/entry");
  } catch (err) {
    next(err);
  }
});

app.get("/trends", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const config = await getConfig(userId);
    if (!config.members.length || !config.items.length) {
      return res.redirect("/setup");
    }
    const validItemIds = new Set(config.items.map((item) => Number(item.id)));
    const hasScopeQuery = Object.prototype.hasOwnProperty.call(req.query, "excluded_item_ids");
    const savedExcludedItemIds = await getTrendExcludedItemIds(userId);
    const excludedItemIds = hasScopeQuery
      ? parseItemIdSet(req.query.excluded_item_ids, validItemIds)
      : parseItemIdSet(savedExcludedItemIds.join(","), validItemIds);

    const result = await pool.query(
      `SELECT
        p.period_date,
        p.stock_pnl_manual,
        i.id AS item_id,
        i.kind,
        i.asset_group,
        i.owner_member_id,
        v.amount
       FROM snapshot_periods p
       JOIN snapshot_values v ON v.period_id = p.id
       JOIN tracking_items i ON i.id = v.item_id
       WHERE p.user_id = $1
         AND i.user_id = $1
       ORDER BY p.period_date ASC`,
      [userId]
    );
    const viewMode = req.query.view === "member" ? "member" : "family";
    const selectedMemberId = Number(req.query.member_id || 0);
    const memberExists = config.members.some((m) => m.id === selectedMemberId);
    const effectiveViewMode = viewMode === "member" && memberExists ? "member" : "family";
    const selectedMember = config.members.find((m) => m.id === selectedMemberId) || null;
    const isMemberView = effectiveViewMode === "member";

    const byDate = new Map();
    for (const row of result.rows) {
      if (isMemberView && row.owner_member_id !== selectedMemberId) {
        continue;
      }
      if (excludedItemIds.has(Number(row.item_id))) {
        continue;
      }
      const key = dayjs(row.period_date).format("YYYY-MM-DD");
      const item = byDate.get(key) || {
        periodDate: key,
        stockMarketValue: 0,
        stockPnl: isMemberView ? null : toNumber(row.stock_pnl_manual),
        stockMarketValueChange: null,
        stockNetFlow: null,
        totalIncome: 0,
        totalExpenseManual: 0,
        totalExpense: null,
        implicitExpense: null,
        totalAssets: 0,
        totalLiabilities: 0,
        netAssets: 0,
      };
      const amount = toNumber(row.amount);
      if (row.kind === "asset" && row.asset_group === "investment") item.stockMarketValue += amount;
      if (row.kind === "asset") item.totalAssets += amount;
      if (row.kind === "liability") item.totalLiabilities += amount;
      if (row.kind === "income") item.totalIncome += amount;
      if (row.kind === "expense") item.totalExpenseManual += amount;
      byDate.set(key, item);
    }

    const sorted = [...byDate.values()].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
    let prevStockMarketValue = 0;
    let prevNetAssets = null;
    const trendData = sorted.map((row, index) => {
      const stockMarketValueChange = index === 0 ? null : row.stockMarketValue - prevStockMarketValue;
      const inferredNetFlow =
        stockMarketValueChange === null || row.stockPnl === null ? null : stockMarketValueChange - row.stockPnl;
      prevStockMarketValue = row.stockMarketValue;
      const netAssets = row.totalAssets - row.totalLiabilities;
      const periodChange = prevNetAssets === null ? null : netAssets - prevNetAssets;
      const totalExpense = periodChange === null || row.stockPnl === null ? null : row.totalIncome + row.stockPnl - periodChange;
      const implicitExpense = totalExpense === null ? null : totalExpense - row.totalExpenseManual;
      prevNetAssets = netAssets;
      return {
        ...row,
        stockMarketValueChange,
        stockNetFlow: inferredNetFlow,
        netAssets,
        periodChange,
        totalExpense,
        implicitExpense,
      };
    });
    const latestSummary = trendData[trendData.length - 1] || null;
    const memberNameById = new Map(config.members.map((member) => [Number(member.id), member.name]));
    const memberAssetTotals = new Map(config.members.map((member) => [Number(member.id), 0]));
    const sharedAssetKey = "shared";
    memberAssetTotals.set(sharedAssetKey, 0);
    if (!isMemberView && latestSummary) {
      for (const row of result.rows) {
        const key = dayjs(row.period_date).format("YYYY-MM-DD");
        if (key !== latestSummary.periodDate || row.kind !== "asset" || excludedItemIds.has(Number(row.item_id))) {
          continue;
        }
        const ownerKey = row.owner_member_id ? Number(row.owner_member_id) : sharedAssetKey;
        memberAssetTotals.set(ownerKey, (memberAssetTotals.get(ownerKey) || 0) + toNumber(row.amount));
      }
    }
    const latestAssetComposition = isMemberView
      ? []
      : [...memberAssetTotals.entries()]
          .map(([ownerKey, amount]) => ({
            label: ownerKey === sharedAssetKey ? "共同" : memberNameById.get(ownerKey) || "未知成员",
            amount,
          }))
          .filter((item) => item.amount > 0);
    const anomalies = buildTrendAnomalies(trendData, { isMemberView });
    const trendContext = {
      viewLabel: isMemberView && selectedMember ? `${selectedMember.name}个人` : "家庭",
      netAssetLabel: isMemberView && selectedMember ? `${selectedMember.name}净资产` : "家庭净资产",
      isMemberView,
      hasDerivedMetrics: !isMemberView && trendData.length >= 2,
    };

    res.render("trends", {
      title: "趋势",
      trendData,
      latestAssetComposition,
      latestSummary,
      anomalies,
      trendContext,
      members: config.members,
      viewMode: effectiveViewMode,
      selectedMemberId,
      scopeItems: config.items,
      excludedItemIds: [...excludedItemIds],
      excludedItemIdsParam: [...excludedItemIds].join(","),
      hasScopeQuery,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/trends/scope", async (req, res, next) => {
  try {
    const userId = currentUserId(req);
    const config = await getConfig(userId);
    const validItemIds = new Set(config.items.map((item) => Number(item.id)));
    const excludedItemIds =
      req.body.scope_action === "reset" ? [] : [...parseItemIdSet(req.body.excluded_item_ids, validItemIds)];
    await saveTrendExcludedItemIds(userId, excludedItemIds);

    const params = new URLSearchParams();
    const viewMode = req.body.view === "member" ? "member" : "family";
    params.set("view", viewMode);
    const selectedMemberId = Number(req.body.member_id || 0);
    if (viewMode === "member" && config.members.some((member) => Number(member.id) === selectedMemberId)) {
      params.set("member_id", String(selectedMemberId));
    }
    res.redirect(`/trends?${params.toString()}`);
  } catch (err) {
    next(err);
  }
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = Number(err.status || 500);
  res.status(status).send(status === 500 ? "服务器错误，请检查日志。" : err.message);
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
