const stockCodePattern = /(?<![A-Z0-9.-])\d{4,6}(?![A-Z0-9.-])/i;
const headingPatterns = [
  ['stock', /(?:股票|證券|商品)?(?:代號|代碼)[\/、](?:股票|證券|商品)?名稱|(?:股票|證券)\((?:代號|代碼)[\/、]名稱\)/gu],
  ['code', /股票代號|證券代號|商品代號|代號|代碼/gu],
  ['name', /股票名稱|證券名稱|商品名稱|標的名稱|股票[\/／]名稱|名稱|標的|股票|證券/gu],
  ['shares', /(?:持有股數|持股股數|庫存股數|(?:持有|持股|庫存)(?:數量|數|餘額)|剩餘股數|股數|庫存)(?:\((?:千股|股|張)\)|千股|[股張])?/gu],
  ['cost', /每股(?:平均)?成本(?:價)?|平均(?:買進|買入)?成本(?:價)?|單位成本(?:價)?|成本均價|庫存均價|持有均價|買[進入]均價|平均買[進入]價|成本價|平均單價|均價/gu],
  ['price', /最新成交價|目前(?:市價|價格)|最新價格|最新價|現價|市價|成交價|參考價|收盤價/gu],
  ['other', /(?:可賣|可售|委託)(?:庫存股數|庫存|股數|數量)?|(?:投資|投入|買進|總|庫存)成本|成本金額|成本總額|成交金額|(?:預估)?(?:市值|損益|報酬率)|漲跌幅?|庫存種類|交易別|幣別|日期/gu]
];
const identityHeadings = new Set(['code', 'name', 'stock']);
export const maxImageHoldings = 50;

const normalize = (value) => String(value ?? '').normalize('NFKC').trim();
const nameKey = (value) => normalize(value).replace(/臺/g, '台').replace(/[\s*＊]/g, '').toUpperCase();
export const isTaiwanImportCode = (value) => /^\d{4,6}$/.test(normalize(value));

function wordRows(tsv) {
  const words = [];
  for (const line of tsv.split(/\r?\n/)) {
    const [level, , , , , , left, top, width, height, confidence, ...text] = line.split('\t');
    const label = normalize(text.join('\t'));
    if (level !== '5' || !label || Number(width) <= 0 || Number(height) <= 0) continue;
    words.push({ text: label, x: Number(left), y: Number(top) + Number(height) / 2, width: Number(width), height: Number(height), confidence: Number(confidence) });
  }
  words.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const word of words) {
    const row = rows.at(-1);
    if (row && Math.abs(word.y - row.y) <= Math.max(4, Math.max(word.height, row.height) * .48)) {
      row.y += (word.y - row.y) / (row.words.length + 1);
      row.height = Math.max(row.height, word.height);
      row.words.push(word);
    } else {
      rows.push({ y: word.y, height: word.height, words: [word] });
    }
  }
  return rows.map((row) => row.words.sort((a, b) => a.x - b.x));
}

function findHeadings(words) {
  let text = '';
  const locations = [];
  for (const word of words) {
    const label = word.text.replace(/\s+/g, '');
    for (let i = 0; i < label.length; i++) locations.push(word.x + (i + .5) * word.width / label.length);
    text += label;
  }
  const matches = [];
  for (const [kind, pattern] of headingPatterns) {
    for (const match of text.matchAll(pattern)) matches.push({ kind, start: match.index, text: match[0] });
  }
  matches.sort((a, b) => a.start - b.start || b.text.length - a.text.length);
  let end = 0;
  return matches.filter((match) => {
    if (match.start < end) return false;
    end = match.start + match.text.length;
    return true;
  }).map((match) => ({
    ...match,
    center: (locations[match.start] + locations[match.start + match.text.length - 1]) / 2
  }));
}

function columnWords(words, columns) {
  const cells = columns.map(() => []);
  for (const word of words) {
    const midpoint = word.x + word.width / 2;
    const index = columns.findIndex((column, i) => !columns[i + 1] || midpoint < (column.center + columns[i + 1].center) / 2);
    if (index >= 0) cells[index].push(word);
  }
  return cells;
}

function readAmount(words, kind, heading) {
  if (!words.length || words.some((word) => word.confidence < 55)) return '';
  const text = words.map((word) => word.text).join(' ').replace(/\s*([,.])\s*/g, '$1');
  const match = text.match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(千股|股|張|元)?$/u);
  if (!match) return '';
  const unit = match[2] || (kind === 'shares' ? heading.match(/千股|張/u)?.[0] : '');
  if ((kind === 'shares' && unit === '元') || (kind !== 'shares' && unit && unit !== '元')) return '';
  const number = Number(match[1].replace(/,/g, '')) * (unit === '張' || unit === '千股' ? 1000 : 1);
  if (!Number.isFinite(number) || (kind === 'price' && number <= 0) || (kind === 'shares' && (!Number.isSafeInteger(number) || number <= 0))) return '';
  return String(number);
}

