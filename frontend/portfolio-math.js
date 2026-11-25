export function calculateTopup(item, { buyPrice = item.price, futurePrice = item.price, add = true } = {}) {
  const price = Number(buyPrice);
  const unit = Number(item.shareUnit);
  const budget = Number(item.budget);
  const commission = Number(item.commissionRatePercent) / 100;
  const tax = Number(item.sellTaxRatePercent) / 100;
  const lotCost = price * unit * (1 + commission);
  const shares = add && lotCost > 0 ? Math.floor((budget + 1e-8) / lotCost) * unit : 0;
  const addedCost = shares * price;
  const buyCommission = addedCost * commission;
  const purchaseTotal = addedCost + buyCommission;
  const totalShares = Number(item.currentShares) + shares;
  const totalCost = Number(item.averageCost) * Number(item.currentShares) + addedCost;
  const costBasisWithBuyFee = totalCost + buyCommission;
  const marketValue = Number(futurePrice) * totalShares;
  const saleCommission = marketValue * commission;
  const saleTax = marketValue * tax;
  const pnl = marketValue - costBasisWithBuyFee - saleCommission - saleTax;
  const breakEven = totalShares > 0 && commission + tax < 1
    ? costBasisWithBuyFee / (totalShares * (1 - commission - tax))
    : null;

  return {
    price, shares, addedCost, buyCommission, purchaseTotal, totalShares, totalCost, marketValue,
    saleCommission, saleTax, transactionCosts: buyCommission + saleCommission + saleTax,
    averageCost: totalShares ? totalCost / totalShares : 0,
    pnl, pnlPercent: costBasisWithBuyFee ? pnl / costBasisWithBuyFee * 100 : 0,
    remaining: Math.max(0, budget - purchaseTotal), breakEven
  };
}

export function topupApiResult(item) {
  const result = calculateTopup(item);
  return {
    ...item,
    sharesToBuy: result.shares,
    addedCost: result.addedCost,
    purchaseTotal: result.purchaseTotal,
    remainingBudget: result.remaining,
    totalShares: result.totalShares,
    newAverageCost: result.averageCost,
    buyCommission: result.buyCommission,
    estimatedSaleCommission: result.saleCommission,
    estimatedSaleTax: result.saleTax,
    estimatedTransactionCosts: result.transactionCosts,
    estimatedBreakEvenPrice: result.breakEven,
    projectedUnrealizedPnl: result.pnl,
    projectedUnrealizedPnlPercent: result.pnlPercent,
    feesAndTaxIncluded: true
  };
}

export function compareTopup(item, buyPrice, futurePrice, portfolio = null) {
  const baseline = calculateTopup(item, { buyPrice, futurePrice, add: false });
  const added = calculateTopup(item, { buyPrice, futurePrice });
  const weight = (scenario) => {
    if (!portfolio) return null;
    const stockValue = scenario.marketValue + portfolio.otherSameSymbolShares * futurePrice;
    const total = stockValue + portfolio.otherStockValue;
    return total > 0 ? stockValue / total * 100 : null;
  };
  return { baseline, added, baselineWeight: weight(baseline), addedWeight: weight(added), pnlDifference: added.pnl - baseline.pnl };
}

export function marketTotals(holdings, priceFor, currencyFor) {
  const totals = new Map();
  for (const item of holdings) {
    const currency = currencyFor(item);
    const result = totals.get(currency) ?? { cost: 0, value: 0 };
    result.cost += Number(item.cost || 0) * Number(item.shares || 0);
    result.value += Number(priceFor(item) || 0) * Number(item.shares || 0);
    totals.set(currency, result);
  }
  return totals;
}
