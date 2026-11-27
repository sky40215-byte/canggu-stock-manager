const day = 86400000;
const dateInTaiwan = (daysAgo = 0) => new Date(Date.now() + 8 * 3600000 - daysAgo * day).toISOString().slice(0, 10);
const symbolPattern = /^\d{4,6}[A-Z]?$/;
const colors = ['#087f83', '#ad4d25', '#5354a1', '#478042', '#946119'];
const industryNames = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜',
  '08': '玻璃陶瓷', '09': '造紙工業', 10: '鋼鐵工業', 11: '橡膠工業', 12: '汽車工業', 14: '建材營造',
  15: '航運業', 16: '觀光餐旅', 17: '金融保險', 18: '貿易百貨', 21: '化學工業', 22: '生技醫療',
  23: '油電燃氣', 24: '半導體', 25: '電腦及週邊設備', 26: '光電', 27: '通信網路', 28: '電子零組件',
  29: '電子通路', 30: '資訊服務', 31: '其他電子', 32: '文化創意', 33: '農業科技', 35: '綠能環保',
  36: '數位雲端', 37: '運動休閒', 38: '居家生活'
};

const percent = (value) => Number.isFinite(value) ? `${value.toFixed(2)}%` : '資料不足';
const movementClass = (value) => value < 0 ? 'negative' : value > 0 ? 'positive' : '';

