import assert from 'node:assert/strict';
import test from 'node:test';
import { companyProfiles, eventCandidates, findCompanyMentions } from '../backend/international-events.mjs';

const market = companyProfiles([
  { 公司代號: '2330', 公司簡稱: '臺積電', 英文簡稱: 'TSMC' },
  { 公司代號: '2317', 公司簡稱: '鴻海', 英文簡稱: 'Hon Hai' },
  { 公司代號: '3167', 公司簡稱: '大量', 公司名稱: '大量科技股份有限公司' },
  { 公司代號: '1303', 公司簡稱: '南亞', 公司名稱: '南亞塑膠工業股份有限公司' },
  { 公司代號: '5007', 公司簡稱: '三星', 公司名稱: '三星科技股份有限公司' },
  { 公司代號: '2338', 公司簡稱: '光罩', 公司名稱: '台灣光罩股份有限公司' },
  { 公司代號: '0050', 公司簡稱: '基金' }
], '上市').concat(companyProfiles([
  { SecuritiesCompanyCode: '5347', CompanyAbbreviation: '世界', CompanyName: '世界先進積體電路', Symbol: 'VIS' },
  { SecuritiesCompanyCode: '1234', CompanyAbbreviation: '模擬', Symbol: 'Hon Hai' }
], '上櫃'));
const companies = new Map(market.map((row) => [row.code, row]));
const headlines = [
  { title: 'New export restrictions may affect TSMC orders - Publisher', source: 'Publisher' },
  { title: '出口新規影響世界各地的產業', description: '另一則相關新聞提到鴻海' },
  { title: '出口新規下的投資 - 臺積電', source: '臺積電' },
  { title: 'NTSMCX foreign policy' },
  { title: 'Hon Hai linked to event' },
  { title: '傳叫停東南亞出貨，大量晶片找買家' },
  { title: '韓國三星測試先進光罩' }
];
const mentions = findCompanyMentions(headlines, companies.values());

test('matches bilingual titles while excluding generic names, publishers and ambiguous aliases', () => {
  assert.deepEqual([...mentions], [['2330', ['N1']]]);
  assert.equal(companies.has('0050'), false);
});

test('uses titled company mentions even when model output is unavailable', () => {
  const stocks = eventCandidates({ eventSourceIds: new Set(['N1']), headlines, companies, mentions });
  assert.equal(stocks.length, 1);
  assert.equal(stocks[0].connection, 'mention');
  assert.equal(stocks[0].impact, '方向未定');
  assert.deepEqual(stocks[0].evidence, ['N1']);
});

test('recognizes ambiguous short names only with a matching code or distinctive company name', () => {
  const cited = findCompanyMentions([{ title: '大量（3167）與南亞塑膠工業發布公告' }], companies.values());
  assert.deepEqual([...cited.keys()].sort(), ['1303', '3167']);
});

test('filters unknown codes and unsupported stock claims and distinguishes modeled impact', () => {
  const base = { reason: '測試原因', mechanism: '測試公司具體曝險', impact: '可能承壓' };
  const stock = eventCandidates({
    companies, mentions, headlines, eventSourceIds: new Set(['N1']), modelCodes: new Set(companies.keys()),
    modelStocks: [
      { ...base, code: '1234', evidence: ['F1'] },
      { ...base, code: '2317', evidence: ['N1', 'N99'] },
      { ...base, code: '9999', evidence: ['N1'] },
      { ...base, code: '5347', mechanism: '', evidence: ['N1'] }
    ]
  });
  assert.deepEqual(stock.map(({ code, connection, evidence }) => [code, connection, evidence]), [
    ['2330', 'mention', ['N1']], ['2317', 'inference', ['N1']]
  ]);
});
