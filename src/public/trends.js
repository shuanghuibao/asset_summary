(function renderTrendCharts() {
  const rows = Array.isArray(window.__TREND_DATA__) ? window.__TREND_DATA__ : [];
  const trendContext = window.__TREND_CONTEXT__ || {};
  const memberAssetComposition = Array.isArray(window.__MEMBER_ASSET_COMPOSITION__)
    ? window.__MEMBER_ASSET_COMPOSITION__
    : [];
  const isMemberView = Boolean(trendContext.isMemberView);
  const chartGrid = document.querySelector(".chart-grid");

  function showChartError(message) {
    if (!chartGrid) return;
    chartGrid.innerHTML = `<div class="chart-error">${message}</div>`;
  }

  if (typeof Chart === "undefined") {
    showChartError("图表组件加载失败，请刷新页面或检查部署配置。");
    return;
  }

  if (!rows.length) {
    showChartError("暂无可展示的趋势数据。");
    return;
  }

  const labels = rows.map((x) => x.periodDate);
  const value = (row, key) => (row[key] === null || row[key] === undefined ? null : Number(row[key]));

  const lineBaseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { position: "bottom" } },
  };

  const createChart = (id, config) => {
    const el = document.getElementById(id);
    if (!el) return;
    new Chart(el, config);
  };

  createChart("netAssetChart", {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: trendContext.netAssetLabel || "家庭净资产",
          data: rows.map((x) => value(x, "netAssets")),
          borderColor: "#4e79a7",
          backgroundColor: "rgba(78,121,167,0.12)",
          tension: 0.25,
        },
      ],
    },
    options: lineBaseOptions,
  });

  const stockDatasets = [
    {
      label: `${trendContext.viewLabel || "家庭"}投资市值`,
      type: "line",
      data: rows.map((x) => value(x, "stockMarketValue")),
      borderColor: "#59a14f",
      yAxisID: "y",
    },
  ];
  if (!isMemberView) {
    stockDatasets.push(
      {
        label: "本期投资收益",
        data: rows.map((x) => value(x, "stockPnl")),
        backgroundColor: "#4e79a7",
        yAxisID: "y1",
      },
      {
        label: "本期净投入",
        data: rows.map((x) => value(x, "stockNetFlow")),
        backgroundColor: "#f28e2b",
        yAxisID: "y1",
      }
    );
  }

  createChart("stockChart", {
    type: "bar",
    data: {
      labels,
      datasets: stockDatasets,
    },
    options: {
      ...lineBaseOptions,
      scales: {
        y: { position: "left" },
        y1: { position: "right", grid: { drawOnChartArea: false } },
      },
    },
  });

  const expenseDatasets = [];
  if (!isMemberView) {
    expenseDatasets.push(
      {
        label: "总支出",
        data: rows.map((x) => value(x, "totalExpense")),
        borderColor: "#8e5ea2",
        backgroundColor: "rgba(142,94,162,0.12)",
        spanGaps: true,
        tension: 0.25,
      },
      {
        label: "隐含支出",
        data: rows.map((x) => value(x, "implicitExpense")),
        borderColor: "#e15759",
        backgroundColor: "rgba(225,87,89,0.12)",
        spanGaps: true,
        tension: 0.25,
      }
    );
  }
  expenseDatasets.push({
    label: "已记录支出",
    data: rows.map((x) => value(x, "totalExpenseManual")),
    borderColor: "#4e79a7",
    backgroundColor: "rgba(78,121,167,0.10)",
    spanGaps: true,
    tension: 0.25,
  });

  createChart("expenseChart", {
    type: "line",
    data: {
      labels,
      datasets: expenseDatasets,
    },
    options: lineBaseOptions,
  });

  if (!isMemberView && memberAssetComposition.length) {
    const assetTotal = memberAssetComposition.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    createChart("memberAssetChart", {
      type: "pie",
      data: {
        labels: memberAssetComposition.map((item) => item.label),
        datasets: [
          {
            label: "成员资产组成",
            data: memberAssetComposition.map((item) => Number(item.amount || 0)),
            backgroundColor: ["#4e79a7", "#59a14f", "#f28e2b", "#76b7b2", "#edc949", "#af7aa1"],
          },
        ],
      },
      options: {
        ...lineBaseOptions,
        plugins: {
          ...lineBaseOptions.plugins,
          title: {
            display: true,
            text: "最新一期成员资产组成",
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const amount = Number(context.raw || 0);
                const percent = assetTotal ? ` (${((amount / assetTotal) * 100).toFixed(1)}%)` : "";
                return `${context.label}: ${amount.toLocaleString("zh-CN")}${percent}`;
              },
            },
          },
        },
      },
    });
  }

  createChart("structureChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: `${trendContext.viewLabel || "家庭"}总资产`,
          data: rows.map((x) => value(x, "totalAssets")),
          backgroundColor: "#76b7b2",
        },
        {
          label: `${trendContext.viewLabel || "家庭"}总负债`,
          data: rows.map((x) => {
            const amount = value(x, "totalLiabilities");
            return amount === null ? null : -amount;
          }),
          backgroundColor: "#e15759",
        },
      ],
    },
    options: {
      ...lineBaseOptions,
      plugins: {
        ...lineBaseOptions.plugins,
        tooltip: {
          callbacks: {
            label: (context) => {
              const label = context.dataset.label ? `${context.dataset.label}: ` : "";
              return `${label}${Math.abs(Number(context.raw || 0)).toLocaleString("zh-CN")}`;
            },
          },
        },
      },
      scales: {
        y: {
          ticks: {
            callback: (tickValue) => Math.abs(Number(tickValue)).toLocaleString("zh-CN"),
          },
        },
      },
    },
  });
})();