export function readHoldingTable(tsv) {
  const rows = wordRows(tsv);
  const headings = rows.map(findHeadings);
  const start = headings.findIndex((columns) => columns.some(({ kind }) => identityHeadings.has(kind))
    && columns.some(({ kind }) => kind === 'shares' || kind === 'cost'));
  if (start < 0) return [];
  const results = [];
  let columns = headings[start];
  for (let i = start + 1; i < rows.length && results.length < maxImageHoldings; i++) {
    if (headings[i].some(({ kind }) => identityHeadings.has(kind)) && headings[i].some(({ kind }) => kind === 'shares' || kind === 'cost')) {
      columns = headings[i];
      continue;
    }
    const cells = columnWords(rows[i], columns);
    const identity = cells.flatMap((cell, j) => identityHeadings.has(columns[j].kind) ? cell : []);
    const label = identity.map((word) => word.text).join(' ');
    if (/^(?:合計|總計|小計|總覽|總市值|合計市值)(?:[：:]|$)/u.test(label.replace(/\s+/g, ''))) break;
    const code = identity.filter((word) => word.confidence >= 55).map((word) => word.text).join(' ').match(stockCodePattern)?.[0] || '';
    const name = label.replace(stockCodePattern, '').replace(/(?<=\p{Script=Han})\s+(?=[\p{Script=Han}0-9])/gu, '').replace(/\s+/g, ' ').trim();
    if (!code && !/\p{Script=Han}/u.test(name)) continue;
    const amount = (kind) => {
      const matching = columns.map((column, index) => column.kind === kind ? index : -1).filter((index) => index >= 0);
      return matching.length === 1 ? readAmount(cells[matching[0]], kind, columns[matching[0]].text) : '';
    };
    const shares = amount('shares'), cost = amount('cost'), price = amount('price');
    if (!code && !shares && !cost) continue;
    results.push({ code, name, shares, cost, price });
  }
  return results;
}

export function matchHoldingNames(rows, quotes) {
  const names = new Map();
  for (const [code, quote] of quotes) {
    if (!isTaiwanImportCode(code) || !quote.name) continue;
    const key = nameKey(quote.name);
    names.set(key, names.has(key) ? null : code);
  }
  return rows.map((row) => {
    const code = row.code || names.get(nameKey(row.name)) || '';
    return { ...row, code, name: row.name || quotes.get(code)?.name || '' };
  });
}

export function reviewImageHoldings(drafts, holdings, quotes) {
  const matches = new Map();
  for (const holding of holdings) {
    if (holding.market && holding.market !== 'tw') continue;
    const code = String(holding.name || '').match(stockCodePattern)?.[0] || holding.symbol;
    if (code) matches.set(code, [...(matches.get(code) || []), holding]);
  }
  const selectedCounts = new Map();
  for (const draft of drafts) {
    const code = normalize(draft.code);
    if (draft.action !== 'skip' && isTaiwanImportCode(code)) selectedCounts.set(code, (selectedCounts.get(code) || 0) + 1);
  }
  return drafts.map((draft) => {
    const code = normalize(draft.code);
    const existing = matches.get(code) || [];
    const quote = quotes.get(code);
    const name = normalize(draft.name) || quote?.name || '';
    const shares = Number(draft.shares), cost = Number(draft.cost);
    const price = normalize(draft.price) ? Number(draft.price) : null;
    const issues = [];
    if (!isTaiwanImportCode(code)) issues.push('請填 4–6 碼台股代號');
    if (!name) issues.push('請填股票名稱');
    if (!Number.isSafeInteger(shares) || shares <= 0) issues.push('請填大於零的整數股數');
    if (!normalize(draft.cost) || !Number.isFinite(cost) || cost < 0) issues.push('請填每股平均成本');
    if (price !== null && (!Number.isFinite(price) || price <= 0)) issues.push('請填正數備用價或留空');
    if (existing.length > 1) issues.push('已有多筆同代號持股，請先手動整理');
    if (draft.action !== 'skip' && draft.action !== (existing.length ? 'update' : 'add')) issues.push('請確認新增或更新');
    if (draft.action !== 'skip' && (selectedCounts.get(code) || 0) > 1) issues.push('同一代號請保留一筆匯入');
    const notes = [];
    if (quote?.name && name && nameKey(quote.name) !== nameKey(name)) notes.push('行情名稱為 ' + quote.name + '，請核對');
    if (!quote && isTaiwanImportCode(code)) notes.push('目前行情未能核對此代號');
    return { code, name, shares, cost, price, quote, existing, issues, notes };
  });
}
