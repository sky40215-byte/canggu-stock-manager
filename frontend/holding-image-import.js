const stockCodePattern = /(?<![A-Z0-9.-])\d{4,6}(?![A-Z0-9.-])/i;
const headingPatterns = [
  ['stock', /(?:股票|證券|商品)?(?:代號|代碼)[\/、](?:股票|證券|商品)?名稱|(?:股票|證券)\((?:代號|代碼)[\/、]名稱\)/gu],
  ['code', /股票代號|證券代號|商品代號|代號|代碼/gu],
  ['name', /股票名稱|證券名稱|商品名稱|標的名稱|股票[\/／]名稱|名稱|標的|股票|證券|商品/gu],
  ['shares', /(?:(?:持有|持股|持倉|庫存)(?:股數|數量|數|餘額)|剩餘股數|股數|現股庫存|庫存)(?:\((?:千股|股|張)\)|千股|[股張])?/gu],
  ['cost', /每股(?:平均)?成本(?:價)?|平均(?:買進|買入)?成本(?:價)?|單位成本(?:價)?|成本均價|庫存均價|持有均價|持倉均價|買[進入]均價|平均買[進入]價|成本價|平均單價|均價/gu],
  ['price', /最新成交價|目前(?:市價|價格)|最新價格|最新價|現價|市價|成交價|參考價|收盤價/gu],
  ['other', /(?:可賣|可售|委託)(?:庫存股數|庫存|股數|數量)?|(?:成交|買進|買入|賣出|交易)(?:股數|數量)|(?:成交|賣出|委託)均價|(?:投資|投入|買進|總|庫存)成本|成本金額|成本總額|成交金額|(?:[預预]估)?(?:庫存淨值|庫存市值|市值|損益(?:金額)?|報酬率)|漲跌幅?|庫存種類|市場[別别]|交易[別别]|幣別|日期|下[單单]|閃電|明[細细]|利息/gu]
];
const identityHeadings = new Set(['code', 'name', 'stock']);
const cardPatterns = [...headingPatterns, ['shares', /持有|持股|持倉/gu]];
const cardFieldNames = new Set(['shares', 'cost', 'price']);
export const maxImageHoldings = 50;

const normalize = (value) => String(value ?? '').normalize('NFKC').trim();
const nameKey = (value) => normalize(value).replace(/臺/g, '台').replace(/[\s*＊]/g, '').toUpperCase();
export const isTaiwanImportCode = (value) => /^\d{4,6}$/.test(normalize(value));

function tsvWords(tsv) {
  const words = [];
  for (const line of tsv.split(/\r?\n/)) {
    const [level, , , , , , left, top, width, height, confidence, ...text] = line.split('\t');
    const label = normalize(text.join('\t'));
    if (level !== '5' || !label || Number(width) <= 0 || Number(height) <= 0) continue;
    words.push({ text: label, x: Number(left), y: Number(top) + Number(height) / 2, width: Number(width), height: Number(height), confidence: Number(confidence) });
  }
  return words;
}

