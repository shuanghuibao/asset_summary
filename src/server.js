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

async function createAdminUser(email, password) {
  const result = await pool.query(
    `INSERT INTO admin_users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email`,
    [normalizeEmail(email), hashPassword(password)]
  );
  return result.rows[0];
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
    res.locals.currentAdmin = session;
    return next();
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

    const admin = await createAdminUser(email, password);
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

async function getPeriods() {
  const result = await pool.query("SELECT * FROM snapshot_periods ORDER BY period_date DESC");
  return result.rows;
}

async function getConfig(includeInactive = false) {
  const itemFilter = includeInactive ? "" : "WHERE i.is_active = TRUE";
  const memberFilter = includeInactive ? "" : "WHERE is_active = TRUE";
  const [membersRes, itemsRes] = await Promise.all([
    pool.query(`SELECT * FROM members ${memberFilter} ORDER BY is_active DESC, id ASC`),
    pool.query(
      `SELECT i.*, m.name AS owner_member_name
       FROM tracking_items i
       LEFT JOIN members m ON m.id = i.owner_member_id
       ${itemFilter}
       ORDER BY i.is_active DESC, i.owner_member_id NULLS LAST, i.id ASC`
    ),
  ]);

  return {
    members: membersRes.rows,
    items: itemsRes.rows,
  };
}

async function getLatestPeriodValues(periodId) {
  const result = await pool.query(
    `SELECT v.amount, i.kind, i.asset_group, i.name, i.owner_member_id, m.name AS member_name
     FROM snapshot_values v
     JOIN tracking_items i ON i.id = v.item_id
     LEFT JOIN members m ON m.id = i.owner_member_id
     WHERE v.period_id = $1`,
    [periodId]
  );
  return result.rows;
}

function formatDate(value) {
  return dayjs(value).format("YYYY-MM-DD");
}

async function getPeriodSnapshot(periodId) {
  const [periodRes, valuesRes] = await Promise.all([
    pool.query("SELECT * FROM snapshot_periods WHERE id = $1", [periodId]),
    pool.query("SELECT item_id, amount FROM snapshot_values WHERE period_id = $1", [periodId]),
  ]);
  if (!periodRes.rows.length) return null;
  return {
    period: periodRes.rows[0],
    values: Object.fromEntries(valuesRes.rows.map((row) => [Number(row.item_id), toNumber(row.amount)])),
  };
}

async function getBackupData() {
  const [members, items, periods, values] = await Promise.all([
    pool.query("SELECT id, name, is_active, created_at FROM members ORDER BY id ASC"),
    pool.query(
      `SELECT id, name, kind, asset_group, owner_member_id, is_active, created_at
       FROM tracking_items
       ORDER BY id ASC`
    ),
    pool.query("SELECT id, period_date, stock_pnl_manual, note, created_at FROM snapshot_periods ORDER BY period_date ASC"),
    pool.query("SELECT id, period_id, item_id, amount, created_at FROM snapshot_values ORDER BY period_id ASC, item_id ASC"),
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

async function buildSnapshotsCsv() {
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
     LEFT JOIN members m ON m.id = i.owner_member_id
     ORDER BY p.period_date ASC, i.id ASC`
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

async function importBackupData(data) {
  const members = ensureArray(data.members, "members");
  const items = ensureArray(data.trackingItems, "trackingItems");
  const periods = ensureArray(data.snapshotPeriods, "snapshotPeriods");
  const values = ensureArray(data.snapshotValues, "snapshotValues");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM snapshot_values");
    await client.query("DELETE FROM snapshot_periods");
    await client.query("DELETE FROM tracking_items");
    await client.query("DELETE FROM members");

    for (const member of members) {
      await client.query(
        `INSERT INTO members (id, name, is_active, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamp, NOW()))`,
        [Number(member.id), String(member.name || "").trim(), member.is_active !== false, member.created_at || null]
      );
    }

    for (const item of items) {
      await client.query(
        `INSERT INTO tracking_items (id, name, kind, asset_group, owner_member_id, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamp, NOW()))`,
        [
          Number(item.id),
          String(item.name || "").trim(),
          item.kind,
          item.kind === "asset" ? item.asset_group || "other" : null,
          item.owner_member_id || null,
          item.is_active !== false,
          item.created_at || null,
        ]
      );
    }

    for (const period of periods) {
      await client.query(
        `INSERT INTO snapshot_periods (id, period_date, note, stock_pnl_manual, created_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, NOW()))`,
        [Number(period.id), period.period_date, period.note || "", toNumber(period.stock_pnl_manual), period.created_at || null]
      );
    }

    for (const value of values) {
      await client.query(
        `INSERT INTO snapshot_values (id, period_id, item_id, amount, created_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, NOW()))`,
        [Number(value.id), Number(value.period_id), Number(value.item_id), toNumber(value.amount), value.created_at || null]
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

app.get("/", async (req, res, next) => {
  try {
    const config = await getConfig();
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

    const periods = await getPeriods();
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

    const latestValuesAll = await getLatestPeriodValues(periods[0].id);
    const previousValuesAll = periods[1] ? await getLatestPeriodValues(periods[1].id) : [];
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

app.get("/backup/export.json", async (_req, res, next) => {
  try {
    const data = await getBackupData();
    const filename = `family-asset-backup-${dayjs().format("YYYYMMDD-HHmmss")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
});

