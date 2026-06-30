const { pool } = require("../config/db");

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshot_periods (
      id SERIAL PRIMARY KEY,
      period_date DATE NOT NULL UNIQUE,
      note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_finance_snapshots (
      id SERIAL PRIMARY KEY,
      period_id INTEGER NOT NULL REFERENCES snapshot_periods(id) ON DELETE CASCADE,
      member TEXT NOT NULL CHECK (member IN ('宝', '李')),
      salary_income NUMERIC(14,2) NOT NULL DEFAULT 0,
      bonus_income NUMERIC(14,2) NOT NULL DEFAULT 0,
      housing_fund_income NUMERIC(14,2) NOT NULL DEFAULT 0,
      cash_savings NUMERIC(14,2) NOT NULL DEFAULT 0,
      stock_fund_market_value NUMERIC(14,2) NOT NULL DEFAULT 0,
      housing_fund_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      credit_card_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      stock_pnl_manual NUMERIC(14,2) NOT NULL DEFAULT 0,
      stock_net_flow_computed NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(period_id, member)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS household_snapshots (
      id SERIAL PRIMARY KEY,
      period_id INTEGER NOT NULL UNIQUE REFERENCES snapshot_periods(id) ON DELETE CASCADE,
      remaining_mortgage_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      monthly_mortgage_payment NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_expense NUMERIC(14,2) NOT NULL DEFAULT 0,
      note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  console.log("Migration completed.");
}

migrate()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