function wordRows(words) {
  const rows = [];
  for (const word of [...words].sort((a, b) => a.y - b.y)) {
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

function describeLine(words) {
  let text = '';
  const characters = [];
  for (const word of words) {
    const label = word.text.replace(/\s+/g, '');
    for (let i = 0; i < label.length; i++) characters.push({
      x: word.x + (i + .5) * word.width / label.length,
      confidence: word.confidence
    });
    text += label;
  }
  return { text, characters };
}

function findHeadings({ text, characters }, patterns = headingPatterns) {
  const matches = [];
  for (const [kind, pattern] of patterns) {
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
    center: (characters[match.start].x + characters[match.start + match.text.length - 1].x) / 2
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

function readAmount(words, kind, heading, requireUnit = false) {
  if (!words.length || words.some((word) => word.confidence < 55)) return '';
  return parseAmount(words.map((word) => word.text).join(' '), kind, heading, requireUnit);
}

function parseAmount(value, kind, heading, requireUnit = false) {
  let text = value.replace(/\s*([,.])\s*/g, '$1').trim();
  if (kind !== 'shares') text = text.replace(/^(?:NT\s*\$|TWD|\$)\s*/i, '');
  const match = text.match(/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(千股|股|張|元)?$/u);
  if (!match) return '';
  const unit = match[2] || (kind === 'shares' ? heading.match(/千股|張/u)?.[0] : '');
  if (requireUnit && !unit && !/(?:股數|\(股\)|(?:持有|庫存|數量|餘額)股$)/u.test(heading)) return '';
  if ((kind === 'shares' && unit === '元') || (kind !== 'shares' && unit && unit !== '元')) return '';
  const numericText = match[1].replace(/,/g, '');
  let number = Number(numericText);
  if (unit === '張' || unit === '千股') {
    const [whole, fraction = ''] = numericText.split('.');
    const preciseFraction = fraction.replace(/0+$/, '');
    if (preciseFraction.length > 3) return '';
    number = Number(whole + preciseFraction.padEnd(3, '0'));
  }
  if (!Number.isFinite(number) || (kind === 'price' && number <= 0) || (kind === 'shares' && (!Number.isSafeInteger(number) || number <= 0))) return '';
  return String(number);
}

export function readHoldingTable(tsv, quotes = new Map()) {
  return readHoldingWords(tsvWords(tsv), quotes);
}

export function readPaddleHoldingTable(items, quotes = new Map()) {
  const words = items.flatMap(({ text, poly, score }) => {
    if (!text || !Array.isArray(poly) || poly.length < 4 || !Number.isFinite(score)) return [];
    const x = poly.map((point) => point[0]), y = poly.map((point) => point[1]);
    const left = Math.min(...x), top = Math.min(...y);
    const width = Math.max(...x) - left, height = Math.max(...y) - top;
    if (!(width > 0) || !(height > 0)) return [];
    return [{ text: normalize(text), x: left, y: top + height / 2, width, height, confidence: score * 100 }];
  });
  return readHoldingWords(words, quotes);
}

function readHoldingWords(words, quotes) {
  const rows = wordRows(words);
  const lines = rows.map(describeLine);
  const headings = lines.map((line) => /\d/.test(line.text) ? [] : findHeadings(line));
  const isTableHeader = (columns) => columns.some(({ kind }) => identityHeadings.has(kind))
    && columns.some(({ kind }) => kind === 'shares' || kind === 'cost');
  let skipSection = false;
  const start = headings.findIndex((columns, index) => {
    if (unrelatedSection.test(lines[index].text)) skipSection = true;
    if (holdingSection.test(lines[index].text)) skipSection = false;
    return !skipSection && isTableHeader(columns);
  });
  if (start < 0) return readHoldingCards(rows, lines, quotes);
  const results = [];
  let columns = inventoryColumns(headings[start]), entries = [];
  for (let i = start + 1; i < rows.length && results.length < maxImageHoldings; i++) {
    if (unrelatedSection.test(lines[i].text)) break;
    if (isTableHeader(headings[i])) {
      results.push(...mergeTableRows(entries).slice(0, maxImageHoldings - results.length));
      entries = [];
      columns = inventoryColumns(headings[i]);
      continue;
    }
    const words = rows[i], cells = columnWords(words, columns);
    const identity = cells.flatMap((cell, j) => identityHeadings.has(columns[j].kind) ? cell : []);
    const label = identity.map((word) => word.text).join(' ');
    if (/^(?:合計|總計|小計|總覽|總市值|合計市值)(?:[：:]|$)/u.test(label.replace(/\s+/g, ''))) break;
    const code = identity.filter((word) => word.confidence >= 55).map((word) => word.text).join(' ').match(stockCodePattern)?.[0] || '';
    const nameText = label.replace(stockCodePattern, '').replace(/(?<=\p{Script=Han})\s+(?=[\p{Script=Han}0-9])/gu, '').replace(/\s+/g, ' ').trim();
    const name = /\p{Script=Han}/u.test(nameText) ? nameText : '';
    const amount = (kind) => {
      const matching = columns.map((column, index) => column.kind === kind ? index : -1).filter((index) => index >= 0);
      return matching.length === 1 ? readAmount(cells[matching[0]], kind, columns[matching[0]].text) : '';
    };
    const shares = amount('shares'), cost = amount('cost'), price = amount('price');
    if (!code && !name && !shares && !cost) continue;
    entries.push({
      row: { code, name, shares, cost, price },
      y: words.reduce((sum, word) => sum + word.y, 0) / words.length,
      height: Math.max(...words.map((word) => word.height)),
      labelOnly: identity.length === words.length
    });
  }
  results.push(...mergeTableRows(entries).slice(0, maxImageHoldings - results.length));
  return results.length ? results : readHoldingCards(rows, lines, quotes);
}

function inventoryColumns(columns) {
  const inventory = columns.some(({ kind, text }) => kind === 'shares' && /^(?:庫存|持有|持股|持倉)/u.test(text));
  if (!inventory || columns.some(({ kind }) => kind === 'cost')) return columns;
  return columns.map((column) => column.text === '成交均價' ? { ...column, kind: 'cost' } : column);
}

function mergeTableRows(entries) {
  const anchors = entries.filter(({ row }) => row.shares || row.cost);
  const supplemental = new Map(), joined = new Set();
  for (const entry of entries) {
    const { row, labelOnly, y, height } = entry;
    if (!labelOnly || (!row.code && !row.name) || row.shares || row.cost || row.price) continue;
    const nearby = anchors.filter((anchor) => Math.abs(anchor.y - y) <= Math.max(height, anchor.height) * 1.35)
      .sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
    const [closest, second] = nearby;
    if (!closest || (second && Math.abs(second.y - y) - Math.abs(closest.y - y) < height * .3)) continue;
    if ((closest.row.code && row.code && closest.row.code !== row.code) ||
      (closest.row.name && row.name && nameKey(closest.row.name) !== nameKey(row.name))) continue;
    if (!supplemental.has(closest)) supplemental.set(closest, []);
    supplemental.get(closest).push(row);
    joined.add(entry);
  }
  return entries.flatMap((entry) => {
    if (joined.has(entry)) return [];
    const extra = supplemental.get(entry) || [];
    const unique = (field) => {
      const values = new Set(extra.map((row) => row[field]).filter(Boolean));
      return values.size === 1 ? values.values().next().value : '';
    };
    const row = { ...entry.row, code: entry.row.code || unique('code'), name: entry.row.name || unique('name') };
    return (row.code || row.name) && (row.code || row.shares || row.cost) ? [row] : [];
  });
}

const trimCardValue = (value) => value.replace(/^[\s:|｜、,;]+|[\s:|｜、,;]+$/gu, '');
const codeCandidates = new RegExp(stockCodePattern.source, 'gi');
const summaryLine = /^(?:庫存總覽|帳戶|合計|總計|小計|總市值)/u;
const holdingSection = /^(?:我的持股|持股明細|持倉明細|股票庫存|庫存明細|庫存總覽)/u;
const unrelatedSection = /^(?:自選股|我的自選|交易(?:明細|紀錄|記錄)|成交明細|委託(?:明細|紀錄|記錄))/u;

function cardIdentity(words, captions, quotes, codesByName) {
  if (captions.some(({ kind }) => cardFieldNames.has(kind) || kind === 'other')) return null;
  if (words.some(({ confidence }) => confidence < 55)) return null;
  const text = words.map(({ text }) => text).join(' ').replace(/^(?:股票|證券|商品)?(?:代號|代碼|名稱)\s*[:：]?\s*/u, '');
  const found = [...text.matchAll(codeCandidates)];
  if (found.length > 1) return { ambiguous: true };
  const code = found[0]?.[0] || '';
  const name = text.replace(stockCodePattern, '').replace(/^[\s:|().·-]+|[\s:|().·-]+$/gu, '').replace(/\s+/g, '');
  if (code && quotes.has(code) && !name) return { code, name: quotes.get(code).name };
  if (code && /^[\p{Script=Han}A-Z0-9*.\-()]{2,28}$/iu.test(name) && /\p{Script=Han}/u.test(name)) return { code, name };
  const matchedCode = !code && codesByName.get(nameKey(name));
  return matchedCode ? { code: matchedCode, name } : null;
}

function cardValue(captions, index, line, nextRow, next, anchor, height) {
  const caption = captions[index];
  const start = caption.start + caption.text.length;
  const end = captions[index + 1]?.start ?? line.text.length;
  if (line.characters.slice(caption.start, start).some(({ confidence }) => confidence < 55)) return '';
  const printed = trimCardValue(line.text.slice(start, end));
  if (printed) {
    if (line.characters.slice(caption.start, end).some(({ confidence }) => confidence < 55)) return '';
    return parseAmount(printed, caption.kind, caption.text, caption.kind === 'shares');
  }
  if (!nextRow?.length || !next || next.captions.length || next.identity || nextRow[0].y - anchor.y > height * 3) return '';
  const sameColumn = columnWords(nextRow, captions)[index].filter((word) => Math.abs(word.x + word.width / 2 - caption.center) <= height * 2);
  return readAmount(sameColumn, caption.kind, caption.text, caption.kind === 'shares');
}

function readHoldingCards(rows, lines, quotes) {
  const codesByName = new Map();
  for (const [code, quote] of quotes) {
    if (!isTaiwanImportCode(code) || !quote.name) continue;
    const key = nameKey(quote.name);
    codesByName.set(key, codesByName.has(key) ? null : code);
  }
  const entries = lines.map((line, index) => {
    const captions = findHeadings(line, cardPatterns);
    return { captions, identity: cardIdentity(rows[index], captions, quotes, codesByName) };
  });
  const cards = [];
  let current = null, inHoldings = false, unrelated = false;
  function finalize() {
    if (current?.quantityLabel) {
      const { code, name, fields } = current;
      const field = (kind) => fields[kind].size === 1 ? [...fields[kind]][0] : '';
      cards.push({ code, name, shares: field('shares'), cost: field('cost'), price: field('price') });
    }
    current = null;
  }
  for (let i = 0; i < rows.length && cards.length < maxImageHoldings; i++) {
    const line = lines[i];
    const { captions, identity } = entries[i];
    const anchor = rows[i][0];
    const height = Math.max(...rows[i].map((word) => word.height));
    if (holdingSection.test(line.text)) { finalize(); inHoldings = true; unrelated = false; continue; }
    if (unrelatedSection.test(line.text)) { finalize(); inHoldings = false; unrelated = true; continue; }
    if (unrelated) continue;
    if (summaryLine.test(line.text)) { finalize(); continue; }
    if (identity || (current && anchor.y - current.y > current.height * 12)) finalize();
    if (cards.length >= maxImageHoldings) break;
    if (identity && !identity.ambiguous) {
      current = { ...identity, y: anchor.y, height, quantityLabel: false, fields: { shares: new Set(), cost: new Set(), price: new Set() } };
      continue;
    }
    if (!current) continue;
    captions.forEach((caption, index) => {
      if (!cardFieldNames.has(caption.kind)) return;
      if (caption.kind === 'shares' && !inHoldings && /^股數(?:\(|[股張]|千股|$)/u.test(caption.text)) return;
      if (caption.kind === 'shares') current.quantityLabel = true;
      const value = cardValue(captions, index, line, rows[i + 1], entries[i + 1], anchor, height);
      if (value) current.fields[caption.kind].add(value);
    });
  }
  if (cards.length < maxImageHoldings) finalize();
  return cards;
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