export function alignCloses(series) {
  const closes = series.map(({ candles = [] }) => new Map(candles.flatMap(({ date, close }) => {
    const price = Number(close), session = String(date || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(session) && Number.isFinite(price) && price > 0 ? [[session, price]] : [];
  })));
  const dates = [...(closes[0]?.keys() || [])].filter((date) => closes.every((prices) => prices.has(date))).sort();
  return { dates, values: closes.map((prices) => dates.map((date) => prices.get(date))) };
}

export function priceMetrics(prices) {
  if (prices.length < 2) return { performance: null, drawdown: null, volatility: null };
  let peak = prices[0], drawdown = 0;
  const daily = [];
  for (let index = 1; index < prices.length; index++) {
    peak = Math.max(peak, prices[index]);
    drawdown = Math.min(drawdown, prices[index] / peak - 1);
    daily.push(prices[index] / prices[index - 1] - 1);
  }
  const mean = daily.reduce((sum, value) => sum + value, 0) / daily.length;
  const squared = daily.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return {
    performance: (prices.at(-1) / prices[0] - 1) * 100,
    drawdown: drawdown * 100,
    volatility: daily.length >= 2 ? Math.sqrt(squared / (daily.length - 1) * 252) * 100 : null
  };
}

export function positionWeights(positions, classified) {
  const values = new Map(), byIndustry = new Map();
  let total = 0, unknown = 0, unpriced = 0, fallback = 0;
  for (const { code, name, shares, price, backup } of positions) {
    const value = shares * price;
    if (!Number.isFinite(value) || value <= 0) { unpriced++; continue; }
    total += value;
    if (backup) fallback++;
    const key = code || name;
    const prior = values.get(key);
    values.set(key, { label: prior?.label || name || code, value: (prior?.value || 0) + value });
    const industry = Object.hasOwn(industryNames, classified[code]) ? industryNames[classified[code]] : '';
    if (!industry) { unknown += value; continue; }
    byIndustry.set(industry, (byIndustry.get(industry) || 0) + value);
  }
  const sort = (rows) => rows.map(({ label, value }) => ({ label, weight: value / total * 100 })).sort((a, b) => b.weight - a.weight);
  return {
    stocks: sort([...values.values()]), industries: sort([...byIndustry].map(([label, value]) => ({ label, value }))),
    unknown: total ? unknown / total * 100 : 0, unpriced, fallback
  };
}

function trendChart(dates, lines) {
  const minimum = Math.min(100, ...lines.flatMap((row) => row.values));
  const maximum = Math.max(100, ...lines.flatMap((row) => row.values));
  const gap = Math.max((maximum - minimum) * 0.08, 0.3);
  const low = minimum - gap, high = maximum + gap;
  const x = (index) => 54 + index / (dates.length - 1) * 642;
  const y = (value) => 195 - (value - low) / (high - low) * 174;
  const grid = [high, (high + low) / 2, low].map((value) => `<path d="M54 ${y(value)}H696" stroke="currentColor" opacity="0.15"/><text x="47" y="${y(value) + 4}" text-anchor="end">${value.toFixed(1)}</text>`).join('');
  const paths = lines.map((row, index) => `<polyline points="${row.values.map((value, i) => `${x(i).toFixed(2)},${y(value).toFixed(2)}`).join(' ')}" fill="none" stroke="${colors[index]}" stroke-width="2.5" stroke-linejoin="round"/>`).join('');
  return `<svg viewBox="0 0 716 225" role="img" aria-label="以首個共同交易日為 100 的績效線圖">${grid}<path d="M54 ${y(100)}H696" stroke="currentColor" opacity="0.45" stroke-dasharray="5 4"/>${paths}<text x="54" y="217">${dates[0]}</text><text x="696" y="217" text-anchor="end">${dates.at(-1)}</text></svg>`;
}

function factors(data) {
  const per = data.valuation?.per;
  const revenue = data.revenue || [];
  const growth = revenue.length === 3 && revenue.every((row) => Number.isFinite(row.yearOverYear)) ? revenue.reduce((sum, row) => sum + row.yearOverYear, 0) / 3 : null;
  const flow = data.chip?.ratio, t = data.technical;
  const band = (value, cuts) => Number.isFinite(value) ? cuts.filter((cut) => value >= cut).length * 25 : null;
  return [
    { name: '價值', score: per > 0 ? band(-per, [-30, -25, -18, -12]) : null, evidence: per > 0 ? `本益比 ${per.toFixed(1)} 倍 · ${data.valuation.date}` : '缺少正本益比', method: '本益比從 30、25、18、12 倍往下，每跨一檔加 25 分。' },
    { name: '成長', score: band(growth, [-10, 0, 10, 20]), evidence: growth == null ? '缺少 3 個月營收年增率' : `近 3 個月平均營收年增 ${percent(growth)} · ${revenue.at(-1).month}`, method: '平均年增達 −10%、0%、10%、20%，每跨一檔加 25 分。' },
    { name: '籌碼', score: band(flow, [-10, 0, 5, 10]), evidence: flow == null ? '缺少近 20 個交易日法人資料' : `近 20 日法人淨買賣比 ${percent(flow)} · ${data.chip.date}`, method: '淨買賣比為（買進 − 賣出）÷（買進 ＋ 賣出）。達 −10%、0%、5%、10% 各加 25 分。' },
    { name: '技術', score: t ? Math.round([t.close > t.sma20, t.close > t.sma60, t.momentum > 0].filter(Boolean).length / 3 * 100) : null, evidence: t ? `近 20 日漲跌 ${percent(t.momentum)} · ${t.date}` : '缺少 60 日歷史行情', method: '收盤高於 20 日均線、高於 60 日均線及 20 日漲幅為正，各占三分之一。' }
  ];
}

export function mountMarketPerformance({ element, health, fetchMarket, getPositions, getWatchlist, getIdentity, escape }) {
  const query = (selector) => element.querySelector(selector);
  const risk = (selector) => health.querySelector(selector);
  const form = query('form'), symbols = query('[data-performance-symbols]'), from = query('[data-performance-from]'), to = query('[data-performance-to]');
  const compareStatus = query('[role="status"]'), compareResult = query('[data-performance-result]'), choices = query('[data-performance-choices]');
  const weightsResult = risk('[data-weights-result]'), historyStatus = risk('[data-health-status]'), historyResult = risk('[data-health-history]');
  const factorSymbol = risk('[data-factor-symbol]'), factorResult = risk('[data-factor-result]');
  let industries = {}, industryState = '', identity, positionKey, choiceKey;
  let compareRequest = 0, healthRequest = 0, factorRequest = 0;
  const listText = (values) => values.map(({ label, weight }) => `<li><span>${escape(label)}</span><strong>${percent(weight)}</strong></li>`).join('');

  to.max = to.value = dateInTaiwan();
  from.max = to.max;
  from.value = dateInTaiwan(90);

  async function json(path, request = fetchMarket) {
    const response = await request(path);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '資料暫時無法取得。');
    return data;
  }

  function renderWeights(positions) {
    const result = positionWeights(positions, industries);
    if (!result.stocks.length) {
      weightsResult.textContent = positions.length ? '持股缺少可用價格，暫時無法計算比重。' : '新增台股持股後即可檢視集中度。';
      return;
    }
    const warnings = [
      ...result.stocks.filter((row) => row.weight >= 40).map((row) => `${row.label} 占 ${percent(row.weight)}，達單一持股門檻 40%。`),
      ...result.industries.filter((row) => row.weight >= 50).map((row) => `${row.label} 占 ${percent(row.weight)}，達產業門檻 50%。`)
    ];
    const coverage = [result.unpriced ? `${result.unpriced} 筆缺價，未列入比重` : '', result.fallback ? `${result.fallback} 筆採備用價` : '', result.unknown > 0 ? `${percent(result.unknown)} 市值未歸類（含未拆解的 ETF）` : ''].filter(Boolean);
    const industryNote = result.industries.length ? `<ul>${listText(result.industries)}</ul>` : '<p>目前沒有可歸類的部位。</p>';
    weightsResult.innerHTML = `${warnings.length ? `<ul class="performance-warnings">${warnings.map((text) => `<li>${escape(text)}</li>`).join('')}</ul>` : '<p>已計算部位暫無集中度警示。</p>'}
      <div class="performance-weights"><div><h4>個股市值比重</h4><ul>${listText(result.stocks)}</ul></div><div><h4>產業市值比重</h4>${industryNote}</div></div>
      <small>${escape([...coverage, industryState === 'loading' ? '正在讀取產業分類' : '', industryState === 'failed' ? '產業分類暫時無法取得，重新開啟健檢頁可再試' : ''].filter(Boolean).join(' · '))}</small>`;
  }

  function refresh() {
    const currentIdentity = getIdentity(), positions = getPositions();
    if (currentIdentity !== identity) {
      identity = currentIdentity;
      compareRequest++; healthRequest++; factorRequest++;
      form.querySelector('button[type="submit"]').disabled = false;
      symbols.value = compareStatus.textContent = compareResult.innerHTML = historyResult.innerHTML = factorResult.innerHTML = '';
      positionKey = choiceKey = undefined;
    }
    const currentKey = JSON.stringify(positions.map(({ code, name, shares }) => [code, name, shares]));
    if (currentKey !== positionKey) {
      positionKey = currentKey;
      healthRequest++; factorRequest++;
      historyStatus.textContent = historyResult.innerHTML = factorResult.innerHTML = '';
      const codes = new Map(positions.filter(({ code }) => /^[1-9]\d{3}$/.test(code)).map(({ code, name }) => [code, name]));
      factorSymbol.innerHTML = '<option value="">選擇台股公司</option>' + [...codes].map(([code, name]) => `<option value="${escape(code)}">${escape(name)}</option>`).join('');
      risk('[data-health-submit]').disabled = !positions.length;
      risk('[data-factor-submit]').disabled = true;
    }
    const watchlist = getWatchlist().filter(({ code }) => symbolPattern.test(code));
    const currentChoiceKey = JSON.stringify(watchlist);
    if (currentChoiceKey !== choiceKey) {
      choiceKey = currentChoiceKey;
      choices.innerHTML = watchlist.length ? watchlist.map(({ code, name }) => `<button type="button" class="secondary-button" data-add-symbol="${escape(code)}">${escape(name)}</button>`).join('') : '<small>自選清單目前沒有台股，可直接輸入代號。</small>';
    }
    renderWeights(positions);
  }

  function openHealth() {
    if (industryState === 'loading' || industryState === 'ready') return;
    industryState = 'loading';
    refresh();
    json('/api/market/industries', fetch).then((data) => {
      industries = data.industries;
      industryState = 'ready';
    }).catch(() => { industryState = 'failed'; }).finally(refresh);
  }

  function parseSymbols() {
    return [...new Set(symbols.value.toUpperCase().split(/[\s,，、]+/).filter(Boolean))];
  }

  choices.addEventListener('click', (event) => {
    const code = event.target.closest('[data-add-symbol]')?.dataset.addSymbol;
    if (!code) return;
    const codes = parseSymbols();
    if (codes.includes(code)) return;
    if (codes.length >= 5) { compareStatus.textContent = '一次最多比較 5 檔。'; return; }
    symbols.value = [...codes, code].join('、');
  });

  function loadSeries(codes, start, end) {
    return json(`/api/fugle/performance?${new URLSearchParams({ symbols: codes.join(','), from: start, to: end })}`);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    compareResult.innerHTML = '';
    const codes = parseSymbols();
    if (codes.length < 2 || codes.length > 5 || codes.some((code) => !symbolPattern.test(code))) {
      compareStatus.textContent = '請輸入 2 至 5 個不同的台股代號。'; return;
    }
    if (from.value >= to.value || Date.parse(to.value) - Date.parse(from.value) > 364 * day) {
      compareStatus.textContent = '起日須早於迄日，區間最多 364 天。'; return;
    }
    const id = ++compareRequest, button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    compareStatus.textContent = '正在取得歷史日線…';
    try {
      const { series } = await loadSeries(codes, from.value, to.value);
      if (id !== compareRequest) return;
      const failures = series.filter((row) => row.error || alignCloses([row]).dates.length < 2);
      if (failures.length) {
        compareStatus.textContent = failures.map((row) => `${row.code} ${row.error || '此期間收盤資料不足'}`).join('；');
        return;
      }
      const { dates, values } = alignCloses(series);
      if (dates.length < 2) { compareStatus.textContent = '所選股票不足兩個共同交易日，請調整日期或代號。'; return; }
      const lines = series.map((row, index) => ({ code: row.code, label: getWatchlist().find(({ code }) => code === row.code)?.name || row.code, values: values[index].map((price) => price / values[index][0] * 100), ...priceMetrics(values[index]) }));
      const rows = lines.map((row, index) => `<tr><th scope="row"><i style="--series-color:${colors[index]}"></i>${escape(row.label)}</th><td class="${movementClass(row.performance)}">${percent(row.performance)}</td><td>${percent(row.drawdown)}</td><td>${percent(row.volatility)}</td></tr>`).join('');
      compareStatus.textContent = `${dates[0]} 至 ${dates.at(-1)} · ${dates.length} 個共同交易日`;
      compareResult.innerHTML = `${trendChart(dates, lines)}<div class="risk-table-wrap"><table><caption class="sr-only">股票區間績效指標</caption><thead><tr><th scope="col">標的</th><th scope="col">區間漲跌</th><th scope="col">最大回撤</th><th scope="col">年化波動</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } catch (error) {
      if (id === compareRequest) compareStatus.textContent = error.message;
    } finally {
      if (id === compareRequest) button.disabled = false;
    }
  });

  risk('[data-health-submit]').addEventListener('click', async (event) => {
    const positions = getPositions().filter(({ shares }) => shares > 0);
    const shares = new Map();
    for (const position of positions) shares.set(position.code, (shares.get(position.code) || 0) + position.shares);
    const codes = [...shares.keys()];
    historyResult.innerHTML = '';
    if (!codes.length || codes.some((code) => !symbolPattern.test(code)) || codes.length > 15) {
      historyStatus.textContent = '近 90 日組合試算支援 1 至 15 檔，且每檔須有有效台股代號。'; return;
    }
    const id = ++healthRequest, button = event.currentTarget;
    button.disabled = true;
    historyStatus.textContent = '正在取得近 90 日行情…';
    try {
      const { series } = await loadSeries(codes, dateInTaiwan(90), dateInTaiwan());
      if (id !== healthRequest) return;
      const missing = series.filter((row) => row.error || alignCloses([row]).dates.length < 3);
      if (missing.length) { historyStatus.textContent = `行情不足，無法估算完整組合。${missing.map((row) => `${row.code} ${row.error || '不足 3 個交易日'}`).join('；')}`; return; }
      const { dates, values } = alignCloses(series);
      if (dates.length < 3) { historyStatus.textContent = '組合不足 3 個共同交易日，無法完整估算。請確認持股代號及日線資料。'; return; }
      const total = dates.map((_, index) => values.reduce((sum, prices, row) => sum + prices[index] * shares.get(series[row].code), 0));
      const { drawdown, volatility } = priceMetrics(total);
      historyStatus.textContent = `${dates[0]} 至 ${dates.at(-1)} · ${dates.length} 個共同交易日`;
      historyResult.innerHTML = `<div><span>最大回撤</span><strong>${percent(drawdown)}</strong></div><div><span>年化波動度</span><strong>${percent(volatility)}</strong></div>`;
    } catch (error) {
      if (id === healthRequest) historyStatus.textContent = error.message;
    } finally {
      if (id === healthRequest) button.disabled = false;
    }
  });

  factorSymbol.addEventListener('change', () => {
    factorRequest++;
    risk('[data-factor-submit]').disabled = !factorSymbol.value;
    factorResult.textContent = '';
  });
  risk('[data-factor-submit]').addEventListener('click', async (event) => {
    if (!factorSymbol.value) { factorResult.textContent = '請先選擇台股公司。'; return; }
    const id = ++factorRequest, button = event.currentTarget;
    button.disabled = true;
    factorResult.textContent = '正在讀取各面向資料…';
    try {
      const data = await json(`/api/market/stock-factors?${new URLSearchParams({ symbol: factorSymbol.value })}`);
      if (id !== factorRequest) return;
      factorResult.innerHTML = factors(data).map((item) => `<article><h4>${item.name}</h4><strong>${item.score == null ? '資料不足' : `${item.score} / 100`}</strong><p>${escape(item.evidence)}</p><small>${item.method}</small></article>`).join('');
    } catch (error) {
      if (id === factorRequest) factorResult.textContent = error.message;
    } finally {
      if (id === factorRequest) button.disabled = false;
    }
  });

  return { refresh, openHealth };
}
