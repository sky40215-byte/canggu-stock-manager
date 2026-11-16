import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const BACKEND_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PROJECT_ROOT = resolve(BACKEND_ROOT, '..');
const FRONTEND_ROOT = resolve(PROJECT_ROOT, 'frontend');
const LOCAL_CONFIG_PATH = process.env.CANGGU_CONFIG_PATH || resolve(process.env.LOCALAPPDATA || PROJECT_ROOT, 'Canggu', 'config.env');
try {
  const localEnv = await readFile(LOCAL_CONFIG_PATH, 'utf8');
  for (const line of localEnv.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* Local AppData config is optional; environment variables also work. */ }
const PORT = Number(process.env.CANGGU_PORT || process.env.PORT || 4174);
const FUGLE_API_KEY = process.env.FUGLE_API_KEY || '';
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3';
const OLLAMA_PROXY_TOKEN = process.env.OLLAMA_PROXY_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const fundamentalsCache = new Map();
const assistantRateLimits = new Map();
const fugleHistoryRequests = [];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
async function fetchJson(url, extraHeaders = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'CangguPersonalStockApp/1.0', ...extraHeaders } });
  if (!response.ok) throw Object.assign(new Error(`資料來源回應 ${response.status}`), { status: response.status });
  return response.json();
}
async function finMindDataset(dataset, symbol, startDate) {
  const params = new URLSearchParams({ dataset, data_id: symbol, start_date: startDate, ...(FINMIND_TOKEN ? { token: FINMIND_TOKEN } : {}) });
  let payload;
  try {
    payload = await fetchJson(`https://api.finmindtrade.com/api/v4/data?${params}`);
  } catch (error) {
    if (error?.status === 402) throw Object.assign(new Error('FinMind API 使用額度已達上限（402）。請設定 FINMIND_TOKEN 或稍後再試。'), { status: 502 });
    throw error;
  }
  if (payload.status !== 200 || !Array.isArray(payload.data)) throw new Error(payload.msg || 'FinMind 暫時無法提供資料。');
  return payload.data;
}
async function fundamentals(symbol) {
  const cached = fundamentalsCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const start = new Date(); start.setDate(start.getDate() - 450);
  const startDate = start.toISOString().slice(0, 10);
  const [valuationRows, revenueRows] = await Promise.all([
    finMindDataset('TaiwanStockPER', symbol, startDate),
    finMindDataset('TaiwanStockMonthRevenue', symbol, startDate)
  ]);
  const valuation = valuationRows.filter((row) => row.date).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;
  const metricNumber = (raw) => raw == null || String(raw).trim() === '' || /^n\/a$/i.test(String(raw).trim()) ? null : Number.isFinite(Number(raw)) ? Number(raw) : null;
  const byMonth = new Map(revenueRows.map((row) => [`${row.revenue_year}-${String(row.revenue_month).padStart(2, '0')}`, row]));
  const revenue = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, row]) => {
    const priorMonth = `${Number(row.revenue_year) - 1}-${String(row.revenue_month).padStart(2, '0')}`;
    const prior = byMonth.get(priorMonth), amount = metricNumber(row.revenue), previous = metricNumber(prior?.revenue);
    return { month, amount, yearOverYear: amount !== null && previous !== null && previous !== 0 ? (amount / previous - 1) * 100 : null };
  });
  const data = {
    symbol,
    valuation: valuation ? {
      date: valuation.date,
      per: metricNumber(valuation.PER),
      dividendYield: metricNumber(valuation.dividend_yield),
      pbr: metricNumber(valuation.PBR)
    } : null,
    revenue,
    source: 'FinMind 免費台股資料',
    updatedAt: new Date().toISOString()
  };
  fundamentalsCache.set(symbol, { data, expiresAt: Date.now() + 30 * 60 * 1000 });
  if (fundamentalsCache.size > 200) fundamentalsCache.delete(fundamentalsCache.keys().next().value);
  return data;
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
async function fugleIntradayQuote(symbol) {
  if (!FUGLE_API_KEY) {
    throw Object.assign(new Error('尚未設定 Fugle API 金鑰。'), { status: 503 });
  }

  const response = await fetch(
    `https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/${encodeURIComponent(symbol)}`,
    {
      signal: AbortSignal.timeout(15000),
      headers: {
        'X-API-KEY': FUGLE_API_KEY,
        'User-Agent': 'CangguPersonalStockApp/1.0'
      }
    }
  );

  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? 'Fugle API 金鑰無效或方案未開通。'
      : response.status === 429
        ? 'Fugle API 請求已達方案限制，請稍後再試。'
        : `Fugle 報價查詢失敗（${response.status}）。`;
    throw Object.assign(new Error(message), { status: 502 });
  }

  return response.json();
}
async function fugleTrend(symbol, days) {
  if (!FUGLE_API_KEY) return { configured: false };
  const end = new Date(), start = new Date(end.getTime() - days * 86400000);
  const date = (value) => value.toISOString().slice(0, 10);
  const params = new URLSearchParams({ from: date(start), to: date(end), fields: 'open,high,low,close,volume', sort: 'asc' });
  while (true) {
    const now = Date.now();
    while (fugleHistoryRequests.length && now - fugleHistoryRequests[0] >= 60000) fugleHistoryRequests.shift();
    if (fugleHistoryRequests.length < 55) { fugleHistoryRequests.push(now); break; }
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, 60050 - (now - fugleHistoryRequests[0]))));
  }
  const response = await fetch(`https://api.fugle.tw/marketdata/v1.0/stock/historical/candles/${encodeURIComponent(symbol)}?${params}`, { signal: AbortSignal.timeout(15000), headers: { 'X-API-KEY': FUGLE_API_KEY, 'User-Agent': 'CangguPersonalStockApp/1.0' } });
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? 'Fugle API 金鑰無效或方案未開通。' : response.status === 429 ? 'Fugle API 請求已達方案限制，請稍後再試。' : response.status === 404 ? '這段期間沒有可用的歷史行情。' : `Fugle 回應錯誤（${response.status}）。`;
    const error = new Error(message); error.status = response.status; throw error;
  }
  const payload = await response.json();
  const candles = withIndicators((Array.isArray(payload.data) ? payload.data : []).filter((row) => Number.isFinite(Number(row.close))).sort((a, b) => String(a.date).localeCompare(String(b.date))));
  return { configured: true, symbol, market: payload.market || payload.exchange || '', timeframe: payload.timeframe || 'D', candles, source: 'Fugle 歷史日 K', updatedAt: new Date().toISOString() };
}
async function requireAuthenticatedUser(req, res) {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    send(res, 401, { error: '請先登入後再使用 Fugle 資料。' });
    return null;
  }
  try {
    const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      signal: AbortSignal.timeout(10000),
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      send(res, 401, { error: '登入狀態已失效，請重新登入。' });
      return null;
    }
    const user = await response.json();
    if (!user?.id) {
      send(res, 401, { error: '無法確認登入帳號，請重新登入。' });
      return null;
    }
    return user;
  } catch {
    send(res, 503, { error: '暫時無法驗證登入狀態，請稍後再試。' });
    return null;
  }
}
async function readJsonBody(req, maxBytes = 16000) {
  let raw = '', size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('訊息內容太長，請縮短後再送出。'), { status: 413 });
    raw += chunk;
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('訊息格式不正確。'), { status: 400 }); }
}
function checkAssistantRateLimit(key) {
  const now = Date.now(), windowMs = 60 * 60 * 1000, current = assistantRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    assistantRateLimits.set(key, { count: 1, resetAt: now + windowMs });
    if (assistantRateLimits.size > 5000) for (const [id, item] of assistantRateLimits) if (item.resetAt <= now) assistantRateLimits.delete(id);
    return true;
  }
  if (current.count >= 20) return false;
  current.count += 1;
  return true;
}
const assistantTopics = {
  general: '一般問題', overview: '投資總覽', holdings: '我的持股', ledger: '交易與股利', allocation: '資產配置',
  alerts: '價格提醒', events: '公司事件', journal: '投資日誌', insights: '投資檢視', trendAnalysis: '技術趨勢分析',
  holdingAnalysis: '我的持股分析', stockDesk: '個股查詢／自選', candidates: '候選股篩選', watchlist: '價格觀察紀錄',
  news: '新聞與公司公告', references: '研究來源與文獻'
};
function assistantSystemPrompt(topic, marketContext = '') {
  const topicInstruction = topic === '一般問題' ? '' : topic === '加碼試算'
    ? '本次是加碼試算。使用者明確提供的平均成本、持股數和預算可用於解釋試算結果；先照提供的計算值說明，不要重新計算或改動股數。若有近 20 個交易日高低價與 ATR，另列歷史價格觀察範圍並解釋其限制；歷史區間不是建議進場價。趨勢只作一般研究參考，不可建議使用者一定加碼，也不可把技術區間當成個人化買賣指令。'
    : `使用者選擇的網站主題是「${topic}」。請將回答聚焦於此功能及其相關概念；你只收到主題名稱，沒有讀取該頁或其中的個人資料。`;
  const marketInstruction = marketContext
    ? `\n以下是本次由伺服器查詢的 Fugle 行情與日 K 技術摘要：\n${marketContext}\n回答股票相關問題時，請以這份資料為主要依據，並明確標示報價時間、歷史 K 線日期與來源。請用繁體中文、短句和下列結構回答：\n1. 行情摘要：價格、漲跌和資料時間。\n2. 趨勢判讀：給出偏多／中性／偏弱的研究傾向，並列出均線、RSI、MACD、區間及成交量中實際有提供的指標。\n3. 條件式觀察：說明偏多、轉弱或盤整時可觀察的條件；若使用者詢問進出場，可用資料中的近 20 日高低與 ATR 作為歷史觀察區間，清楚說明觸發條件，不得稱為精確或保證的買賣價。\n4. 主要風險與下一步核對事項。\n只引用資料中確實存在的數字；缺漏請寫「資料不足」。不要捏造財報、新聞、法人籌碼或未提供的行情。不可聲稱看到了使用者持倉，也不可給保證獲利或要求立即買賣的指令。`
    : '';
  return `你是端股內的台股研究助理，使用繁體中文，先給簡短結論，再用清楚標題和條列列出依據。區分「資料事實」與「推論」，說明資料日期及限制。可以提供一般投資研究參考、風險情境與查證方向，但不可保證報酬、假裝掌握未提供資料，或把回答寫成適合此使用者的確定買賣命令。除本次附帶的行情資料和使用者本次自行提供的內容外，你沒有取得使用者的持倉、帳戶或其他頁面資訊。缺資料就直接說明，不要猜測；勿索取密碼或 API 金鑰。請以一般讀者看得懂的繁體中文輸出，不要使用 Markdown 星號、井字號或 LaTeX；計算請寫成白話算式，例如「67 股 × NT$68.2／股 = 約 NT$4,569.40」，並解釋數字代表什麼。${topicInstruction}${marketInstruction}`;
}
function assistantMarketSummary(symbol, quote, trend) {
  const round = (raw, digits = 2) => {
    if (raw == null || raw === '') return null;
    const number = Number(raw);
    return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
  };
  const candles = trend?.candles || [];
  const last = candles.at(-1), previous = candles.at(-2);
  const recent = candles.slice(-20);
  const closeReturn = (count) => {
    const first = candles.at(-(count + 1));
    return first?.close > 0 && last?.close > 0 ? round((last.close / first.close - 1) * 100) : null;
  };
  const ranges = candles.slice(-14).map((row, index, rows) => {
    const previousRow = candles[candles.length - rows.length + index - 1];
    const high = Number(row.high), low = Number(row.low), priorClose = Number(previousRow?.close);
    return Number.isFinite(high) && Number.isFinite(low)
      ? Number.isFinite(priorClose) ? Math.max(high - low, Math.abs(high - priorClose), Math.abs(low - priorClose)) : high - low
      : null;
  }).filter(Number.isFinite);
  const atr14 = ranges.length ? round(average(ranges)) : null;
  const dailyVolumes = recent.map((row) => Number(row.volume)).filter(Number.isFinite);
  const latestVolume = Number(last?.volume);
  const quoteTime = Number(quote.lastUpdated);
  const quoteUpdatedAt = Number.isFinite(quoteTime) && quoteTime > 0
    ? new Date(quoteTime / 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    : 'Fugle 未提供更新時間';
  const quoteData = {
    source: 'Fugle 即時報價 API（依方案可能為延遲或最近成交資料）',
    symbol: quote.symbol || symbol,
    name: quote.name || '',
    market: quote.market || quote.exchange || '',
    quoteUpdatedAt,
    quoteDate: quote.date || null,
    lastPrice: round(quote.lastPrice ?? quote.closePrice),
    priceType: quote.lastPrice == null ? '無最後成交價時以 Fugle 收盤價欄位作參考' : '最後成交價（含試撮）',
    change: round(quote.change),
    changePercent: round(quote.changePercent),
    previousClose: round(quote.previousClose),
    openPrice: round(quote.openPrice),
    highPrice: round(quote.highPrice),
    lowPrice: round(quote.lowPrice),
    averagePrice: round(quote.avgPrice),
    intradayTradeVolume: round(quote.total?.tradeVolume, 0)
  };
  const technicalData = last ? {
    source: trend.source || 'Fugle 歷史日 K',
    period: `${candles.length} 個交易日`,
    lastCandleDate: last.date || null,
    lastDailyClose: round(last.close),
    return20TradingDaysPct: closeReturn(20),
    return60TradingDaysPct: closeReturn(60),
    sma20: round(last.sma20),
    sma60: round(last.sma60),
    rsi14: round(last.rsi14, 1),
    macdHistogram: round(last.macdHistogram, 4),
    macdHistogramImproving: last.macdHistogram != null && previous?.macdHistogram != null && Number.isFinite(Number(last.macdHistogram)) && Number.isFinite(Number(previous.macdHistogram))
      ? Number(last.macdHistogram) > Number(previous.macdHistogram)
      : null,
    latestDailyVolume: Number.isFinite(latestVolume) ? round(latestVolume, 0) : null,
    averageDailyVolume20: dailyVolumes.length ? round(average(dailyVolumes), 0) : null,
    recent20TradingDayLow: (() => { const values = recent.map((row) => Number(row.low)).filter(Number.isFinite); return values.length ? round(Math.min(...values)) : null; })(),
    recent20TradingDayHigh: (() => { const values = recent.map((row) => Number(row.high)).filter(Number.isFinite); return values.length ? round(Math.max(...values)) : null; })(),
    atr14,
    disclaimer: '均線、指標、區間與波動值是由歷史日 K 計算的研究參考，不代表未來走勢。'
  } : { source: 'Fugle 歷史日 K', unavailable: true, reason: trend?.error || '本次未取得足夠歷史 K 線；僅有報價資料，不能據此判讀中短期趨勢。' };
  return JSON.stringify({ quote: quoteData, technical: technicalData });
}
function fugleAssistantAnswer(marketContext) {
  const { quote, technical } = JSON.parse(marketContext);
  const lines = [`${quote.name ? `${quote.name}（${quote.symbol}）` : quote.symbol}｜Fugle 行情與技術摘要`,
    `報價：NT$ ${quote.lastPrice ?? '資料不足'}；${quote.change == null ? '漲跌資料不足' : `漲跌 ${quote.change >= 0 ? '+' : ''}${quote.change}（${quote.changePercent ?? '—'}%）`}；${quote.quoteUpdatedAt}。${quote.priceType ? `價格類型：${quote.priceType}。` : ''}`];
  if (technical.unavailable) {
    lines.push(`歷史日 K：${technical.reason || '目前無法取得'}。`, '目前只能參考報價，無法判讀中短期趨勢。');
  } else {
    const trend = Number.isFinite(technical.sma20) && Number.isFinite(technical.sma60)
      ? technical.lastDailyClose > technical.sma20 && technical.sma20 > technical.sma60 ? '偏多（收盤高於 20 日均線，且 20 日均線高於 60 日均線）'
        : technical.lastDailyClose < technical.sma20 && technical.sma20 < technical.sma60 ? '偏弱（收盤低於 20 日均線，且 20 日均線低於 60 日均線）'
          : '中性或均線交錯'
      : '資料不足，無法判斷均線趨勢';
    lines.push(`趨勢參考：${trend}。日 K 截至 ${technical.lastCandleDate || '日期未提供'}（${technical.period}）。`);
    lines.push(`技術數據：RSI(14) ${technical.rsi14 ?? '不足'}；MACD 柱體 ${technical.macdHistogram ?? '不足'}${technical.macdHistogramImproving == null ? '' : technical.macdHistogramImproving ? '（較前一日改善）' : '（較前一日轉弱）'}；20 日區間 NT$ ${technical.recent20TradingDayLow ?? '不足'}–${technical.recent20TradingDayHigh ?? '不足'}；ATR(14) ${technical.atr14 ?? '不足'}。`);
    if (technical.return20TradingDaysPct != null) lines.push(`近 20 個交易日漲跌幅：${technical.return20TradingDaysPct >= 0 ? '+' : ''}${technical.return20TradingDaysPct}%。`);
  }
  lines.push('解讀方式：這是依 Fugle 報價及歷史日 K 數值整理的固定摘要，並非 AI 對話；資料可能延遲，也不構成個人化買賣建議。');
  return lines.join('\n');
}
async function askGemini(messages, topic, marketContext = '') {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: assistantSystemPrompt(topic, marketContext) }] },
      contents: messages.map((item) => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] })),
      generationConfig: { maxOutputTokens: 900, temperature: 0.5 }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 502;
    throw Object.assign(new Error(response.status === 429 ? '助理目前的服務額度已用完，請稍後再試。' : '助理服務暫時無法回答，請稍後再試。'), { status });
  }
  const answer = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!answer) throw Object.assign(new Error('助理沒有產生回答，請換個方式提問。'), { status: 502 });
  return answer;
}
async function askOllama(messages, topic, marketContext = '') {
  let response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST', signal: AbortSignal.timeout(120000),
      headers: {
  'Content-Type': 'application/json',
  ...(OLLAMA_PROXY_TOKEN ? { Authorization: `Bearer ${OLLAMA_PROXY_TOKEN}` } : {})
},
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, messages: [
        { role: 'system', content: assistantSystemPrompt(topic, marketContext) },
        ...messages.map(({ role, content }) => ({ role, content }))
      ], options: { temperature: 0.25, num_predict: 700 } })
    });
  } catch {
    throw Object.assign(new Error('無法連線到 Ollama。請確認 Ollama 已啟動、模型已下載，且 OLLAMA_BASE_URL 設定正確。'), { status: 503 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Ollama 暫時無法回答，請確認模型名稱與服務狀態。'), { status: 502 });
  const answer = data.message?.content?.trim();
  if (!answer) throw Object.assign(new Error('Ollama 沒有產生回答，請換個方式提問。'), { status: 502 });
  return answer;
}
function aiProviderConfigured(provider) {
  if (provider === 'fugle') return Boolean(FUGLE_API_KEY);
  if (provider === 'ollama') return Boolean(process.env.OLLAMA_BASE_URL || AI_PROVIDER === 'ollama');
  if (provider === 'gemini') return Boolean(GEMINI_API_KEY);
  return false;
}
async function askAssistant(messages, topic, marketContext = '', provider = AI_PROVIDER) {
  if (provider === 'ollama' && aiProviderConfigured(provider)) return askOllama(messages, topic, marketContext);
  if (provider === 'gemini' && aiProviderConfigured(provider)) return askGemini(messages, topic, marketContext);
  throw Object.assign(new Error('助理尚未完成設定。請管理者設定 AI_PROVIDER 與對應服務。'), { status: 503 });
}
const screenCache = new Map(), screenJobs = new Map(), screenJobByKey = new Map();
function analyzeScreenCandles(quote, candles, horizon) {
  if (candles.length < Math.max(22, horizon + 1)) return null;
  const last = candles.at(-1), previous = candles.at(-2), baseline = candles.at(-horizon - 1), window = candles.slice(-horizon - 1, -1), recent20 = candles.slice(-21, -1);
  const support = Math.min(...window.map((row) => Number(row.low)).filter(Number.isFinite)), resistance = Math.max(...window.map((row) => Number(row.high)).filter(Number.isFinite));
  const trueRanges = candles.slice(-15).map((row, index, rows) => { const prev = candles[candles.length - rows.length + index - 1]; const h = Number(row.high), l = Number(row.low), pc = Number(prev?.close); return Number.isFinite(h) && Number.isFinite(l) ? Number.isFinite(pc) ? Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)) : h-l : null; }).filter(Number.isFinite);
  const atr = trueRanges.length ? average(trueRanges) : last.close * 0.04;
  const averageVolume = average(recent20.map((row) => Number(row.volume)).filter(Number.isFinite)), volumeOK = averageVolume > 0 && Number(last.volume) >= averageVolume * 1.2;
  const horizonReturn = baseline?.close > 0 ? (last.close / baseline.close - 1) * 100 : 0, bullish = last.sma20 != null && last.sma60 != null && last.close > last.sma20 && last.sma20 > last.sma60;
  const improving = last.macdHistogram != null && previous?.macdHistogram != null && last.macdHistogram > previous.macdHistogram;
  const rsi = last.rsi14;
  const score = (horizonReturn > 0 ? 1 : 0) + (horizonReturn > 2 ? 1 : 0) + (bullish ? 2 : 0) + (rsi >= 40 && rsi <= 65 ? 1 : 0) + (improving ? 1 : 0) + (volumeOK ? 1 : 0) - (rsi >= 75 ? 2 : 0);
  const breakout = last.close > resistance && bullish && rsi >= 50 && rsi <= 68 && improving && volumeOK;
  const entryLow = breakout ? resistance : support, entryHigh = breakout ? resistance + atr * 0.25 : support + atr * 0.5, stop = Math.max(0, (breakout ? resistance : support) - atr * 0.5);
  const entry = (entryLow + entryHigh) / 2, risk = Math.max(entry - stop, atr * 0.25), target1 = entry + risk, target2 = entry + risk * 2;
  const pullback = !breakout && bullish && last.close >= entryLow && last.close <= entryHigh && rsi >= 35 && rsi <= 60 && improving;
  const overextended = last.close > entryHigh;
  const nearBuyZone = !overextended && Math.abs(last.close - entry) <= atr && bullish && rsi >= 38 && rsi <= 68 && improving;
  const priority = pullback ? 4 : breakout && !overextended ? 3 : nearBuyZone ? 2 : overextended || rsi >= 75 ? 0 : 1;
  const priorityLabel = pullback ? '回測區內・條件改善' : breakout && !overextended ? '突破量價確認' : nearBuyZone ? '接近觀察區・趨勢偏多' : overextended ? '高於觀察區・避免追價' : '一般觀察';
  const status = pullback ? '回測支撐觀察區，等待轉強確認' : breakout ? (overextended ? '突破成立但已高於觀察區，避免追價' : '突破量價條件符合（以最近日 K 計算）') : overextended ? '現價高於觀察區，避免追價' : score >= 5 ? '趨勢條件較佳，等待價格進入觀察區' : '條件未齊，列為觀察';
  const zoneDistance = Math.abs(last.close - entry) / Math.max(atr, 0.01);
  return { code: quote.code, name: quote.name, market: quote.market, price: quote.price, date: last.date, turnover: quote.turnover, horizonReturn, score, priority, priorityLabel, zoneDistance, rsi, entryLow, entryHigh, stop, target1, target2, support, resistance, status, volumeOK, smaTrend: bullish, improving, breakout, pullback };
}
async function runScreenJob(job, universe) {
  let next = 0, failures = 0;
  const candidates = [];
  const worker = async () => {
    while (next < universe.length) {
      const index = next++, quote = universe[index];
      try {
        const trend = await fugleTrend(String(quote.code), 90), item = analyzeScreenCandles(quote, trend.candles, job.horizon);
        if (item) candidates.push(item);
      } catch { failures++; }
      job.scanned++;
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  candidates.sort((a, b) => b.priority - a.priority || b.score - a.score || a.zoneDistance - b.zoneDistance || b.horizonReturn - a.horizonReturn || Number(b.turnover) - Number(a.turnover));
  const data = { configured: true, status: 'complete', candidates: candidates.slice(0, 10), eligibleCount: universe.length, analyzedCount: job.scanned, horizon: job.horizon, updatedAt: job.updatedAt, warnings: failures ? [`${failures} 檔歷史資料無法取得或超出 API 配額`] : [] };
  job.status = 'complete'; job.data = data; job.completedAt = Date.now();
  screenCache.set(job.key, { time: Date.now(), data });
  screenJobByKey.delete(job.key);
}
async function screenStocks(priceLimit, horizon) {
  if (!FUGLE_API_KEY) return { configured: false };
  const key = `${priceLimit}:${horizon}`, cached = screenCache.get(key);
  if (cached && Date.now() - cached.time < 180000) return { ...cached.data, fromCache: true };
  const activeId = screenJobByKey.get(key), activeJob = activeId && screenJobs.get(activeId);
  if (activeJob) return { configured: true, status: activeJob.status, jobId: activeJob.id, scanned: activeJob.scanned, total: activeJob.total };
  const market = await quotes();
  const universe = market.quotes.filter((row) => /^\d{4}$/.test(String(row.code)) && !String(row.code).startsWith('0') && Number(row.price) > 0 && Number(row.price) <= priceLimit && Number(row.turnover) >= 30000000 && !/(ETF|基金|存託|權證|牛|熊|期貨|債)/i.test(String(row.name)));
  if (!universe.length) return { configured: true, status: 'complete', candidates: [], eligibleCount: 0, analyzedCount: 0, horizon, updatedAt: market.updatedAt, message: '目前沒有符合價格及最低成交值條件的上市櫃個股。' };
  const job = { id: randomUUID(), key, horizon, updatedAt: market.updatedAt, scanned: 0, total: universe.length, status: 'running', startedAt: Date.now() };
  screenJobs.set(job.id, job); screenJobByKey.set(key, job.id);
  void runScreenJob(job, universe).catch(() => { job.status = 'failed'; job.error = '分析工作中斷，請稍後重新篩選。'; screenJobByKey.delete(key); });
  for (const [id, saved] of screenJobs) if (Date.now() - (saved.completedAt || saved.startedAt) > 60 * 60 * 1000) screenJobs.delete(id);
  return { configured: true, status: 'running', jobId: job.id, scanned: 0, total: job.total, updatedAt: market.updatedAt };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/api/sync/config') return send(res, 200, { configured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY), production: process.env.NODE_ENV === 'production', url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
    if (url.pathname === '/api/assistant/status') return send(res, 200, {
      configured: aiProviderConfigured(AI_PROVIDER),
      provider: AI_PROVIDER === 'ollama' ? 'ollama' : AI_PROVIDER === 'gemini' ? 'gemini' : 'unknown',
      model: AI_PROVIDER === 'ollama' ? OLLAMA_MODEL : 'Gemini',
      ollamaModel: OLLAMA_MODEL,
      providers: { fugle: aiProviderConfigured('fugle'), ollama: aiProviderConfigured('ollama'), gemini: aiProviderConfigured('gemini') }
    });
    if (url.pathname === '/api/assistant' && req.method === 'POST') {
      let user = null;
      if (process.env.NODE_ENV === 'production' || SUPABASE_URL) {
        user = await requireAuthenticatedUser(req, res);
        if (!user) return;
      }
      const rateKey = user?.id || req.socket.remoteAddress || 'local';
      if (!checkAssistantRateLimit(rateKey)) return send(res, 429, { error: '每小時最多詢問 20 次，請稍後再試。' });
      const body = await readJsonBody(req);
      const provider = body.provider === undefined ? AI_PROVIDER : body.provider;
      if (!['fugle', 'ollama', 'gemini'].includes(provider)) return send(res, 400, { error: '請選擇可用的助理服務。' });
      if (!aiProviderConfigured(provider)) return send(res, 503, { error: provider === 'fugle' ? 'Fugle 尚未設定 API 金鑰。' : provider === 'gemini' ? 'Gemini 尚未設定 API 金鑰，請選擇已設定的服務。' : 'Ollama 尚未設定服務網址，請選擇已設定的服務。' });
      const topic = assistantTopics[body.topic] || '一般問題';
      const symbol = String(body.symbol || '').trim();
      if (symbol && !/^\d{4,6}$/.test(symbol)) return send(res, 400, { error: '股票代號請輸入 4–6 位數字。' });
      if (provider === 'fugle') {
        if (!symbol) return send(res, 400, { error: '使用 Fugle 行情摘要時，請先填入股票代號。' });
        const quote = await fugleIntradayQuote(symbol);
        let trend = null;
        try { trend = await fugleTrend(symbol, 150); }
        catch (error) { trend = { error: error.message || 'Fugle 歷史日 K 暫時無法取得。' }; }
        return send(res, 200, { answer: fugleAssistantAnswer(assistantMarketSummary(symbol, quote, trend)), provider });
      }
      if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 10) return send(res, 400, { error: '對話訊息數量不正確。' });
      const messages = body.messages.map((item) => ({ role: item?.role, content: typeof item?.content === 'string' ? item.content.trim() : '' }));
      if (messages.some((item) => !['user', 'assistant'].includes(item.role) || !item.content || item.content.length > 2000) || messages.at(-1)?.role !== 'user') return send(res, 400, { error: '每則訊息需在 2,000 字內，且最新訊息必須是你的提問。' });
      let marketContext = '';
      if (symbol) {
        const quote = await fugleIntradayQuote(symbol);
        let trend = null;
        try { trend = await fugleTrend(symbol, 150); }
        catch (error) { trend = { error: error.message || 'Fugle 歷史日 K 暫時無法取得。' }; }
        marketContext = assistantMarketSummary(symbol, quote, trend);
      }
      return send(res, 200, { answer: await askAssistant(messages, topic, marketContext, provider), provider });
    }
    if (url.pathname === '/api/topup/calculate' && req.method === 'POST') {
      let user = null;
      if (process.env.NODE_ENV === 'production' || SUPABASE_URL) {
        user = await requireAuthenticatedUser(req, res);
        if (!user) return;
      }
      const body = await readJsonBody(req);
      const query = String(body.symbolOrName || '').trim().slice(0, 40);
      const averageCost = Number(body.averageCost), currentShares = Number(body.currentShares), budget = Number(body.budget);
      const shareUnit = Number(body.shareUnit), mode = body.mode === 'ollama' ? 'ollama' : body.mode === 'fugle' ? 'fugle' : '';
      const commissionRatePercent = body.commissionRatePercent === undefined ? 0.1425 : Number(body.commissionRatePercent);
      const sellTaxRatePercent = body.sellTaxRatePercent === undefined ? 0.3 : Number(body.sellTaxRatePercent);
      if (!query) return send(res, 400, { error: '請輸入股票代號或完整名稱。' });
      if (!(averageCost > 0 && averageCost <= 1000000) || !(currentShares > 0 && Number.isInteger(currentShares) && currentShares <= 1000000000) || !(budget > 0 && budget <= 10000000000)) return send(res, 400, { error: '請填入有效的平均成本、整數持股數與加碼預算。' });
      if (![1, 1000].includes(shareUnit)) return send(res, 400, { error: '股數單位設定不正確。' });
      if (!Number.isFinite(commissionRatePercent) || commissionRatePercent < 0 || commissionRatePercent > 1 || !Number.isFinite(sellTaxRatePercent) || sellTaxRatePercent < 0 || sellTaxRatePercent > 5) return send(res, 400, { error: '請確認手續費與賣出證交稅率設定。' });
      if (!mode) return send(res, 400, { error: '請選擇 Fugle 試算或 Ollama 分析。' });
      if (!FUGLE_API_KEY) return send(res, 503, { error: '尚未設定 Fugle API 金鑰，無法取得目前行情。' });
      if (mode === 'ollama') {
        if (body.aiConsent !== true) return send(res, 400, { error: '使用 Ollama 分析前，請先勾選資料傳送同意。' });
        if (!aiProviderConfigured('ollama')) return send(res, 503, { error: 'Ollama 服務尚未設定。' });
        const rateKey = user?.id || req.socket.remoteAddress || 'local';
        if (!checkAssistantRateLimit(rateKey)) return send(res, 429, { error: '每小時助理分析次數已達上限，請稍後再試。' });
      }
      let symbol = query, resolvedName = '';
      if (!/^\d{4,6}$/.test(query)) {
        const market = await quotes(), normalizedQuery = query.toLocaleLowerCase('zh-TW');
        const exact = market.quotes.filter((row) => String(row.name).trim().toLocaleLowerCase('zh-TW') === normalizedQuery);
        const matches = exact.length ? exact : market.quotes.filter((row) => String(row.name).toLocaleLowerCase('zh-TW').includes(normalizedQuery));
        const unique = [...new Map(matches.map((row) => [String(row.code), row])).values()];
        if (unique.length !== 1) return send(res, 404, { error: unique.length ? '名稱符合多檔股票，請改輸入股票代號。' : '找不到這個名稱；可輸入完整股票名稱或代號。' });
        symbol = String(unique[0].code); resolvedName = String(unique[0].name || '');
      }
      const quote = await fugleIntradayQuote(symbol);
      const price = Number(quote.lastPrice ?? quote.closePrice ?? quote.previousClose);
      if (!(price > 0 && Number.isFinite(price))) return send(res, 502, { error: 'Fugle 沒有提供可用價格，請稍後重試。' });
      const quoteTimestamp = Number(quote.lastUpdated);
      const quoteUpdatedAt = Number.isFinite(quoteTimestamp) && quoteTimestamp > 0
        ? new Date(quoteTimestamp / 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
        : 'Fugle 未提供更新時間';
      const sharesToBuy = Math.floor(budget / (price * shareUnit)) * shareUnit;
      const addedCost = sharesToBuy * price;
      const totalShares = currentShares + sharesToBuy;
      const totalCost = averageCost * currentShares + addedCost;
      const commissionRate = commissionRatePercent / 100, sellTaxRate = sellTaxRatePercent / 100;
      const buyCommission = addedCost * commissionRate;
      const estimatedSaleValue = price * totalShares;
      const estimatedSaleCommission = estimatedSaleValue * commissionRate;
      const estimatedSaleTax = estimatedSaleValue * sellTaxRate;
      const estimatedTransactionCosts = buyCommission + estimatedSaleCommission + estimatedSaleTax;
      const estimatedNetPnl = estimatedSaleValue - totalCost - estimatedTransactionCosts;
      const estimatedBreakEvenPrice = totalShares > 0 && commissionRate + sellTaxRate < 1
        ? (totalCost + buyCommission) / (totalShares * (1 - commissionRate - sellTaxRate))
        : null;
      const result = {
        symbol: quote.symbol || symbol,
        name: quote.name || resolvedName,
        price,
        priceType: quote.lastPrice == null ? 'Fugle 收盤價／昨收參考' : 'Fugle 最後成交價（含試撮）',
        quoteDate: quote.date || null,
        quoteUpdatedAt,
        averageCost,
        currentShares,
        budget,
        shareUnit,
        commissionRatePercent,
        sellTaxRatePercent,
        sharesToBuy,
        addedCost,
        remainingBudget: budget - addedCost,
        totalShares,
        newAverageCost: totalShares ? totalCost / totalShares : averageCost,
        buyCommission,
        estimatedSaleCommission,
        estimatedSaleTax,
        estimatedTransactionCosts,
        estimatedBreakEvenPrice,
        projectedUnrealizedPnl: estimatedNetPnl,
        projectedUnrealizedPnlPercent: totalCost + buyCommission > 0 ? estimatedNetPnl / (totalCost + buyCommission) * 100 : 0,
        feesAndTaxIncluded: true
      };
      if (mode === 'fugle') return send(res, 200, { mode, result });
      let trend = null;
      try { trend = await fugleTrend(symbol, 150); }
      catch (error) { trend = { error: error.message || 'Fugle 歷史日 K 暫時無法取得。' }; }
      const marketSummary = JSON.parse(assistantMarketSummary(symbol, quote, trend));
      const context = JSON.stringify({ market: marketSummary, userEnteredCalculation: result });
      const analysis = await askAssistant([
        { role: 'user', content: '請用一般讀者看得懂的繁體中文，解釋以下加碼試算和技術趨勢，列出 Fugle 試算價格、若有資料則列出近 20 個交易日的歷史價格區間，並提供偏多、中性或偏弱的研究觀察、需要確認的條件與主要風險。歷史價格區間不可描述成建議進場價。不要把它寫成個人化下單指令。' }
      ], '加碼試算', context, 'ollama');
      return send(res, 200, { mode, result, analysis });
    }
    if (url.pathname === '/api/fugle/status') {
      if (!await requireAuthenticatedUser(req, res)) return;
      return send(res, 200, { configured: Boolean(FUGLE_API_KEY) });
    }
    if (url.pathname === '/api/fugle/trend') {
      if (!await requireAuthenticatedUser(req, res)) return;
      const symbol = String(url.searchParams.get('symbol') || '').trim();
      const days = Number(url.searchParams.get('days') || 90);
      if (!/^\d{4,6}$/.test(symbol)) return send(res, 400, { error: '請輸入 4–6 碼股票代號。' });
      if (![90, 180, 350].includes(days)) return send(res, 400, { error: '查詢期間不正確。' });
      return send(res, 200, await fugleTrend(symbol, days));
    }
    if (url.pathname === '/api/fugle/screen') {
      if (!await requireAuthenticatedUser(req, res)) return;
      const priceLimitValue = url.searchParams.get('priceLimit'), priceLimit = priceLimitValue === 'unlimited' ? Infinity : Number(priceLimitValue), horizon = Number(url.searchParams.get('horizon'));
      if (!(priceLimit === Infinity || Number.isFinite(priceLimit) && priceLimit > 0 && priceLimit <= 1000000)) return send(res, 400, { error: '請輸入有效的每股價格上限，或選擇不限。' });
      if (![5, 20].includes(horizon)) return send(res, 400, { error: '持有期間請選一週或一個月。' });
      return send(res, 200, await screenStocks(priceLimit, horizon));
    }
    const screenJobMatch = url.pathname.match(/^\/api\/fugle\/screen\/([\w-]+)$/);
    if (screenJobMatch) {
      if (!await requireAuthenticatedUser(req, res)) return;
      const job = screenJobs.get(screenJobMatch[1]);
      if (!job) return send(res, 404, { error: '掃描工作已失效，請重新篩選。' });
      if (job.status === 'complete') return send(res, 200, job.data);
      if (job.status === 'failed') return send(res, 502, { error: job.error || '分析工作中斷，請重新篩選。' });
      return send(res, 200, { configured: true, status: job.status, jobId: job.id, scanned: job.scanned, total: job.total });
    }
    if (url.pathname === '/api/quotes') return send(res, 200, await quotes());
    if (url.pathname === '/api/fundamentals') {
      const symbol = String(url.searchParams.get('symbol') || '').trim();
      if (!/^\d{4,6}$/.test(symbol)) return send(res, 400, { error: '請輸入 4–6 碼股票代號。' });
      return send(res, 200, await fundamentals(symbol));
    }
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
    const file = resolve(FRONTEND_ROOT, `.${requested}`);
    if (!file.startsWith(FRONTEND_ROOT + sep) || !['.html', '.css', '.js', '.webmanifest', '.svg', '.png'].includes(extname(file))) return send(res, 404, { error: '找不到檔案。' });
    const body = await readFile(file);
    return send(res, 200, body, MIME[extname(file)] || 'application/octet-stream');
  } catch (error) {
    return send(res, error?.status || 502, { error: error?.message || '連線失敗，請稍後再試。' });
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`端股已啟動：http://127.0.0.1:${PORT}`);
  console.log('伺服器只監聽本機；行情與新聞查詢會向對應外部資料來源送出股票名稱或代號。');
});
