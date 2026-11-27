import assert from 'node:assert/strict';
import test from 'node:test';
import { alignCloses, positionWeights, priceMetrics } from '../frontend/market-performance.js';

test('aligns both prices on the same valid trading days without filling gaps', () => {
  const series = (rows) => ({ candles: rows.map(([day, close]) => ({ date: `2026-11-${day}`, close })) });
  assert.deepEqual(alignCloses([
    series([['04', 22], ['02', 20], ['03', null], ['05', 24]]),
    series([['05', 200], ['03', 220], ['02', 200], ['04', 0]])
  ]), { dates: ['2026-11-02', '2026-11-05'], values: [[20, 24], [200, 200]] });
});

test('maximum drawdown tracks successive peaks and volatility requires two returns', () => {
  const twoPrices = priceMetrics([100, 90]);
  assert.ok(Math.abs(twoPrices.drawdown + 10) < 1e-9);
  assert.equal(twoPrices.volatility, null);
  const metrics = priceMetrics([100, 120, 90, 130]);
  assert.equal(metrics.drawdown, -25);
  assert.ok(Math.abs(metrics.performance - 30) < 1e-9);
  assert.ok(metrics.volatility > 0);
  assert.equal(priceMetrics([100, 100, 100]).volatility, 0);
});

test('groups duplicate positions and uses the full priced portfolio as the industry denominator', () => {
  const result = positionWeights([
    { code: '2330', name: '台積電', shares: 3, price: 10 },
    { code: '2330', name: '台積電', shares: 2, price: 10, backup: true },
    { code: '2454', name: '聯發科', shares: 2, price: 10 },
    { code: '0050', name: 'ETF', shares: 3, price: 10 },
    { code: '2317', name: '鴻海', shares: 2, price: 0 }
  ], { '2330': '24', '2454': '24', '2317': '28' });
  assert.equal(result.stocks[0].weight, 50);
  assert.deepEqual(result.industries, [{ label: '半導體', weight: 70 }]);
  assert.equal(result.unknown, 30);
  assert.equal(result.unpriced, 1);
  assert.equal(result.fallback, 1);
});
