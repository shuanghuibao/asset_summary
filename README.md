# Family Asset Tracker

家庭资产月度更新应用，支持：

- Setup 初始化（先定义家庭成员、再定义资产/负债/收入/支出/股票科目）
- 快照录入（按自定义科目动态生成输入项）
- 股票盈亏手工录入与股票净投入自动反推
- 总览指标（净资产、环比变化、资产/负债/收支）
- 趋势图（净资产、股票市值/盈亏/净投入、资产负债结构）

## 1. Local Run

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` 会自动：

1. 使用 Docker Compose 启动本地 Postgres。
2. 连接 `postgresql://asset_summary:asset_summary@localhost:5433/asset_summary`。
3. 执行 `npm run db:migrate`。
4. 启动开发服务。

访问 `http://localhost:3000`。

首次访问会要求创建管理员账号。之后使用管理员邮箱和密码登录。

如果只想启动应用而不自动启动数据库，可使用：

```bash
npm run dev:app
```

## 2. Data Formula

- 本月股票净投入（自动）  
  `stock_net_flow = current_market_value - prev_market_value - stock_pnl_manual`

- 家庭净资产  
  `net_assets = total_assets - total_liabilities`

## 3. Render Deployment (Free Tier)

项目已包含 `render.yaml`，可直接在 Render 新建 Blueprint 部署：

1. 推送仓库到 GitHub
2. 在 Render 选择 Blueprint 部署
3. Render 自动创建：
   - `family-asset-app` (Web Service, free)
   - `family-asset-db` (Postgres, free)
4. 首次部署会执行 `npm run db:migrate`
5. 打开站点 URL，按页面提示创建管理员账号

Render 文档入口：[render.com](https://render.com/)