app.get("/backup/export.csv", async (_req, res, next) => {
  try {
    const csv = await buildSnapshotsCsv();
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
    const raw = String(req.body.backup_json || "").trim();
    if (!raw) {
      return res.status(400).render("backup", { title: "备份", message: "", error: "请粘贴 JSON 备份内容。" });
    }
    const data = JSON.parse(raw);
    await importBackupData(data);
    res.render("backup", { title: "备份", message: "备份已导入，数据已恢复。", error: "" });
  } catch (err) {
    res.status(400).render("backup", { title: "备份", message: "", error: err.message || "导入失败，请检查备份内容。" });
  }
});

app.get("/setup", async (req, res, next) => {
  try {
    const config = await getConfig(true);
    res.render("setup", { title: "Setup", config });
  } catch (err) {
    next(err);
  }
});

app.post("/setup/members", async (req, res, next) => {
  try {
    const names = String(req.body.member_names || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    if (names.length) {
      await pool.query(
        `INSERT INTO members (name)
         SELECT DISTINCT name
         FROM unnest($1::text[]) AS name
         WHERE length(trim(name)) > 0
         ON CONFLICT (name) DO NOTHING`,
        [names]
      );
    }

    const config = await getConfig(true);
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
    const members = Array.isArray(req.body.members) ? req.body.members : [];
    await client.query("BEGIN");

    let updatedCount = 0;
    let deletedCount = 0;
    const skippedDeleteIds = [];

    for (const raw of members) {
      const id = Number(raw.id);
      if (!Number.isInteger(id)) continue;

      if (Boolean(raw.marked_for_delete)) {
        const usageRes = await client.query("SELECT COUNT(*)::int AS cnt FROM tracking_items WHERE owner_member_id = $1", [id]);
        const usageCount = Number(usageRes.rows[0]?.cnt || 0);
        if (usageCount > 0) {
          skippedDeleteIds.push(id);
          continue;
        }
        const delRes = await client.query("DELETE FROM members WHERE id = $1", [id]);
        if (delRes.rowCount > 0) deletedCount += 1;
        continue;
      }

      const name = String(raw.name || "").trim();
      const isActive = raw.is_active !== false;
      if (!name) continue;

      const upRes = await client.query(
        `UPDATE members
         SET name = $1, is_active = $2
         WHERE id = $3`,
        [name, isActive, id]
      );
      if (upRes.rowCount > 0) updatedCount += 1;
    }

    await client.query("COMMIT");
    const config = await getConfig(true);
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
    const itemName = String(req.body.item_name || "").trim();
    const kind = req.body.kind;
    const assetGroup = kind === "asset" ? req.body.asset_group || "other" : null;
    const returnTo = req.body.return_to === "/entry" ? "/entry" : "/setup";

    await pool.query(
      `INSERT INTO tracking_items (name, kind, asset_group, owner_member_id)
       VALUES ($1, $2, $3, $4)`,
      [itemName, kind, assetGroup, req.body.owner_member_id || null]
    );
    const config = await getConfig(true);
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

app.get("/api/setup-config", async (_req, res, next) => {
  try {
    const config = await getConfig(true);
    res.json({ ok: true, config });
  } catch (err) {
    next(err);
  }
});

app.post("/setup/items/:id/update", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const itemName = String(req.body.item_name || "").trim();
    const kind = req.body.kind;
    const assetGroup = kind === "asset" ? req.body.asset_group || "other" : null;
    const ownerMemberId = req.body.owner_member_id || null;

    await pool.query(
      `UPDATE tracking_items
       SET name = $1, kind = $2, asset_group = $3, owner_member_id = $4
       WHERE id = $5`,
      [itemName, kind, assetGroup, ownerMemberId, id]
    );

    const config = await getConfig(true);
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
    const id = Number(req.params.id);
    const active = String(req.body.active) === "true";
    await pool.query("UPDATE tracking_items SET is_active = $1 WHERE id = $2", [active, id]);
    const config = await getConfig(true);
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
    const id = Number(req.params.id);
    const usageRes = await pool.query("SELECT COUNT(*)::int AS cnt FROM snapshot_values WHERE item_id = $1", [id]);
    const usageCount = Number(usageRes.rows[0]?.cnt || 0);
    if (usageCount > 0) {
      return res.status(409).json({
        ok: false,
        message: "该科目已有历史记录，不能删除。你可以先停用。",
      });
    }

    await pool.query("DELETE FROM tracking_items WHERE id = $1", [id]);
    const config = await getConfig(true);
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
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => Number(x)).filter((x) => Number.isInteger(x)) : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, message: "未选择科目" });
    }

    const usageRes = await pool.query(
      `SELECT item_id, COUNT(*)::int AS cnt
       FROM snapshot_values
       WHERE item_id = ANY($1::int[])
       GROUP BY item_id`,
      [ids]
    );
    const blockedIds = usageRes.rows.filter((r) => Number(r.cnt) > 0).map((r) => Number(r.item_id));
    const deletableIds = ids.filter((id) => !blockedIds.includes(id));

    if (deletableIds.length) {
      await pool.query("DELETE FROM tracking_items WHERE id = ANY($1::int[])", [deletableIds]);
    }

    const config = await getConfig(true);
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
        const usageRes = await client.query("SELECT COUNT(*)::int AS cnt FROM snapshot_values WHERE item_id = $1", [id]);
        const usageCount = Number(usageRes.rows[0]?.cnt || 0);
        if (usageCount > 0) {
          skippedDeleteIds.push(id);
          continue;
        }
        const delRes = await client.query("DELETE FROM tracking_items WHERE id = $1", [id]);
        if (delRes.rowCount > 0) deletedCount += 1;
        continue;
      }

      const kind = String(raw.kind || "").trim();
      const name = String(raw.name || "").trim();
      const ownerMemberId = raw.owner_member_id ? Number(raw.owner_member_id) : null;
      const isActive = raw.is_active !== false;
      const assetGroup = kind === "asset" ? String(raw.asset_group || "other").trim() : null;
      if (!name || !["asset", "liability", "income", "expense"].includes(kind)) continue;

      const upRes = await client.query(
        `UPDATE tracking_items
         SET name = $1, kind = $2, asset_group = $3, owner_member_id = $4, is_active = $5
         WHERE id = $6`,
        [name, kind, assetGroup, ownerMemberId, isActive, id]
      );
      if (upRes.rowCount > 0) updatedCount += 1;
    }

    await client.query("COMMIT");
    const config = await getConfig(true);
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
    const membersRes = await pool.query("SELECT id, name FROM members ORDER BY id ASC");
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
        `INSERT INTO tracking_items (name, kind, asset_group, owner_member_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [item.name, item.kind, item.asset_group, item.owner_member_id]
      );
    }

    const config = await getConfig(true);
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
    const selectedPeriodId = Number(req.query.period_id || 0);
    const copyFromId = Number(req.query.copy_from || 0);
    const sourcePeriodId = selectedPeriodId || copyFromId;
    const selectedSnapshot = sourcePeriodId ? await getPeriodSnapshot(sourcePeriodId) : null;
    const config = await getConfig(Boolean(selectedSnapshot));
    if (!config.members.length || !config.items.length) {
      return res.redirect("/setup");
    }
    const periods = await getPeriods();
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
    const validationErrors = validateEntryPayload(req.body);
    if (validationErrors.length) {
      const config = await getConfig(true);
      const periods = await getPeriods();
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
      `INSERT INTO snapshot_periods (period_date, note, stock_pnl_manual)
       VALUES ($1, $2, $3)
       ON CONFLICT (period_date)
       DO UPDATE SET
         note = EXCLUDED.note,
         stock_pnl_manual = EXCLUDED.stock_pnl_manual
       RETURNING id, period_date`,
      [periodDate, note, toNumber(req.body.stock_pnl_manual)]
    );
    const period = periodRes.rows[0];

    const config = await getConfig(true);
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).send("无效的周期 ID");
    }
    await pool.query("DELETE FROM snapshot_periods WHERE id = $1", [id]);
    res.redirect("/entry");
  } catch (err) {
    next(err);
  }
});

app.get("/trends", async (req, res, next) => {
  try {
    const config = await getConfig();
    if (!config.members.length || !config.items.length) {
      return res.redirect("/setup");
    }

    const result = await pool.query(
      `SELECT
        p.period_date,
        p.stock_pnl_manual,
        i.kind,
        i.asset_group,
        i.owner_member_id,
        v.amount
       FROM snapshot_periods p
       JOIN snapshot_values v ON v.period_id = p.id
       JOIN tracking_items i ON i.id = v.item_id
       ORDER BY p.period_date ASC`
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
      latestSummary,
      anomalies,
      trendContext,
      members: config.members,
      viewMode: effectiveViewMode,
      selectedMemberId,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send("服务器错误，请检查日志。");
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
