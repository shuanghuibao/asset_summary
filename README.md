# Family Asset Tracker

家庭资产月度更新应用，支持：

- 快照录入（宝/李/共同）
- 股票盈亏手工录入与股票净投入自动反推
- 总览指标（净资产、环比变化、贷款等）
- 趋势图（净资产、股票市值/盈亏/净投入、资产负债结构）

## 1. Local Run

```bash
npm install
cp .env.example .env
# 设置 .env 内 DATABASE_URL
npm run db:migrate
npm run dev
```

访问 `http://localhost:3000`。

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

Render 文档入口：[render.com](https://render.com/)
