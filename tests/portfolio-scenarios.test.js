import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTopup, compareTopup } from '../frontend/portfolio-math.js';
import { calculateStress } from '../frontend/portfolio-stress.js';

const example = {
  price: 100, budget: 20000, currentShares: 200, averageCost: 120, shareUnit: 1,
  commissionRatePercent: 0.1, sellTaxRatePercent: 0.3
};
const cents = (number) => Math.round(number * 100);

test('the competition example includes buy and sell costs in each calculation', () => {
  const { baseline, added, pnlDifference } = compareTopup(example, 100, 90, { otherSameSymbolShares: 0, otherStockValue: 7200 });
  assert.equal(added.shares, 199);
  assert.equal(added.totalShares, 399);
  assert.equal(cents(added.buyCommission), 1990);
  assert.equal(cents(added.saleCommission), 3591);
  assert.equal(cents(added.saleTax), 10773);
  assert.equal(cents(baseline.pnl), -607200);
  assert.equal(cents(added.pnl), -815354);
  assert.equal(cents(pnlDifference), -208154);
});

test('whole-lot rounding never buys an unaffordable fraction', () => {
  const item = { ...example, shareUnit: 1000 };
  assert.equal(calculateTopup({ ...item, budget: 100099 }).shares, 0);
  assert.equal(calculateTopup({ ...item, budget: 100100 }).shares, 1000);
});

test('stress sums market value changes and excludes positions without a price', () => {
  const result = calculateStress([
    { id: 'semi', shares: 200, price: 100 },
    { id: 'industrial', shares: 100, price: 72 },
    { id: 'unknown', shares: 50, price: 0 }
  ], -10);
  assert.equal(result.current, 27200);
  assert.equal(result.stressed, 24480);
  assert.equal(result.difference, -2720);
  assert.equal(result.excluded, 1);
  assert.deepEqual(result.rows.map(({ id, difference }) => [id, difference]), [['semi', -2000], ['industrial', -720]]);
});
