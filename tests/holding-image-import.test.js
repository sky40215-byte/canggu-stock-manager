import assert from 'node:assert/strict';
import test from 'node:test';
import { matchHoldingNames, readHoldingTable, readPaddleHoldingTable, reviewImageHoldings } from '../frontend/holding-image-import.js';

function makeTsv(rows) {
  return rows.flatMap((columns, row) => columns.map((text, column) =>
    [5, 1, 1, 1, 1, column + 1, column * 155, row * 32, 100, 18, 92, text].join('\t')
  )).join('\n');
}

test('uses PaddleOCR positions and confidence to fill the correct cells', () => {
  const items = [
    ['股票代號', '股票名稱', '持有股數', '平均成本', '目前市價'],
    ['0050', '元大台灣50', '1.0010 張', '157.30', '170.80']
  ].flatMap((row, line) => row.map((text, column) => {
    const left = column * 155, top = line * 32;
    return { text, poly: [[left, top], [left + 92, top], [left + 92, top + 20], [left, top + 20]],
      score: text === '157.30' ? 0.4 : 0.96 };
  }));
  assert.deepEqual(readPaddleHoldingTable(items), [
    { code: '0050', name: '元大台灣50', shares: '1001', cost: '', price: '170.8' }
  ]);
});

test('reads broker inventory with product name and code on separate lines', () => {
  const rows = [
    [20, [[0, '明细'], [110, '商品'], [240, '市場別'], [315, '庫存股數'], [430, '成交均價'], [540, '投資成本'], [640, '市價']]],
    [53, [[110, '台積電']]],
    [68, [[0, '明細'], [240, '上市'], [315, '1,200'], [430, '642.50'], [540, '771,000'], [640, '720']]],
    [83, [[110, '2330']]],
    [133, [[110, '元大台灣50']]],
    [148, [[0, '明細'], [240, '上市'], [315, '500'], [430, '157.30'], [540, '78,650'], [640, '170.8']]],
    [163, [[110, '0050']]]
  ];
  const items = rows.flatMap(([y, cells]) => cells.map(([x, text]) => ({
    text, score: .96, poly: [[x, y], [x + 64, y], [x + 64, y + 18], [x, y + 18]]
  })));
  assert.deepEqual(readPaddleHoldingTable(items), [
    { code: '2330', name: '台積電', shares: '1200', cost: '642.5', price: '720' },
    { code: '0050', name: '元大台灣50', shares: '500', cost: '157.3', price: '170.8' }
  ]);
});

test('distinguishes a transaction average from an inventory average', () => {
  const transaction = makeTsv([
    ['交易明細'],
    ['商品', '成交股數', '成交均價', '成交金額'],
    ['2330 台積電', '100', '720', '72,000']
  ]);
  assert.deepEqual(readHoldingTable(transaction), []);
  assert.equal(readHoldingTable(makeTsv([
    ['股票代號', '股數', '成交均價'],
    ['2330 台積電', '20', '721']
  ]))[0].cost, '');
});

test('reads a per-share cost and converts lots without taking values from adjacent columns', () => {
  const tsv = makeTsv([
    ['股票代號／名稱', '庫存(張)', '可賣股數', '總成本', '每股平均成本', '最新價'],
    ['0050 元大台灣50', '2.5', '1,500', '393,250', '157.30', '170.8'],
    ['2330 台積電', '67 股', '0', '43,047.5', '642.50', '720'],
    ['合 計', '2,567', '', '436,297.5', '', ''],
    ['0050', '1', '1,000', '93,250', '157.30', '170.8']
  ]);
  assert.deepEqual(readHoldingTable(tsv), [
    { code: '0050', name: '元大台灣50', shares: '2500', cost: '157.3', price: '170.8' },
    { code: '2330', name: '台積電', shares: '67', cost: '642.5', price: '720' }
  ]);
});

test('reads inventory cards by their labels and skips watchlist rows', () => {
  const result = readHoldingTable(makeTsv([
    ['庫存明細'],
    ['台積電（2330）'],
    ['現價 NT$ 720', '持有 67 股', '均價 NT$ 642.50'],
    ['元大台灣50', '0050'],
    ['庫存 2.5 張', '可賣股數 2,000', '總成本 393,250'],
    ['自選股'],
    ['2303 聯電'],
    ['持有 40 股', '現價 50']
  ]));
  assert.deepEqual(result, [
    { code: '2330', name: '台積電', shares: '67', cost: '642.5', price: '720' },
    { code: '0050', name: '元大台灣50', shares: '2500', cost: '', price: '' }
  ]);
});

test('pairs stacked labels by column and leaves ambiguous units and conflicting quantities for review', () => {
  const result = readHoldingTable(makeTsv([
    ['我的持股'],
    ['台積電'],
    ['每股均價', '持有股數'],
    ['642.50', '67'],
    ['持有 100 股'],
    ['0050 元大台灣50'],
    ['持股 2', '均價 157.30'],
    ['成本價'],
    ['2330'],
    ['持倉股數 8', '可賣股數 6']
  ]), new Map([['2330', { name: '台積電' }]]));
  assert.deepEqual(result, [
    { code: '2330', name: '台積電', shares: '', cost: '642.5', price: '' },
    { code: '0050', name: '元大台灣50', shares: '', cost: '157.3', price: '' },
    { code: '2330', name: '台積電', shares: '8', cost: '', price: '' }
  ]);
});

test('total cost and available quantity cannot substitute for missing fields', () => {
  const tsv = makeTsv([
    ['股票名稱', '持有股數', '可賣股數', '總成本', '最新價'],
    ['臺積電', '20', '10', '12,850', '720']
  ]);
  const quotes = new Map([['2330', { name: '台積電', price: 720 }]]);
  const results = matchHoldingNames(readHoldingTable(tsv), quotes);
  assert.deepEqual(results, [{ code: '2330', name: '臺積電', shares: '20', cost: '', price: '720' }]);
  const [review] = reviewImageHoldings([{ ...results[0], action: 'add' }], [], quotes);
  assert.deepEqual(review.issues, ['請填每股平均成本']);
  assert.deepEqual(readHoldingTable(makeTsv([
    ['股票名稱', '可賣股數', '總成本', '最新價'],
    ['臺積電', '20', '12,850', '720']
  ])), []);
});

test('rejects duplicate drafts and leaves existing holdings distinguishable by market', () => {
  const existing = { id: 'taiwan', name: '0050 元大台灣50', shares: 10, cost: 150 };
  const overseas = { id: 'overseas', market: 'hk', name: '0050 香港標的' };
  const draft = { code: '0050', name: '元大台灣50', shares: '20', cost: '143', price: '', action: 'update' };
  const results = reviewImageHoldings([draft, draft], [existing, overseas], new Map());
  assert.deepEqual(results.map((row) => row.issues), [['同一代號請保留一筆匯入'], ['同一代號請保留一筆匯入']]);
  const [update] = reviewImageHoldings([draft, { ...draft, action: 'skip' }], [existing, overseas], new Map());
  assert.deepEqual(update.existing, [existing]);
  assert.deepEqual(update.issues, []);
});
