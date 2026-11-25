import { calculateTopup, marketTotals, topupApiResult } from './portfolio-math.js?v=20261125c';
import { formatScenarioMoney, mountScenarioComparison } from './scenario-compare.js?v=20261125c';

(() => {
  'use strict';
  const STORAGE_KEY = 'canggu.v1.portfolio';
  const $ = (id) => document.getElementById(id);
  const initialState = { holdings: [], observations: [], transactions: [], alerts: [], journal: [], watchlist: [], watchlistGroups: {}, events: [], settings: { eyeComfort: false, topupReviewReminders: [] } };
  const hadLocalState = localStorage.getItem(STORAGE_KEY) !== null;
  let state = loadState();
  let quoteMap = new Map();
  let internationalQuoteMap = new Map();
  const overviewQuoteJobs = new Map();
  const overviewQuoteStatus = new Map();
  let lastInternationalQuote = null;
  let stockLookupRequest = 0;
  let quoteRefreshPromise = null;
  let lastQuoteFetchAt = 0;
  let screenCandidateResults = null;
  let toastTimer;
  let supabaseClient = null, cloudUser = null, cloudReady = false, cloudSyncEnabled = false, cloudSyncTimer = null, lastCloudUpdatedAt = '';
  let servicesStarted = false, accountMode = 'login';

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || !Array.isArray(parsed.holdings) || !Array.isArray(parsed.observations)) return structuredClone(initialState);
      return { ...initialState, ...parsed, transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [], alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [], journal: Array.isArray(parsed.journal) ? parsed.journal : [], watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [], watchlistGroups: parsed.watchlistGroups && typeof parsed.watchlistGroups === 'object' && !Array.isArray(parsed.watchlistGroups) ? parsed.watchlistGroups : {}, events: Array.isArray(parsed.events) ? parsed.events : [], settings: parsed.settings && typeof parsed.settings === 'object' ? { ...initialState.settings, ...parsed.settings, topupReviewReminders: Array.isArray(parsed.settings.topupReviewReminders) ? parsed.settings.topupReviewReminders : [] } : { ...initialState.settings } };
    } catch { return structuredClone(initialState); }
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { showToast('瀏覽器儲存空間不足，請先匯出備份。'); }
    if (cloudSyncEnabled && cloudReady) queueCloudSave();
  }
  function persistLocalOnly() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { showToast('瀏覽器儲存空間不足，請先匯出備份。'); }
  }
  function hasPortfolioContent(value) {
    return ['holdings','observations','transactions','alerts','journal','watchlist','events'].some((key) => Array.isArray(value?.[key]) && value[key].length > 0)
      || ['topupReviewReminders', 'screenPresets'].some((key) => Array.isArray(value?.settings?.[key]) && value.settings[key].length > 0);
  }
  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function normalizePortfolio(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(initialState);
    return { ...Object.fromEntries(['holdings','observations','transactions','alerts','journal','watchlist','events'].map((key) => [key, Array.isArray(value[key]) ? value[key] : []])), watchlistGroups: value.watchlistGroups && typeof value.watchlistGroups === 'object' && !Array.isArray(value.watchlistGroups) ? value.watchlistGroups : {}, settings: value.settings && typeof value.settings === 'object' ? { ...initialState.settings, ...value.settings, topupReviewReminders: Array.isArray(value.settings.topupReviewReminders) ? value.settings.topupReviewReminders : [] } : { ...initialState.settings } };
  }
  function showAccountGate(message = '') {
    $('accountGate').hidden = false; $('appShell').hidden = true; $('logoutBtn').hidden = true;
    if (message) $('accountStatus').textContent = message;
  }
  function showSyncedApp() {
    $('accountGate').hidden = true; $('appShell').hidden = false; $('logoutBtn').hidden = false;
    $('syncBadge').innerHTML = '<i></i>雲端同步已開啟';
    $('syncBadge').title = lastCloudUpdatedAt ? `最近同步：${new Date(lastCloudUpdatedAt).toLocaleString('zh-TW')}` : '雲端資料同步已啟用';
  }
  function startAppServices() {
    if (servicesStarted) return;
    servicesStarted = true; checkFugleStatus(); renderCandidates(); refreshQuotes(); checkTopupReviewReminders(); renderTopupReviewReminders();
    if (state.holdings.length) refreshNews();
  }
  async function initAccountSync() {
    let config;
    try {
      const response = await fetch('/api/sync/config', { cache: 'no-store' });
      config = await response.json();
      if (!response.ok) throw new Error(config.error || '無法讀取同步設定。');
    } catch (error) {
      showAccountGate(`無法連線到登入設定：${error.message}`); return;
    }
    if (!config.configured) {
      if (config.production) { showAccountGate('網站雲端登入尚未設定完成，請聯絡管理者。'); return; }
      $('accountGate').hidden = true; $('appShell').hidden = false; $('syncBadge').innerHTML = '<i></i>僅儲存於此裝置';
      startAppServices(); return;
    }
    if (!window.supabase?.createClient) { showAccountGate('登入元件載入失敗，請重新整理並確認網路連線。'); return; }
    supabaseClient = window.supabase.createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    $('accountModeToggle').addEventListener('click', () => {
      accountMode = accountMode === 'login' ? 'signup' : 'login';
      $('accountSubmit').textContent = accountMode === 'login' ? '登入' : '建立帳號';
      $('accountPassword').autocomplete = accountMode === 'login' ? 'current-password' : 'new-password';
      $('accountModeToggle').textContent = accountMode === 'login' ? '還沒有帳號？建立帳號' : '已有帳號？返回登入';
      $('accountStatus').textContent = '';
    });
    $('accountForm').addEventListener('submit', async (event) => {
      event.preventDefault(); const button = $('accountSubmit'); button.disabled = true; $('accountStatus').textContent = accountMode === 'login' ? '正在登入…' : '正在建立帳號…';
      try {
        const email = $('accountEmail').value.trim(), password = $('accountPassword').value;
        const result = accountMode === 'login' ? await supabaseClient.auth.signInWithPassword({ email, password }) : await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
        if (result.error) throw result.error;
        if (result.data.session) await activateCloudUser(result.data.session);
        else $('accountStatus').textContent = '帳號已建立。請先到電子信箱完成驗證，再回來登入。';
      } catch (error) { $('accountStatus').textContent = error.message || '登入失敗，請檢查帳號和密碼。'; }
      finally { button.disabled = false; }
    });
    $('logoutBtn').addEventListener('click', async () => {
      if (supabaseClient) { await supabaseClient.auth.signOut(); showAccountGate('已登出。再次登入即可繼續同步。'); }
    });
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) { cloudSyncEnabled = false; cloudReady = false; cloudUser = null; showAccountGate('請登入以讀取你的雲端資料。'); }
      else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') queueMicrotask(() => activateCloudUser(session));
    });
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) { showAccountGate(`無法讀取登入狀態：${error.message}`); return; }
    if (data.session) await activateCloudUser(data.session);
    else showAccountGate('請登入或建立帳號；第一次登入會將此裝置的資料同步到雲端。');
  }
  let activatingUserId = '';
  async function activateCloudUser(session) {
    if (!session?.user || activatingUserId === session.user.id || (cloudReady && cloudUser?.id === session.user.id)) return;
    activatingUserId = session.user.id; cloudUser = session.user; showAccountGate('正在安全載入你的雲端資料…');
    try {
      const { data: row, error } = await supabaseClient.from('portfolio_data').select('data,updated_at').eq('user_id', cloudUser.id).maybeSingle();
      if (error) throw error;
      let shouldUpload = !row;
      if (row?.data) {
        const localState = normalizePortfolio(state), cloudState = normalizePortfolio(row.data), localHasData = hadLocalState && hasPortfolioContent(localState);
        if (localHasData && stableSerialize(state) !== stableSerialize(cloudState)) {
          const useDevice = confirm('此裝置和雲端都有資料。按「確定」會用此裝置資料覆寫雲端；按「取消」會載入雲端資料並覆蓋此裝置。');
          if (useDevice) { state = localState; shouldUpload = true; } else state = cloudState;
        } else state = cloudState;
        lastCloudUpdatedAt = row.updated_at || '';
        persistLocalOnly(); render();
      }
      cloudReady = true;
      if (shouldUpload && !await saveCloudData()) throw new Error('無法儲存到雲端，請確認資料庫存取政策。');
      cloudReady = true; cloudSyncEnabled = true; activatingUserId = ''; showSyncedApp(); startAppServices();
    } catch (error) {
      activatingUserId = ''; cloudReady = false; cloudSyncEnabled = false;
      showAccountGate(`雲端資料庫尚未設定完成：${error.message}。請先完成資料表與存取政策設定。`);
    }
  }
  function queueCloudSave() {
    clearTimeout(cloudSyncTimer); cloudSyncTimer = setTimeout(async () => { cloudSyncTimer = null; if (!await saveCloudData()) setTimeout(queueCloudSave, 5000); }, 700);
  }
  async function saveCloudData() {
    if (!supabaseClient || !cloudUser || !cloudReady) return true;
    const { data, error } = await supabaseClient.from('portfolio_data').upsert({ user_id: cloudUser.id, data: state }, { onConflict: 'user_id' }).select('updated_at').single();
    if (error) { $('syncBadge').innerHTML = '<i></i>同步失敗'; $('accountStatus').textContent = `雲端同步失敗：${error.message}。本機資料仍保留。`; return false; }
    lastCloudUpdatedAt = data.updated_at || new Date().toISOString(); $('syncBadge').innerHTML = '<i></i>雲端同步已開啟'; $('syncBadge').title = `最近同步：${new Date(lastCloudUpdatedAt).toLocaleString('zh-TW')}`;
    return true;
  }
  async function pullCloudData() {
    if (!cloudSyncEnabled || !cloudReady || !cloudUser || cloudSyncTimer || document.querySelector('dialog[open]')) return;
    const { data, error } = await supabaseClient.from('portfolio_data').select('data,updated_at').eq('user_id', cloudUser.id).maybeSingle();
    if (error) { $('syncBadge').innerHTML = '<i></i>同步檢查失敗'; return; }
    if (data?.data && data.updated_at > lastCloudUpdatedAt) { state = normalizePortfolio(data.data); lastCloudUpdatedAt = data.updated_at; persistLocalOnly(); render(); }
  }
  function refreshVisibleData() { pullCloudData(); if (servicesStarted && Date.now() - lastQuoteFetchAt > 60000) refreshQuotes(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshVisibleData(); });
  window.addEventListener('focus', refreshVisibleData);
  setInterval(pullCloudData, 45000);
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const money = (value) => 'NT$ ' + num(value).toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const marketLabels = { tw: '台灣', us: '美國', jp: '日本', hk: '香港', gb: '英國', de: '德國', ca: '加拿大', au: '澳洲', in: '印度', sg: '新加坡', kr: '韓國', fr: '法國' };
  const marketCurrencies = { tw: 'TWD', us: 'USD', jp: 'JPY', hk: 'HKD', gb: 'GBP', de: 'EUR', ca: 'CAD', au: 'AUD', in: 'INR', sg: 'SGD', kr: 'KRW', fr: 'EUR' };
  const holdingMarket = (item) => item?.market || 'tw';
  const holdingCurrency = (item) => {
    if (holdingMarket(item) === 'tw') return 'TWD';
    if (item?.currency === 'GBp') return 'GBX';
    const currency = String(item?.currency || '').toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : '';
  };
  const currencyMoney = (value, currency) => {
    if (currency === 'TWD') return money(value);
    const decimals = ['JPY', 'KRW'].includes(currency) ? 0 : 2;
    return (currency ? currency + ' ' : '') + num(value).toLocaleString('zh-TW', { maximumFractionDigits: decimals });
  };
  const internationalQuoteKey = (item) => [holdingMarket(item), String(item?.symbol || item?.name || '').toUpperCase(), String(item?.micCode || item?.exchange || '').toUpperCase()].join(':');
  const holdingQuote = (item) => {
    if (holdingMarket(item) === 'tw') return quoteMap.get(stockCode(item.name));
    const quote = internationalQuoteMap.get(internationalQuoteKey(item));
    return quote && holdingCurrency(quote) === holdingCurrency(item) ? quote : undefined;
  };
  const marketTickPrice = (value) => { const n = num(value), tick = n < 10 ? 0.01 : n < 50 ? 0.05 : n < 100 ? 0.1 : n < 500 ? 0.5 : n < 1000 ? 1 : 5; return Math.round((n + Number.EPSILON) / tick) * tick; };
  const marketRefMoney = (value) => money(marketTickPrice(value));
  const pct = (value) => `${num(value) > 0 ? '+' : ''}${num(value).toFixed(2)}%`;
  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const stockCode = (name) => String(name).match(/\b\d{4,6}\b/)?.[0] || '';
  const livePrice = (item) => holdingQuote(item)?.price ?? num(item.price);
  const holdingScenarioButton = (item, compact = false) => `<button type="button" class="secondary-button holding-scenario-button" data-simulate-holding="${esc(item.id)}" aria-label="試算 ${esc(item.name)} 持倉">${compact ? '試算' : '試算這筆持倉'}</button>`;
  function showToast(message) { const toast = $('toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500); }
  function pnl(item) { return (num(item.price) - num(item.cost)) * num(item.shares); }
  function render() {
    const holdings = state.holdings;
    const taiwanHoldings = holdings.filter((item) => holdingMarket(item) === 'tw');
    const realized = state.transactions.filter((row) => row.type === 'sell').reduce((sum, row) => sum + num(row.realizedPnl), 0);
    const dividends = state.transactions.filter((row) => row.type === 'dividend').reduce((sum, row) => sum + num(row.shares) * num(row.price), 0);
    $('realizedPnl').textContent = money(realized); $('realizedPnl').className = `metric ${realized < 0 ? 'negative' : realized > 0 ? 'positive' : ''}`; $('dividendTotal').textContent = money(dividends);
    renderOverviewHoldings();
    renderTopupHoldingOptions();
    renderScreenPresets();
    $('holdingCount').textContent = String(holdings.length);
    const heldSelect = $('heldStockSelect'), selectedHeldId = heldSelect.value;
    heldSelect.innerHTML = taiwanHoldings.length ? taiwanHoldings.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('') : '<option value="">請先新增台股</option>';
    if (taiwanHoldings.some((item) => item.id === selectedHeldId)) heldSelect.value = selectedHeldId;
    $('holdingsBody').innerHTML = holdings.map((item, index) => {
      const quote = holdingQuote(item), currency = holdingCurrency(item), price = livePrice(item);
      const valueNow = price * num(item.shares), currentPnl = (price - num(item.cost)) * num(item.shares), rate = num(item.cost) * num(item.shares) ? currentPnl / (num(item.cost) * num(item.shares)) * 100 : 0;
      const colors = ['','blue','gold','pink']; const initial = esc(item.name.trim().slice(0, 1) || '股');
      return `<tr><td><div class="stock-name"><span class="stock-avatar ${colors[index % colors.length]}">${initial}</span><span>${esc(item.name)}<small class="stock-sub">${esc(marketLabels[holdingMarket(item)] || '其他市場')} · ${quote ? `${esc(quote.datetime || quote.date || quote.updatedAt || '')}` : item.updated ? `備用價 · ${esc(item.updated)}` : '個人持倉'}</small></span></div></td><td>${num(item.shares).toLocaleString('zh-TW')}</td><td>${currencyMoney(item.cost, currency)}</td><td>${currencyMoney(price, currency)}${quote?.change !== null && quote?.change !== undefined ? `<small class="quote-change ${quote.change < 0 ? 'negative' : 'positive'}">${quote.change > 0 ? '+' : ''}${currencyMoney(quote.change, currency)}</small>` : ''}</td><td>${currencyMoney(valueNow, currency)}</td><td class="${currentPnl < 0 ? 'negative' : 'positive'}">${currencyMoney(currentPnl, currency)} <small>(${pct(rate)})</small></td><td>${num(item.targetWeight) ? `${num(item.targetWeight).toFixed(1)}%` : '—'}</td><td><div class="row-actions"><button class="row-action" data-edit="${esc(item.id)}" title="編輯">✎</button><button class="row-action" data-delete="${esc(item.id)}" title="刪除">×</button></div></td></tr>`;
    }).join('');
    $('holdingsBody').querySelectorAll('[data-edit]').forEach((button) => {
      const item = holdings.find((holding) => holding.id === button.dataset.edit);
      if (item) button.insertAdjacentHTML('beforebegin', holdingScenarioButton(item, true));
    });
    $('emptyHoldings').style.display = holdings.length ? 'none' : 'block';
    $('stockOptions').innerHTML = taiwanHoldings.map((item) => `<option value="${esc(item.name)}"></option>`).join('');
    $('mopsQuickLinks').innerHTML = taiwanHoldings.filter((item) => stockCode(item.name)).map((item) => `<a class="mops-chip" href="https://mops.twse.com.tw/mops/web/t05st01?TYPEK=all&co_id=${encodeURIComponent(stockCode(item.name))}" target="_blank" rel="noopener noreferrer">${esc(item.name)} 公告 ↗</a>`).join('');
    const filter = $('newsStockFilter'), selected = filter.value || 'all';
    filter.innerHTML = `<option value="all">全部持股</option>` + holdings.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    filter.value = holdings.some((item) => item.id === selected) || selected === 'all' ? selected : 'all';
    if (!holdings.length) $('quoteStatus').textContent = '新增持股後可更新最新交易日行情';
    renderInsights();
    renderTrend();
    renderLedger(); renderAllocation(); renderAlerts(); renderJournal(); renderTopupReviewReminders();
    renderStockWatchlist(); renderEvents(); applyEyeComfort();
  }
  function renderOverviewSummary(market, holdings) {
    const totals = marketTotals(holdings, livePrice, holdingCurrency);
    if (!totals.size) totals.set(marketCurrencies[market], { cost: 0, value: 0 });
    const groups = [...totals].sort(([a], [b]) => a.localeCompare(b));
    const fields = { marketValue: (row) => row.value, costValue: (row) => row.cost, totalPnl: (row) => row.value - row.cost };
    for (const [id, amount] of Object.entries(fields)) {
      $(id).innerHTML = groups.map(([currency, row]) => {
        const value = amount(row);
        const color = id === 'totalPnl' ? (value < 0 ? 'negative' : value > 0 ? 'positive' : '') : '';
        return `<span class="${color}">${esc(currencyMoney(value, currency))}</span>`;
      }).join('');
      $(id).classList.toggle('metric-breakdown', groups.length > 1);
    }
    const row = groups[0][1], ratio = row.cost ? (row.value - row.cost) / row.cost * 100 : 0;
    $('totalPnlPct').hidden = groups.length > 1 || !row.cost;
    $('totalPnlPct').textContent = pct(ratio);
    $('totalPnlPct').classList.toggle('negative', ratio < 0);
    $('pnlBasis').textContent = '市值減帳面成本，未扣預估賣出費用';
    const quotes = holdings.map(holdingQuote).filter(Boolean);
    const dates = [...new Set(quotes.map((quote) => String(quote.datetime || quote.date || '').slice(0, 10)).filter(Boolean))].sort();
    const source = market === 'tw' ? 'TWSE／TPEx' : 'Twelve Data';
    const range = dates.length === 1 ? dates[0] : dates.length > 1 ? dates[0] + ' 至 ' + dates.at(-1) : '日期未提供';
    $('marketValueBasis').textContent = quotes.length ? source + ' · ' + range + (quotes.length < holdings.length ? ' · 部分使用備用價' : '')
      : holdings.length ? '依備用價格估算' : '此市場尚無持股';
    $('summaryGrid').classList.toggle('is-overseas', market !== 'tw');
    $('summaryGrid').querySelectorAll('[data-tw-only]').forEach((card) => { card.hidden = market !== 'tw'; });
    if (!$('overview').hidden) $('marketFreshness').hidden = market !== 'tw';
  }
  function renderOverviewHoldings() {
    const container = $('overviewHoldings');
    if (!container) return;
    const market = $('overviewMarketFilter')?.value || 'tw';
    const marketHoldings = state.holdings.filter((item) => holdingMarket(item) === market);
    renderOverviewSummary(market, marketHoldings);
    const holdings = marketHoldings.sort((a, b) => holdingCurrency(a).localeCompare(holdingCurrency(b)) || livePrice(b) * num(b.shares) - livePrice(a) * num(a.shares)).slice(0, 4);
    $('overviewMarketStatus').textContent = (holdings.length && overviewQuoteStatus.get(market)) || '';
    $('refreshMarketHoldings').hidden = market === 'tw' || !holdings.length;
    $('refreshMarketHoldings').disabled = overviewQuoteJobs.has(market);
    $('refreshMarketHoldings').textContent = overviewQuoteJobs.has(market) ? '更新中…' : '更新行情';
    if (!holdings.length) {
      container.innerHTML = market === 'tw' ? '<div class="overview-empty"><span>目前還沒有台股持倉</span><small>新增股票後，這裡會顯示市值較高的部位與目前損益。</small><a href="#holdings">前往管理持股 ↗</a></div>' : `<div class="overview-empty"><span>尚未加入${esc(marketLabels[market] || '此市場')}持股</span><small>到個股查詢搜尋股票，再按「加入持股」。</small><a href="#stockDesk">前往海外個股查詢 ↗</a></div>`;
      return;
    }
    container.innerHTML = holdings.map((item) => {
      const quote = holdingQuote(item), currency = holdingCurrency(item), price = livePrice(item);
      const value = price * num(item.shares), pnlValue = (price - num(item.cost)) * num(item.shares);
      const pnlRate = num(item.cost) * num(item.shares) ? pnlValue / (num(item.cost) * num(item.shares)) * 100 : 0;
      const quoteTime = quote?.datetime || quote?.date;
      const priceLabel = quote ? (quote.source || 'TWSE／TPEx') + ' · ' + (quoteTime || '時間未提供') : '使用備用價格';
      return `<article class="overview-holding"><div class="overview-holding-title"><span class="overview-holding-mark">${esc(item.name.trim().slice(0,1) || '股')}</span><span><b>${esc(item.name)}</b><small>${esc(priceLabel)}</small></span></div><div class="overview-holding-value"><b>${currencyMoney(value, currency)}</b><small>${num(item.shares).toLocaleString('zh-TW')} 股 · ${currencyMoney(price, currency)}／股</small></div><div class="overview-holding-pnl ${pnlValue < 0 ? 'negative' : 'positive'}"><b>${currencyMoney(pnlValue, currency)}</b><small>${pct(pnlRate)}</small></div>${holdingScenarioButton(item, true)}</article>`;
    }).join('');
  }
  function setQuoteFreshness(state, label, title = '') {
    const badge = $('quoteFreshnessBadge');
    if (!badge) return;
    badge.dataset.state = state;
    badge.textContent = label;
    badge.title = title || label;
  }
  function quoteChangePct(quote) { const price = num(quote.price), change = Number(quote.change); return price - change > 0 && Number.isFinite(change) ? change / (price - change) * 100 : null; }
  function renderStockQuote(quote) {
    const code = String(quote.code), change = Number(quote.change), changePct = quoteChangePct(quote), watched = state.watchlist.includes(code);
    const newsUrl = `https://news.google.com/search?q=${encodeURIComponent(`"${code}" "${quote.name}"`)}&hl=zh-TW&gl=TW`;
    return `<article class="stock-quote-card"><div class="stock-quote-title"><b>${esc(code)} ${esc(quote.name)}</b><small>${esc(quote.market || '台股')} · ${esc(quote.date || '最近交易日')}${quote.turnover != null ? ` · 成交值 ${money(quote.turnover)}` : ''}</small></div><div class="stock-quote-value">${money(quote.price)}<small class="${change < 0 ? 'negative' : 'positive'}">${Number.isFinite(change) ? `${change > 0 ? '+' : ''}${change.toFixed(2)}${changePct == null ? '' : `（${pct(changePct)}）`}` : '漲跌資料暫缺'}</small></div><div class="stock-quote-actions"><button type="button" class="secondary-button" data-fundamentals="${esc(code)}">載入基本面</button><button type="button" class="secondary-button" data-stock-analyze="${esc(code)}">技術分析</button><button type="button" class="${watched ? 'secondary-button' : 'primary-button'}" data-watch-add="${esc(code)}" ${watched ? 'disabled' : ''}>${watched ? '已加入自選' : '＋ 加入自選'}</button><a class="candidate-links" href="${esc(newsUrl)}" target="_blank" rel="noopener noreferrer">相關新聞 ↗</a></div><div class="stock-fundamentals" data-fundamentals-panel="${esc(code)}" hidden></div></article>`;
  }
  async function loadFundamentals(symbol, button) {
    const panel = [...document.querySelectorAll('[data-fundamentals-panel]')].find((item) => item.dataset.fundamentalsPanel === symbol);
    if (!panel) return;
    button.disabled = true; button.textContent = '載入中…'; panel.hidden = false; panel.innerHTML = '<span class="feature-empty">正在載入基本面與營收資料…</span>';
    try {
      const response = await fetch(`/api/fundamentals?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.error || '基本面資料讀取失敗。');
      const valuation = data.valuation;
      const metric = (label, value, suffix = '') => `<div><small>${label}</small><b>${value == null ? '—' : `${Number(value).toFixed(2)}${suffix}`}</b></div>`;
      const rows = [...data.revenue].reverse().map((row) => `<tr><td>${esc(row.month)}</td><td>${row.amount == null ? '—' : `${(row.amount / 100000000).toFixed(2)} 億`}</td><td class="${row.yearOverYear == null ? '' : row.yearOverYear < 0 ? 'negative' : 'positive'}">${row.yearOverYear == null ? '—' : `${row.yearOverYear > 0 ? '+' : ''}${row.yearOverYear.toFixed(2)}%`}</td></tr>`).join('');
      panel.innerHTML = `<div class="fundamentals-heading"><b>免費台股基本面</b><small>估值日期：${esc(valuation?.date || '暫無資料')}</small></div><div class="fundamentals-metrics">${metric('本益比', valuation?.per, ' 倍')}${metric('殖利率', valuation?.dividendYield, '%')}${metric('股價淨值比', valuation?.pbr, ' 倍')}</div><div class="fundamentals-revenue"><b>近 12 個月營收</b><div class="fundamentals-table-wrap"><table><thead><tr><th>月份</th><th>營收</th><th>年增率</th></tr></thead><tbody>${rows || '<tr><td colspan="3">暫無營收資料</td></tr>'}</tbody></table></div></div><small class="fundamentals-source">資料來源：FinMind · ${esc(data.updatedAt.slice(0, 10))} 更新；估值為資料來源最近提供日期。</small>`;
      button.textContent = '更新基本面';
    } catch (error) {
      panel.innerHTML = `<span class="feature-empty">${esc(error.message)}</span>`; button.textContent = '重試基本面';
    } finally { button.disabled = false; }
  }
  function renderStockWatchlist() {
    $('watchlistCount').textContent = `${state.watchlist.length} 檔`;
    if (!state.watchlist.length) { $('stockWatchlist').innerHTML = '<div class="stock-watch-empty">還沒有待觀察股票。查詢個股後按「加入自選」。</div>'; return; }
    const selectedGroup = $('watchlistGroupFilter').value || 'all', visibleCodes = state.watchlist.filter((code) => selectedGroup === 'all' || (state.watchlistGroups[code] || '觀察中') === selectedGroup);
    if (!visibleCodes.length) { $('stockWatchlist').innerHTML = '<div class="stock-watch-empty">這個分組目前沒有股票。</div>'; return; }
    $('stockWatchlist').innerHTML = visibleCodes.map((code) => {
      const quote = quoteMap.get(String(code)), change = quote ? Number(quote.change) : NaN, changePct = quote ? quoteChangePct(quote) : null;
      const name = quote?.name || '行情更新後顯示名稱', date = quote?.date || '尚無最新行情';
      const group = state.watchlistGroups[code] || '觀察中';
      return `<article class="stock-watch-row"><div class="stock-watch-main"><b>${esc(code)} ${esc(name)}</b><small>${esc(quote?.market || '台股')} · ${esc(date)}${quote?.turnover != null ? ` · 成交值 ${money(quote.turnover)}` : ''}</small></div><div class="stock-watch-price">${quote ? money(quote.price) : '—'}<small class="${change < 0 ? 'negative' : 'positive'}">${quote && Number.isFinite(change) ? `${change > 0 ? '+' : ''}${change.toFixed(2)}${changePct == null ? '' : `（${pct(changePct)}）`}` : '尚無行情'}</small></div><label class="watch-group-picker"><span class="sr-only">${esc(code)} 分組</span><select data-watch-group="${esc(code)}" aria-label="${esc(code)} 分組"><option${group === '觀察中' ? ' selected' : ''}>觀察中</option><option${group === '準備買進' ? ' selected' : ''}>準備買進</option><option${group === '長期追蹤' ? ' selected' : ''}>長期追蹤</option></select></label><div class="stock-watch-actions"><button class="secondary-button" type="button" data-stock-analyze="${esc(code)}">技術分析</button><button class="secondary-button" type="button" data-watch-remove="${esc(code)}">移除</button></div></article>`;
    }).join('');
  }
  function lookupQuotes(query) {
    const key = query.trim().toLocaleLowerCase().replace(/\s+/g, '');
    const values = [...quoteMap.values()];
    if (/^\d{4,6}$/.test(key)) return values.filter((row) => String(row.code) === key);
    const exact = values.filter((row) => String(row.name).toLocaleLowerCase().replace(/\s+/g, '') === key);
    return exact.length ? exact : values.filter((row) => String(row.name).toLocaleLowerCase().includes(key) || String(row.code).includes(key)).slice(0, 12);
  }
  function showStockLookup(query) {
    const matches = lookupQuotes(query);
    if (!matches.length) { $('stockLookupResult').innerHTML = `<div class="feature-empty">找不到「${esc(query)}」的行情，請確認代號或名稱，或先更新行情。</div>`; return; }
    $('stockLookupResult').innerHTML = matches.map(renderStockQuote).join('');
  }
  let lastInternationalSearch = null;
  async function internationalMarketFetch(url) {
    const { data, error } = await supabaseClient?.auth.getSession() || {};
    if (supabaseClient && (error || !data?.session?.access_token)) throw new Error('登入狀態已失效，請重新登入後查詢海外行情。');
    const headers = data?.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {};
    return fetch(url, { cache: 'no-store', headers });
  }
  function refreshSelectedMarketHoldings(force = false) {
    const market = $('overviewMarketFilter').value;
    if (market === 'tw' || overviewQuoteJobs.has(market)) return;
    const holdings = state.holdings.filter((item) => holdingMarket(item) === market && item.symbol && (item.micCode || item.exchange));
    const pending = new Map(holdings.map((item) => [internationalQuoteKey(item), item]));
    if (!force) for (const key of pending.keys()) {
      if (Date.now() - (internationalQuoteMap.get(key)?.fetchedAt || 0) < 60000) pending.delete(key);
    }
    if (!pending.size) return;
    overviewQuoteStatus.set(market, '正在更新' + marketLabels[market] + '持股報價…');
    const job = (async () => {
      let updated = 0;
      const failed = [];
      for (const [key, item] of pending) {
        try {
          const params = new URLSearchParams({ market, symbol: item.symbol, exchange: item.exchange || '', micCode: item.micCode || '', history: '0' });
          const response = await internationalMarketFetch('/api/markets/quote?' + params), data = await response.json();
          if (!response.ok) throw new Error(data.error || '報價讀取失敗');
          if (holdingCurrency(data) !== holdingCurrency(item)) throw new Error('報價幣別與持倉紀錄不同');
          internationalQuoteMap.set(key, { ...data, fetchedAt: Date.now() }); updated += 1;
        } catch (error) { failed.push(item.symbol + ': ' + (error.message || '更新失敗')); }
      }
      overviewQuoteStatus.set(market, failed.length ? '已更新 ' + updated + '/' + pending.size + ' 檔。未更新：' + failed.join('；') : '已更新 ' + updated + ' 檔' + marketLabels[market] + '持股。');
    })().finally(() => {
      overviewQuoteJobs.delete(market);
      render();
    });
    overviewQuoteJobs.set(market, job);
    renderOverviewHoldings();
  }
  function renderInternationalSearch(data, query) {
    if (!data.results.length) {
      $('stockLookupResult').innerHTML = `<div class="feature-empty">在${esc(data.label)}市場找不到「${esc(query)}」，可試公司英文名稱或代號。</div>`;
      return;
    }
    $('stockLookupResult').innerHTML = `<div class="global-market-search-list">
      ${data.results.map((item, index) => `<article>
        <div><b>${esc(item.symbol)} · ${esc(item.name)}</b><small>${esc(item.exchange)} · ${esc(item.country)} · ${esc(item.currency)}${item.access ? ` · 資料權限 ${esc(item.access)}` : ''}</small></div>
        <div class="global-market-actions">
          <button type="button" class="secondary-button" data-international-stock="${index}">查看行情</button>
          <button type="button" class="primary-button" data-add-international-holding="${index}" aria-label="加入持股 ${esc(item.symbol)}">＋ 加入持股</button>
        </div>
      </article>`).join('')}
    </div>`;
  }
  async function searchInternationalMarket(query) {
    const market = $('stockLookupMarket').value;
    const request = ++stockLookupRequest;
    lastInternationalQuote = null;
    lastInternationalSearch = null;
    $('stockLookupResult').innerHTML = '<div class="feature-empty">正在搜尋海外市場股票…</div>';
    try {
      const response = await internationalMarketFetch(`/api/markets/search?market=${encodeURIComponent(market)}&q=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (request !== stockLookupRequest) return;
      if (!response.ok) throw new Error(data.error || '海外股票搜尋失敗。');
      lastInternationalSearch = { ...data, query };
      renderInternationalSearch(data, query);
    } catch (error) { if (request === stockLookupRequest) $('stockLookupResult').innerHTML = `<div class="feature-empty">${esc(error.message || '海外股票搜尋失敗。')}</div>`; }
  }
  async function loadInternationalQuote(item) {
    if (!item) return;
    const request = ++stockLookupRequest;
    const market = lastInternationalSearch.market;
    $('stockLookupResult').innerHTML = '<div class="feature-empty">正在讀取海外報價與日線資料…</div>';
    try {
      const params = new URLSearchParams({ market, symbol: item.symbol, exchange: item.exchange, micCode: item.micCode || '' });
      const response = await internationalMarketFetch(`/api/markets/quote?${params}`), data = await response.json();
      if (request !== stockLookupRequest) return;
      if (!response.ok) throw new Error(data.error || '海外行情讀取失敗。');
      lastInternationalQuote = { ...data, market, symbol: item.symbol, exchange: item.exchange, micCode: item.micCode || '' };
      internationalQuoteMap.set(internationalQuoteKey(lastInternationalQuote), { ...data, fetchedAt: Date.now() });
      const formatter = { format: (value) => currencyMoney(value, holdingCurrency(data)) };
      const closes = data.candles.map((row) => Number(row.close)).filter((value) => Number.isFinite(value));
      const min = Math.min(...closes), max = Math.max(...closes), span = max - min || 1;
      const points = data.candles.map((row, index) => `${(index / Math.max(1, data.candles.length - 1) * 360).toFixed(1)},${(70 - (Number(row.close) - min) / span * 60).toFixed(1)}`).join(' ');
      const first = data.candles[0], last = data.candles.at(-1), changeClass = data.change < 0 ? 'negative' : 'positive';
      $('stockLookupResult').innerHTML = `<article class="global-market-quote">
        <header>
          <div><b>${esc(data.symbol)} · ${esc(data.name)}</b><small>${esc(data.countryLabel)} · ${esc(data.exchange)} · ${esc(data.currency)}</small></div>
          <div class="global-market-actions">
            <button type="button" class="secondary-button" data-back-market-search>返回搜尋結果</button>
            <button type="button" class="primary-button" data-add-international-holding="quote">＋ 加入持股</button>
          </div>
        </header>
        <div class="global-market-price"><strong>${formatter.format(data.price)}</strong><span class="${changeClass}">${data.change > 0 ? '+' : ''}${formatter.format(data.change)}（${data.changePercent > 0 ? '+' : ''}${data.changePercent.toFixed(2)}%）</span></div>
        ${points ? `<div class="global-market-chart"><svg viewBox="0 0 360 76" role="img" aria-label="${esc(data.symbol)} 近期日收盤價走勢"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg><small>日收盤區間 ${formatter.format(min)}–${formatter.format(max)} · ${esc(first?.date || '')} 至 ${esc(last?.date || '')} · ${data.candles.length} 個交易日</small></div>` : '<div class="feature-empty">目前沒有可用的歷史日線。</div>'}
        <small class="global-market-source">資料來源：${esc(data.source)} · 行情時間 ${esc(data.datetime || data.updatedAt.slice(0, 10))}。${esc(data.priceNote)}</small>
      </article>`;
    } catch (error) {
      if (request !== stockLookupRequest) return;
      lastInternationalQuote = { ...item, market };
      $('stockLookupResult').innerHTML = `<div class="feature-empty">
        ${esc(error.message || '海外行情讀取失敗。')}
        <div class="global-market-actions">
          <button type="button" class="secondary-button" data-back-market-search>返回搜尋結果</button>
          <button type="button" class="primary-button" data-add-international-holding="quote">＋ 加入持股</button>
        </div>
      </div>`;
    }
  }
  function setupStockLookupMarkets() {
    const form = $('stockLookupForm'), marketLabel = document.createElement('label'), market = document.createElement('select');
    market.id = 'stockLookupMarket';
    market.innerHTML = '<option value="tw">台灣（TWSE／TPEx）</option><option value="us">美國</option><option value="jp">日本</option><option value="hk">香港</option><option value="gb">英國</option><option value="de">德國</option><option value="ca">加拿大</option><option value="au">澳洲</option><option value="in">印度</option><option value="sg">新加坡</option><option value="kr">韓國</option><option value="fr">法國</option>';
    marketLabel.textContent = '選擇股票市場'; marketLabel.append(market); form.insertBefore(marketLabel, form.firstElementChild);
    const note = form.querySelector('small');
    const marketStatus = document.createElement('div'); marketStatus.id = 'stockLookupMarketStatus'; marketStatus.className = 'trend-status'; marketStatus.setAttribute('role', 'status'); marketStatus.setAttribute('aria-live', 'polite'); form.after(marketStatus);
    market.addEventListener('change', () => {
      const local = market.value === 'tw';
      stockLookupRequest += 1;
      lastInternationalQuote = null; lastInternationalSearch = null;
      $('stockLookupInput').placeholder = local ? '例如：2330、台積電、009816' : '例如：AAPL 或 Apple';
      note.textContent = local ? '行情以證交所／櫃買中心最近交易日收盤資料為準。' : '用代號或英文名稱搜尋。先查看行情可帶入備用價格，也可以直接加入持股並手動填寫。';
      $('stockLookupResult').innerHTML = `<div class="feature-empty">已切換至${market.selectedOptions[0].textContent}，輸入代號或名稱開始查詢。</div>`;
    });
    void fetch('/api/markets/status', { cache: 'no-store' }).then((response) => response.json()).then((data) => {
      marketStatus.textContent = data.configured ? '海外市場查詢已設定。可使用的國家、即時／延遲狀態與免費額度依資料服務方案而異。' : '海外市場程式已加入；設定 Twelve Data 金鑰後才能查詢。Windows 本機請在 %LOCALAPPDATA%\\Canggu\\config.env 加入 TWELVE_DATA_API_KEY；Render 請在服務的 Environment 設定同名變數。免費 Basic 方案含部分美股即時資料，其他市場依方案與交易所授權。';
    }).catch(() => { marketStatus.textContent = '海外市場服務狀態目前無法讀取。'; });
  }
  function renderInsights() {
    const holdings = state.holdings.filter((item) => holdingMarket(item) === 'tw');
    if (!holdings.length) {
      $('insightContent').innerHTML = '<div class="insight-empty"><b>新增持股後開始檢視</b><span>系統會依部位集中度、最新行情變動與損益列出研究待辦。</span></div>';
      return;
    }
    const marketValue = holdings.reduce((sum, item) => sum + livePrice(item) * num(item.shares), 0);
    const cards = [];
    holdings.forEach((item) => {
      const code = stockCode(item.name), quote = quoteMap.get(code), value = livePrice(item) * num(item.shares);
      const weight = marketValue ? value / marketValue * 100 : 0;
      const cost = num(item.cost) * num(item.shares), rate = cost ? ((value - cost) / cost) * 100 : 0;
      if (weight >= 40) cards.push(`<article class="insight-item"><span class="insight-mark warn">!</span><div><b>${esc(item.name)}：部位集中度偏高</b><p>約占目前持倉市值 ${weight.toFixed(1)}%。可檢視分散程度、資金用途與可承受波動。</p>${holdingScenarioButton(item)}</div></article>`);
      if (quote?.change !== null && quote?.change !== undefined && Math.abs(num(quote.change)) >= 5) cards.push(`<article class="insight-item"><span class="insight-mark warn">↕</span><div><b>${esc(item.name)}：最近交易日波動較大</b><p>官方行情顯示漲跌 ${num(quote.change) > 0 ? '+' : ''}${num(quote.change).toFixed(2)} 元。建議核對公告、新聞與事件日期。</p></div></article>`);
      if (rate <= -10) cards.push(`<article class="insight-item"><span class="insight-mark down">↓</span><div><b>${esc(item.name)}：重新檢查原始投資假設</b><p>目前未實現損益約 ${pct(rate)}。回顧持有期限、資金需求與原先研究紀錄；成本價本身不代表合理價值。</p></div></article>`);
      else if (rate >= 20) cards.push(`<article class="insight-item"><span class="insight-mark up">↑</span><div><b>${esc(item.name)}：檢視獲利後的配置</b><p>目前未實現損益約 ${pct(rate)}。可檢視部位是否超出原定配置，並把費用與稅務納入考量。</p></div></article>`);
    });
    if (!quoteMap.size) cards.unshift('<article class="insight-item"><span class="insight-mark">i</span><div><b>行情尚未更新</b><p>目前以備用價格估算。先更新行情，提醒才會包含官方最近交易日變動。</p></div></article>');
    if (!cards.length) cards.push('<article class="insight-item"><span class="insight-mark">✓</span><div><b>目前沒有觸發預設提醒</b><p>這不代表風險不存在；仍需依投資期限、財務目標與可承受損失自行評估。</p></div></article>');
    $('insightContent').innerHTML = cards.join('');
  }
  function renderTrend() {
    const observations = [...state.observations].sort((a,b) => a.date.localeCompare(b.date));
    if (!observations.length) {
      $('trendContent').innerHTML = '<div class="trend-empty"><strong>先記錄幾個價格觀察點</strong><span>累積資料後，這裡會整理近期變化方向。</span></div>'; return;
    }
    const byStock = new Map();
    observations.forEach((item) => { const list = byStock.get(item.stock) || []; list.push(item); byStock.set(item.stock, list); });
    const blocks = [...byStock.entries()].map(([stock, rows]) => {
      const first = rows[0], last = rows[rows.length - 1], change = first.price ? (last.price - first.price) / first.price * 100 : 0;
      const direction = change > 1 ? 'up' : change < -1 ? 'down' : 'flat';
      const label = direction === 'up' ? '觀察期間呈上行' : direction === 'down' ? '觀察期間呈下行' : '觀察期間變化有限';
      const glyph = direction === 'up' ? '↗' : direction === 'down' ? '↘' : '→';
      const note = rows.length < 2 ? '目前只有一筆紀錄，尚無法比較趨勢。' : `從 ${first.date} 到 ${last.date}，記錄價格由 ${money(first.price)} 變為 ${money(last.price)}，變動 ${pct(change)}（${rows.length} 筆）。`;
      const recent = [...rows].reverse().slice(0, 2).map((row) => `<div class="trend-history"><span>${esc(stock)} <small>${esc(row.note || '')}</small></span><span>${money(row.price)} <small>${esc(row.date)}</small></span></div>`).join('');
      return `<div class="trend-summary ${direction}"><span class="trend-arrow">${glyph}</span><div><b>${esc(stock)} · ${label}</b><p>${note}</p></div></div>${recent}`;
    }).join('');
    $('trendContent').innerHTML = blocks;
  }
  function refreshQuotes() {
    if (quoteRefreshPromise) return quoteRefreshPromise;
    quoteRefreshPromise = refreshQuotesNow().finally(() => { quoteRefreshPromise = null; });
    return quoteRefreshPromise;
  }
  async function refreshQuotesNow() {
    const button = $('refreshQuotes'), candidateButton = $('refreshCandidates'); button.disabled = true; candidateButton.disabled = true; button.textContent = '載入中…'; candidateButton.textContent = '載入中…'; $('quoteStatus').textContent = '正在讀取 TWSE／TPEx 官方收盤資料…'; setQuoteFreshness('loading', '行情更新中');
    try {
      const response = await fetch('/api/quotes', { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.error || '行情更新失敗');
      quoteMap = new Map(data.quotes.map((row) => [String(row.code), row])); lastQuoteFetchAt = Date.now(); render(); renderCandidates(data.quotes, data.updatedAt);
      $('stockDeskQuoteDate').textContent = `官方收盤資料 ${data.quotes.map((row) => row.date).filter(Boolean).sort().at(-1) || data.updatedAt.slice(0, 10)} · ${data.source || 'TWSE／TPEx OpenAPI'}`;
      if ($('stockLookupInput').value.trim() && $('stockLookupMarket')?.value === 'tw') showStockLookup($('stockLookupInput').value);
      evaluateAlerts();
      const taiwanHoldings = state.holdings.filter((item) => holdingMarket(item) === 'tw');
      const matched = taiwanHoldings.filter((item) => quoteMap.has(stockCode(item.name))).length;
      const dataDate = data.quotes.map((row) => row.date).filter(Boolean).sort().at(-1) || '最近交易日';
      $('quoteStatus').textContent = `${taiwanHoldings.length ? `${matched}/${taiwanHoldings.length} 檔台股持股比對成功 · ` : `全市場 ${data.quotes.length.toLocaleString('zh-TW')} 檔 · `}${dataDate} 最近交易日收盤 · 來源 ${data.source || 'TWSE／TPEx OpenAPI'} · 查詢於 ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`;
      setQuoteFreshness('fresh', `官方收盤 ${dataDate}`, `來源：${data.source || 'TWSE／TPEx OpenAPI'}；最近查詢：${new Date(lastQuoteFetchAt).toLocaleString('zh-TW')}`);
      if (data.warnings?.length) $('quoteStatus').textContent += ` · ${data.warnings.join('、')}`;
      if (taiwanHoldings.length && !matched) showToast('行情已連線，但台股持股名稱中需要有 4–6 碼股票代號才能配對。');
    } catch (error) { const detail = error.message.includes('Failed to fetch') ? '無法連到資料服務，請確認服務已啟動。' : error.message; const previousDate = [...quoteMap.values()].map((row) => row.date).filter(Boolean).sort().at(-1); $('quoteStatus').textContent = previousDate ? `更新失敗，暫沿用 ${previousDate} 的舊資料 · ${detail}` : `行情更新失敗 · ${detail}`; setQuoteFreshness('error', previousDate ? `更新失敗 · 沿用 ${previousDate}` : '行情更新失敗', detail); $('candidateContent').innerHTML = `<div class="news-empty">公開行情暫時無法取得：${esc(error.message)}</div>`; showToast('行情更新失敗；總覽已標出目前資料日期。'); }
    finally { button.disabled = false; candidateButton.disabled = false; button.textContent = '↻ 更新行情'; candidateButton.textContent = '↻ 更新候選股號'; }
  }
  function renderCandidates(quotes = [...quoteMap.values()], updatedAt = '') {
    const candidates = quotes.map((row) => {
      const code = String(row.code), price = num(row.price), change = Number(row.change), previous = price - change;
      return { ...row, code, changePct: previous > 0 && Number.isFinite(change) ? change / previous * 100 : 0 };
    }).filter((row) => /^\d{4}$/.test(row.code) && !row.code.startsWith('0') && !/(購|售|牛|熊|ETF|期貨|權證)/i.test(row.name) && row.changePct > 0 && (row.turnover == null || row.turnover >= 30000000))
      .sort((a, b) => b.changePct - a.changePct).slice(0, 8);
    if (!candidates.length) { $('candidateContent').innerHTML = '<div class="news-empty">尚無可用漲幅資料，請稍後更新。</div>'; return; }
    $('candidateContent').innerHTML = candidates.map((item) => {
      const newsUrl = `https://news.google.com/search?q=${encodeURIComponent(`"${item.code}" "${item.name}"`)}&hl=zh-TW&gl=TW`;
      const noticeUrl = `https://mops.twse.com.tw/mops/web/t05st01?TYPEK=all&co_id=${encodeURIComponent(item.code)}`;
      return `<article class="candidate-row"><div class="candidate-stock"><b>${esc(item.code)} ${esc(item.name)}</b><small>${esc(item.market)} · ${esc(item.date || updatedAt.slice(0, 10) || '最近交易日')}${item.turnover != null ? ` · 成交值 ${money(item.turnover)}` : ''}</small></div><div class="candidate-price">${money(item.price)}<small class="positive">+${item.changePct.toFixed(2)}%</small></div><div class="candidate-links"><a href="${esc(newsUrl)}" target="_blank" rel="noopener noreferrer">相關新聞 ↗</a><a href="${esc(noticeUrl)}" target="_blank" rel="noopener noreferrer">公司公告 ↗</a></div></article>`;
    }).join('');
  }
  const screenPresetFields = ['screenPriceUnlimited', 'screenPriceLimit', 'screenHorizon', 'screenBudgetUnlimited', 'screenBudget', 'screenLossUnlimited', 'screenMaxLoss', 'screenShareUnit'];
  function screenPresets() {
    return Array.isArray(state.settings.screenPresets)
      ? state.settings.screenPresets.filter((row) => row?.id && row?.name && row.fields && typeof row.fields === 'object')
      : [];
  }
  function renderScreenPresets() {
    const select = $('screenPreset'), selected = select.value;
    select.innerHTML = '<option value="">選擇條件</option>' + screenPresets().map((row) => `<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('');
    if (screenPresets().some((row) => row.id === selected)) select.value = selected;
    $('removeScreenPreset').disabled = !select.value;
  }
  function screenScoreDetails(item) {
    if (!Array.isArray(item.scoreBreakdown)) return '';
    return `<details class="screen-score-details"><summary>查看分數明細</summary><dl>
      ${item.scoreBreakdown.map((row) => `<div><dt>${esc(row.label)}</dt><dd>${row.missing ? '資料不足' : row.points ? `${row.points > 0 ? '+' : ''}${Number(row.points)} 分` : '未觸發 · 0 分'}</dd></div>`).join('')}
    </dl></details>`;
  }
  function renderScreenCandidates(data, sizing, page = 1) {
    const container = $('screenContent'), candidates = data.candidates || [], pageSize = 10;
    if (!candidates.length) { container.innerHTML = `<div class="screen-empty">${esc(data.message || '目前沒有符合條件的候選，試著放寬每股價格上限或稍後再查。')}</div>`; return; }
    const pageCount = Math.ceil(candidates.length / pageSize), currentPage = Math.max(1, Math.min(pageCount, Number(page) || 1)), offset = (currentPage - 1) * pageSize;
    const shown = candidates.slice(offset, offset + pageSize);
    container.innerHTML = `<div class="screen-results-heading"><b>符合行情條件 ${Number(data.eligibleCount ?? candidates.length).toLocaleString('zh-TW')} 檔 · 完成評分 ${candidates.length.toLocaleString('zh-TW')} 檔</b><span>依評分由高到低排序 · 每頁 ${pageSize} 檔</span></div>` + shown.map((item, index) => {
      const newsUrl = `https://news.google.com/search?q=${encodeURIComponent(`"${item.code}" "${item.name}"`)}&hl=zh-TW&gl=TW`;
      const noticeUrl = `https://mops.twse.com.tw/mops/web/t05st01?TYPEK=all&co_id=${encodeURIComponent(item.code)}`;
      const entryLow = marketTickPrice(item.entryLow), entryHigh = marketTickPrice(item.entryHigh), stop = marketTickPrice(item.stop), entry = marketTickPrice((entryLow + entryHigh) / 2), riskPerShare = Math.max(0, entry - stop);
      const riskShares = sizing.lossUnlimited ? Infinity : riskPerShare > 0 ? Math.floor(sizing.maxLoss / riskPerShare) : 0, budgetShares = sizing.budgetUnlimited ? Infinity : Math.floor(sizing.budget / entry), rawShares = Math.min(riskShares, budgetShares), unitShares = Number.isFinite(rawShares) ? Math.floor(rawShares / sizing.unit) * sizing.unit : 0;
      const invested = unitShares * entry, plannedLoss = unitShares * riskPerShare;
      const target1 = marketTickPrice(item.target1), target2 = marketTickPrice(item.target2), gross1 = unitShares * (target1 - entry), gross2 = unitShares * (target2 - entry);
      const noSharesReason = unitShares ? '' : sizing.budgetUnlimited && sizing.lossUnlimited ? '預算與虧損上限都不限，無法估算股數；請至少設定其中一項。' : sizing.unit === 1000 ? '目前預算或虧損上限不足以估算 1 張（1000 股）' : '目前預算或虧損上限不足以估算 1 股';
      return `<article class="screen-row"><div class="screen-row-top"><div class="candidate-stock"><b><span class="screen-rank">${offset + index + 1}</span>${esc(item.code)} ${esc(item.name || '')}</b><small>${esc(item.market || '台股')} · 日 K ${esc(item.date || '')} · 成交值 ${money(item.turnover)}</small></div><div class="screen-quote">${money(item.price)}<small class="${item.horizonReturn >= 0 ? 'positive' : 'negative'}">${data.horizon === 5 ? '5 日' : '20 日'} ${pct(item.horizonReturn)}</small></div><span class="screen-score screen-priority-${Number(item.priority) || 0}">${esc(item.priorityLabel || '一般觀察')} · ${item.score} 分</span></div><div class="screen-state">${esc(item.status)}</div><div class="screen-levels"><span>買入觀察區 <b>${marketRefMoney(item.entryLow)} – ${marketRefMoney(item.entryHigh)}</b></span><span>風險失效價 <b>${marketRefMoney(item.stop)}</b></span><span>假設停利 1R / 2R <b>${marketRefMoney(target1)} / ${marketRefMoney(target2)}</b></span></div><div class="screen-sizing"><b>部位試算（假設單檔使用整筆預算）</b><div><span>估算買入 <strong>${unitShares.toLocaleString('zh-TW')} 股</strong></span><span>假設進場均價 <strong>${marketRefMoney(entry)}</strong></span><span>預估投入 <strong>${money(invested)}</strong></span><span>觸及失效價估損 <strong>${money(plannedLoss)}</strong></span><span>全數停利 1R 毛利 <strong>${money(gross1)}</strong></span><span>全數停利 2R 毛利 <strong>${money(gross2)}</strong></span></div>${noSharesReason ? `<small class="sizing-warning">${noSharesReason}</small>` : ''}</div><div class="screen-reasons"><span>RSI ${item.rsi == null ? '資料不足' : Number(item.rsi).toFixed(1)}</span><span>${item.smaTrend ? '均線偏多' : '均線未偏多'}</span><span>${item.improving ? 'MACD 動能改善' : 'MACD 動能未改善'}</span><span>${item.volumeOK ? '成交量放大' : '量能未達確認'}</span></div><div class="candidate-links screen-links"><a href="${esc(newsUrl)}" target="_blank" rel="noopener noreferrer">相關新聞 ↗</a><a href="${esc(noticeUrl)}" target="_blank" rel="noopener noreferrer">公司公告 ↗</a></div></article>`;
    }).join('') + `<nav class="screen-pagination" aria-label="候選股分頁"><span>第 ${currentPage} / ${pageCount} 頁 · 共 ${candidates.length.toLocaleString('zh-TW')} 檔</span><div><button type="button" class="secondary-button" data-screen-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>上一頁</button><button type="button" class="secondary-button" data-screen-page="${currentPage + 1}" ${currentPage >= pageCount ? 'disabled' : ''}>下一頁</button></div></nav>`;
    container.querySelectorAll('.screen-row').forEach((node, index) => {
      const item = shown[index], code = String(item.code), watched = state.watchlist.includes(code);
      node.querySelector('.screen-reasons').insertAdjacentHTML('afterend', screenScoreDetails(item));
      node.querySelector('.screen-links').insertAdjacentHTML('afterbegin', `<button type="button" class="secondary-button" data-screen-watch="${esc(code)}" ${watched ? 'disabled' : ''}>${watched ? '已加入自選' : '＋ 加入自選'}</button>`);
    });
  }
  $('screenContent').addEventListener('click', (event) => {
    const add = event.target.closest('[data-screen-watch]');
    if (add && !state.watchlist.includes(add.dataset.screenWatch)) {
      state.watchlist.push(add.dataset.screenWatch);
      state.watchlistGroups[add.dataset.screenWatch] = '觀察中';
      persist(); renderStockWatchlist();
      add.disabled = true; add.textContent = '已加入自選';
      showToast('已加入自選「觀察中」。');
      return;
    }
    const button = event.target.closest('[data-screen-page]');
    if (button && !button.disabled && screenCandidateResults) renderScreenCandidates(screenCandidateResults.data, screenCandidateResults.sizing, Number(button.dataset.screenPage));
  });
  [['screenPriceUnlimited', 'screenPriceLimit'], ['screenBudgetUnlimited', 'screenBudget'], ['screenLossUnlimited', 'screenMaxLoss']].forEach(([toggleId, inputId]) => {
    $(toggleId).addEventListener('change', () => { const input = $(inputId); input.disabled = $(toggleId).checked; if (input.disabled) input.value = ''; });
  });
  $('saveScreenPreset').addEventListener('click', () => {
    const name = prompt('為這組篩選條件命名')?.trim().slice(0, 40);
    if (!name) return;
    const existing = screenPresets().find((row) => row.name === name);
    if (!existing && screenPresets().length >= 10) return showToast('最多儲存 10 組條件。請先刪除一組。');
    const fields = Object.fromEntries(screenPresetFields.map((id) => {
      const input = $(id);
      return [id, input.type === 'checkbox' ? input.checked : input.value];
    }));
    const id = existing?.id || crypto.randomUUID();
    state.settings.screenPresets = [...screenPresets().filter((row) => row.id !== id), { id, name, fields }];
    persist(); renderScreenPresets();
    $('screenPreset').value = id;
    $('removeScreenPreset').disabled = false;
    showToast('已儲存篩選條件。');
  });
  $('screenPreset').addEventListener('change', () => {
    const row = screenPresets().find((preset) => preset.id === $('screenPreset').value);
    $('removeScreenPreset').disabled = !row;
    if (!row) return;
    for (const id of screenPresetFields) {
      const input = $(id);
      if (input.type === 'checkbox') input.checked = row.fields[id] === true;
      else input.value = row.fields[id] ?? '';
    }
    screenPresetFields.filter((id) => id.endsWith('Unlimited')).forEach((id) => $(id).dispatchEvent(new Event('change')));
    showToast('已載入條件，按「篩選並試算」開始查詢。');
  });
  $('removeScreenPreset').addEventListener('click', () => {
    state.settings.screenPresets = screenPresets().filter((row) => row.id !== $('screenPreset').value);
    persist(); renderScreenPresets(); showToast('已刪除所選條件。');
  });
  $('screenForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const priceUnlimited = $('screenPriceUnlimited').checked, budgetUnlimited = $('screenBudgetUnlimited').checked, lossUnlimited = $('screenLossUnlimited').checked;
    const priceLimit = priceUnlimited ? Infinity : Number($('screenPriceLimit').value), horizon = Number($('screenHorizon').value), budget = budgetUnlimited ? Infinity : Number($('screenBudget').value), maxLoss = lossUnlimited ? Infinity : Number($('screenMaxLoss').value), unit = Number($('screenShareUnit').value), button = $('runScreen');
    if (!priceUnlimited && (!Number.isFinite(priceLimit) || priceLimit <= 0)) return showToast('請輸入大於 0 的每股價格上限，或選擇不限。');
    if (!budgetUnlimited && (!Number.isFinite(budget) || budget <= 0)) return showToast('請輸入大於 0 的投入預算，或選擇不限。');
    if (!lossUnlimited && (!Number.isFinite(maxLoss) || maxLoss <= 0)) return showToast('請輸入大於 0 的單筆最大可承受虧損，或選擇不限。');
    button.disabled = true; button.textContent = '正在掃描…'; $('screenStatus').textContent = '正在整理上市櫃普通股行情，準備逐檔分析歷史日 K…'; $('screenContent').innerHTML = ''; screenCandidateResults = null;
    try {
      let response = await fugleFetch(`/api/fugle/screen?priceLimit=${encodeURIComponent(priceUnlimited ? 'unlimited' : priceLimit)}&horizon=${encodeURIComponent(horizon)}`), data = await response.json();
      if (!response.ok) throw new Error(data.error || '條件篩選失敗');
      if (!data.configured) throw new Error('尚未設定 Fugle API 金鑰。');
      while (data.status === 'running' && data.jobId) {
        $('screenStatus').textContent = `正在分析全部符合行情條件的股票：${Number(data.scanned || 0).toLocaleString('zh-TW')} / ${Number(data.total || 0).toLocaleString('zh-TW')} 檔。歷史行情受 Fugle API 呼叫額度限制，完成時間依符合條件的股票數量而異。`;
        await new Promise((resolve) => setTimeout(resolve, 2200));
        response = await fugleFetch(`/api/fugle/screen/${encodeURIComponent(data.jobId)}`); data = await response.json();
        if (!response.ok) throw new Error(data.error || '候選掃描中斷，請重新篩選。');
      }
      const sizing = { budget, maxLoss, unit, budgetUnlimited, lossUnlimited };
      screenCandidateResults = { data, sizing }; renderScreenCandidates(data, sizing);
      $('screenStatus').textContent = `已分析 ${Number(data.analyzedCount || 0).toLocaleString('zh-TW')} / ${Number(data.eligibleCount || 0).toLocaleString('zh-TW')} 檔符合行情條件股票，完成評分 ${data.candidates?.length || 0} 檔；結果依分數由高至低排列，可翻頁瀏覽全部評分結果 · 每股上限 ${priceUnlimited ? '不限' : money(priceLimit)} · ${horizon === 5 ? '約一週' : '約一個月'} · 預算 ${budgetUnlimited ? '不限' : money(budget)} · 單筆虧損上限 ${lossUnlimited ? '不限' : money(maxLoss)} · ${unit === 1 ? '零股' : '整股'}估算 · 最近交易日資料${budgetUnlimited && lossUnlimited ? ' · 未設定部位上限，不估算股數' : ''}${data.warnings?.length ? ` · ${data.warnings.join('、')}` : ''}`;
    } catch (error) { $('screenStatus').textContent = error.message; }
    finally { button.disabled = false; button.textContent = '篩選並試算'; }
  });
  function renderNews(items, message) {
    if (message) { $('newsContent').innerHTML = `<div class="news-empty">${esc(message)}</div>`; return; }
    if (!items?.length) { $('newsContent').innerHTML = '<div class="news-empty">目前沒有找到相關新聞。你仍可前往公開資訊觀測站查看公司公告。</div>'; return; }
    $('newsContent').innerHTML = items.map((item) => `<article class="news-item"><span class="news-date">${esc(item.publishedAt || '最新')}</span><div class="news-main"><a class="news-story-link" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer"><b>${esc(item.title)}</b></a><small>${esc(item.source || 'Google News RSS')}</small><div class="news-actions">${item.sourceUrl ? `<a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">來源網站 ↗</a>` : ''}<a href="${esc(item.searchLink || `https://news.google.com/search?q=${encodeURIComponent(`\"${item.title}\"`)}&hl=zh-TW&gl=TW`)}" target="_blank" rel="noopener noreferrer">Google News 備用連結 ↗</a></div></div></article>`).join('');
  }
  async function refreshNews() {
    const selected = $('newsStockFilter').value;
    const chosen = selected === 'all' ? state.holdings : state.holdings.filter((item) => item.id === selected);
    const keyword = $('newsKeyword').value.trim();
    if (!chosen.length && !keyword) { $('newsFreshness').dataset.state = 'pending'; $('newsFreshness').textContent = '等待查詢條件'; return renderNews([], '請先新增持股，或輸入關鍵字搜尋新聞。'); }
    const button = $('refreshNews'); button.disabled = true; button.textContent = '載入中…';
    $('newsFreshness').dataset.state = 'loading'; $('newsFreshness').textContent = '查詢中…';
    try {
      const stocks = chosen.map((item) => ({ name: item.name.replace(/\b\d{4,6}\b/g, '').trim(), code: stockCode(item.name) }));
      const terms = stocks.flatMap((item) => [item.name.slice(0, 32), item.code].filter(Boolean));
      const query = [terms.length ? `(${terms.map((term) => `"${term}"`).join(' OR ')})` : '', keyword].filter(Boolean).join(' ');
      const params = new URLSearchParams({ stocks: JSON.stringify(stocks), keyword });
      const response = await fetch(`/api/news?${params}`, { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.error || '動態更新失敗');
      const searchUrl = `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW`;
      $('newsSourceLinks').innerHTML = `<a class="mops-chip" href="${esc(searchUrl)}" target="_blank" rel="noopener noreferrer">在 Google News 開啟完整搜尋結果 ↗</a>`;
      renderNews(data.items);
      const queriedAt = new Date(); $('newsFreshness').dataset.state = 'fresh'; $('newsFreshness').textContent = `查詢於 ${queriedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`; $('newsFreshness').title = `最近成功查詢：${queriedAt.toLocaleString('zh-TW')}`;
    } catch (error) { $('newsFreshness').dataset.state = 'error'; $('newsFreshness').textContent = '查詢失敗'; $('newsFreshness').title = error.message; $('newsSourceLinks').innerHTML = ''; renderNews([], error.message || '新聞來源暫時無法連線，請稍後重試。'); }
    finally { button.disabled = false; button.textContent = '⌕ 搜尋新聞'; }
  }
  $('globalDemoFill').addEventListener('click', () => {
    $('globalCompany').value = 'NVIDIA'; $('globalTicker').value = 'NVDA'; $('globalTaiwanCodes').value = '2330、2317'; $('globalRelation').value = 'AI 加速器、先進製程、伺服器供應鏈';
    $('globalResearchStatus').textContent = '已填入示範查詢條件。按「分析產業與個股」後會重新查詢即時公開資料；需勾選資料同意。';
    $('globalCompany').focus();
  });
  $('globalResearchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!$('globalResearchConsent').checked) { $('globalResearchStatus').textContent = '請先閱讀並勾選資料傳送同意。'; $('globalResearchConsent').focus(); return; }
    const button = $('globalResearchSubmit'); button.disabled = true; button.textContent = '查詢與整理中…'; $('globalResearchResult').hidden = true;
    $('globalResearchConsent').checked = false;
    $('globalResearchStatus').textContent = '正在搜尋海外新聞與申報資料，並比對上市櫃公司名單分析可能受影響的產業及個股。';
    try {
      const { data: sessionData } = await supabaseClient?.auth.getSession() || {};
      const headers = { 'Content-Type': 'application/json' };
      if (sessionData?.session?.access_token) headers.Authorization = `Bearer ${sessionData.session.access_token}`;
      const response = await fetch('/api/international-research', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ companyName: $('globalCompany').value.trim(), ticker: $('globalTicker').value.trim(), taiwanCodes: $('globalTaiwanCodes').value.trim(), relation: $('globalRelation').value.trim(), provider: $('globalAiProvider').value, aiConsent: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '國際事件查詢失敗，請稍後重試。');
      const research = data.research || {}, sec = research.sec || {};
      const filings = (sec.filings || []).map((filing) => `<li><a href="${esc(filing.url)}" target="_blank" rel="noopener noreferrer">${esc(filing.form)} · 申報 ${esc(filing.date)}${filing.period ? ` · 期間 ${esc(filing.period)}` : ''}</a>${filing.description ? `<small>${esc(filing.description)}</small>` : ''}</li>`).join('');
      const financials = (sec.financials || []).map((metric) => `<span class="global-metric"><small>${esc(metric.label)} · ${esc(metric.end)} · ${esc(metric.form)}</small><b>${Number(metric.value).toLocaleString('zh-TW')} ${esc(metric.unit)}</b></span>`).join('');
      const newsItems = (research.headlines || []).map((item) => `<li><a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a><small>${esc(item.publishedAt || '')} · ${esc(item.source || 'Google News')}${item.description ? ` · ${esc(item.description)}` : ''}</small></li>`).join('');
      const analysis = data.impactAnalysis || {}, impactStocks = analysis.stocks || [], industries = analysis.industries || [];
      const researchSources = new Map([
        ...(research.headlines || []).map((item, index) => [`N${index + 1}`, { title: item.title, url: item.link, date: item.publishedAt }]),
        ...(sec.filings || []).map((item, index) => [`F${index + 1}`, { title: `${item.form} ${item.date || ''} ${item.description || ''}`.trim(), url: item.url, date: item.date }]),
        ...(sec.financials || []).map((item, index) => [`M${index + 1}`, { title: `${item.label} ${item.end || ''}`.trim(), date: item.end }])
      ]);
      const showEvidence = (evidence) => Array.isArray(evidence) && evidence.length ? `<div class="global-evidence"><b>引用來源（可點擊核對）</b>${evidence.map((id) => { const source = researchSources.get(id); if (!source) return ''; const label = `<span>${esc(id)}</span> ${esc(source.title)}${source.date ? ` · ${esc(source.date)}` : ''}`; return source.url ? `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : `<div class="global-evidence-text">${label}</div>`; }).join('')}</div>` : '<small class="global-evidence-missing">尚無可核對來源</small>';
      const evidenceCoverage = (item) => {
        const summary = item.evidenceSummary || {};
        const count = Number(summary.count) || 0;
        const types = Array.isArray(summary.types) ? summary.types : [];
        return count ? `引用依據：${count} 則${types.length ? `（${types.map(esc).join('、')}）` : ''}` : '引用依據：無';
      };
      const directionClass = (value) => value === '可能受惠' ? 'positive' : value === '可能承壓' ? 'negative' : 'uncertain';
      const industryCards = industries.map((item) => `<article class="global-impact-industry"><header><b>${esc(item.name || '未分類產業')}</b><span title="模型自評的定性程度，不是機率">模型信心${esc(item.confidence || '未評估')}</span></header><p>${esc(item.impact || '')}</p><small>可能傳導：${esc(item.transmission || '資料不足')}</small><small>${evidenceCoverage(item)}</small>${showEvidence(item.evidence)}</article>`).join('');
      const impactStockCards = impactStocks.map((item) => {
        const quote = item.quote, price = quote ? Number(quote.lastPrice ?? quote.closePrice ?? quote.previousClose) : Number(item.dailyClose);
        const quoteDate = quote?.date || quote?.quoteUpdatedAt || quote?.lastUpdated || item.dailyDate || '';
        const priceLabel = Number.isFinite(price) && price > 0 ? `NT$ ${price.toLocaleString('zh-TW')} · ${esc(quoteDate)} · ${esc(quote?.quoteSource || '最近收盤')}` : esc(item.quoteError || '目前無行情');
        return `<article class="global-impact-stock"><header><b>${esc(item.code)} ${esc(item.name || '')}</b><span class="global-impact-badge ${directionClass(item.impact)}">${esc(item.impact || '影響不明')}</span></header><small title="模型信心是定性自評，不是機率">${esc(item.market || '')} · ${priceLabel} · 模型信心${esc(item.confidence || '未評估')}</small><small>${evidenceCoverage(item)}</small><div class="global-pathway"><span>海外事件</span><i>→</i><span>${esc(item.industry || '相關產業')}</span><i>→</i><b>${esc(item.code)} ${esc(item.name || '')}</b></div><p>${esc(item.reason || '')}</p>${item.horizon ? `<small>觀察區間：${esc(item.horizon)}</small>` : ''}${showEvidence(item.evidence)}</article>`;
      }).join('');
      const requestedStockCards = (analysis.requestedStocks || []).map((item) => `<article class="global-impact-stock"><header><b>${esc(item.code)} ${esc(item.name || '')}</b><span class="global-impact-badge uncertain">${esc(item.impact || '尚無足夠證據')}</span></header><small>${esc(item.market || '')} · 最近收盤 NT$ ${Number(item.dailyClose || 0).toLocaleString('zh-TW')} · ${esc(item.dailyDate || '')}</small><p>${esc(item.reason || '')}</p></article>`).join('');
      const risks = (analysis.risks || []).map((risk) => `<li>${esc(risk)}</li>`).join('');
      const invalidCodes = (research.unrecognizedCodes || []).length ? `<p class="global-source-note">以下代號未出現在目前上市櫃個股名單：${esc(research.unrecognizedCodes.join('、'))}</p>` : '';
      const replayNews = (research.headlines || []).filter((item) => item.publishedAt && item.link).slice(0, 10);
      const replayPanel = impactStocks.length && replayNews.length ? `<section class="global-replay"><h3>歷史事件回放</h3><p>以新聞日期前一個收盤價為基準，比較事件後 5／20 個交易日的價格變化；這是歷史比較，不代表事件造成漲跌。</p><div class="global-replay-form"><label>事件新聞<select id="globalReplayNews">${replayNews.map((item, index) => `<option value="${index}">${esc(item.publishedAt)} · ${esc(item.title)}</option>`).join('')}</select></label><label>觀察台股<select id="globalReplayStock">${impactStocks.map((item) => `<option value="${esc(item.code)}">${esc(item.code)} ${esc(item.name)}</option>`).join('')}</select></label><button type="button" class="secondary-button" id="globalReplayRun">比較事件前後</button></div><div id="globalReplayResult" class="global-replay-result" aria-live="polite"></div></section>` : '';
      $('globalResearchResult').innerHTML = `<div class="global-result-summary"><b>${esc(research.foreignCompany)}${research.ticker ? `（${research.ticker}）` : ''} · 國際事件研究</b><p>${esc(analysis.summary || '目前沒有足夠公開資料可做產業與個股推論。')}</p><small>分析方式：${esc(data.provider === 'ollama' ? 'Ollama' : 'Gemini 3.8 Flash')} · 個股關聯為研究推論，並須引用下方來源</small></div>${replayPanel}<section><h3>可能受影響的產業 · ${industries.length} 項</h3><div class="global-impact-grid">${industryCards || '<p>目前沒有足夠資料判斷受影響產業。請確認新聞與申報來源是否有資料。</p>'}</div></section><section><h3>有來源支持的相關台股 · ${impactStocks.length} 檔</h3><div class="global-impact-grid">${impactStockCards || '<p>目前沒有足夠證據確認相關個股，不會把手動輸入的股票直接當成受影響標的。</p>'}</div>${invalidCodes}</section>${requestedStockCards ? `<section><h3>你指定檢視的股票（尚未確認與事件相關）</h3><div class="global-impact-grid">${requestedStockCards}</div></section>` : ''}${risks ? `<section><h3>仍需查證</h3><ul class="global-links">${risks}</ul></section>` : ''}<section><h3>SEC 財報與申報</h3>${sec.available ? `<p class="global-source-note">SEC EDGAR · ${esc(sec.company)} · 更新 ${esc(sec.updatedAt || '')}</p>${financials ? `<div class="global-metrics">${financials}</div>` : '<p>目前沒有可用的標準化財務欄位，請查看原始申報。</p>'}<ul class="global-links">${filings || '<li>目前沒有最近申報文件。</li>'}</ul>` : `<p>${esc(sec.reason || '未取得 SEC 資料。')}</p>${research.ticker ? `<a href="https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(research.ticker)}" target="_blank" rel="noopener noreferrer">在 SEC EDGAR 搜尋原始申報 ↗</a>` : ''}`}</section><section><h3>海外新聞 · ${esc(research.headlines?.length || 0)} 則</h3><ul class="global-links">${newsItems || '<li>Google News 目前沒有傳回相關文章。</li>'}</ul></section><small class="global-updated">資料查詢時間：${esc(research.generatedAt || '')} · 新聞為 Google News RSS，財報申報為 SEC EDGAR，台股名單為證交所與櫃買中心；報價優先 Fugle，無法取得時回退至 TWSE／TPEx 最近收盤資料。</small>`;
      const confidenceNote = document.createElement('small');
      confidenceNote.className = 'global-source-note';
      confidenceNote.textContent = '模型信心是定性自評，不是機率；引用來源數量只表示模型引用了幾筆資料，不代表來源品質或因果證明。請點開來源自行核對。';
      $('globalResearchResult').querySelector('.global-result-summary')?.append(confidenceNote);
      $('globalReplayRun')?.addEventListener('click', async () => {
        const replayButton = $('globalReplayRun'), resultNode = $('globalReplayResult');
        const newsIndex = Number($('globalReplayNews').value), selectedNews = replayNews[newsIndex], code = $('globalReplayStock').value;
        if (!selectedNews || !code) return;
        const replayDate = new Date(selectedNews.publishedAt);
        if (Number.isNaN(replayDate.getTime())) { resultNode.textContent = '這則新聞沒有可辨識的發布日期，無法進行歷史回放。'; return; }
        replayButton.disabled = true; replayButton.textContent = '讀取歷史行情…'; resultNode.textContent = '正在比較事件前後的 Fugle 日 K…';
        try {
          const { data: currentSession } = await supabaseClient?.auth.getSession() || {};
          const replayHeaders = { 'Content-Type': 'application/json' };
          if (currentSession?.session?.access_token) replayHeaders.Authorization = `Bearer ${currentSession.session.access_token}`;
          const replayResponse = await fetch('/api/event-replay', { method: 'POST', headers: replayHeaders, cache: 'no-store', body: JSON.stringify({ code, name: $('globalReplayStock').selectedOptions[0]?.textContent || '', eventDate: replayDate.toISOString().slice(0, 10) }) });
          const replayData = await replayResponse.json();
          if (!replayResponse.ok) throw new Error(replayData.error || '歷史回放暫時無法讀取。');
          const rows = replayData.comparisons || [];
          resultNode.innerHTML = `<div class="global-replay-heading"><b>${esc(replayData.code)} ${esc(replayData.name || '')}</b><span>新聞日 ${esc(replayData.eventDate)} · 基準日 ${esc(replayData.baselineDate || '無資料')} · 基準收盤 ${replayData.baseline !== null && replayData.baseline !== undefined ? money(replayData.baseline) : '無資料'}</span></div><div class="global-replay-metrics">${rows.map((row) => `<article><small>事件後 ${row.tradingDays} 個交易日 · ${esc(row.date || '尚未累積')}</small><b class="${Number(row.changePercent) >= 0 ? 'positive' : 'negative'}">${row.close ? `${money(row.close)}　${Number(row.changePercent) >= 0 ? '+' : ''}${Number(row.changePercent).toFixed(2)}%` : '尚未有足夠後續資料'}</b></article>`).join('')}</div><small>${esc(replayData.note || '')} 來源：${esc(replayData.source)}；事件日前後價格比較只呈現時間關聯，不代表因果關係。</small>`;
        } catch (error) { resultNode.textContent = error.message || '歷史回放讀取失敗。'; }
        finally { replayButton.disabled = false; replayButton.textContent = '比較事件前後'; }
      });
      $('globalResearchResult').hidden = false; $('globalResearchStatus').textContent = research.headlines?.length || sec.available ? `已取得 ${research.headlines?.length || 0} 則新聞${sec.available ? '與 SEC 申報資料' : ''}，分析結果會標明來源；請核對原文與推論。` : '新聞與 SEC 來源目前沒有可用資料；畫面已標示資料不足，不會猜測相關產業或個股。'; void refreshAssistantMetrics();
    } catch (error) { $('globalResearchStatus').textContent = error.message || '查詢失敗，請稍後再試。'; }
    finally { button.disabled = false; button.textContent = '分析產業與個股'; }
  });
  function openHolding(item, prefill = null) {
    $('holdingForm').reset(); $('holdingId').value = item?.id || ''; $('holdingDialogTitle').textContent = item ? '編輯持股' : '新增持股';
    const source = item || prefill, market = holdingMarket(source);
    $('holdingMarket').value = market; $('holdingSymbol').value = source?.symbol || ''; $('holdingExchange').value = source?.exchange || ''; $('holdingMicCode').value = source?.micCode || ''; $('holdingCurrency').value = holdingCurrency(source);
    $('holdingMarketInfo').textContent = market === 'tw' ? '台灣持股 · 金額以新台幣顯示' : (marketLabels[market] || '海外') + '持股 · ' + holdingCurrency(source) + ' · 海外行情會以各自幣別計算';
    $('holdingNameHelp').textContent = market === 'tw' ? '請填 4–6 碼股票代號，才能自動比對行情。' : '已從海外個股查詢帶入市場與代號；持有股數與平均成本請自行填寫。';
    $('avgCost').placeholder = market === 'tw' ? '850' : '每股買入成本';
    $('currentPrice').placeholder = market === 'tw' ? '900' : '每股備用價格';
    if (item) { $('stockName').value = item.name; $('shares').value = item.shares; $('avgCost').value = item.cost; $('currentPrice').value = item.price; $('targetWeight').value = item.targetWeight || ''; }
    else if (prefill) { $('stockName').value = (prefill.symbol + ' ' + (prefill.name || '')).trim().slice(0, 80); $('currentPrice').value = prefill.price ?? ''; }
    $('holdingDialog').showModal();
  }
  function openPrice() {
    $('priceForm').reset(); $('priceDate').value = isoToday();
    if (state.holdings.length === 1) $('priceStock').value = state.holdings[0].name;
    $('priceDialog').showModal();
  }
  ['addHolding','emptyAdd'].forEach((id) => $(id).addEventListener('click', () => openHolding()));
  $('addHoldingTop').addEventListener('click', () => {
    const market = $('overviewMarketFilter').value;
    if (market === 'tw') openHolding();
    else {
      $('stockLookupMarket').value = market;
      $('stockLookupMarket').dispatchEvent(new Event('change'));
      showPage('stockDesk', true);
      $('stockLookupInput').focus();
    }
  });
  $('addPrice').addEventListener('click', openPrice);
  setupStockLookupMarkets();
  $('overviewMarketFilter').addEventListener('change', () => { renderOverviewHoldings(); refreshSelectedMarketHoldings(); });
  $('refreshMarketHoldings').addEventListener('click', () => refreshSelectedMarketHoldings(true));
  $('overviewHoldings').addEventListener('click', (event) => {
    const link = event.target.closest('a[href="#stockDesk"]');
    if (!link) return;
    const picker = $('stockLookupMarket');
    picker.value = $('overviewMarketFilter').value;
    picker.dispatchEvent(new Event('change'));
  });
  $('stockLookupForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const query = $('stockLookupInput').value.trim();
    lastInternationalQuote = null;
    if ($('stockLookupMarket').value !== 'tw') { await searchInternationalMarket(query); return; }
    const request = ++stockLookupRequest;
    if (!quoteMap.size) { $('stockLookupResult').innerHTML = '<div class="feature-empty">正在更新全市場行情…</div>'; await refreshQuotes(); }
    if (request === stockLookupRequest) showStockLookup(query);
  });
  $('stockLookupResult').addEventListener('click', (event) => {
    const international = event.target.closest('[data-international-stock]'), back = event.target.closest('[data-back-market-search]');
    const addHolding = event.target.closest('[data-add-international-holding]');
    if (addHolding) {
      const selection = addHolding.dataset.addInternationalHolding;
      const item = selection === 'quote' ? lastInternationalQuote : lastInternationalSearch?.results[Number(selection)];
      if (item) {
        const stock = { ...item, market: item.market || lastInternationalSearch.market };
        const key = internationalQuoteKey(stock);
        const existing = state.holdings.find((holding) => holdingMarket(holding) !== 'tw' && internationalQuoteKey(holding) === key);
        openHolding(existing, { ...stock, price: stock.price ?? holdingQuote(stock)?.price });
      }
      return;
    }
    if (international) { void loadInternationalQuote(lastInternationalSearch?.results?.[Number(international.dataset.internationalStock)]); return; }
    if (back && lastInternationalSearch) { renderInternationalSearch(lastInternationalSearch, lastInternationalSearch.query); return; }
    const add = event.target.closest('[data-watch-add]'), analyze = event.target.closest('[data-stock-analyze]'), fundamental = event.target.closest('[data-fundamentals]');
    if (add && !state.watchlist.includes(add.dataset.watchAdd)) { state.watchlist.push(add.dataset.watchAdd); state.watchlistGroups[add.dataset.watchAdd] = '觀察中'; persist(); renderStockWatchlist(); showStockLookup($('stockLookupInput').value); showToast('已加入「觀察中」分組。'); }
    if (analyze) openStockAnalysis(analyze.dataset.stockAnalyze);
    if (fundamental) loadFundamentals(fundamental.dataset.fundamentals, fundamental);
  });
  $('stockWatchlist').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-watch-remove]'), analyze = event.target.closest('[data-stock-analyze]');
    if (remove) { state.watchlist = state.watchlist.filter((code) => code !== remove.dataset.watchRemove); delete state.watchlistGroups[remove.dataset.watchRemove]; persist(); renderStockWatchlist(); if ($('stockLookupInput').value.trim()) showStockLookup($('stockLookupInput').value); showToast('已從待觀察清單移除。'); }
    if (analyze) openStockAnalysis(analyze.dataset.stockAnalyze);
  });
  $('stockWatchlist').addEventListener('change', (event) => { const select = event.target.closest('[data-watch-group]'); if (!select) return; state.watchlistGroups[select.dataset.watchGroup] = select.value; persist(); renderStockWatchlist(); showToast(`已移至「${select.value}」分組。`); });
  $('watchlistGroupFilter').addEventListener('change', renderStockWatchlist);
  $('refreshQuotes').addEventListener('click', refreshQuotes);
  $('refreshCandidates').addEventListener('click', refreshQuotes);
  $('refreshNews').addEventListener('click', refreshNews);
  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close()));
  $('holdingForm').addEventListener('submit', (event) => {
    event.preventDefault(); const id = $('holdingId').value || crypto.randomUUID();
    const item = {
      id, name: $('stockName').value.trim(), shares: num($('shares').value),
      cost: num($('avgCost').value), price: num($('currentPrice').value), targetWeight: num($('targetWeight').value),
      market: $('holdingMarket').value || 'tw', symbol: $('holdingSymbol').value.trim(),
      exchange: $('holdingExchange').value.trim(), micCode: $('holdingMicCode').value.trim(),
      currency: $('holdingCurrency').value, updated: new Date().toLocaleDateString('zh-TW')
    };
    if (!item.name || item.shares <= 0 || item.cost < 0 || item.price < 0) return showToast('請檢查輸入內容。');
    if (item.market !== 'tw' && (!item.symbol || !(item.exchange || item.micCode) || !holdingCurrency(item))) return showToast('請重新查詢海外股票，確認交易所與幣別。');
    const index = state.holdings.findIndex((row) => row.id === id); if (index >= 0) state.holdings[index] = item; else state.holdings.push(item);
    if (item.market !== 'tw') $('overviewMarketFilter').value = item.market;
    persist(); render(); $('holdingDialog').close(); showToast('持股已儲存。');
    if (item.market === 'tw') { refreshQuotes(); refreshNews(); }
    else refreshSelectedMarketHoldings();
  });
  $('priceForm').addEventListener('submit', (event) => {
    event.preventDefault(); const row = { id: crypto.randomUUID(), stock: $('priceStock').value.trim(), date: $('priceDate').value, price: num($('observedPrice').value), note: $('priceNote').value.trim() };
    if (!row.stock || !row.date || row.price < 0) return showToast('請檢查輸入內容。');
    state.observations.push(row); persist(); render(); $('priceDialog').close(); showToast('價格觀察已新增。');
  });
  $('holdingsBody').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit]'), remove = event.target.closest('[data-delete]');
    if (edit) { const item = state.holdings.find((row) => row.id === edit.dataset.edit); if (item) openHolding(item); }
    if (remove) { const item = state.holdings.find((row) => row.id === remove.dataset.delete); if (item && confirm(`確定刪除「${item.name}」？`)) { state.holdings = state.holdings.filter((row) => row.id !== item.id); persist(); render(); showToast('持股已刪除。'); } }
  });
  $('exportBtn').addEventListener('click', () => { $('backupForm').reset(); $('backupDialog').showModal(); });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  let pendingEncryptedBackup = null;
  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try { const data = JSON.parse(await file.text());
      if (data.format === 'canggu-encrypted-backup') { pendingEncryptedBackup = data; $('importPasswordForm').reset(); $('importPasswordDialog').showModal(); }
      else { applyBackup(data); }
    } catch { showToast('無法讀取備份檔，請確認檔案格式。'); } finally { event.target.value = ''; }
  });
  $('addTransaction').addEventListener('click', () => { $('transactionForm').reset(); $('transactionDate').value = isoToday(); $('transactionType').value = 'buy'; updateTransactionLabel(); $('transactionDialog').showModal(); });
  $('transactionType').addEventListener('change', updateTransactionLabel);
  $('transactionForm').addEventListener('submit', (event) => {
    event.preventDefault(); const type = $('transactionType').value, stock = $('transactionStock').value.trim(), shares = num($('transactionShares').value), price = num($('transactionPrice').value), fees = num($('transactionFees').value), tax = num($('transactionTax').value);
    if (!stock || shares <= 0 || price < 0 || fees < 0 || tax < 0) return showToast('請檢查交易資料。');
    const taiwanHoldings = state.holdings.filter((item) => holdingMarket(item) === 'tw');
    const code = stockCode(stock);
    if (state.holdings.some((item) => holdingMarket(item) !== 'tw' && [item.symbol, item.name].some((name) => name?.toLowerCase() === stock.toLowerCase())) &&
        !taiwanHoldings.some((item) => item.name.toLowerCase() === stock.toLowerCase())) {
      return showToast('交易與股利紀錄適用台股。海外持股可在「我的持股」編輯。');
    }
    let holding = taiwanHoldings.find((item) => code && stockCode(item.name) === code);
    if (!holding) holding = taiwanHoldings.find((item) => item.name.toLowerCase() === stock.toLowerCase());
    let realizedPnl = 0;
    if (type === 'buy') {
      if (!holding) { holding = { id: crypto.randomUUID(), name: stock, shares: 0, cost: 0, price, targetWeight: 0, updated: isoToday() }; state.holdings.push(holding); }
      holding.cost = (num(holding.shares) * num(holding.cost) + shares * price + fees + tax) / (num(holding.shares) + shares); holding.shares = num(holding.shares) + shares; holding.price = price;
    } else if (type === 'sell') {
      if (!holding || shares > num(holding.shares)) return showToast('賣出股數不能多於目前持有股數。');
      realizedPnl = shares * (price - num(holding.cost)) - fees - tax; holding.shares = num(holding.shares) - shares; holding.price = price;
      if (holding.shares <= 0.0000001) state.holdings = state.holdings.filter((item) => item.id !== holding.id);
    }
    state.transactions.push({ id: crypto.randomUUID(), type, date: $('transactionDate').value, stock, shares, price, fees, tax, note: $('transactionNote').value.trim(), realizedPnl });
    persist(); render(); $('transactionDialog').close(); showToast(type === 'buy' ? '買進紀錄已儲存，持股成本已更新。' : type === 'sell' ? '賣出紀錄已儲存。' : '股利紀錄已儲存。');
  });
  $('addAlert').addEventListener('click', () => { $('alertForm').reset(); if (state.holdings.length === 1) $('alertStock').value = state.holdings[0].name; $('alertDialog').showModal(); });
  $('alertForm').addEventListener('submit', (event) => { event.preventDefault(); const stock = $('alertStock').value.trim(), target = num($('alertTarget').value); if (!stock || target <= 0) return showToast('請輸入股票和有效目標價。'); state.alerts.push({ id: crypto.randomUUID(), stock, direction: $('alertDirection').value, target, active: true, createdAt: isoToday() }); persist(); renderAlerts(); $('alertDialog').close(); showToast('價格提醒已儲存於此裝置。'); });
  $('alertsContent').addEventListener('click', (event) => { const button = event.target.closest('[data-delete-alert]'); if (button) { state.alerts = state.alerts.filter((row) => row.id !== button.dataset.deleteAlert); persist(); renderAlerts(); } });
  $('addEvent').addEventListener('click', () => { $('eventForm').reset(); $('eventDate').value = isoToday(); if (state.holdings.length === 1) $('eventStock').value = state.holdings[0].name; $('eventDialog').showModal(); });
  $('eventForm').addEventListener('submit', (event) => { event.preventDefault(); const row = { id: crypto.randomUUID(), title: $('eventTitle').value.trim(), type: $('eventType').value, date: $('eventDate').value, stock: $('eventStock').value.trim(), note: $('eventNoteInput').value.trim() }; if (!row.title || !row.date) return showToast('請輸入事件名稱和日期。'); state.events.push(row); persist(); renderEvents(); $('eventDialog').close(); showToast('公司事件已儲存並加入同步。'); });
  $('eventsContent').addEventListener('click', (event) => { const button = event.target.closest('[data-delete-event]'); if (!button) return; state.events = state.events.filter((row) => row.id !== button.dataset.deleteEvent); persist(); renderEvents(); showToast('事件已刪除。'); });
  $('eyeModeToggle').addEventListener('click', () => { state.settings.eyeComfort = !state.settings.eyeComfort; applyEyeComfort(); persist(); showToast(state.settings.eyeComfort ? '已切換暖色護眼配色。' : '已切回標準配色。'); });
  $('addJournal').addEventListener('click', () => { $('journalForm').reset(); $('journalDialog').showModal(); });
  $('journalForm').addEventListener('submit', (event) => { event.preventDefault(); state.journal.unshift({ id: crypto.randomUUID(), title: $('journalTitle').value.trim(), stock: $('journalStock').value.trim(), thesis: $('journalThesis').value.trim(), risk: $('journalRisk').value.trim(), reviewDate: $('journalReviewDate').value, createdAt: isoToday(), done: false }); persist(); renderJournal(); $('journalDialog').close(); showToast('投資日誌已儲存於此裝置。'); });
  $('journalContent').addEventListener('click', (event) => { const done = event.target.closest('[data-complete-journal]'), remove = event.target.closest('[data-delete-journal]'); if (done) { const row = state.journal.find((item) => item.id === done.dataset.completeJournal); if (row) row.done = !row.done; persist(); renderJournal(); } if (remove) { state.journal = state.journal.filter((item) => item.id !== remove.dataset.deleteJournal); persist(); renderJournal(); } });
  $('backupForm').addEventListener('submit', async (event) => { event.preventDefault(); const password = $('backupPassword').value; if (password !== $('backupPasswordConfirm').value) return showToast('兩次輸入的密碼不一致。'); try { const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), key = await backupKey(password, salt); const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ ...state, exportedAt: new Date().toISOString(), schema: 2 }))); const file = { format: 'canggu-encrypted-backup', version: 1, algorithm: 'AES-GCM', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000 }, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }; downloadJson(file, `端股加密備份-${isoToday()}.json`); $('backupDialog').close(); $('backupForm').reset(); showToast('加密備份已下載；請妥善保存密碼與檔案。'); } catch { showToast('加密失敗，請使用本機網頁重新操作。'); } });
  $('importPasswordForm').addEventListener('submit', async (event) => { event.preventDefault(); try { const file = pendingEncryptedBackup, key = await backupKey($('importPassword').value, fromBase64(file.salt)); const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(file.iv) }, key, fromBase64(file.data)); const data = JSON.parse(new TextDecoder().decode(plain)); if (applyBackup(data)) { $('importPasswordDialog').close(); $('importPasswordForm').reset(); pendingEncryptedBackup = null; } } catch { showToast('密碼錯誤或備份檔已損毀，請再試一次。'); } });
  let fugleConfigured = false, trendData = null, heldStockData = null;
  async function fugleFetch(url) {
    const { data, error } = await supabaseClient?.auth.getSession() || {};
    if (error || !data?.session?.access_token) throw new Error('請先登入後再使用 Fugle 行情資料。');
    return fetch(url, { cache: 'no-store', headers: { Authorization: `Bearer ${data.session.access_token}` } });
  }
  async function checkFugleStatus() {
    try { const response = await fugleFetch('/api/fugle/status'), data = await response.json(); fugleConfigured = Boolean(data.configured); $('fugleBadge').textContent = fugleConfigured ? 'Fugle 已設定' : '尚未設定 API 金鑰'; $('fugleBadge').classList.toggle('source-warning', !fugleConfigured); }
    catch { $('fugleBadge').textContent = '連線設定無法讀取'; }
    if (!fugleConfigured) {
      const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
      $('trendStatus').innerHTML = isLocal
        ? `尚未設定 Fugle API 金鑰。<a href="https://developer.fugle.tw/" target="_blank" rel="noopener noreferrer">前往 Fugle 申請</a>後，將 <code>FUGLE_API_KEY=你的金鑰</code> 存到 Windows 本機檔案 <code>%LOCALAPPDATA%\\Canggu\\config.env</code>，再重新啟動 run_local.bat。不要把金鑰放進 OneDrive 專案資料夾或網頁程式碼。`
        : '網站管理者尚未在伺服器設定 Fugle API 金鑰。金鑰僅應存放在伺服器環境變數，請勿輸入網頁或貼到聊天。';
    }
  }
  const assistantHistory = [];
  function renderAssistantMetrics(data) {
    let node = $('assistantMetrics');
    if (!node) { node = document.createElement('div'); node.id = 'assistantMetrics'; node.className = 'assistant-status'; $('assistantStatus').after(node); }
    const provider = $('assistantProvider').value;
    const metric = data?.aiMetrics?.[provider];
    if (!metric?.total) { node.textContent = 'AI 服務統計：目前尚無本次啟動期間的模型請求紀錄。'; return; }
    node.textContent = `${provider === 'ollama' ? 'Ollama' : 'Gemini'} 服務統計（伺服器本次啟動）：${metric.total} 次，成功 ${metric.successRatePercent}%，平均 ${metric.averageDurationMs.toLocaleString('zh-TW')} 毫秒${metric.lastErrorCode ? `；最近錯誤代碼 ${metric.lastErrorCode}` : ''}。重啟伺服器後歸零。`;
  }
  async function refreshAssistantMetrics() {
    try { const response = await fetch('/api/assistant/status', { cache: 'no-store' }); if (response.ok) renderAssistantMetrics(await response.json()); } catch {}
  }
  function formatAssistantText(value) {
    const currencyMarker = '\uE000';
    return String(value || '')
      .replace(/\\text\{([^{}]*)\}/g, '$1')
      .replace(/\\mathrm\{([^{}]*)\}/g, '$1')
      .replace(/\\times\b/g, ' × ')
      .replace(/\\cdot\b/g, ' × ')
      .replace(/\\div\b/g, ' ÷ ')
      .replace(/\\approx\b/g, '約 ')
      .replace(/\\geq\b/g, '≥ ')
      .replace(/\\leq\b/g, '≤ ')
      .replace(/\\%/g, '%')
      .replace(/\\\$/g, currencyMarker)
      .replaceAll('\\(', '').replaceAll('\\)', '')
      .replaceAll('\\[', '').replaceAll('\\]', '')
      .replaceAll('\\{', '').replaceAll('\\}', '')
      .replace(/\$\$?/g, '')
      .replaceAll(currencyMarker, '$')
      .replace(/^\s*---+\s*$/gm, '')
      .replace(/^\s*#{1,6}\s*(.+)$/gm, '【$1】')
      .replace(/\*\*(.*?)\*\*/gs, '$1')
      .replace(/__(.*?)__/gs, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function addAssistantMessage(role, content) {
    const list = $('assistantMessages');
    list.querySelector('.assistant-empty')?.remove();
    const bubble = document.createElement('div');
    bubble.className = `assistant-message assistant-message-${role}`;
    const label = document.createElement('b'); label.textContent = role === 'user' ? '你' : '助理';
    const text = document.createElement('p'); text.textContent = formatAssistantText(content);
    bubble.append(label, text); list.append(bubble); list.scrollTop = list.scrollHeight;
    return bubble;
  }
  let assistantProviderAvailability = { fugle: false, ollama: false, gemini: false };
  function updateAssistantProviderCopy() {
    const provider = $('assistantProvider').value, useOllama = provider === 'ollama', useFugle = provider === 'fugle';
    const name = useFugle ? 'Fugle 行情服務' : useOllama ? 'Ollama' : 'Gemini';
    const privacy = document.querySelector('.assistant-privacy p'), consent = document.querySelector('.assistant-card .assistant-consent');
    if (privacy) privacy.textContent = useFugle
      ? '勾選同意並送出後，系統只會把股票代號傳給 Fugle 查詢報價與歷史日 K，再由程式產生固定技術摘要。你的問題文字、近期對話、持倉、成本和損益都不會傳給 Fugle 或 AI。此模式不能回答一般聊天問題。'
      : `勾選同意並送出後，主題、問題與最近 10 則對話會交給 ${name}。填股票代號時，Fugle 報價和歷史日 K 指標也會交給 ${name}。持倉、成本、損益不會自動讀取；對話不會保存在帳號或瀏覽器。${useOllama ? '資料會送至目前設定的 Ollama 服務。' : 'Gemini 是 Google 雲端服務，請勿輸入不願交給 Google 的資料。'}`;
    if (consent) consent.lastChild.textContent = useFugle
      ? '我已閱讀，並同意只將股票代號送給 Fugle 查詢行情；不傳送問題文字或對話'
      : `我已閱讀，並同意將本次主題、問題、近期對話及填入代號查到的行情資料（可能包含交易所最近收盤資料）傳給 ${name}`;
    const assistantInput = $('assistantInput');
    assistantInput.disabled = useFugle;
    assistantInput.required = !useFugle;
    assistantInput.placeholder = useFugle ? 'Fugle 摘要模式不使用問題文字；填入股票代號後即可查詢。' : '輸入你的問題（最多 2,000 字）';
    $('assistantSend').textContent = useFugle ? '查詢行情摘要' : '送出問題';
    $('assistantBadge').textContent = assistantProviderAvailability[provider] ? `${name}${useOllama ? ` · ${$('assistantBadge').dataset.ollamaModel || '本機模型'}` : ''} 已設定` : `${name} 尚未設定`;
    $('assistantBadge').classList.toggle('source-warning', !assistantProviderAvailability[provider]);
  }
  async function checkAssistantStatus() {
    try {
      const response = await fetch('/api/assistant/status', { cache: 'no-store' }), data = await response.json();
      renderAssistantMetrics(data);
      assistantProviderAvailability = data.providers || { fugle: false, ollama: data.provider === 'ollama' && data.configured, gemini: data.provider === 'gemini' && data.configured };
      $('assistantBadge').dataset.ollamaModel = data.ollamaModel || (data.provider === 'ollama' ? data.model : '') || '本機模型';
      const select = $('assistantProvider');
      [...select.options].forEach((option) => { option.disabled = !assistantProviderAvailability[option.value]; });
      const ollamaAssistantOption = select.querySelector('option[value="ollama"]');
      ollamaAssistantOption.textContent = assistantProviderAvailability.ollama ? `Ollama（${$('assistantBadge').dataset.ollamaModel}）` : 'Ollama（尚未設定）';
      $('globalAiProvider').querySelector('option[value="ollama"]').disabled = !assistantProviderAvailability.ollama;
      $('globalAiProvider').querySelector('option[value="gemini"]').disabled = !assistantProviderAvailability.gemini;
      if (!assistantProviderAvailability[$('globalAiProvider').value]) $('globalAiProvider').value = assistantProviderAvailability.gemini ? 'gemini' : 'ollama';
      const updateGlobalResearchStatus = () => {
        const provider = $('globalAiProvider').value;
        $('globalResearchStatus').textContent = provider === 'gemini'
          ? assistantProviderAvailability.gemini ? 'Gemini 3.8 Flash 已設定。輸入海外公司名稱即可分析可能受影響的台灣產業與個股；台股代號可以留白。' : 'Gemini 尚未設定 GEMINI_API_KEY，請到 Render 的端股 Web Service → Environment 設定金鑰，再重新部署。'
          : assistantProviderAvailability.ollama ? 'Ollama 已設定。輸入海外公司名稱即可分析可能受影響的產業與個股；本機模型會使用成交較活躍的上市櫃公司名單。' : 'Ollama 尚未設定或目前無法使用，請選擇已設定的 Gemini。';
      };
      $('globalAiProvider').addEventListener('change', updateGlobalResearchStatus);
      updateGlobalResearchStatus();
      const ollamaTopupOption = $('topupMode').querySelector('option[value="ollama"]');
      ollamaTopupOption.disabled = !assistantProviderAvailability.ollama;
      if (!assistantProviderAvailability.ollama) ollamaTopupOption.textContent = 'Ollama 分析（尚未設定）';
      if (ollamaTopupOption.disabled && $('topupMode').value === 'ollama') { $('topupMode').value = 'fugle'; updateTopupMode(); }
      if (!assistantProviderAvailability[select.value]) select.value = assistantProviderAvailability[data.provider] ? data.provider : assistantProviderAvailability.ollama ? 'ollama' : assistantProviderAvailability.gemini ? 'gemini' : 'fugle';
      select.addEventListener('change', () => { updateAssistantProviderCopy(); void refreshAssistantMetrics(); });
      updateAssistantProviderCopy();
      if (!assistantProviderAvailability.ollama && !assistantProviderAvailability.gemini && !assistantProviderAvailability.fugle) $('assistantStatus').textContent = '尚未設定 Fugle 或可用的助理服務。';
    } catch { $('assistantBadge').textContent = '助理設定無法讀取'; $('assistantStatus').textContent = '目前無法連線到助理設定，請重新整理後再試。'; }
  }
  $('assistantForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const provider = $('assistantProvider').value;
    const symbol = $('assistantSymbol').value.trim();
    const question = provider === 'fugle' ? `查詢 ${symbol} 行情與技術摘要` : $('assistantInput').value.trim();
    if (!question) return;
    if (provider === 'fugle' && !/^\d{4,6}$/.test(symbol)) { $('assistantStatus').textContent = 'Fugle 摘要需要 4–6 位數股票代號，例如 2330。'; $('assistantSymbol').focus(); return; }
    if (!$('assistantConsent').checked) { $('assistantStatus').textContent = '請先閱讀並勾選資料傳送同意，再送出問題。'; $('assistantConsent').focus(); return; }
    $('assistantConsent').checked = false;
    const button = $('assistantSend'); button.disabled = true; $('assistantStatus').textContent = '助理正在整理回答…';
    addAssistantMessage('user', question); $('assistantInput').value = '';
    assistantHistory.push({ role: 'user', content: question });
    const pending = addAssistantMessage('assistant', '正在思考…');
    try {
      const { data } = await supabaseClient?.auth.getSession() || {};
      const headers = { 'Content-Type': 'application/json' };
      if (data?.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
      const response = await fetch('/api/assistant', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ topic: $('assistantTopic').value, provider, symbol, messages: provider === 'fugle' ? [] : assistantHistory.slice(-10) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '助理暫時無法回答，請稍後再試。');
      pending.querySelector('p').textContent = formatAssistantText(result.answer);
      assistantHistory.push({ role: 'assistant', content: result.answer });
      $('assistantStatus').textContent = '';
      void refreshAssistantMetrics();
    } catch (error) {
      pending.remove(); assistantHistory.pop(); addAssistantMessage('assistant', error.message || '連線失敗，請稍後再試。'); $('assistantStatus').textContent = '這次沒有取得回答；你可以稍後重新送出。'; void refreshAssistantMetrics();
    } finally { button.disabled = false; $('assistantInput').focus(); }
  });
  checkAssistantStatus();
  let topupRequest = 0;
  function renderTopupHoldingOptions() {
    const picker = $('topupHolding'), selected = picker.value;
    picker.innerHTML = '<option value="">自行輸入台股</option>' + state.holdings.map((item) =>
      `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(holdingCurrency(item))}</option>`).join('');
    if (state.holdings.some((item) => item.id === selected)) picker.value = selected;
    else if (selected) selectTopupHolding(null);
  }
  function selectTopupHolding(item) {
    topupRequest += 1;
    $('topupHolding').value = item?.id || '';
    $('topupSymbol').readOnly = Boolean(item);
    $('topupMode').disabled = false;
    const holdingMode = $('topupMode').querySelector('[value="holding"]');
    holdingMode.hidden = !item;
    $('topupMode').querySelector('[value="fugle"]').disabled = Boolean(item && holdingMarket(item) !== 'tw');
    $('topupMode').querySelector('[value="ollama"]').disabled = Boolean(item && holdingMarket(item) !== 'tw');
    $('topupSymbol').value = item ? item.symbol || stockCode(item.name) || item.name : '';
    $('topupAverageCost').value = item?.cost ?? '';
    $('topupCurrentShares').value = item?.shares ?? '';
    $('topupBudget').value = '';
    $('topupShareUnit').value = '1';
    $('topupConsent').checked = false;
    $('topupResult').hidden = true;
    $('addTopupPriceAlert').disabled = true;
    $('topupSubmit').disabled = false;
    const overseas = Boolean(item && holdingMarket(item) !== 'tw');
    $('topupShareUnit').querySelector('[value="1000"]').disabled = overseas;
    $('topupMode').value = item ? 'holding' : 'fugle';
    $('topupFeeRate').value = overseas ? '0' : '0.1425';
    $('topupTaxRate').value = overseas ? '0' : '0.3';
    $('topupHoldingInfo').textContent = item ? `${marketLabels[holdingMarket(item)]} · ${holdingCurrency(item)}${overseas ? ' · 請填寫你的券商費率' : ''}` : '';
    $('topupStatus').textContent = item ? '持有股數與成本已帶入。請輸入加碼預算。' : '填寫股數、成本及預算開始試算。';
    $('addTopupReviewReminder').disabled = overseas;
    updateTopupMode();
  }
  $('topupHolding').addEventListener('change', () => selectTopupHolding(state.holdings.find((item) => item.id === $('topupHolding').value)));
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-simulate-holding]');
    if (!button) return;
    const item = state.holdings.find((holding) => holding.id === button.dataset.simulateHolding);
    if (!item) return;
    showPage('topup', true);
    selectTopupHolding(item);
    $('topupBudget').focus();
  });
  function updateTopupMode() {
    const mode = $('topupMode').value, useOllama = mode === 'ollama';
    $('topupConsentRow').hidden = !useOllama;
    $('topupSubmit').textContent = mode === 'holding' ? '試算持倉' : '查行情並試算';
    $('topupModeHint').textContent = mode === 'holding'
      ? '以持倉最近取得的報價或備用價格估算，並使用持倉原幣。'
      : useOllama
      ? '優先用 Fugle 取得價格與歷史日 K；Fugle 報價失敗時改用 TWSE／TPEx 最近收盤價，再由 Ollama 整理趨勢與風險。'
      : '優先使用 Fugle 行情；無法取得時改用 TWSE／TPEx 最近收盤價，計算預算股數與加碼後均價。備援收盤價不是盤中即時價。';
  }
  $('topupMode').addEventListener('change', updateTopupMode);
  function topupScenarioValues(item, buyPrice) {
    return calculateTopup(item, { buyPrice: Number(buyPrice) || item.price });
  }
  function topupScenarioMarkup(item, selectedPrice = item.price) {
    const money = (value) => formatScenarioMoney(value, item.currency);
    const quotePrice = Number(item.price), step = quotePrice < 1 ? 0.0001 : 0.01;
    const minimum = Math.max(step, Math.round(quotePrice * 0.8 / step) * step);
    const maximum = Math.max(minimum + step, Math.round(quotePrice * 1.2 / step) * step);
    const precision = step < 0.01 ? 4 : 2;
    const scenario = topupScenarioValues(item, selectedPrice);
    const pnlClass = scenario.pnl < 0 ? 'negative' : 'positive';
    const comparison = [...new Set([minimum, quotePrice, maximum])].map((buyPrice) => {
      const option = topupScenarioValues(item, buyPrice), className = option.pnl < 0 ? 'negative' : 'positive';
      return `<article><small>假設買入 ${money(buyPrice)}</small><b>${option.shares.toLocaleString('zh-TW')} 股</b><span>均價 ${money(option.averageCost)}／股</span><strong class="${className}">${money(option.pnl)}</strong></article>`;
    }).join('');
    return `<section class="topup-scenario"><div class="topup-scenario-heading"><div><b>買入價格情境拉桿</b><small>以下為 ${esc(item.quoteSource || '目前報價')} 價格上下 20% 的假設區間；基準價格固定為 ${money(quotePrice)}，調整後即時重算。</small></div><strong data-scenario-price>${money(scenario.price)}<small>假設加碼買入價／股</small></strong></div><label class="topup-slider-label" for="topupPriceSlider"><span>${money(minimum)}</span><input id="topupPriceSlider" type="range" min="${minimum.toFixed(precision)}" max="${maximum.toFixed(precision)}" step="${step}" value="${scenario.price.toFixed(precision)}" aria-label="調整假設加碼買入價"><span>${money(maximum)}</span></label><div class="topup-scenario-grid"><article><small>預算可買股數</small><b data-scenario-shares>${scenario.shares.toLocaleString('zh-TW')} 股</b></article><article><small>加碼後均價（未含交易費）</small><b data-scenario-average>${money(scenario.averageCost)}／股</b></article><article><small>以 ${esc(item.quoteSource || '目前報價')} 價格估算淨損益</small><b data-scenario-pnl class="${pnlClass}">${money(scenario.pnl)}（${scenario.pnlPercent >= 0 ? '+' : ''}${scenario.pnlPercent.toFixed(2)}%）</b></article><article><small>估算損益兩平價</small><b data-scenario-breakeven>${money(scenario.breakEven)}／股</b></article><article><small>估計交易成本</small><b data-scenario-fees>${money(scenario.transactionCosts)}</b></article><article><small>加碼含費支出／預算餘額</small><b data-scenario-budget>${money(scenario.purchaseTotal)}／${money(scenario.remaining)}</b></article></div>${topupBreakevenMarkup(item, scenario)}<button type="button" id="saveTopupPriceAlert" class="secondary-button topup-price-alert-button" ${item.market !== 'tw' ? 'hidden' : ''}>將 ${money(scenario.price)} 設為到價觀察提醒</button>${topupScenarioChart(item, minimum, maximum, scenario.price)}<div class="topup-comparisons"><b>低／現價／高三種買入價格比較</b><div>${comparison}</div></div><small class="topup-scenario-note">淨損益已估算加碼買進手續費、按目前市值估算的賣出手續費與證交稅。現有平均成本視為既有成本基礎；券商最低手續費、個人實際折扣與滑價可能造成差異。</small></section>`;
  }
  function topupBreakevenMarkup(item, scenario) {
    const money = (value) => formatScenarioMoney(value, item.currency);
    const rates = [0.03, 0.06, 0.10], current = Number(item.price), breakEven = Number(scenario.breakEven);
    const rows = rates.map((rate) => {
      if (breakEven <= current) return `<article><small>假設年報酬 ${(rate * 100).toFixed(0)}%</small><b>現價已達估算損平線</b><span>僅按此情境與目前報價判斷</span></article>`;
      const months = Math.ceil(12 * Math.log(breakEven / current) / Math.log(1 + rate));
      if (!Number.isFinite(months) || months > 1200) return `<article><small>假設年報酬 ${(rate * 100).toFixed(0)}%</small><b>時間過長，暫不估算</b><span>損平價 ${money(breakEven)}</span></article>`;
      const date = new Date(); date.setMonth(date.getMonth() + months);
      return `<article><small>假設年報酬 ${(rate * 100).toFixed(0)}%</small><b>約 ${months < 12 ? `${months} 個月` : `${(months / 12).toFixed(1)} 年`}</b><span>約 ${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}；損平價 ${money(breakEven)}</span></article>`;
    }).join('');
    return `<div class="topup-breakeven"><b>回本時間情境（從目前報價起算）</b><div>${rows}</div><small>假設價格每年固定上漲 3%／6%／10%，未計入未來加碼、股利、價格波動或其他成本；這是數學情境，不是預測或保證。</small></div>`;
  }
  function topupScenarioChart(item, minimum, maximum, selectedPrice) {
    const money = (value) => formatScenarioMoney(value, item.currency);
    const points = Array.from({ length: 41 }, (_, index) => {
      const pointPrice = minimum + (maximum - minimum) * index / 40;
      return { pnl: topupScenarioValues(item, pointPrice).pnl };
    });
    const minY = Math.min(0, ...points.map((point) => point.pnl)), maxY = Math.max(0, ...points.map((point) => point.pnl));
    const spread = Math.max(1, maxY - minY), x = (index) => 38 + index / 40 * 544, y = (value) => 12 + (maxY - value) / spread * 116;
    const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.pnl).toFixed(1)}`).join(' ');
    const selectedRatio = Math.max(0, Math.min(1, (Number(selectedPrice) - minimum) / (maximum - minimum)));
    const markerX = 38 + selectedRatio * 544;
    const markerPnl = topupScenarioValues(item, minimum + selectedRatio * (maximum - minimum)).pnl;
    const markerY = y(markerPnl);
    return `<div class="topup-chart-wrap"><svg class="topup-scenario-chart" viewBox="0 0 620 160" role="img" aria-label="假設加碼買入價與估算未實現損益關係圖"><line x1="38" x2="582" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="topup-chart-zero"/><path d="${path}" class="topup-chart-line"/><line x1="${markerX.toFixed(1)}" x2="${markerX.toFixed(1)}" y1="12" y2="128" class="topup-chart-marker-line"/><circle cx="${markerX.toFixed(1)}" cy="${markerY.toFixed(1)}" r="5" class="topup-chart-marker ${markerPnl < 0 ? 'negative' : 'positive'}"/><text x="38" y="151">${money(minimum)}</text><text x="582" y="151" text-anchor="end">${money(maximum)}</text><text x="38" y="10">${money(maxY)}</text><text x="582" y="10" text-anchor="end">${money(minY)}</text></svg><small>橫軸：假設加碼買入價　·　縱軸：以 ${esc(item.quoteSource || '目前報價')} 價格估算的總未實現損益</small></div>`;
  }
  function updateTopupScenario(item, selectedPrice) {
    const money = (value) => formatScenarioMoney(value, item.currency);
    const section = $('topupPriceSlider')?.closest('.topup-scenario');
    if (!section) return;
    const minimum = Number($('topupPriceSlider').min), maximum = Number($('topupPriceSlider').max), scenario = topupScenarioValues(item, selectedPrice);
    section.querySelector('[data-scenario-price]').innerHTML = `${money(scenario.price)}<small>假設加碼買入價／股</small>`;
    section.querySelector('[data-scenario-shares]').textContent = `${scenario.shares.toLocaleString('zh-TW')} 股`;
    section.querySelector('[data-scenario-average]').textContent = `${money(scenario.averageCost)}／股`;
    const pnl = section.querySelector('[data-scenario-pnl]');
    pnl.textContent = `${money(scenario.pnl)}（${scenario.pnlPercent >= 0 ? '+' : ''}${scenario.pnlPercent.toFixed(2)}%）`;
    pnl.classList.toggle('negative', scenario.pnl < 0); pnl.classList.toggle('positive', scenario.pnl >= 0);
    section.querySelector('[data-scenario-budget]').textContent = `${money(scenario.purchaseTotal)}／${money(scenario.remaining)}`;
    section.querySelector('[data-scenario-breakeven]').textContent = `${money(scenario.breakEven)}／股`;
    section.querySelector('[data-scenario-fees]').textContent = money(scenario.transactionCosts);
    section.querySelector('.topup-breakeven').outerHTML = topupBreakevenMarkup(item, scenario);
    const alertButton = section.querySelector('#saveTopupPriceAlert');
    if (alertButton) alertButton.textContent = `將 ${money(scenario.price)} 設為到價觀察提醒`;
    section.querySelector('.topup-chart-wrap').outerHTML = topupScenarioChart(item, minimum, maximum, scenario.price);
  }
  function scenarioPortfolio(item, holding) {
    if (!holding) return null;
    const portfolio = { otherSameSymbolShares: 0, otherStockValue: 0 };
    const key = holdingMarket(holding) === 'tw' ? stockCode(holding.name) : internationalQuoteKey(holding);
    for (const entry of state.holdings) {
      if (entry.id === holding.id || holdingMarket(entry) !== holdingMarket(holding) || holdingCurrency(entry) !== item.currency) continue;
      const entryKey = holdingMarket(entry) === 'tw' ? stockCode(entry.name) : internationalQuoteKey(entry);
      if (key && entryKey === key) portfolio.otherSameSymbolShares += num(entry.shares);
      else portfolio.otherStockValue += livePrice(entry) * num(entry.shares);
    }
    return portfolio;
  }
  function saveScenarioDraft(item, scenario) {
    const money = (value) => formatScenarioMoney(value, item.currency);
    const rows = [
      `參考價格 ${money(item.price)}／股（${item.quoteSource || '持倉價格'}，${item.quoteDate || item.quoteUpdatedAt || '日期未提供'}）`,
      `原持有 ${item.currentShares} 股，平均成本 ${money(item.averageCost)}／股，預算 ${money(item.budget)}。`,
      `假設以 ${money(scenario.buyPrice)} 買入，未來股價 ${money(scenario.futurePrice)}（${pct(scenario.change)}）。`,
      `不加碼估算淨損益 ${money(scenario.baseline.pnl)}。加碼 ${scenario.added.shares} 股、含費支出 ${money(scenario.added.purchaseTotal)}，估算淨損益 ${money(scenario.added.pnl)}。`,
      `加碼前後損益兩平價 ${money(scenario.baseline.breakEven)} → ${money(scenario.added.breakEven)}。`
    ];
    if (scenario.baselineWeight != null && scenario.addedWeight != null) rows.push(`同市場、同幣別持倉比重 ${scenario.baselineWeight.toFixed(1)}% → ${scenario.addedWeight.toFixed(1)}%。`);
    $('journalForm').reset();
    $('journalTitle').value = (`${item.symbol} 持倉情境試算`).slice(0, 80);
    $('journalStock').value = (`${item.symbol} ${item.name || ''}`).trim().slice(0, 30);
    $('journalThesis').value = rows.join('\n');
    $('journalDialog').showModal();
  }
  function bindTopupScenario(item, holding) {
    const slider = $('topupPriceSlider');
    if (!slider) return;
    const comparison = mountScenarioComparison($('topupComparison'), {
      item, buyPrice: () => Number(slider.value), portfolio: scenarioPortfolio(item, holding),
      onSave: (scenario) => saveScenarioDraft(item, scenario)
    });
    slider.addEventListener('input', () => {
      updateTopupScenario(item, Number(slider.value));
      comparison.refresh();
    });
    $('saveTopupPriceAlert')?.addEventListener('click', () => {
      const target = Number(slider.value), stock = `${item.symbol} ${item.name || ''}`.trim();
      state.alerts.push({ id: crypto.randomUUID(), stock, direction: 'below', target, active: true, createdAt: isoToday(), source: 'topup' });
      persist(); renderAlerts(); showToast(`已設定 ${money(target)} 到價觀察提醒；到價後請重新檢視風險。`);
    });
  }
  function addCalendarMonths(date, months) { const source = new Date(`${date}T12:00:00`), day = source.getDate(); source.setDate(1); source.setMonth(source.getMonth() + months); source.setDate(Math.min(day, new Date(source.getFullYear(), source.getMonth() + 1, 0).getDate())); return `${source.getFullYear()}-${String(source.getMonth() + 1).padStart(2, '0')}-${String(source.getDate()).padStart(2, '0')}`; }
  function reminderNextDate(fromDate, frequency) { if (frequency !== 'weekly') return addCalendarMonths(fromDate, frequency === 'quarterly' ? 3 : 1); const d = new Date(`${fromDate}T12:00:00`); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function renderTopupReviewReminders() {
    const list = $('topupReviewReminderList'); if (!list) return;
    const rows = state.settings.topupReviewReminders || [];
    list.innerHTML = rows.length ? rows.map((row) => `<article><span><b>${esc(row.stock)}</b><small>${row.frequency === 'weekly' ? '每週' : row.frequency === 'quarterly' ? '每季' : '每月'}檢視 · 下次 ${esc(row.nextDueDate)}</small></span><button type="button" class="row-action" data-delete-topup-reminder="${esc(row.id)}" aria-label="刪除檢視提醒">×</button></article>`).join('') : '<small>尚未設定定期檢視提醒。</small>';
  }
  function checkTopupReviewReminders() {
    let changed = false; const due = [], today = isoToday();
    (state.settings.topupReviewReminders || []).forEach((row) => {
      if (row.nextDueDate > today || row.lastNotifiedOn === today) return;
      due.push(row.stock); row.lastNotifiedOn = today;
      do { row.nextDueDate = reminderNextDate(row.nextDueDate, row.frequency); } while (row.nextDueDate <= today);
      changed = true;
    });
    if (changed) { persist(); renderTopupReviewReminders(); showToast(`持倉檢視提醒到期：${[...new Set(due)].join('、')}。請重新檢視預算與風險。`); }
  }
  $('addTopupReviewReminder')?.addEventListener('click', () => {
    const symbol = $('topupSymbol').value.trim(), frequency = $('topupReviewFrequency').value;
    if (!symbol) { $('topupSymbol').focus(); return showToast('請先輸入股票代號或名稱。'); }
    const existing = (state.settings.topupReviewReminders || []).some((row) => row.stock.toLowerCase() === symbol.toLowerCase() && row.frequency === frequency);
    if (existing) return showToast('這檔股票已設定相同週期的檢視提醒。');
    const nextDueDate = reminderNextDate(isoToday(), frequency);
    state.settings.topupReviewReminders.push({ id: crypto.randomUUID(), stock: symbol, frequency, nextDueDate });
    persist(); renderTopupReviewReminders(); showToast(`已設定${frequency === 'weekly' ? '每週' : frequency === 'quarterly' ? '每季' : '每月'}檢視提醒，首次提醒日期 ${nextDueDate}。`);
  });
  $('topupReviewReminderList')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-topup-reminder]'); if (!button) return;
    state.settings.topupReviewReminders = state.settings.topupReviewReminders.filter((row) => row.id !== button.dataset.deleteTopupReminder);
    persist(); renderTopupReviewReminders();
  });
  $('addTopupPriceAlert')?.addEventListener('click', () => $('saveTopupPriceAlert')?.click());
  $('topupReviewReminderList') && renderTopupReviewReminders();
  window.addEventListener('focus', () => { checkTopupReviewReminders(); renderTopupReviewReminders(); });
  setInterval(checkTopupReviewReminders, 60000);
  $('topupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = $('topupMode').value, aiConsent = $('topupConsent').checked;
    if (mode === 'ollama' && !aiConsent) { $('topupStatus').textContent = '使用 Ollama 分析前，請先閱讀並勾選資料傳送同意。'; $('topupConsent').focus(); return; }
    const commissionRatePercent = Number($('topupFeeRate').value), sellTaxRatePercent = Number($('topupTaxRate').value);
    if (!Number.isFinite(commissionRatePercent) || commissionRatePercent < 0 || commissionRatePercent > 1 || !Number.isFinite(sellTaxRatePercent) || sellTaxRatePercent < 0 || sellTaxRatePercent > 5) { $('topupStatus').textContent = '請確認手續費率為 0–1%，賣出證交稅率為 0–5%。'; return; }
    const request = ++topupRequest;
    const holding = state.holdings.find((item) => item.id === $('topupHolding').value);
    const input = {
      symbolOrName: $('topupSymbol').value.trim(), averageCost: Number($('topupAverageCost').value),
      currentShares: Number($('topupCurrentShares').value), budget: Number($('topupBudget').value),
      shareUnit: Number($('topupShareUnit').value), commissionRatePercent, sellTaxRatePercent
    };
    const button = $('topupSubmit'); button.disabled = true; button.textContent = '正在計算…';
    $('topupStatus').textContent = '正在取得可用行情，整理加碼股數…'; $('topupResult').hidden = true;
    $('topupConsent').checked = false; $('addTopupPriceAlert').disabled = true;
    try {
      let dataResult;
      if (mode === 'holding') {
        if (!holding) throw new Error('請先選擇一筆持股。');
        const price = livePrice(holding), quote = holdingQuote(holding);
        if (!(price >= 0.0001)) throw new Error('請先在「我的持股」填寫有效的備用價格，或更新行情。');
        dataResult = { mode, result: topupApiResult({
          ...input, symbol: input.symbolOrName, name: holding.name, price, currency: holdingCurrency(holding),
          market: holdingMarket(holding), quoteSource: quote ? quote.source || 'TWSE／TPEx' : '持倉備用價格',
          quoteDate: quote?.date || quote?.datetime, priceType: quote ? '最近取得的持股行情' : '手動輸入的參考價格'
        }) };
      } else {
        const { data } = await supabaseClient?.auth.getSession() || {};
        const headers = { 'Content-Type': 'application/json' };
        if (data?.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
        const response = await fetch('/api/topup/calculate', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ ...input, mode, aiConsent }) });
        dataResult = await response.json();
        if (!response.ok) throw new Error(dataResult.error || '加碼試算失敗，請稍後重試。');
      }
      if (request !== topupRequest) return;
      const item = { currency: 'TWD', market: 'tw', ...dataResult.result };
      const money = (value) => formatScenarioMoney(value, item.currency);
      $('addTopupPriceAlert').disabled = item.market !== 'tw';
      $('topupResult').innerHTML = `<div class="topup-result-heading"><div><b>${esc(item.symbol)} ${esc(item.name || '')}</b><small>${esc(item.quoteDate || '行情日期未提供')} · ${esc(item.quoteUpdatedAt || '')} · ${esc(item.priceType)}</small></div><strong>${money(item.price)}<small>${esc(item.quoteSource || 'Fugle')} 價格參考</small></strong></div><div class="topup-result-grid"><article><small>預算可買股數</small><b>${Number(item.sharesToBuy).toLocaleString('zh-TW')} 股</b></article><article><small>加碼支出（含買入手續費）</small><b>${money(item.purchaseTotal)}</b></article><article><small>加碼後總股數</small><b>${Number(item.totalShares).toLocaleString('zh-TW')} 股</b></article><article><small>加碼後均價（未含交易費）</small><b>${money(item.newAverageCost)}／股</b></article><article><small>剩餘預算</small><b>${money(item.remainingBudget)}</b></article><article><small>目前市值估算淨損益</small><b class="${item.projectedUnrealizedPnl < 0 ? 'negative' : 'positive'}">${money(item.projectedUnrealizedPnl)}</b></article><article><small>估算損益兩平價</small><b>${money(item.estimatedBreakEvenPrice)}／股</b></article><article><small>買入手續費</small><b>${money(item.buyCommission)}</b></article></div><section id="topupComparison" class="scenario-comparison" aria-label="加碼方案比較"></section>${topupScenarioMarkup(item)}<small class="topup-calculation-note">股數依 ${item.shareUnit === 1000 ? '整張（1,000 股）' : '零股（1 股）'}計算；已依你設定的費率估算交易成本，不含券商最低手續費與滑價。</small>${dataResult.analysis ? `<section class="topup-analysis"><b>Ollama 趨勢觀察</b><p>${esc(formatAssistantText(dataResult.analysis))}</p></section>` : ''}`;
      bindTopupScenario(item, holding);
      $('topupResult').hidden = false;
      $('topupStatus').textContent = dataResult.mode === 'ollama' ? `計算完成；以下另附 Ollama 行情觀察。價格來源：${item.quoteSource || 'Fugle'}。` : `試算完成。價格來源：${item.quoteSource || 'Fugle'}。`;
    } catch (error) { if (request === topupRequest) $('topupStatus').textContent = error.message || '連線失敗，請稍後重試。'; }
    finally { if (request === topupRequest) { button.disabled = false; updateTopupMode(); } }
  });
  updateTopupMode();
  $('loadTrend').addEventListener('click', async () => {
    const symbol = $('trendSymbol').value.trim(), days = $('trendRange').value;
    if (!/^\d{4,6}$/.test(symbol)) return showToast('請輸入 4–6 碼股票代號。');
    $('loadTrend').disabled = true; $('trendStatus').textContent = '正在向 Fugle 讀取歷史日 K…'; $('trendResult').hidden = true;
    try {
      const response = await fugleFetch(`/api/fugle/trend?symbol=${encodeURIComponent(symbol)}&days=${encodeURIComponent(days)}`), data = await response.json();
      if (!response.ok) throw new Error(data.error || '趨勢資料讀取失敗');
      if (!data.configured) { fugleConfigured = false; $('fugleBadge').textContent = '尚未設定 API 金鑰'; return checkFugleStatus(); }
      if (!data.candles?.length) throw new Error('此股票目前沒有可用的歷史日 K。');
      trendData = data; $('trendStatus').textContent = `${data.symbol} · ${data.market || '台股'} · ${data.candles.length} 個交易日 · 來源：Fugle 歷史日 K`;
      $('trendResult').hidden = false; requestAnimationFrame(() => renderTrendAnalysis(data));
    } catch (error) { $('trendStatus').textContent = error.message; }
    finally { $('loadTrend').disabled = false; }
  });
  async function loadHeldStock() {
    const holding = state.holdings.find((item) => item.id === $('heldStockSelect').value), code = holding ? stockCode(holding.name) : '';
    if (!holding) { $('heldStockStatus').textContent = '目前沒有持股可分析，請先到「我的持股」新增股票。'; $('heldStockResult').hidden = true; return; }
    if (!code) { $('heldStockStatus').textContent = '無法從持股名稱辨識股票代號。請在持股名稱中包含 4–6 碼代號，例如「2330 台積電」。'; $('heldStockResult').hidden = true; return; }
    const button = $('loadHeldStock'); button.disabled = true; button.textContent = '載入中…'; $('heldStockStatus').textContent = '正在讀取所選股票的歷史日 K…'; $('heldStockResult').hidden = true;
    try {
      const days = $('heldStockRange').value;
      const response = await fugleFetch(`/api/fugle/trend?symbol=${encodeURIComponent(code)}&days=${encodeURIComponent(days)}`), data = await response.json();
      if (!response.ok) throw new Error(data.error || '個股資料讀取失敗');
      if (!data.configured) throw new Error('尚未設定 Fugle API 金鑰。請先於本機設定金鑰並重新啟動程式。');
      if (!data.candles?.length) throw new Error('此股票目前沒有可用的歷史日 K。');
      heldStockData = { ...data, holdingId: holding.id };
      $('heldStockStatus').textContent = `${holding.name}（${code}） · ${data.market || '台股'} · ${data.candles.length} 個交易日 · ${data.candles.at(-1).date} 收盤資料 · Fugle 歷史日 K`;
      $('heldStockResult').hidden = false; requestAnimationFrame(() => renderHeldStock(data, holding));
    } catch (error) { $('heldStockStatus').textContent = error.message; }
    finally { button.disabled = false; button.textContent = '載入個股資料'; }
  }
  $('loadHeldStock').addEventListener('click', loadHeldStock);
  $('heldStockSelect').addEventListener('change', loadHeldStock);
  $('heldStockRange').addEventListener('change', loadHeldStock);
  function renderHeldStock(data, holding) {
    const rows = data.candles, last = rows.at(-1), previous = rows.at(-2), change = previous?.close ? (last.close - previous.close) / previous.close * 100 : null;
    const marketValue = last.close * num(holding.shares), pnlValue = (last.close - num(holding.cost)) * num(holding.shares);
    const volume = Number(last.volume), metrics = [
      ['最新收盤', money(last.close)], ['單日漲跌', change == null ? '—' : pct(change)], ['當日高 / 低', `${money(last.high)} / ${money(last.low)}`],
      ['成交量', Number.isFinite(volume) ? volume.toLocaleString('zh-TW') : '—'], ['持有股數', num(holding.shares).toLocaleString('zh-TW')],
      ['持倉市值 / 損益', `${money(marketValue)} / ${money(pnlValue)}`], ['SMA 20 / 60（簡單移動平均線）', `${last.sma20 == null ? '—' : money(last.sma20)} / ${last.sma60 == null ? '—' : money(last.sma60)}`],
      ['RSI 14（相對強弱指標）', last.rsi14 == null ? '—' : last.rsi14.toFixed(1)], ['MACD（指數平滑異同移動平均線）柱狀值', last.macdHistogram == null ? '—' : last.macdHistogram.toFixed(3)]
    ];
    $('heldStockMetrics').innerHTML = metrics.map(([label, value]) => `<article class="indicator-card"><small>${esc(label)}</small><b>${esc(value)}</b></article>`).join('');
    $('heldStockRows').innerHTML = rows.slice(-12).reverse().map((row) => `<tr><td>${esc(row.date)}</td><td>${money(row.open)}</td><td>${money(row.high)}</td><td>${money(row.low)}</td><td>${money(row.close)}</td><td>${Number.isFinite(Number(row.volume)) ? Number(row.volume).toLocaleString('zh-TW') : '—'}</td></tr>`).join('');
    drawHoldingCandles(rows);
  }
  function drawHoldingCandles(candles) {
    const canvas = $('heldStockChart'), rect = canvas.getBoundingClientRect(), width = rect.width, height = 340, ratio = window.devicePixelRatio || 1;
    if (!width) return;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d'); ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0); ctx.clearRect(0, 0, width, height);
    const data = candles.slice(-90), values = data.flatMap((row) => [Number(row.high), Number(row.low), row.sma20]).filter(Number.isFinite);
    if (!values.length) return;
    const min = Math.min(...values), max = Math.max(...values), pad = (max - min || max * .04 || 1) * .1, low = min - pad, high = max + pad;
    const left = 58, right = width - 12, top = 15, bottom = height - 34, plotWidth = right - left, plotHeight = bottom - top;
    const x = (index) => left + plotWidth * (index + .5) / data.length, y = (value) => bottom - (value - low) / (high - low) * plotHeight;
    ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) { const py = top + plotHeight * i / 4, value = high - (high - low) * i / 4; ctx.beginPath(); ctx.strokeStyle = '#edf0eb'; ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke(); ctx.fillStyle = '#89938d'; ctx.fillText(value.toFixed(2), left - 8, py); }
    const candleWidth = Math.max(2, Math.min(9, plotWidth / data.length * .65));
    data.forEach((row, index) => {
      const open = Number(row.open), close = Number(row.close), highValue = Number(row.high), lowValue = Number(row.low);
      if (![open, close, highValue, lowValue].every(Number.isFinite)) return;
      const up = close >= open, color = up ? '#c65d59' : '#47785d', cx = x(index), bodyTop = y(Math.max(open, close)), bodyBottom = y(Math.min(open, close));
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, y(highValue)); ctx.lineTo(cx, y(lowValue)); ctx.stroke();
      ctx.fillRect(cx - candleWidth / 2, bodyTop, candleWidth, Math.max(1, bodyBottom - bodyTop));
    });
    ctx.beginPath(); ctx.strokeStyle = '#6487b0'; ctx.lineWidth = 1.8; let started = false;
    data.forEach((row, index) => { if (row.sma20 == null || !Number.isFinite(Number(row.sma20))) return; if (!started) { ctx.moveTo(x(index), y(row.sma20)); started = true; } else ctx.lineTo(x(index), y(row.sma20)); }); if (started) ctx.stroke();
    ctx.fillStyle = '#89938d'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillText(data[0].date, left, height - 8); ctx.textAlign = 'right'; ctx.fillText(data.at(-1).date, right, height - 8);
  }
  function renderTrendAnalysis(data) {
    const candles = data.candles, last = candles.at(-1), previous = candles.at(-2), change = previous?.close ? (last.close - previous.close) / previous.close * 100 : 0;
    const signal = last.sma20 !== null && last.sma60 !== null && last.close > last.sma20 && last.sma20 > last.sma60 ? '中短期均線偏多' : last.sma20 !== null && last.sma60 !== null && last.close < last.sma20 && last.sma20 < last.sma60 ? '中短期均線偏弱' : '均線交錯，方向未明';
    const notes = [signal, last.rsi14 >= 70 ? 'RSI（相對強弱指標）偏高' : last.rsi14 <= 30 ? 'RSI（相對強弱指標）偏低' : 'RSI（相對強弱指標）位於中間區間', last.macdHistogram == null ? 'MACD（指數平滑異同移動平均線）資料累積中' : last.macdHistogram >= 0 ? 'MACD（指數平滑異同移動平均線）動能為正' : 'MACD（指數平滑異同移動平均線）動能為負'];
    $('trendSignal').innerHTML = `<b>${esc(signal)}</b><span>${notes.slice(1).map(esc).join(' · ')}</span><small>最新資料 ${esc(last.date)} · 收盤 ${money(last.close)}（${pct(change)}）</small>`;
    renderTradePlan(candles);
    const metrics = [['收盤價', money(last.close)], ['SMA 20（20日簡單移動平均線）', last.sma20 == null ? '資料累積中' : money(last.sma20)], ['SMA 60（60日簡單移動平均線）', last.sma60 == null ? '資料累積中' : money(last.sma60)], ['RSI 14（相對強弱指標）', last.rsi14 == null ? '資料累積中' : last.rsi14.toFixed(1)], ['MACD（指數平滑異同移動平均線）柱狀值', last.macdHistogram == null ? '資料累積中' : last.macdHistogram.toFixed(3)]];
    $('trendIndicators').innerHTML = metrics.map(([label, value]) => `<article class="indicator-card"><small>${label}</small><b>${value}</b></article>`).join('');
    drawTrendChart(candles);
  }
  function renderTradePlan(candles) {
    const last = candles.at(-1), previous = candles.at(-2), prior = candles.slice(-21, -1);
    const plan = $('tradePlan');
    if (!last || prior.length < 10) { plan.innerHTML = '<b>資料不足，暫無進出場價位參考</b><p>至少需要 10 個以上的前期交易日資料。</p>'; return; }
    const trueRanges = candles.slice(-15).map((row, index, rows) => {
      const prev = candles[candles.length - rows.length + index - 1];
      const high = Number(row.high), low = Number(row.low), prevClose = Number(prev?.close);
      if (![high, low].every(Number.isFinite)) return null;
      return Number.isFinite(prevClose) ? Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)) : high - low;
    }).filter((value) => Number.isFinite(value) && value >= 0);
    const atr = trueRanges.length ? trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length : last.close * 0.04;
    const support = Math.min(...prior.map((row) => Number(row.low)).filter(Number.isFinite));
    const resistance = Math.max(...prior.map((row) => Number(row.high)).filter(Number.isFinite));
    if (![atr, support, resistance].every(Number.isFinite) || !last.close) { plan.innerHTML = '<b>行情欄位不足，無法計算價位</b>'; return; }
    const avgVolume = prior.map((row) => Number(row.volume)).filter(Number.isFinite).reduce((sum, value, _, rows) => sum + value / rows.length, 0);
    const volume = Number(last.volume), volumeOK = avgVolume > 0 && volume >= avgVolume * 1.2;
    const histImproving = last.macdHistogram != null && previous?.macdHistogram != null && last.macdHistogram > previous.macdHistogram;
    const bullishTrend = last.sma20 != null && last.sma60 != null && last.close > last.sma20 && last.sma20 > last.sma60;
    const rsi = last.rsi14, breakoutCondition = last.close > resistance && bullishTrend && rsi != null && rsi >= 50 && rsi <= 68 && histImproving && volumeOK;
    const breakoutEntryHigh = resistance + atr * 0.25, breakout = breakoutCondition && last.close <= breakoutEntryHigh, breakoutTooExtended = breakoutCondition && last.close > breakoutEntryHigh;
    const pullbackLow = support, pullbackHigh = support + atr * 0.5;
    const inPullbackZone = last.close >= pullbackLow && last.close <= pullbackHigh;
    const pullback = inPullbackZone && rsi != null && rsi >= 30 && rsi <= 55 && histImproving && last.close >= support;
    const weak = last.sma20 != null && last.close < last.sma20 && last.macdHistogram != null && last.macdHistogram < 0;
    const overheated = rsi != null && rsi >= 70 && last.close >= resistance * 0.95;
    let entryLow = pullbackLow, entryHigh = pullbackHigh, status = '觀察中：尚未滿足買入條件', tone = 'neutral';
    if (breakout || breakoutTooExtended) { entryLow = resistance; entryHigh = breakoutEntryHigh; status = breakoutTooExtended ? '突破但已偏離觀察區：避免追價' : '突破條件符合：等日收盤確認'; tone = breakoutTooExtended ? 'caution' : 'positive'; }
    else if (pullback) { status = '回測觀察區：等待轉強確認'; tone = 'positive'; }
    else if (overheated) { status = '高檔偏熱：檢視停利與持倉風險'; tone = 'caution'; }
    else if (weak) { status = last.close > entryHigh ? '趨勢偏弱、現價高於觀察區：檢視持倉風險' : '趨勢偏弱：檢視持倉風險'; tone = 'caution'; }
    const stop = Math.max(0, (breakout || breakoutTooExtended ? resistance : support) - atr * 0.5);
    const entry = (entryLow + entryHigh) / 2, risk = Math.max(entry - stop, atr * 0.25);
    const target1 = entry + risk, target2 = entry + risk * 2;
    const price = (value) => marketRefMoney(value);
    const checks = [
      `${bullishTrend ? '✓' : '·'} 收盤${last.close > last.sma20 ? '高於' : '未高於'} SMA20（20日簡單移動平均線）；SMA20 ${last.sma20 > last.sma60 ? '高於' : '未高於'} SMA60（60日簡單移動平均線）`,
      `${rsi == null ? '· RSI（相對強弱指標）資料不足' : `${rsi >= 50 && rsi <= 68 ? '✓' : '·'} RSI（相對強弱指標）${rsi.toFixed(1)}（突破條件 50–68）`}`,
      `${histImproving ? '✓' : '·'} MACD（指數平滑異同移動平均線）柱狀值較前一日${histImproving ? '改善' : '未改善'}`,
      `${avgVolume ? `${volumeOK ? '✓' : '·'} 成交量${volumeOK ? '達' : '未達'} 20 日均量 1.2 倍` : '· 成交量資料不足'}`
    ];
    plan.innerHTML = `<div class="trade-plan-head"><div><span class="eyebrow">RULE-BASED TRADE PLAN</span><h3>買賣價位參考</h3></div><span class="trade-plan-status ${tone}">${status}</span></div><div class="trade-levels"><article><small>買入觀察區</small><b>${price(entryLow)} – ${price(entryHigh)}</b><span>需等候條件確認；不代表應立即買進</span></article><article><small>假設買入策略失效價</small><b>${price(stop)}</b><span>以支撐位與 ATR（平均真實波幅）估算，不是個人持倉停損單</span></article><article><small>假設進場後停利參考 1R / 2R</small><b>${price(target1)} / ${price(target2)}</b><span>R 代表進場價至策略失效價的風險距離；此處按其 1／2 倍試算，不套用你的持倉成本</span></article><article><small>前 20 日支撐 / 壓力</small><b>${price(support)} / ${price(resistance)}</b><span>歷史區間，不保證未來有效</span></article></div><div class="trade-plan-rules"><b>觸發條件檢視</b><ul>${checks.map((item) => `<li>${esc(item)}</li>`).join('')}</ul><p>${overheated ? 'RSI（相對強弱指標）偏高且接近區間壓力，可檢視分批停利規則。' : weak ? `收盤低於 SMA20（20日簡單移動平均線）且 MACD（指數平滑異同移動平均線）動能為負，屬風險檢視提示。${last.close > entryHigh ? '現價已高於買入觀察區；價位回落前不要把此試算當成進場訊號。' : ''}` : breakoutTooExtended ? '突破訊號出現但收盤已高於計算的觀察區上緣，價位可能已偏離；此規則不追價。' : breakout ? '突破條件已符合，但需確認日收盤與成交量；跳空或盤中波動可能令價格偏離。' : pullback ? '價格進入支撐觀察帶且動能改善；仍需自行確認風險與持有期間。' : '條件未齊時先列為觀察；避免只因觸及單一價位就作決策。'}</p></div>`;
  }
  function drawTrendChart(candles) {
    const canvas = $('trendChart'), rect = canvas.getBoundingClientRect(), width = rect.width, height = 300, ratio = window.devicePixelRatio || 1;
    if (!width) return;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d'); ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0); ctx.clearRect(0, 0, width, height);
    const values = candles.flatMap((row) => [row.close, row.sma20, row.sma60]).filter((value) => value != null && Number.isFinite(value));
    if (!values.length) return;
    const min = Math.min(...values), max = Math.max(...values), pad = (max - min || max * 0.04 || 1) * 0.1, low = min - pad, high = max + pad;
    const left = 52, right = width - 14, top = 16, bottom = height - 32, x = (index) => left + (right-left) * index / Math.max(1, candles.length-1), y = (value) => bottom - (value-low)/(high-low)*(bottom-top);
    ctx.font = '11px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.strokeStyle = '#edf0eb'; ctx.fillStyle = '#89938d'; ctx.lineWidth = 1;
    for (let i=0;i<5;i++) { const py = top + (bottom-top)*i/4, val = high - (high-low)*i/4; ctx.beginPath(); ctx.moveTo(left,py); ctx.lineTo(right,py); ctx.stroke(); ctx.fillText(val.toFixed(2), left-8, py); }
    const drawLine = (key, color, lineWidth) => { ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = lineWidth; let started=false; candles.forEach((row,index) => { const value = row[key]; if (value == null || !Number.isFinite(value)) return; if (!started) { ctx.moveTo(x(index),y(value)); started=true; } else ctx.lineTo(x(index),y(value)); }); if (started) ctx.stroke(); };
    drawLine('sma60','#d49a51',1.5); drawLine('sma20','#6487b0',1.7); drawLine('close','#47785d',2);
    ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillStyle='#89938d';ctx.fillText(candles[0].date, left, height-8);ctx.textAlign='right';ctx.fillText(candles.at(-1).date, right, height-8);
  }
  window.addEventListener('resize', () => { if (trendData && !$('trendAnalysis').hidden) drawTrendChart(trendData.candles); if (heldStockData && !$('holdingAnalysis').hidden) drawHoldingCandles(heldStockData.candles); });
  const pageTitles = { overview: '投資總覽', holdings: '我的持股', ledger: '交易與股利', allocation: '資產配置', alerts: '價格提醒', events: '公司事件', journal: '投資日誌', insights: '投資檢視', trendAnalysis: '技術趨勢', holdingAnalysis: '持股分析', topup: '加碼試算', stockDesk: '個股查詢／自選', candidates: '推薦股號', watchlist: '趨勢觀察', news: '市場動態', globalTaiwanResearch: '國際事件與台股', assistant: '詢問助理', references: '研究資料', workspace: '多功能工作區' };
  const workspaceGrid = $('workspacePanelGrid'), workspaceHome = new Map();
  const workspaceFeatureIds = Object.keys(pageTitles).filter((id) => !['overview', 'workspace'].includes(id));
  workspaceFeatureIds.forEach((id) => { const element = $(id); if (element?.parentElement) workspaceHome.set(id, { parent: element.parentElement, next: element.nextElementSibling }); });
  let workspaceOpenPages = [];
  try { workspaceOpenPages = [...new Set(JSON.parse(localStorage.getItem('duanguWorkspacePages') || '[]').filter((id) => workspaceFeatureIds.includes(id)))]; } catch { workspaceOpenPages = []; }
  let workspacePositions = {}, workspaceZIndex = 1;
  try { workspacePositions = JSON.parse(localStorage.getItem('duanguWorkspacePositions') || '{}') || {}; } catch { workspacePositions = {}; }
  const persistWorkspace = () => { try { localStorage.setItem('duanguWorkspacePages', JSON.stringify(workspaceOpenPages)); } catch { /* Workspace layout remains usable without browser storage. */ } };
  function saveWorkspacePosition(panel) {
    const width = workspaceGrid.clientWidth || 1;
    if (width < 700) return;
    workspacePositions[panel.dataset.page] = { x: panel.offsetLeft / width, y: panel.offsetTop, w: panel.offsetWidth / width };
    try { localStorage.setItem('duanguWorkspacePositions', JSON.stringify(workspacePositions)); } catch { /* Position is still applied for this session. */ }
  }
  function updateWorkspaceCanvasHeight() {
    const bottom = [...workspaceGrid.querySelectorAll('.workspace-panel')].reduce((max, panel) => Math.max(max, panel.offsetTop + panel.offsetHeight), 0);
    workspaceGrid.style.height = `${Math.max(bottom + 18, 0)}px`;
  }
  function enablePanelDragging(panel, heading, resizeHandle) {
    let operation = null;
    panel.addEventListener('pointerdown', () => { workspaceZIndex += 1; panel.style.zIndex = String(workspaceZIndex); });
    heading.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      event.preventDefault();
      operation = { type: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
      heading.classList.add('is-dragging');
      heading.setPointerCapture(event.pointerId);
    });
    resizeHandle.addEventListener('pointerdown', (event) => {
      event.preventDefault(); event.stopPropagation();
      operation = { type: 'resize', pointerId: event.pointerId, startX: event.clientX, width: panel.offsetWidth };
      resizeHandle.setPointerCapture(event.pointerId);
    });
    const move = (event) => {
      if (!operation || operation.pointerId !== event.pointerId) return;
      const canvasWidth = workspaceGrid.clientWidth || 1;
      if (operation.type === 'move') {
        const left = Math.max(0, Math.min(canvasWidth - panel.offsetWidth, operation.left + event.clientX - operation.startX));
        panel.style.left = `${left / canvasWidth * 100}%`;
        panel.style.top = `${Math.max(0, operation.top + event.clientY - operation.startY)}px`;
      } else {
        const maxWidth = Math.max(220, canvasWidth - panel.offsetLeft);
        const minWidth = Math.min(300, maxWidth);
        const width = Math.max(minWidth, Math.min(maxWidth, operation.width + event.clientX - operation.startX));
        panel.style.width = `${width / canvasWidth * 100}%`;
      }
      updateWorkspaceCanvasHeight();
    };
    const finish = (event) => {
      if (!operation || operation.pointerId !== event.pointerId) return;
      operation = null; heading.classList.remove('is-dragging'); saveWorkspacePosition(panel); updateWorkspaceCanvasHeight();
    };
    heading.addEventListener('pointermove', move); heading.addEventListener('pointerup', finish); heading.addEventListener('pointercancel', finish);
    resizeHandle.addEventListener('pointermove', move); resizeHandle.addEventListener('pointerup', finish); resizeHandle.addEventListener('pointercancel', finish);
  }
  function restoreWorkspacePanels() {
    [...workspaceGrid.querySelectorAll('.workspace-panel')].forEach((panel) => {
      const id = panel.dataset.page, element = $(id), home = workspaceHome.get(id);
      if (element && home) { home.parent.insertBefore(element, home.next?.parentElement === home.parent ? home.next : null); element.hidden = true; }
      panel.remove();
    });
  }
  function updateWorkspaceControls() {
    [...$('workspaceFeatureSelect').options].forEach((option) => { if (option.value) option.disabled = workspaceOpenPages.includes(option.value); });
    $('workspaceCount').textContent = workspaceOpenPages.length ? `已開啟 ${workspaceOpenPages.length} 項功能` : '尚未開啟功能';
    $('workspaceEmpty').hidden = workspaceOpenPages.length > 0;
  }
  function renderWorkspacePanels() {
    restoreWorkspacePanels();
    const canvasWidth = workspaceGrid.clientWidth || 1, narrowCanvas = canvasWidth < 700;
    const columnBottoms = [0, 0];
    workspaceOpenPages.forEach((id) => {
      const element = $(id), home = workspaceHome.get(id);
      if (!element || !home) return;
      const panel = document.createElement('article'); panel.className = 'workspace-panel'; panel.dataset.page = id;
      const heading = document.createElement('header'); heading.className = 'workspace-panel-heading';
      const title = document.createElement('b'); title.textContent = '拖曳此列移動';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'workspace-panel-close'; close.setAttribute('aria-label', `關閉${pageTitles[id]}`); close.textContent = '×';
      close.addEventListener('click', () => { workspaceOpenPages = workspaceOpenPages.filter((item) => item !== id); persistWorkspace(); renderWorkspacePanels(); updateWorkspaceControls(); });
      heading.append(title, close);
      const resizeHandle = document.createElement('button'); resizeHandle.type = 'button'; resizeHandle.className = 'workspace-panel-resize'; resizeHandle.setAttribute('aria-label', `拖曳調整${pageTitles[id]}視窗大小`); resizeHandle.title = '拖曳調整大小'; resizeHandle.textContent = '◢';
      const saved = workspacePositions[id];
      if (!narrowCanvas && saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y)) && Number.isFinite(Number(saved.w))) {
        const widthRatio = Math.max(narrowCanvas ? 0.97 : 0.32, Math.min(narrowCanvas ? 0.97 : 0.98, Number(saved.w)));
        const xRatio = Math.max(0, Math.min(1 - widthRatio, Number(saved.x)));
        panel.style.left = `${xRatio * 100}%`; panel.style.top = `${Math.max(0, Number(saved.y))}px`; panel.style.width = `${widthRatio * 100}%`;
      } else {
        const column = narrowCanvas ? 0 : columnBottoms[0] <= columnBottoms[1] ? 0 : 1;
        const widthRatio = narrowCanvas ? 0.97 : 0.49;
        panel.style.left = `${column ? 51 : 0}%`; panel.style.top = `${columnBottoms[column]}px`; panel.style.width = `${widthRatio * 100}%`;
      }
      panel.append(heading, element, resizeHandle); workspaceGrid.append(panel); element.hidden = false;
      enablePanelDragging(panel, heading, resizeHandle);
      const column = narrowCanvas || panel.offsetLeft < canvasWidth * 0.5 ? 0 : 1;
      columnBottoms[column] = Math.max(columnBottoms[column], panel.offsetTop + panel.offsetHeight + 14);
    });
    updateWorkspaceControls();
    requestAnimationFrame(() => {
      if (trendData && workspaceOpenPages.includes('trendAnalysis')) drawTrendChart(trendData.candles);
      if (heldStockData && workspaceOpenPages.includes('holdingAnalysis')) drawHoldingCandles(heldStockData.candles);
      workspaceGrid.querySelectorAll('.workspace-panel').forEach(saveWorkspacePosition);
      updateWorkspaceCanvasHeight();
    });
  }
  const workspaceSelect = $('workspaceFeatureSelect');
  workspaceFeatureIds.forEach((id) => { const option = document.createElement('option'); option.value = id; option.textContent = pageTitles[id]; workspaceSelect.append(option); });
  $('workspaceAddFeature').addEventListener('click', () => {
    const id = workspaceSelect.value;
    if (!id || workspaceOpenPages.includes(id)) return;
    workspaceOpenPages.push(id); persistWorkspace(); workspaceSelect.value = ''; renderWorkspacePanels();
  });
  $('workspaceReset').addEventListener('click', () => { workspaceOpenPages = []; persistWorkspace(); renderWorkspacePanels(); });
  window.addEventListener('resize', () => {
    if ($('workspace').hidden) return;
    const width = workspaceGrid.clientWidth || 1, narrow = width < 700;
    let top = 0;
    [...workspaceGrid.querySelectorAll('.workspace-panel')].forEach((panel) => {
      const saved = workspacePositions[panel.dataset.page];
      if (narrow) { panel.style.left = '0%'; panel.style.width = '97%'; panel.style.top = `${top}px`; top += panel.offsetHeight + 14; }
      else if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.w))) {
        const panelWidth = Math.max(0.32, Math.min(0.98, Number(saved.w))), left = Math.max(0, Math.min(1 - panelWidth, Number(saved.x)));
        panel.style.left = `${left * 100}%`; panel.style.width = `${panelWidth * 100}%`; panel.style.top = `${Math.max(0, Number(saved.y) || 0)}px`;
      }
    });
    updateWorkspaceCanvasHeight();
  });
  function showPage(page, updateHash = false) {
    if (!pageTitles[page]) page = 'overview';
    if (page !== 'workspace') restoreWorkspacePanels();
    document.querySelector('.lower-grid').hidden = false;
    $('watchlist').hidden = true; $('references').hidden = true;
    const mainSections = [...document.querySelectorAll('.main-content > section')];
    mainSections.forEach((section) => { section.hidden = true; });
    if (page === 'overview') { $('overview').hidden = false; $('summaryGrid').hidden = false; $('marketFreshness').hidden = $('overviewMarketFilter').value !== 'tw'; $('portfolioSnapshot').hidden = false; $('workflowStrip').hidden = false; $('insights').hidden = false; $('watchlist').hidden = false; $('references').hidden = false; }
    else if (page === 'workspace') { $('workspace').hidden = false; document.querySelector('.lower-grid').hidden = true; renderWorkspacePanels(); }
    else if (page === 'watchlist' || page === 'references') {
      const grid = document.querySelector('.lower-grid'); grid.hidden = false; grid.classList.add('single-page');
      $('watchlist').hidden = page !== 'watchlist'; $('references').hidden = page !== 'references';
    } else { $(page).hidden = false; }
    if (page === 'holdingAnalysis' && state.holdings.length && (!heldStockData || heldStockData.holdingId !== $('heldStockSelect').value)) loadHeldStock();
    if (page !== 'watchlist' && page !== 'references') document.querySelector('.lower-grid').classList.remove('single-page');
    const activeNavGroup = [...document.querySelectorAll('.sidebar nav .nav-link')].find((link) => link.hash === `#${page}`)?.closest('.nav-group');
    document.querySelectorAll('.sidebar nav .nav-group').forEach((group) => { group.open = group === activeNavGroup; });
    document.querySelectorAll('.sidebar nav .nav-link').forEach((link) => {
      const active = link.hash === `#${page}`; link.classList.toggle('active', active);
    });
    document.querySelector('.breadcrumb b').textContent = pageTitles[page];
    if (updateHash && location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
    if (page === 'overview' && servicesStarted && Date.now() - lastQuoteFetchAt > 60000) refreshQuotes();
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }
  document.querySelector('.sidebar nav').addEventListener('click', (event) => { const link = event.target.closest('.nav-link'); if (!link) return; event.preventDefault(); showPage(link.hash.slice(1), true); });
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); showPage('overview', true); });
  window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
  function updateTransactionLabel() { const dividend = $('transactionType').value === 'dividend'; $('transactionPriceLabel').firstChild.textContent = dividend ? '每股股利' : '成交價（每股）'; }
  function openStockAnalysis(code) { $('trendSymbol').value = code; showPage('trendAnalysis', true); $('loadTrend').click(); }
  function renderLedger() { const rows = [...state.transactions].sort((a,b) => b.date.localeCompare(a.date)); $('transactionsBody').innerHTML = rows.map((row) => { const type = { buy: '買進', sell: '賣出', dividend: '股利' }[row.type] || row.type, amount = row.type === 'dividend' ? num(row.shares) * num(row.price) : row.type === 'sell' ? num(row.realizedPnl) : -(num(row.shares) * num(row.price) + num(row.fees) + num(row.tax)); return `<tr><td>${esc(row.date)}</td><td>${esc(row.stock)}${row.note ? `<small class="stock-sub">${esc(row.note)}</small>` : ''}</td><td>${type}</td><td>${num(row.shares).toLocaleString('zh-TW')}</td><td>${money(row.price)}</td><td>${money(num(row.fees)+num(row.tax))}</td><td class="${amount < 0 ? 'negative' : 'positive'}">${money(amount)}</td></tr>`; }).join(''); $('emptyTransactions').style.display = rows.length ? 'none' : 'block'; }
  function renderAllocation() { const holdings = state.holdings.filter((item) => holdingMarket(item) === 'tw'), total = holdings.reduce((sum,item) => sum + livePrice(item)*num(item.shares),0), targets = holdings.reduce((sum,item) => sum + num(item.targetWeight),0); $('allocationContent').innerHTML = holdings.length ? `<div class="allocation-summary">已設定目標 ${targets.toFixed(1)}%${targets > 0 && Math.abs(targets-100)>0.5 ? ' · 目標比例合計未達 100%' : ''}</div>` + holdings.map((item) => { const actual = total ? livePrice(item)*num(item.shares)/total*100 : 0, target = num(item.targetWeight), diff = actual-target; return `<div class="allocation-row"><div class="allocation-label"><b>${esc(item.name)}</b><span>目前 ${actual.toFixed(1)}% · 目標 ${target ? `${target.toFixed(1)}%` : '未設定'} · 差距 ${target ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%` : '—'}</span></div><div class="allocation-track"><i style="width:${Math.min(actual,100)}%"></i></div></div>`; }).join('') : '<div class="feature-empty">新增持股後可設定每檔目標比例。</div>'; }
  function renderAlerts() { $('alertsContent').innerHTML = state.alerts.length ? [...state.alerts].reverse().map((row) => `<article class="record-card"><div><b>${esc(row.stock)} · ${row.direction === 'above' ? '到達／高於' : '到達／低於'} ${money(row.target)}</b><p>${row.active ? '等待行情觸發' : `已於 ${esc(row.triggeredAt || '')} 觸發，當時 ${money(row.triggeredPrice)}`}${row.source === 'topup' ? ' · 到價後請重新檢視，不代表加碼建議' : ''}</p></div><button class="row-action" data-delete-alert="${esc(row.id)}" title="刪除提醒">×</button></article>`).join('') : '<div class="feature-empty">尚未設定價格提醒。</div>'; }
  function evaluateAlerts() { let changed = false, triggered = []; state.alerts.forEach((row) => { if (!row.active) return; const price = quoteMap.get(stockCode(row.stock))?.price; if (price == null) return; if ((row.direction === 'above' && price >= row.target) || (row.direction === 'below' && price <= row.target)) { row.active = false; row.triggeredAt = isoToday(); row.triggeredPrice = price; triggered.push(row.stock); changed = true; } }); if (changed) { persist(); renderAlerts(); showToast(`價格提醒觸發：${triggered.join('、')}`); } }
  function renderJournal() { $('journalContent').innerHTML = state.journal.length ? state.journal.map((row) => `<article class="record-card journal-card ${row.done ? 'is-done' : ''}"><div><b>${esc(row.title)}${row.stock ? ` · ${esc(row.stock)}` : ''}</b><p>${esc(row.thesis)}</p>${row.risk ? `<small>風險／失效條件：${esc(row.risk)}</small>` : ''}<small>建立 ${esc(row.createdAt)}${row.reviewDate ? ` · 預計回顧 ${esc(row.reviewDate)}` : ''}</small></div><div class="record-actions"><button class="secondary-button" data-complete-journal="${esc(row.id)}">${row.done ? '取消完成' : '標記完成'}</button><button class="row-action" data-delete-journal="${esc(row.id)}" title="刪除日誌">×</button></div></article>`).join('') : '<div class="feature-empty">尚未建立投資日誌。</div>'; }
  function renderEvents() {
    const today = isoToday(), events = [...state.events].filter((row) => row.date && row.title).sort((a, b) => {
      const aUpcoming = a.date >= today, bUpcoming = b.date >= today;
      return aUpcoming !== bUpcoming ? (aUpcoming ? -1 : 1) : aUpcoming ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
    });
    if (!events.length) { $('eventsContent').innerHTML = '<div class="feature-empty">還沒有已排定的事件。新增法說會、除權息或自己的追蹤日期。</div>'; return; }
    $('eventsContent').innerHTML = events.map((row) => {
      const dayDelta = Math.round((new Date(`${row.date}T00:00:00`) - new Date(`${isoToday()}T00:00:00`)) / 86400000);
      const timing = dayDelta < 0 ? `已過 ${Math.abs(dayDelta)} 天` : dayDelta === 0 ? '今天' : dayDelta === 1 ? '明天' : `${dayDelta} 天後`;
      return `<article class="event-row"><div class="event-date"><b>${esc(row.date.slice(5).replace('-', '/'))}</b><small>${esc(row.date.slice(0, 4))}</small></div><div class="event-main"><div class="event-title-line"><b>${esc(row.title)}</b><span class="event-type">${esc(row.type || '自訂')}</span></div><small>${row.stock ? `${esc(row.stock)} · ` : ''}${esc(row.note || '未填備註')}</small></div><span class="event-countdown ${dayDelta < 0 ? 'event-past' : ''}">${timing}</span><button class="row-action" type="button" data-delete-event="${esc(row.id)}" aria-label="刪除 ${esc(row.title)}">×</button></article>`;
    }).join('');
  }
  function applyEyeComfort() {
    const enabled = Boolean(state.settings?.eyeComfort);
    document.body.dataset.eyeComfort = enabled ? 'true' : 'false';
    const button = $('eyeModeToggle');
    if (button) { button.setAttribute('aria-pressed', String(enabled)); button.textContent = enabled ? '☀ 標準模式' : '☾ 護眼模式'; button.title = enabled ? '切換回標準配色' : '切換到暖色護眼配色'; }
  }
  async function backupKey(password, salt) { const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']); return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']); }
  function toBase64(bytes) { let binary = ''; bytes.forEach((byte) => binary += String.fromCharCode(byte)); return btoa(binary); }
  function fromBase64(value) { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
  function downloadJson(data, name) { const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function applyBackup(data) { if (!Array.isArray(data.holdings) || !Array.isArray(data.observations)) throw new Error('格式不符'); if (!confirm('匯入備份會取代此瀏覽器目前的所有資料，確定繼續？')) return false; state = normalizePortfolio(data); persist(); render(); showToast('備份已匯入。'); return true; }
  if (state.holdings.length && stockCode(state.holdings[0].name)) $('trendSymbol').value = stockCode(state.holdings[0].name);
  let installPromptEvent = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); installPromptEvent = event; $('installAppBtn').hidden = false;
  });
  $('installAppBtn').addEventListener('click', async () => {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    installPromptEvent = null; $('installAppBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { installPromptEvent = null; $('installAppBtn').hidden = true; });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  render();
  showPage(location.hash.slice(1) || 'overview');
  initAccountSync();
})();
