import assert from 'node:assert/strict';
import test from 'node:test';
import { dividendStocks, eligibleDividendShares, normalizeCashDividends, recordedDividend } from '../frontend/cash-dividends.js';

const today = '2026-11-28';
const event = { code: '2330', key: '2330:2026-09-16', exDate: '2026-09-16', paymentDate: '2026-10-08' };
const oldBuy = { type: 'buy', stock: '台積電', date: '2026-08-01', shares: 10 };
const sale = { type: 'sell', stock: '2330 台積電', date: event.exDate, shares: 4 };

test('normalizes the newest source record per ex-date and keeps blank payout dates unconfirmed', () => {
  const original = { stock_id: '2330', CashExDividendTradingDate: event.exDate, CashDividendPaymentDate: event.paymentDate, CashEarningsDistribution: 6.5, CashStatutorySurplus: 0.5, AnnouncementDate: '2026-08-20' };
  const rows = normalizeCashDividends('2330', [original, { ...original, stock_id: '2317' },
    { ...original, CashDividendPaymentDate: '2026-10-09', AnnouncementDate: '2026-09-01' },
    { ...original, CashExDividendTradingDate: '2026-12-17', CashDividendPaymentDate: '' },
    { ...original, CashExDividendTradingDate: '2026-09-31' }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ...event, paymentDate: '2026-10-09', price: 7, announced: '2026-09-01' });
  assert.equal(rows[1].paymentDate, '');
});

test('uses pre-ex-date shares, including shares sold on and after the ex-date', () => {
  const portfolio = { holdings: [{ name: '2330 台積電', shares: 106 }], transactions: [oldBuy, sale, { ...oldBuy, date: event.exDate, shares: 100 }] };
  assert.deepEqual(eligibleDividendShares(portfolio, event, '2330 台積電', today), { shares: 10 });
  const sold = { holdings: [], transactions: [oldBuy, { ...sale, shares: 10 }] };
  assert.deepEqual(eligibleDividendShares(sold, event, '2330 台積電', today), { shares: 10 });
  assert.deepEqual([...dividendStocks(sold, today).keys()], ['2330']);
});

test('leaves incomplete history unestimated and uses current shares provisionally for a future ex-date', () => {
  const portfolio = { holdings: [{ name: '2330 台積電', shares: 40 }], transactions: [oldBuy] };
  assert.deepEqual(eligibleDividendShares(portfolio, event, '台積電', today), { shares: null });
  assert.deepEqual(eligibleDividendShares(portfolio, { ...event, exDate: '2026-12-20' }, '台積電', today), { shares: 40, tentative: true });
  portfolio.holdings[0].shares = 10;
  portfolio.transactions[0] = { ...oldBuy, recordOnly: true };
  assert.deepEqual(eligibleDividendShares(portfolio, event, '台積電', today), { shares: null });
});

test('finds both confirmed event keys and older manual entries by symbol or name on payout date', () => {
  assert.equal(recordedDividend([{ type: 'dividend', dividendKey: event.key, date: '2026-10-01' }], event, '台積電'), true);
  assert.equal(recordedDividend([{ type: 'dividend', stock: '台積電', date: event.paymentDate }], event, '2330 台積電'), true);
  assert.equal(recordedDividend([{ type: 'dividend', stock: '2317 台積電', date: event.paymentDate }], event, '2330 台積電'), false);
  assert.equal(recordedDividend([{ type: 'dividend', stock: '2330 台積電', date: event.paymentDate, dividendKey: '2330:2026-04-01' }], event, '2330 台積電'), false);
});
