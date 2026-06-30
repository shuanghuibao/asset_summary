const { spawn, spawnSync } = require("child_process");
const { Pool } = require("pg");
const dotenv = require("dotenv");

dotenv.config();

const localDatabaseUrl =
  process.env.LOCAL_DATABASE_URL || "postgresql://asset_summary:asset_summary@localhost:5433/asset_summary";

const devEnv = {
  ...process.env,
  NODE_ENV: "development",
  PORT: process.env.DEV_PORT || "3000",
  DATABASE_URL: localDatabaseUrl,
  PGSSLMODE: "disable",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: devEnv,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function getComposeCommand() {
  const composePlugin = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
    env: devEnv,
  });
  if (composePlugin.status === 0) {
    return { command: "docker", args: ["compose"] };
  }

  const standaloneCompose = spawnSync("docker-compose", ["version"], {
    stdio: "ignore",
    env: devEnv,
  });
  if (standaloneCompose.status === 0) {
    return { command: "docker-compose", args: [] };
  }

  throw new Error("未找到 Docker Compose。请安装 Docker Desktop 或 docker-compose。");
}

async function waitForDatabase() {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pool = new Pool({
      connectionString: localDatabaseUrl,
      ssl: false,
      connectionTimeoutMillis: 1000,
    });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (_err) {
      await pool.end().catch(() => {});
      process.stdout.write(attempt === 1 ? "等待本地 Postgres 启动" : ".");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  process.stdout.write("\n");
  throw new Error("本地 Postgres 启动超时，请确认 Docker Desktop 已启动。");
}

async function main() {
  console.log("启动本地 Postgres...");
  const compose = getComposeCommand();
  run(compose.command, [...compose.args, "up", "-d", "postgres"]);

  await waitForDatabase();
  console.log("\n本地 Postgres 已就绪。");

  console.log("执行数据库迁移...");
  run("npm", ["run", "db:migrate"]);

  console.log(`启动开发服务：http://localhost:${devEnv.PORT}`);
  const app = spawn("nodemon", ["src/server.js"], {
    stdio: "inherit",
    env: devEnv,
  });

  app.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
