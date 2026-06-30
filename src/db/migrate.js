const { pool } = require("../config/db");

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_users_email_lower
    ON admin_users (lower(email));
  `);
  await pool.query(`
    ALTER TABLE admin_users
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN;
  `);
  await pool.query(`
    UPDATE admin_users
    SET is_admin = TRUE
    WHERE is_admin IS NULL;
  `);
  await pool.query(`
    ALTER TABLE admin_users
    ALTER COLUMN is_admin SET DEFAULT FALSE;
  `);
  await pool.query(`
    ALTER TABLE admin_users
    ALTER COLUMN is_admin SET NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  `);
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracking_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability', 'income', 'expense')),
      asset_group TEXT CHECK (asset_group IN ('cash', 'investment', 'housing_fund', 'other') OR asset_group IS NULL),
      owner_member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE tracking_items
    DROP CONSTRAINT IF EXISTS tracking_items_kind_check;
  `);
  await pool.query(`
    ALTER TABLE tracking_items
    ADD CONSTRAINT tracking_items_kind_check
    CHECK (kind IN ('asset', 'liability', 'income', 'expense'));
  `);
  await pool.query(`
    ALTER TABLE tracking_items
    ADD COLUMN IF NOT EXISTS asset_group TEXT;
  `);
  await pool.query(`
    ALTER TABLE tracking_items
    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE;
  `);
  await pool.query(`
    ALTER TABLE tracking_items
    DROP CONSTRAINT IF EXISTS tracking_items_asset_group_check;
  `);
  await pool.query(`
    ALTER TABLE tracking_items
    ADD CONSTRAINT tracking_items_asset_group_check
    CHECK (asset_group IN ('cash', 'investment', 'housing_fund', 'other') OR asset_group IS NULL);
  `);
  // Before creating the unique index, deactivate duplicated active rows.
  // Keep the earliest row active and mark the rest inactive.
  await pool.query(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, lower(btrim(name)), kind, COALESCE(owner_member_id, 0)
          ORDER BY id ASC
        ) AS rn
      FROM tracking_items
      WHERE is_active = TRUE
    )
    UPDATE tracking_items t
    SET is_active = FALSE
    FROM ranked r
    WHERE t.id = r.id
      AND r.rn > 1;
  `);
  await pool.query(`
    DROP INDEX IF EXISTS uq_tracking_items_active_name_owner_kind;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tracking_items_user_active_name_owner_kind
    ON tracking_items (user_id, lower(btrim(name)), kind, COALESCE(owner_member_id, 0))
    WHERE is_active = TRUE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshot_periods (
      id SERIAL PRIMARY KEY,
      period_date DATE NOT NULL UNIQUE,
      stock_pnl_manual NUMERIC(14,2) NOT NULL DEFAULT 0,
      note TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE snapshot_periods
    ADD COLUMN IF NOT EXISTS stock_pnl_manual NUMERIC(14,2) NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE snapshot_periods
    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshot_values (
      id SERIAL PRIMARY KEY,
      period_id INTEGER NOT NULL REFERENCES snapshot_periods(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES tracking_items(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (period_id, item_id)
    );
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION ensure_snapshot_value_same_user()
    RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM snapshot_periods p
        JOIN tracking_items i ON i.id = NEW.item_id
        WHERE p.id = NEW.period_id
          AND p.user_id = i.user_id
      ) THEN
        RAISE EXCEPTION 'snapshot period and item must belong to the same user';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS trg_snapshot_values_same_user ON snapshot_values;
  `);
  await pool.query(`
    CREATE TRIGGER trg_snapshot_values_same_user
    BEFORE INSERT OR UPDATE ON snapshot_values
    FOR EACH ROW
    EXECUTE FUNCTION ensure_snapshot_value_same_user();
  `);

  await pool.query(`
    DO $$
    DECLARE
      first_admin_id INTEGER;
      orphan_count INTEGER;
    BEGIN
      SELECT id INTO first_admin_id FROM admin_users ORDER BY id ASC LIMIT 1;

      SELECT
        (SELECT COUNT(*) FROM members WHERE user_id IS NULL) +
        (SELECT COUNT(*) FROM tracking_items WHERE user_id IS NULL) +
        (SELECT COUNT(*) FROM snapshot_periods WHERE user_id IS NULL)
      INTO orphan_count;

      IF orphan_count > 0 AND first_admin_id IS NULL THEN
        RAISE EXCEPTION 'Cannot assign existing asset data because no admin user exists';
      END IF;

      IF first_admin_id IS NOT NULL THEN
        UPDATE members SET user_id = first_admin_id WHERE user_id IS NULL;
        UPDATE tracking_items SET user_id = first_admin_id WHERE user_id IS NULL;
        UPDATE snapshot_periods SET user_id = first_admin_id WHERE user_id IS NULL;
      END IF;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE members
    ALTER COLUMN user_id SET NOT NULL;
  `);
  await pool.query(`
    ALTER TABLE tracking_items
    ALTER COLUMN user_id SET NOT NULL;
  `);
  await pool.query(`
    ALTER TABLE snapshot_periods
    ALTER COLUMN user_id SET NOT NULL;
  `);

  await pool.query(`
    ALTER TABLE members
    DROP CONSTRAINT IF EXISTS members_name_key;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_members_user_name_lower
    ON members (user_id, lower(btrim(name)));
  `);

  await pool.query(`
    ALTER TABLE snapshot_periods
    DROP CONSTRAINT IF EXISTS snapshot_periods_period_date_key;
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshot_periods_user_period_date
    ON snapshot_periods (user_id, period_date);
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
