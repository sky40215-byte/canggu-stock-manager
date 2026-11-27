const day = 86400000;
const lookupWindow = 180;
const symbolPattern = /^\d{4,6}[A-Z]?$/;
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export const dividendDate = (offset = 0) => new Date(Date.now() + 8 * 3600000 + offset * day).toISOString().slice(0, 10);
export const dividendSymbol = (value) => String(value || '').toUpperCase().match(/\b\d{4,6}[A-Z]?\b/)?.[0] || '';

export function normalizeCashDividends(code, rows) {
  const events = new Map();
  for (const row of rows) {
    if (String(row.stock_id) !== code) continue;
    const exDate = row.CashExDividendTradingDate;
    const price = Number(row.CashEarningsDistribution || 0) + Number(row.CashStatutorySurplus || 0);
    if (!validDate(exDate) || !Number.isFinite(price) || price <= 0) continue;
    const key = `${code}:${exDate}`;
    const announced = validDate(row.AnnouncementDate) ? row.AnnouncementDate : '';
    const paymentDate = validDate(row.CashDividendPaymentDate) && row.CashDividendPaymentDate >= exDate ? row.CashDividendPaymentDate : '';
    const current = events.get(key);
    if (!current || announced > current.announced || (announced === current.announced && paymentDate && !current.paymentDate)) {
      events.set(key, { key, code, exDate, paymentDate, price, announced });
    }
  }
  return [...events.values()];
}

const stockKey = (stock) => String(stock || '').trim().normalize('NFKC').toLowerCase();
export function dividendStockMatches(stock, code, name) {
  const listed = dividendSymbol(stock);
  if (listed) return listed === code;
  const fullName = stockKey(name);
  const alias = fullName.replace(/^\d{4,6}[a-z]?\s*/i, '');
  return Boolean(fullName && (stockKey(stock) === fullName || (alias && stockKey(stock) === alias)));
}

export function dividendStocks({ holdings, transactions }, today) {
  const stocks = new Map();
  const cutoff = new Date(Date.parse(today) - lookupWindow * day).toISOString().slice(0, 10);
  const add = (name, explicitCode) => {
    const code = dividendSymbol(explicitCode || name);
    if (symbolPattern.test(code) && !stocks.has(code)) stocks.set(code, name || code);
  };
  for (const item of holdings) if (!item.market || item.market === 'tw') add(item.name, item.symbol);
  for (const row of transactions) if (row.type === 'sell' && row.date >= cutoff) add(row.stock);
  return stocks;
}

export function eligibleDividendShares({ holdings, transactions }, event, name, today) {
  const matchingHoldings = holdings.filter((item) => (!item.market || item.market === 'tw') && dividendSymbol(item.symbol || item.name) === event.code);
  const currentShares = matchingHoldings.reduce((sum, item) => sum + Number(item.shares), 0);
  if (event.exDate > today) return currentShares > 0 && Number.isFinite(currentShares) ? { shares: currentShares, tentative: true } : { shares: 0 };
  const trades = transactions.filter((row) => (row.type === 'buy' || row.type === 'sell') && dividendStockMatches(row.stock, event.code, name));
  if (!trades.length || trades.some((row) => row.recordOnly || !validDate(row.date) || row.date > today || !(Number(row.shares) > 0))) return { shares: null };
  const volume = new Map();
  for (const trade of trades) volume.set(trade.date, (volume.get(trade.date) || 0) + Number(trade.shares) * (trade.type === 'buy' ? 1 : -1));
  let shares = 0, qualifying = 0;
  for (const [date, delta] of [...volume].sort(([a], [b]) => a.localeCompare(b))) {
    shares += delta;
    if (shares < -1e-6) return { shares: null };
    if (date < event.exDate) qualifying = shares;
  }
  return Math.abs(currentShares - shares) < 1e-6 ? { shares: Math.max(0, qualifying) } : { shares: null };
}

export function recordedDividend(transactions, event, name) {
  return transactions.some((row) => row.type === 'dividend' && (
    row.dividendKey === event.key || (!row.dividendKey && event.paymentDate && row.date === event.paymentDate && dividendStockMatches(row.stock, event.code, name))
  ));
}

