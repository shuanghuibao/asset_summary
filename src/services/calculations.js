function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function computeStockNetFlow(currentMarketValue, previousMarketValue, stockPnlManual) {
  return toNumber(currentMarketValue) - toNumber(previousMarketValue) - toNumber(stockPnlManual);
}

function computeMemberTotals(memberSnapshot) {
  const totalIncome =
    toNumber(memberSnapshot.salary_income) +
    toNumber(memberSnapshot.bonus_income) +
    toNumber(memberSnapshot.housing_fund_income);

  const totalAssets =
    toNumber(memberSnapshot.cash_savings) +
    toNumber(memberSnapshot.stock_fund_market_value) +
    toNumber(memberSnapshot.housing_fund_balance);

  const totalLiabilities = toNumber(memberSnapshot.credit_card_balance);

  return {
    totalIncome,
    totalAssets,
    totalLiabilities,
    netAssets: totalAssets - totalLiabilities,
  };
}

function computeHouseholdNetAssets({ memberSnapshots, householdSnapshot }) {
  const memberAssets = memberSnapshots.reduce(
    (acc, row) => acc + toNumber(row.cash_savings) + toNumber(row.stock_fund_market_value) + toNumber(row.housing_fund_balance),
    0
  );
  const memberCreditCards = memberSnapshots.reduce((acc, row) => acc + toNumber(row.credit_card_balance), 0);
  const mortgage = toNumber(householdSnapshot?.remaining_mortgage_total);

  return memberAssets - memberCreditCards - mortgage;
}

module.exports = {
  toNumber,
  computeStockNetFlow,
  computeMemberTotals,
  computeHouseholdNetAssets,
};
