const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const { pool } = require("./config/db");
const { toNumber } = require("./services/calculations");

const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/vendor/chart.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "../node_modules/chart.js/dist/chart.umd.js"));
});
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

function isApiRequest(req) {
  return req.get("X-Requested-With") === "fetch" || req.accepts(["html", "json"]) === "json";
}

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
    const config = await getConfig();
    if (!config.members.length || !config.items.length) {
      return res.redirect("/setup");
    }
    const periods = await getPeriods();
    res.render("entry", {
      title: "录入",
      periods,
      defaultDate: dayjs().format("YYYY-MM-DD"),
      config,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/entry", async (req, res, next) => {
  const client = await pool.connect();
  try {
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

    const config = await getConfig();
    for (const item of config.items) {
      const field = `item_${item.id}`;
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

    const byDate = new Map();
    for (const row of result.rows) {
      if (effectiveViewMode === "member" && row.owner_member_id !== selectedMemberId) {
        continue;
      }
      const key = dayjs(row.period_date).format("YYYY-MM-DD");
      const item = byDate.get(key) || {
        periodDate: key,
        stockMarketValue: 0,
        stockPnl: toNumber(row.stock_pnl_manual),
        stockNetFlow: 0,
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
      const inferredNetFlow = index === 0 ? 0 : row.stockMarketValue - prevStockMarketValue - row.stockPnl;
      prevStockMarketValue = row.stockMarketValue;
      const netAssets = row.totalAssets - row.totalLiabilities;
      const periodChange = prevNetAssets === null ? null : netAssets - prevNetAssets;
      const totalExpense = periodChange === null ? null : row.totalIncome + row.stockPnl - periodChange;
      const implicitExpense = totalExpense === null ? null : totalExpense - row.totalExpenseManual;
      prevNetAssets = netAssets;
      return {
        ...row,
        stockNetFlow: inferredNetFlow,
        netAssets,
        periodChange,
        totalExpense,
        implicitExpense,
      };
    });

    res.render("trends", {
      title: "趋势",
      trendData,
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