export function mountDividendTracker({ panel, overview, getPortfolio, getIdentity, fetchAnnouncements, onReview, escape, money }) {
  const button = panel.querySelector('[data-dividend-refresh]');
  const status = panel.querySelector('[data-dividend-status]');
  const rows = panel.querySelector('[data-dividend-rows]');
  let requestId = 0, scope, identity, attemptedAt = 0, loading = false, errorCount = 0, events = [], visibleEvents = new Map(), previousItems = '';
  const perShare = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 8 });

  function paint() {
    const today = dividendDate(), portfolio = getPortfolio(), stocks = dividendStocks(portfolio, today);
    const recent = dividendDate(-lookupWindow);
    const items = events.filter((event) => stocks.has(event.code) && (event.paymentDate || event.exDate) >= recent).flatMap((event) => {
      const name = stocks.get(event.code);
      const booked = recordedDividend(portfolio.transactions, event, name);
      const { shares, tentative } = eligibleDividendShares(portfolio, event, name, today);
      if (!booked && shares === 0) return [];
      const due = Boolean(event.paymentDate && event.paymentDate <= today);
      return [{ ...event, name, booked, shares, tentative, due }];
    }).sort((a, b) => Number(a.booked) - Number(b.booked) || Number(b.due) - Number(a.due) || (b.paymentDate || b.exDate).localeCompare(a.paymentDate || a.exDate));
    const pending = items.filter((event) => event.due && !event.booked).length;
    overview.hidden = !pending;
    overview.textContent = `${pending} 筆配息待確認`;
    const message = !stocks.size ? '新增有代號或可辨識名稱的台股持股後，這裡會自動查詢配息。'
      : loading ? '正在查詢配息公告…' : errorCount ? `${errorCount} 檔配息暫時無法更新，可稍後重試。`
        : items.length ? `${items.length} 筆配息${pending ? `，${pending} 筆待確認收款` : ''}。` : '目前沒有符合條件的配息公告。';
    if (status.textContent !== message) status.textContent = message;
    button.disabled = loading || !stocks.size;
    const itemsKey = JSON.stringify(items);
    if (previousItems === itemsKey) return;
    previousItems = itemsKey;
    visibleEvents = new Map(items.filter((event) => event.due && !event.booked).map((event) => [event.key, event]));
    rows.innerHTML = items.map((event) => {
      const tag = event.booked ? '已登錄' : event.due ? '待確認收款' : event.paymentDate ? '尚未發放' : '發放日待公告';
      const estimate = event.booked ? '金額請見下方股利紀錄' : event.shares == null ? '股數待確認' : `${event.tentative ? '按目前持股預估' : '按成交紀錄預估'} ${money(Math.round(event.shares * event.price * 100) / 100)}（${perShare.format(event.shares)} 股）`;
      return `<tr><th scope="row">${escape(event.name)}</th><td>${escape(event.exDate)}</td><td>${escape(event.paymentDate || '待公告')}</td><td>${perShare.format(event.price)}</td><td>${estimate}</td><td><div class="dividend-row-actions"><span>${tag}</span>${event.due && !event.booked ? `<button type="button" class="secondary-button" data-review-dividend="${escape(event.key)}">確認入帳</button>` : ''}</div></td></tr>`;
    }).join('');
    rows.closest('.table-wrap').hidden = items.length === 0;
  }

  async function refresh(force = false) {
    const stocks = [...dividendStocks(getPortfolio(), dividendDate()).keys()].sort();
    const nextIdentity = getIdentity(), nextScope = stocks.join(',');
    if (nextScope !== scope || nextIdentity !== identity) {
      if (identity !== nextIdentity) events = [];
      identity = nextIdentity;
      scope = nextScope;
      requestId++;
      loading = false;
      attemptedAt = errorCount = 0;
    }
    if (!stocks.length || loading || (!force && Date.now() - attemptedAt < (errorCount ? 300000 : 3600000))) { paint(); return; }
    const id = ++requestId;
    loading = true;
    attemptedAt = Date.now();
    paint();
    const updated = new Map();
    for (let index = 0; index < stocks.length; index += 20) {
      const codes = stocks.slice(index, index + 20);
      try {
        const result = await fetchAnnouncements(codes);
        if (id !== requestId) return;
        for (const { code, items } of result) if (Array.isArray(items)) updated.set(code, items);
      } catch { if (id !== requestId) return; }
    }
    if (id !== requestId) return;
    events = [...events.filter((event) => stocks.includes(event.code) && !updated.has(event.code)), ...[...updated.values()].flat()];
    errorCount = stocks.length - updated.size;
    loading = false;
    paint();
  }

  button.addEventListener('click', () => void refresh(true));
  rows.addEventListener('click', (event) => {
    const selected = visibleEvents.get(event.target.closest('[data-review-dividend]')?.dataset.reviewDividend);
    if (selected) onReview(selected);
  });
  return { refresh };
}
