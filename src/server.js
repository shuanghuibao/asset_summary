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
app.use(express.static(path.join(__dirname, "public")));

async function getPeriods() {
  const result = await pool.query("SELECT * FROM snapshot_periods ORDER BY period_date DESC");
  return result.rows;
}

async function getConfig() {
  const [membersRes, itemsRes] = await Promise.all([
    pool.query("SELECT * FROM members ORDER BY id ASC"),
    pool.query(
      `SELECT i.*, m.name AS owner_member_name
       FROM tracking_items i
       LEFT JOIN members m ON m.id = i.owner_member_id
       WHERE i.is_active = TRUE
       ORDER BY i.owner_member_id NULLS LAST, i.id ASC`
    ),
  ]);

  return {
    members: membersRes.rows,
    items: itemsRes.rows,
  };
}

async function getLatestPeriodValues(periodId) {
  const result = await pool.query(
    `SELECT v.amount, i.kind, i.name, i.owner_member_id, m.name AS member_name
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
      });
    }

    const latestValues = await getLatestPeriodValues(periods[0].id);
    const previousValues = periods[1] ? await getLatestPeriodValues(periods[1].id) : [];

    const latestAssets = latestValues
      .filter((row) => row.kind === "asset" || row.kind === "stock_market_value")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const latestLiabilities = latestValues
      .filter((row) => row.kind === "liability")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const latestIncome = latestValues
      .filter((row) => row.kind === "income")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const latestExpense = latestValues
      .filter((row) => row.kind === "expense")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);

    const previousAssets = previousValues
      .filter((row) => row.kind === "asset" || row.kind === "stock_market_value")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);
    const previousLiabilities = previousValues
      .filter((row) => row.kind === "liability")
      .reduce((acc, row) => acc + toNumber(row.amount), 0);

    const householdNetAssets = latestAssets - latestLiabilities;
    const previousNetAssets = previousAssets - previousLiabilities;

    const memberTotals = config.members.map((member) => {
      const memberRows = latestValues.filter((row) => row.owner_member_id === member.id);
      const income = memberRows
        .filter((row) => row.kind === "income")
        .reduce((acc, row) => acc + toNumber(row.amount), 0);
      const assets = memberRows
        .filter((row) => row.kind === "asset" || row.kind === "stock_market_value")
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
      periodChange: householdNetAssets - previousNetAssets,
      totalIncome: latestIncome,
      totalExpense: latestExpense,
      totalAssets: latestAssets,
      totalLiabilities: latestLiabilities,
    };

    res.render("overview", {
      title: "总览",
      setupRequired: false,
      latest: periods[0],
      stats,
      memberTotals,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/setup", async (req, res, next) => {
  try {
    const config = await getConfig();
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
    for (const name of names) {
      await pool.query("INSERT INTO members (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
    }
    res.redirect("/setup");
  } catch (err) {
    next(err);
  }
});

app.post("/setup/items", async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO tracking_items (name, kind, owner_member_id)
       VALUES ($1, $2, $3)`,
      [req.body.item_name, req.body.kind, req.body.owner_member_id || null]
    );
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
      `INSERT INTO snapshot_periods (period_date, note)
       VALUES ($1, $2)
       ON CONFLICT (period_date)
       DO UPDATE SET note = EXCLUDED.note
       RETURNING id, period_date`,
      [periodDate, note]
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
        i.kind,
        v.amount
       FROM snapshot_periods p
       JOIN snapshot_values v ON v.period_id = p.id
       JOIN tracking_items i ON i.id = v.item_id
       ORDER BY p.period_date ASC`
    );

    const byDate = new Map();
    for (const row of result.rows) {
      const key = dayjs(row.period_date).format("YYYY-MM-DD");
      const item = byDate.get(key) || {
        periodDate: key,
        stockMarketValue: 0,
        stockPnl: 0,
        stockNetFlow: 0,
        totalAssets: 0,
        totalLiabilities: 0,
        netAssets: 0,
      };
      const amount = toNumber(row.amount);
      if (row.kind === "stock_market_value") item.stockMarketValue += amount;
      if (row.kind === "stock_pnl") item.stockPnl += amount;
      if (row.kind === "asset" || row.kind === "stock_market_value") item.totalAssets += amount;
      if (row.kind === "liability") item.totalLiabilities += amount;
      byDate.set(key, item);
    }

    const sorted = [...byDate.values()].sort((a, b) => a.periodDate.localeCompare(b.periodDate));
    let prevStockMarketValue = 0;
    const trendData = sorted.map((row, index) => {
      const inferredNetFlow = index === 0 ? 0 : row.stockMarketValue - prevStockMarketValue - row.stockPnl;
      prevStockMarketValue = row.stockMarketValue;
      return {
        ...row,
        stockNetFlow: inferredNetFlow,
        netAssets: row.totalAssets - row.totalLiabilities,
      };
    });

    res.render("trends", { title: "趋势", trendData });
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
