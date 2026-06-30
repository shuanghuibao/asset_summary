const rows = window.__TREND_DATA__ || [];
const labels = rows.map((x) => x.periodDate);

const lineBaseOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { position: "bottom" } },
};

new Chart(document.getElementById("netAssetChart"), {
  type: "line",
  data: {
    labels,
    datasets: [
      {
        label: "家庭净资产",
        data: rows.map((x) => x.netAssets),
        borderColor: "#4e79a7",
        backgroundColor: "rgba(78,121,167,0.12)",
        tension: 0.25,
      },
    ],
  },
  options: lineBaseOptions,
});

new Chart(document.getElementById("stockChart"), {
  type: "bar",
  data: {
    labels,
    datasets: [
      {
        label: "股票市值",
        type: "line",
        data: rows.map((x) => x.stockMarketValue),
        borderColor: "#59a14f",
        yAxisID: "y",
      },
      {
        label: "本期股票盈亏",
        data: rows.map((x) => x.stockPnl),
        backgroundColor: "#4e79a7",
        yAxisID: "y1",
      },
      {
        label: "本月股票净投入(自动反推)",
        data: rows.map((x) => x.stockNetFlow),
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

new Chart(document.getElementById("structureChart"), {
  type: "bar",
  data: {
    labels,
    datasets: [
      {
        label: "总资产",
        data: rows.map((x) => x.totalAssets),
        backgroundColor: "#76b7b2",
      },
      {
        label: "总负债",
        data: rows.map((x) => x.totalLiabilities),
        backgroundColor: "#e15759",
      },
    ],
  },
  options: {
    ...lineBaseOptions,
    scales: { x: { stacked: true }, y: { stacked: true } },
  },
});
