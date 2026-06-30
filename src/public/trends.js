(function renderTrendCharts() {
  const rows = Array.isArray(window.__TREND_DATA__) ? window.__TREND_DATA__ : [];
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
          label: "家庭净资产",
          data: rows.map((x) => value(x, "netAssets")),
          borderColor: "#4e79a7",
          backgroundColor: "rgba(78,121,167,0.12)",
          tension: 0.25,
        },
      ],
    },
    options: lineBaseOptions,
  });

  createChart("stockChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "投资市值",
          type: "line",
          data: rows.map((x) => value(x, "stockMarketValue")),
          borderColor: "#59a14f",
          yAxisID: "y",
        },
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
        },
      ],
    },
    options: {
      ...lineBaseOptions,
      scales: {
        y: { position: "left" },
        y1: { position: "right", grid: { drawOnChartArea: false } },
      },
    },
  });

  createChart("expenseChart", {
    type: "line",
    data: {
      labels,
      datasets: [
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
        },
        {
          label: "已记录支出",
          data: rows.map((x) => value(x, "totalExpenseManual")),
          borderColor: "#4e79a7",
          backgroundColor: "rgba(78,121,167,0.10)",
          spanGaps: true,
          tension: 0.25,
        },
      ],
    },
    options: lineBaseOptions,
  });

  createChart("structureChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "总资产",
          data: rows.map((x) => value(x, "totalAssets")),
          backgroundColor: "#76b7b2",
        },
        {
          label: "总负债",
          data: rows.map((x) => value(x, "totalLiabilities")),
          backgroundColor: "#e15759",
        },
      ],
    },
    options: {
      ...lineBaseOptions,
      scales: { x: { stacked: true }, y: { stacked: true } },
    },
  });
})();
