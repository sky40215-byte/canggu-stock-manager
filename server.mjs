import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const LOCAL_CONFIG_PATH = process.env.CANGGU_CONFIG_PATH || resolve(process.env.LOCALAPPDATA || ROOT, 'Canggu', 'config.env');
try {
  const localEnv = await readFile(LOCAL_CONFIG_PATH, 'utf8');
  for (const line of localEnv.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* Local AppData config is optional; environment variables also work. */ }
const PORT = Number(process.env.CANGGU_PORT || process.env.PORT || 4174);
const FUGLE_API_KEY = process.env.FUGLE_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function value(row, names) {
  for (const name of names) if (row[name] !== undefined && row[name] !== null && row[name] !== '') return row[name];
  const keys = Object.keys(row);
  const found = keys.find((key) => names.some((name) => key.toLowerCase().includes(name.toLowerCase())));
  return found ? row[found] : '';
}
function rocDate(date) {
  const raw = String(date || '').replace(/\D/g, '');
  if (raw.length === 7) return `${Number(raw.slice(0, 3)) + 1911}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`;
  if (raw.length === 8) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return String(date || '');
}
function normalize(row, market) {
  const code = String(value(row, market === '上市' ? ['Code', '證券代號', '股票代號'] : ['SecuritiesCompanyCode', 'SecuritiesCode', 'Code', '代號', '股票代號'])).trim();
  const name = String(value(row, market === '上市' ? ['Name', '證券名稱', '股票名稱'] : ['CompanyName', 'Name', '名稱', '股票名稱'])).trim();
  const price = Number(String(value(row, ['ClosingPrice', 'Close', '收盤價', '收盤'])).replace(/,/g, ''));
  if (!/^\d{4,6}$/.test(code) || !Number.isFinite(price) || price <= 0) return null;
  const changeRaw = Number(String(value(row, ['Change', '漲跌價差', '漲跌'])).replace(/,/g, ''));
  const turnover = Number(String(value(row, ['TradeValue', 'TradingValue', 'TradeAmount', '成交金額', '成交值'])).replace(/,/g, ''));
  const date = rocDate(value(row, ['Date', '日期', '交易日期']));
  return { code, name, price, change: Number.isFinite(changeRaw) ? changeRaw : null, turnover: Number.isFinite(turnover) ? turnover : null, date, market };
}
async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'CangguPersonalStockApp/1.0' } });
  if (!response.ok) throw new Error(`資料來源回應 ${response.status}`);
  return response.json();
}
async function quotes() {
  const sources = [
    ['上市', 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'],
    ['上櫃', 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes']
  ];
  const results = await Promise.allSettled(sources.map(async ([market, url]) => {
    const rows = await fetchJson(url);
    if (!Array.isArray(rows)) throw new Error(`${market}行情格式不符`);
    return rows.map((row) => normalize(row, market)).filter(Boolean);
  }));
  const merged = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (!merged.length) throw new Error('行情來源目前無法連線，請稍後再試。');
  return { quotes: merged, updatedAt: new Date().toISOString(), warnings: results.map((r, i) => r.status === 'rejected' ? `${sources[i][0]}市場資料暫時無法取得` : null).filter(Boolean) };
}
function decodeXml(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}
async function news(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0 CangguPersonalStockApp/1.0' } });
  if (!response.ok) throw new Error(`新聞來源回應 ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    const tag = (name) => decodeXml(block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '');
    const title = tag('title'), link = tag('link'), publishedAt = tag('pubDate'), source = tag('source');
    const sourceUrl = decodeXml(block.match(/<source\b[^>]*\burl=["']([^"']+)["'][^>]*>/i)?.[1] || '');
    const validLink = (candidate) => { try { return ['http:', 'https:'].includes(new URL(candidate).protocol); } catch { return false; } };
    const searchLink = `https://news.google.com/search?q=${encodeURIComponent(`"${title}"`)}&hl=zh-TW&gl=TW`;
    return title && validLink(link) ? { title, link, publishedAt, source, sourceUrl: validLink(sourceUrl) ? sourceUrl : '', searchLink } : null;
  }).filter(Boolean);
  return { items: items.slice(0, 20), updatedAt: new Date().toISOString() };
}
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function ema(values, period) {
  if (values.length < period) return values.map(() => null);
  const out = Array(values.length).fill(null), factor = 2 / (period + 1);
  let current = average(values.slice(0, period)); out[period - 1] = current;
  for (let i = period; i < values.length; i++) { current = values[i] * factor + current * (1 - factor); out[i] = current; }
  return out;
}
function withIndicators(candles) {
  const closes = candles.map((row) => Number(row.close));
  const sma = (period) => closes.map((_, index) => index + 1 < period ? null : average(closes.slice(index + 1 - period, index + 1)));
  const sma20 = sma(20), sma60 = sma(60), fastEma = ema(closes, 12), slowEma = ema(closes, 26);
  const macdLine = fastEma.map((fast, index) => fast === null || slowEma[index] === null ? null : fast - slowEma[index]);
  const compactMacd = macdLine.filter((value) => value !== null), signalValues = ema(compactMacd, 9), signalLine = Array(closes.length).fill(null); let signalIndex = 0;
  macdLine.forEach((value, index) => { if (value !== null) signalLine[index] = signalValues[signalIndex++]; });
  const rsi14 = closes.map((_, index) => {
    if (index < 14) return null;
    let gains = 0, losses = 0;
    for (let i = index - 13; i <= index; i++) { const change = closes[i] - closes[i - 1]; if (change > 0) gains += change; else losses -= change; }
    if (!losses) return gains ? 100 : 50;
    return 100 - 100 / (1 + gains / losses);
  });
  return candles.map((row, index) => ({ ...row, close: closes[index], sma20: sma20[index], sma60: sma60[index], rsi14: rsi14[index], macd: macdLine[index], macdSignal: signalLine[index], macdHistogram: macdLine[index] === null || signalLine[index] === null ? null : macdLine[index] - signalLine[index] }));
}
async function fugleTrend(symbol, days) {
  if (!FUGLE_API_KEY) return { configured: false };
  const end = new Date(), start = new Date(end.getTime() - days * 86400000);
  const date = (value) => value.toISOString().slice(0, 10);
  const params = new URLSearchParams({ from: date(start), to: date(end), fields: 'open,high,low,close,volume', sort: 'asc' });
  const response = await fetch(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${encodeURIComponent(symbol)}?${params}`, { signal: AbortSignal.timeout(15000), headers: { 'X-API-KEY': FUGLE_API_KEY, 'User-Agent': 'CangguPersonalStockApp/1.0' } });
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? 'Fugle API 金鑰無效或方案未開通。' : response.status === 429 ? 'Fugle API 請求已達方案限制，請稍後再試。' : response.status === 404 ? '這段期間沒有可用的歷史行情。' : `Fugle 回應錯誤（${response.status}）。`;
    const error = new Error(message); error.status = response.status; throw error;
  }
  const payload = await response.json();
  const candles = withIndicators((Array.isArray(payload.data) ? payload.data : []).filter((row) => Number.isFinite(Number(row.close))).sort((a, b) => String(a.date).localeCompare(String(b.date))));
  return { configured: true, symbol, market: payload.market || payload.exchange || '', timeframe: payload.timeframe || 'D', candles, source: 'Fugle 歷史日 K', updatedAt: new Date().toISOString() };
}
const screenCache = new Map();
async function screenStocks(priceLimit, horizon) {
  if (!FUGLE_API_KEY) return { configured: false };
  const cacheKey = `${priceLimit}:${horizon}`, cached = screenCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 180000) return cached.data;
  const market = await quotes();
  const universe = market.quotes.filter((row) => /^\d{4}$/.test(String(row.code)) && !String(row.code).startsWith('0') && Number(row.price) > 0 && Number(row.price) <= priceLimit && Number(row.turnover) >= 30000000 && !/(ETF|基金|存託|權證|牛|熊|期貨|債)/i.test(String(row.name))).sort((a, b) => Number(b.turnover) - Number(a.turnover)).slice(0, 6);
  if (!universe.length) return { configured: true, candidates: [], updatedAt: market.updatedAt, message: '價格上限內沒有符合成交值篩選的個股；可提高每股價格上限後再試。' };
  const results = await Promise.allSettled(universe.map(async (quote) => {
    const trend = await fugleTrend(String(quote.code), 90), candles = trend.candles;
    if (candles.length < Math.max(22, horizon + 1)) return null;
    const last = candles.at(-1), previous = candles.at(-2), baseline = candles.at(-horizon - 1), window = candles.slice(-horizon - 1, -1), recent20 = candles.slice(-21, -1);
    const support = Math.min(...window.map((row) => Number(row.low)).filter(Number.isFinite)), resistance = Math.max(...window.map((row) => Number(row.high)).filter(Number.isFinite));
    const trueRanges = candles.slice(-15).map((row, index, rows) => { const prev = candles[candles.length - rows.length + index - 1]; const h = Number(row.high), l = Number(row.low), pc = Number(prev?.close); return Number.isFinite(h) && Number.isFinite(l) ? Number.isFinite(pc) ? Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)) : h-l : null; }).filter(Number.isFinite);
    const atr = trueRanges.length ? average(trueRanges) : last.close * 0.04;
    const averageVolume = average(recent20.map((row) => Number(row.volume)).filter(Number.isFinite)), volumeOK = averageVolume > 0 && Number(last.volume) >= averageVolume * 1.2;
    const horizonReturn = baseline?.close > 0 ? (last.close / baseline.close - 1) * 100 : 0, bullish = last.sma20 != null && last.sma60 != null && last.close > last.sma20 && last.sma20 > last.sma60;
    const improving = last.macdHistogram != null && previous?.macdHistogram != null && last.macdHistogram > previous.macdHistogram;
    let score = (horizonReturn > 0 ? 1 : 0) + (horizonReturn > 2 ? 1 : 0) + (bullish ? 2 : 0) + (last.rsi14 >= 40 && last.rsi14 <= 65 ? 1 : 0) + (improving ? 1 : 0) + (volumeOK ? 1 : 0) - (last.rsi14 >= 75 ? 2 : 0);
    const breakout = last.close > resistance && bullish && last.rsi14 >= 50 && last.rsi14 <= 68 && improving && volumeOK;
    const entryLow = breakout ? resistance : support, entryHigh = breakout ? resistance + atr * 0.25 : support + atr * 0.5, stop = Math.max(0, (breakout ? resistance : support) - atr * 0.5);
    const entry = (entryLow + entryHigh) / 2, risk = Math.max(entry - stop, atr * 0.25), target1 = entry + risk, target2 = entry + risk * 2;
    const pullback = last.close >= entryLow && last.close <= entryHigh && last.rsi14 >= 30 && last.rsi14 <= 60 && improving;
    const status = breakout ? '突破量價條件符合（以最近日 K 計算）' : pullback ? '回測支撐觀察區，等待轉強確認' : last.close > entryHigh ? '現價高於觀察區，避免追價' : score >= 5 ? '趨勢條件較佳，等待價格進入觀察區' : '條件未齊，列為觀察';
    return { code: quote.code, name: quote.name, market: quote.market, price: quote.price, date: last.date, turnover: quote.turnover, horizonReturn, score, rsi: last.rsi14, entryLow, entryHigh, stop, target1, target2, support, resistance, status, volumeOK, smaTrend: bullish, improving, breakout, pullback };
  }));
  const candidates = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []).sort((a, b) => b.score - a.score || b.horizonReturn - a.horizonReturn).slice(0, 5);
  const data = { configured: true, candidates, horizon, updatedAt: market.updatedAt, warnings: results.some((result) => result.status === 'rejected') ? ['部分 Fugle 歷史資料暫時無法取得'] : [] };
  screenCache.set(cacheKey, { time: Date.now(), data });
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/sync/config') return send(res, 200, { configured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY), production: process.env.NODE_ENV === 'production', url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
    if (url.pathname === '/api/fugle/status') return send(res, 200, { configured: Boolean(FUGLE_API_KEY) });
    if (url.pathname === '/api/fugle/trend') {
      const symbol = String(url.searchParams.get('symbol') || '').trim();
      const days = Number(url.searchParams.get('days') || 90);
      if (!/^\d{4,6}$/.test(symbol)) return send(res, 400, { error: '請輸入 4–6 碼股票代號。' });
      if (![90, 180, 350].includes(days)) return send(res, 400, { error: '查詢期間不正確。' });
      return send(res, 200, await fugleTrend(symbol, days));
    }
    if (url.pathname === '/api/fugle/screen') {
      const priceLimit = Number(url.searchParams.get('priceLimit')), horizon = Number(url.searchParams.get('horizon'));
      if (!Number.isFinite(priceLimit) || priceLimit <= 0 || priceLimit > 1000000) return send(res, 400, { error: '請輸入有效的每股價格上限。' });
      if (![5, 20].includes(horizon)) return send(res, 400, { error: '持有期間請選一週或一個月。' });
      return send(res, 200, await screenStocks(priceLimit, horizon));
    }
    if (url.pathname === '/api/quotes') return send(res, 200, await quotes());
    if (url.pathname === '/api/news') {
      const stocks = JSON.parse(url.searchParams.get('stocks') || '[]');
      const keyword = String(url.searchParams.get('keyword') || '').replace(/[<>\r\n]/g, ' ').trim().slice(0, 80);
      if (!Array.isArray(stocks) || stocks.length > 12 || (!stocks.length && !keyword)) return send(res, 400, { error: '請選擇持股或輸入關鍵字。' });
      const terms = stocks.flatMap((item) => [String(item?.name || '').trim().slice(0, 32), String(item?.code || '').replace(/\D/g, '').slice(0, 6)]).filter(Boolean);
      if (!terms.length && !keyword) return send(res, 400, { error: '持股資料缺少股票名稱。' });
      const stockQuery = terms.length ? `(${terms.map((term) => `"${term}"`).join(' OR ')})` : '';
      const query = [stockQuery, keyword].filter(Boolean).join(' ');
      const feed = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
      return send(res, 200, await news(feed));
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = resolve(ROOT, `.${requested}`);
    if (!file.startsWith(ROOT + sep) || !['.html', '.css', '.js'].includes(extname(file))) return send(res, 404, { error: '找不到檔案。' });
    const body = await readFile(file);
    return send(res, 200, body, MIME[extname(file)] || 'application/octet-stream');
  } catch (error) {
    return send(res, 502, { error: error?.message || '連線失敗，請稍後再試。' });
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`藏股已啟動：http://127.0.0.1:${PORT}`);
  console.log('伺服器只監聽本機；行情與新聞查詢會向對應外部資料來源送出股票名稱或代號。');
});
