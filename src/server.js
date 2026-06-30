const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const { pool } = require("./config/db");
const {
  computeStockNetFlow,
  computeMemberTotals,
  computeHouseholdNetAssets,
  toNumber,
} = require("./services/calculations");

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

async function getPeriodBundle(periodId) {
  const [periodRes, memberRes, householdRes] = await Promise.all([
    pool.query("SELECT * FROM snapshot_periods WHERE id = $1", [periodId]),
    pool.query("SELECT * FROM member_finance_snapshots WHERE period_id = $1 ORDER BY member", [periodId]),
    pool.query("SELECT * FROM household_snapshots WHERE period_id = $1", [periodId]),
  ]);
  return {
    period: periodRes.rows[0],
    members: memberRes.rows,
    household: householdRes.rows[0],
  };
}

async function getPreviousMemberSnapshot(member, currentPeriodDate) {
  const result = await pool.query(
    `SELECT m.*
      FROM member_finance_snapshots m
      JOIN snapshot_periods p ON p.id = m.period_id
     WHERE m.member = $1
       AND p.period_date < $2
     ORDER BY p.period_date DESC
     LIMIT 1`,
    [member, currentPeriodDate]
  );
  return result.rows[0];
}

app.get("/", async (req, res, next) => {
  try {
    const periods = await getPeriods();
    if (!periods.length) {
      return res.render("overview", {
        title: "总览",
        latest: null,
        previous: null,
        stats: null,
      });
    }

    const latestBundle = await getPeriodBundle(periods[0].id);
    const previousBundle = periods[1] ? await getPeriodBundle(periods[1].id) : null;

    const memberTotals = latestBundle.members.map((row) => ({ member: row.member, ...computeMemberTotals(row) }));
    const householdNetAssets = computeHouseholdNetAssets({
      memberSnapshots: latestBundle.members,
      householdSnapshot: latestBundle.household,
    });

    const previousNetAssets = previousBundle
      ? computeHouseholdNetAssets({
          memberSnapshots: previousBundle.members,
          householdSnapshot: previousBundle.household,
        })
      : 0;

    const stats = {
      householdNetAssets,
      periodChange: householdNetAssets - previousNetAssets,
      mortgage: toNumber(latestBundle.household?.remaining_mortgage_total),
      monthlyMortgagePayment: toNumber(latestBundle.household?.monthly_mortgage_payment),
      totalExpense: toNumber(latestBundle.household?.total_expense),
      memberTotals,
    };

    res.render("overview", {
      title: "总览",
      latest: latestBundle,
      previous: previousBundle,
      stats,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/entry", async (req, res, next) => {
  try {
    const periods = await getPeriods();
    res.render("entry", {
      title: "录入",
      periods,
      defaultDate: dayjs().format("YYYY-MM-DD"),
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

    const members = ["宝", "李"];
    for (const member of members) {
      const previous = await getPreviousMemberSnapshot(member, period.period_date);
      const currentMarketValue = toNumber(req.body[`${member}_stock_fund_market_value`]);
      const stockPnlManual = toNumber(req.body[`${member}_stock_pnl_manual`]);
      const previousMarketValue = toNumber(previous?.stock_fund_market_value);
      const stockNetFlowComputed = computeStockNetFlow(currentMarketValue, previousMarketValue, stockPnlManual);

      await client.query(
        `INSERT INTO member_finance_snapshots (
          period_id, member, salary_income, bonus_income, housing_fund_income, cash_savings,
          stock_fund_market_value, housing_fund_balance, credit_card_balance, stock_pnl_manual, stock_net_flow_computed
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (period_id, member)
        DO UPDATE SET
          salary_income = EXCLUDED.salary_income,
          bonus_income = EXCLUDED.bonus_income,
          housing_fund_income = EXCLUDED.housing_fund_income,
          cash_savings = EXCLUDED.cash_savings,
          stock_fund_market_value = EXCLUDED.stock_fund_market_value,
          housing_fund_balance = EXCLUDED.housing_fund_balance,
          credit_card_balance = EXCLUDED.credit_card_balance,
          stock_pnl_manual = EXCLUDED.stock_pnl_manual,
          stock_net_flow_computed = EXCLUDED.stock_net_flow_computed`,
        [
          period.id,
          member,
          toNumber(req.body[`${member}_salary_income`]),
          toNumber(req.body[`${member}_bonus_income`]),
          toNumber(req.body[`${member}_housing_fund_income`]),
          toNumber(req.body[`${member}_cash_savings`]),
          currentMarketValue,
          toNumber(req.body[`${member}_housing_fund_balance`]),
          toNumber(req.body[`${member}_credit_card_balance`]),
          stockPnlManual,
          stockNetFlowComputed,
        ]
      );
    }

    await client.query(
      `INSERT INTO household_snapshots (
        period_id, remaining_mortgage_total, monthly_mortgage_payment, total_expense, note
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (period_id)
      DO UPDATE SET
        remaining_mortgage_total = EXCLUDED.remaining_mortgage_total,
        monthly_mortgage_payment = EXCLUDED.monthly_mortgage_payment,
        total_expense = EXCLUDED.total_expense,
        note = EXCLUDED.note`,
      [
        period.id,
        toNumber(req.body.remaining_mortgage_total),
        toNumber(req.body.monthly_mortgage_payment),
        toNumber(req.body.total_expense),
        req.body.household_note || "",
      ]
    );

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
    const result = await pool.query(
      `SELECT
        p.period_date,
        m.member,
        m.stock_fund_market_value,
        m.stock_pnl_manual,
        m.stock_net_flow_computed,
        m.cash_savings,
        m.housing_fund_balance,
        m.credit_card_balance,
        h.remaining_mortgage_total
       FROM snapshot_periods p
       JOIN member_finance_snapshots m ON m.period_id = p.id
       LEFT JOIN household_snapshots h ON h.period_id = p.id
       ORDER BY p.period_date ASC, m.member ASC`
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
      item.stockMarketValue += toNumber(row.stock_fund_market_value);
      item.stockPnl += toNumber(row.stock_pnl_manual);
      item.stockNetFlow += toNumber(row.stock_net_flow_computed);
      item.totalAssets +=
        toNumber(row.cash_savings) + toNumber(row.stock_fund_market_value) + toNumber(row.housing_fund_balance);
      item.totalLiabilities += toNumber(row.credit_card_balance);
      item.mortgage = toNumber(row.remaining_mortgage_total);
      byDate.set(key, item);
    }

    const trendData = [...byDate.values()].map((row) => ({
      ...row,
      totalLiabilities: row.totalLiabilities + toNumber(row.mortgage),
      netAssets: row.totalAssets - (row.totalLiabilities + toNumber(row.mortgage)),
    }));

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
