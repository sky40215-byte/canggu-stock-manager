import { calculateTopup, marketTotals, topupApiResult } from './portfolio-math.js?v=20261125d';
import { formatScenarioMoney, mountScenarioComparison } from './scenario-compare.js?v=20261126k';
import { mountQuickSearch } from './quick-search.js?v=20261125d';
import { mountPortfolioStress } from './portfolio-stress.js?v=20261126k';
import { mountHoldingImport } from './holding-import-dialog.js?v=20261126h';
import { getAccountCallback, mountAccountAuth } from './account-auth.js?v=20261128b';
import { mountMarketPerformance } from './market-performance.js?v=20261128c';

(() => {
  'use strict';
  const STORAGE_KEY = 'canggu.v1.portfolio';
  const $ = (id) => document.getElementById(id);
  const initialState = { holdings: [], observations: [], transactions: [], alerts: [], journal: [], watchlist: [], watchlistGroups: {}, events: [], settings: { eyeComfort: false, topupReviewReminders: [] } };
  let state = structuredClone(initialState);
  let quoteMap = new Map();
  let internationalQuoteMap = new Map();
  const overviewQuoteJobs = new Map();
  const overviewQuoteStatus = new Map();
  let lastInternationalQuote = null;
  let stockLookupRequest = 0;
  let quoteRefreshPromise = null;
  let lastQuoteFetchAt = 0;
  let screenCandidateResults = null;
  let overviewSort = { key: 'value', descending: true };
  let overviewHoldingId = '';
  let taiwanQuoteFreshness = { state: 'pending', label: '台股行情待更新', title: '' };
  let toastTimer;
  let supabaseClient = null, cloudUser = null, cloudReady = false, cloudSyncEnabled = false, cloudSyncTimer = null, lastCloudUpdatedAt = '';
  let servicesStarted = false, accountAuth = null, cloudRevision = 0, cloudDirty = false, cloudWrite = null;
  const accountStorageKey = (id) => STORAGE_KEY + '.account.' + id;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || !Array.isArray(parsed.holdings) || !Array.isArray(parsed.observations)) return structuredClone(initialState);
      return normalizePortfolio(parsed);
    } catch { return structuredClone(initialState); }
  }
  function persist() {
    if (cloudReady && cloudUser) { cloudRevision += 1; cloudDirty = true; }
    persistLocalOnly();
    if (cloudSyncEnabled && cloudReady) queueCloudSave();
  }
  function persistLocalOnly() {
    try {
      if (cloudUser) localStorage.setItem(accountStorageKey(cloudUser.id), JSON.stringify({ data: state, updatedAt: lastCloudUpdatedAt, dirty: cloudDirty }));
      else if (!supabaseClient) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    catch { showToast('瀏覽器儲存空間不足，請先匯出備份。'); }
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
  function showAccountGate(message) {
    $('accountGate').hidden = false; $('appShell').hidden = true; $('logoutBtn').hidden = true;
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    if (typeof message === 'string') {
      $('accountStatus').textContent = message;
      delete $('accountStatus').dataset.tone;
    }
  }
  function showSyncedApp() {
    $('accountGate').hidden = true; $('appShell').hidden = false; $('logoutBtn').hidden = false;
    accountAuth.setProfile(cloudUser);
    $('syncBadge').innerHTML = '<i></i>雲端同步已開啟';
    $('syncBadge').title = lastCloudUpdatedAt ? `最近同步：${new Date(lastCloudUpdatedAt).toLocaleString('zh-TW')}` : '雲端資料同步已啟用';
  }
  function startAppServices() {
    if (servicesStarted) return;
    servicesStarted = true; checkFugleStatus(); renderCandidates(); refreshQuotes(); checkTopupReviewReminders(); renderTopupReviewReminders();
    if (!$('workspace').hidden) maybeLoadWorkspaceHolding();
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
      state = loadState(); render();
      $('accountGate').hidden = true; $('appShell').hidden = false; $('syncBadge').innerHTML = '<i></i>僅儲存於此裝置';
      startAppServices(); return;
    }
    if (!window.supabase?.createClient) { showAccountGate('登入元件載入失敗，請重新整理並確認網路連線。'); return; }
    const callback = getAccountCallback(location);
    if (callback.recovery || callback.expired) history.replaceState(history.state, '', location.pathname);
    supabaseClient = window.supabase.createClient(config.url, config.anonKey, { auth: {
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: !callback.recovery
    } });
    accountAuth = mountAccountAuth({
      auth: supabaseClient.auth,
      createRecoveryAuth: () => window.supabase.createClient(config.url, config.anonKey, { auth: {
        persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'canggu-password-recovery'
      } }).auth,
      onSession: activateCloudUser,
      onShowGate: showAccountGate,
      onNotice: showToast
    });
    $('logoutBtn').addEventListener('click', async () => {
      if (cloudDirty) await saveCloudData();
      const { error } = await supabaseClient.auth.signOut();
      if (error) showToast('登出失敗，請稍後再試。');
    });
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        const wasSignedIn = Boolean(cloudUser || activatingUserId);
        cloudSyncEnabled = false; cloudReady = false; cloudUser = null; activatingUserId = '';
        clearTimeout(cloudSyncTimer); cloudSyncTimer = null;
        accountAuth.setProfile(null);
        if (accountAuth.isRecovering() && !wasSignedIn) return;
        showAccountGate('請登入以讀取你的雲端資料。');
        if (wasSignedIn) location.reload();
      } else if (session && !accountAuth.isRecovering() && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED')) {
        setTimeout(() => {
          if (accountAuth.isRecovering()) return;
          if (cloudReady && cloudUser?.id === session.user?.id) {
            cloudUser = session.user;
            accountAuth.setProfile(cloudUser);
          } else if (event !== 'USER_UPDATED') {
            void activateCloudUser(session);
          }
        }, 0);
      }
    });
    if (callback.recovery) {
      await accountAuth.openRecoveryLink(callback.tokens);
      return;
    }
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) { showAccountGate(`無法讀取登入狀態：${error.message}`); return; }
    if (data.session) await activateCloudUser(data.session);
    else showAccountGate(callback.expired ? '驗證連結已失效，請重新寄送驗證信。' : '');
  }
  let activatingUserId = '';
  async function activateCloudUser(session) {
    if (!session?.user || activatingUserId === session.user.id || (cloudReady && cloudUser?.id === session.user.id)) return;
    if (cloudUser && cloudUser.id !== session.user.id) { showAccountGate(); location.reload(); return; }
    const user = session.user;
    activatingUserId = user.id; cloudUser = user; showAccountGate('正在載入此帳號的持倉…');
    try {
      const { data: row, error } = await supabaseClient.from('portfolio_data').select('data,updated_at').eq('user_id', user.id).maybeSingle();
      if (cloudUser?.id !== user.id) return;
      if (error) throw error;
      let local;
      try { local = JSON.parse(localStorage.getItem(accountStorageKey(user.id)) || 'null'); } catch { /* A damaged browser cache may be ignored. */ }
      const remote = normalizePortfolio(row?.data);
      const localData = local?.data ? normalizePortfolio(local.data) : null;
      lastCloudUpdatedAt = row?.updated_at || '';
      const hasPendingChanges = localData && local.dirty === true && stableSerialize(localData) !== stableSerialize(remote);
      let useLocal = Boolean(hasPendingChanges);
      if (useLocal && row && local.updatedAt !== lastCloudUpdatedAt) {
        useLocal = confirm('這個帳號的本機與雲端都有較新的編輯。按「確定」同步本機版本，按「取消」載入雲端版本。');
      }
      state = useLocal ? localData : remote;
      cloudRevision = 0; cloudDirty = useLocal;
      cloudReady = true; cloudSyncEnabled = true; activatingUserId = '';
      persistLocalOnly(); render(); showSyncedApp(); startAppServices();
      if (cloudDirty) queueCloudSave();
    } catch (error) {
      if (cloudUser?.id !== user.id) return;
      activatingUserId = ''; cloudReady = false; cloudSyncEnabled = false;
      showAccountGate(`雲端資料庫尚未設定完成：${error.message}。請先完成資料表與存取政策設定。`);
    }
  }
  function queueCloudSave(delay = 700) {
    clearTimeout(cloudSyncTimer);
    const userId = cloudUser?.id;
    cloudSyncTimer = setTimeout(async () => {
      cloudSyncTimer = null;
      if (!userId || cloudUser?.id !== userId || !cloudDirty) return;
      const saved = await saveCloudData();
      if (cloudUser?.id === userId && cloudDirty) queueCloudSave(saved ? 700 : 5000);
    }, delay);
  }
  async function saveCloudData() {
    if (!supabaseClient || !cloudUser || !cloudReady || !cloudDirty) return true;
    if (cloudWrite) return cloudWrite;
    const id = cloudUser.id, revision = cloudRevision, snapshot = structuredClone(state);
    cloudWrite = (async () => {
      try {
        const { data, error } = await supabaseClient.from('portfolio_data').upsert({ user_id: id, data: snapshot }, { onConflict: 'user_id' }).select('updated_at').single();
        if (cloudUser?.id !== id) return true;
        if (error) throw error;
        lastCloudUpdatedAt = data.updated_at || new Date().toISOString();
        cloudDirty = cloudRevision !== revision;
        persistLocalOnly();
        $('syncBadge').innerHTML = cloudDirty ? '<i></i>正在同步' : '<i></i>雲端同步已開啟';
        $('syncBadge').title = '最近同步 ' + new Date(lastCloudUpdatedAt).toLocaleString('zh-TW');
        return true;
      } catch {
        if (cloudUser?.id === id) $('syncBadge').innerHTML = '<i></i>暫未同步，已存此裝置';
        return false;
      }
    })().finally(() => { cloudWrite = null; });
    return cloudWrite;
  }
  async function pullCloudData() {
    if (!cloudSyncEnabled || !cloudReady || !cloudUser || cloudDirty || cloudWrite || document.querySelector('dialog[open]')) return;
    const id = cloudUser.id, revision = cloudRevision;
    const { data, error } = await supabaseClient.from('portfolio_data').select('data,updated_at').eq('user_id', id).maybeSingle();
    if (cloudUser?.id !== id || revision !== cloudRevision || cloudDirty || document.querySelector('dialog[open]')) return;
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
  function webLink(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  const stockCode = (name) => String(name).match(/\b\d{4,6}\b/)?.[0] || '';
  const livePrice = (item) => holdingQuote(item)?.price ?? num(item.price);
  const holdingScenarioButton = (item, compact = false) => `<button type="button" class="secondary-button holding-scenario-button" data-simulate-holding="${esc(item.id)}" aria-label="試算 ${esc(item.name)} 持倉">${compact ? '試算' : '試算這筆持倉'}</button>`;
  function showToast(message) { const toast = $('toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500); }
  function pnl(item) { return (num(item.price) - num(item.cost)) * num(item.shares); }
  function render() {
    const holdings = state.holdings;
    const taiwanHoldings = holdings.filter((item) => holdingMarket(item) === 'tw');
    const realized = state.transactions.filter((row) => row.type === 'sell').reduce((sum, row) => sum + num(row.realizedPnl), 0);
    const dividends = state.transactions.filter((row) => row.type === 'dividend').reduce((sum, row) => sum + netDividend(row), 0);
    $('realizedPnl').textContent = money(realized); $('realizedPnl').className = `metric ${realized < 0 ? 'negative' : realized > 0 ? 'positive' : ''}`; $('dividendTotal').textContent = money(dividends);
    const uncostedSales = state.transactions.filter((row) => row.type === 'sell' && row.recordOnly).length;
    $('realizedPnlNote').textContent = uncostedSales ? `有 ${uncostedSales} 筆賣出僅存紀錄，尚未計入` : '依台股交易紀錄扣除手續費與稅';
    renderOverviewHoldings();
    stressLab.refresh();
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
    renderInsights();
    renderTrend();
    renderLedger(); renderAllocation(); renderAlerts(); renderJournal(); renderTopupReviewReminders();
    renderStockWatchlist(); renderEvents(); applyEyeComfort();
  }
  function renderOverviewSummary(market, holdings) {
    const totals = marketTotals(holdings, livePrice, holdingCurrency);
    if (!totals.size) totals.set(marketCurrencies[market], { cost: 0, value: 0 });
    const priced = holdings.filter((item) => livePrice(item) > 0);
    const pricedTotals = marketTotals(priced, livePrice, holdingCurrency);
    const groups = [...totals].sort(([a], [b]) => a.localeCompare(b));
    const fields = {
      marketValue: (row, pricedRow) => pricedRow?.value,
      costValue: (row) => row.cost,
      totalPnl: (row, pricedRow) => pricedRow ? pricedRow.value - pricedRow.cost : null
    };
    for (const [id, amount] of Object.entries(fields)) {
      $(id).innerHTML = groups.map(([currency, row]) => {
        const value = amount(row, pricedTotals.get(currency));
        const color = id === 'totalPnl' ? (value < 0 ? 'negative' : value > 0 ? 'positive' : '') : '';
        const formatted = value == null ? (groups.length > 1 && currency ? currency + ' —' : '—') : currencyMoney(value, currency);
        return `<span class="${color}">${esc(formatted)}</span>`;
      }).join('');
      $(id).classList.toggle('metric-breakdown', groups.length > 1);
    }
    const row = pricedTotals.get(groups[0][0]);
    const ratio = row?.cost ? (row.value - row.cost) / row.cost * 100 : 0;
    $('totalPnlPct').hidden = groups.length > 1 || !row?.cost;
    $('totalPnlPct').textContent = pct(ratio);
    $('totalPnlPct').classList.toggle('negative', ratio < 0);
    const fallback = priced.filter((item) => !holdingQuote(item)).length;
    const missing = holdings.length - priced.length;
    $('marketValueBasis').textContent = [fallback ? `${fallback} 筆使用備用價` : '', missing ? `${missing} 筆尚無價格` : ''].filter(Boolean).join(' · ');
    $('pnlBasis').textContent = missing ? '僅計入有價格的持倉' : '未扣賣出費用';
    $('overviewTaiwanTotals').hidden = market !== 'tw';
    $('overviewCurrency').textContent = [marketLabels[market], groups.map(([currency]) => currency || '幣別未填').join('／')].join(' · ');
  }
  function renderOverviewQuoteStatus() {
    const market = $('overviewMarketFilter').value;
    const taiwan = market === 'tw';
    const holdings = state.holdings.filter((item) => holdingMarket(item) === market);
    const quotes = holdings.map(holdingQuote).filter(Boolean);
    if (taiwan && !quotes.length) quotes.push(...quoteMap.values());
    const dates = [...new Set(quotes.map((quote) => String(quote.datetime || quote.date || '').slice(0, 10)).filter(Boolean))].sort();
    const range = dates.length > 1 ? `${dates[0]} 至 ${dates.at(-1)}` : dates[0] || '日期未提供';
    const updating = overviewQuoteJobs.has(market);
    const headline = taiwan
      ? quotes.length ? `TWSE／TPEx · 收盤 ${range}` : taiwanQuoteFreshness.label
      : quotes.length ? `Twelve Data · 報價 ${range}` : holdings.length ? '尚未取得海外報價' : '尚無此市場持股';
    const previous = quotes.length > 0;
    const taiwanStatus = taiwanQuoteFreshness.state;
    const note = updating || (taiwan && taiwanStatus === 'loading') ? '更新中'
      : taiwan && taiwanStatus === 'stale' ? '沿用快取'
      : taiwan && taiwanStatus === 'error' ? '更新有異常' : '';
    $('overviewQuoteHeadline').textContent = previous && note ? `${headline} · ${note}` : updating ? '行情更新中' : headline;
    $('quoteStatus').hidden = !taiwan;
    const overseasStatus = overviewQuoteStatus.get(market) || '';
    $('overviewMarketStatus').textContent = overseasStatus;
    $('overviewMarketStatus').hidden = taiwan || !overseasStatus;
    $('overseasQuoteNote').hidden = taiwan;
    const status = taiwan ? taiwanQuoteFreshness : {
      state: updating ? 'loading' : overseasStatus.includes('未更新：') ? 'error' : quotes.length ? 'fresh' : 'pending',
      label: updating ? `${marketLabels[market]}行情更新中` : quotes.length ? `${marketLabels[market]}報價 · ${dates.at(-1) || '日期未提供'}` : `${marketLabels[market]}行情待更新`,
      title: overseasStatus || headline
    };
    const badge = $('quoteFreshnessBadge');
    badge.dataset.state = status.state;
    badge.textContent = status.label;
    badge.title = status.title || status.label;
    $('refreshQuotes').hidden = !taiwan;
    $('refreshMarketHoldings').hidden = taiwan || !holdings.some((item) => item.symbol && (item.micCode || item.exchange));
    $('refreshMarketHoldings').disabled = updating;
    $('refreshMarketHoldings').textContent = updating ? '更新中…' : '↻ 更新行情';
  }
  function overviewPosition(item) {
    const quote = holdingQuote(item);
    const unitPrice = livePrice(item);
    const price = unitPrice > 0 ? unitPrice : null;
    const shares = num(item.shares), cost = num(item.cost);
    const symbol = item.symbol || (holdingMarket(item) === 'tw' ? stockCode(item.name) : '');
    const name = symbol && item.name.startsWith(symbol + ' ') ? item.name.slice(symbol.length + 1) : item.name;
    return { item, quote, symbol, name, shares, cost, price, currency: holdingCurrency(item),
      value: price == null ? null : price * shares, pnl: price == null ? null : (price - cost) * shares,
      pnlPct: price != null && cost > 0 && shares > 0 ? (price - cost) / cost * 100 : null };
  }
  const pnlClass = (value) => value < 0 ? 'negative' : value > 0 ? 'positive' : '';
  function overviewPriceSource(row) {
    const { quote, item, price } = row;
    if (quote) {
      const taiwan = holdingMarket(item) === 'tw';
      return [quote.source || (taiwan ? 'TWSE／TPEx' : 'Twelve Data'), taiwan ? '收盤' : '報價', quote.datetime || quote.date || '資料時間未提供'].join(' · ');
    }
    return price == null ? '尚無可用價格' : ['備用價', item.updated].filter(Boolean).join(' · ');
  }
  function renderOverviewHoldings() {
    const market = $('overviewMarketFilter').value;
    const marketHoldings = state.holdings.filter((item) => holdingMarket(item) === market);
    renderOverviewSummary(market, marketHoldings);
    renderOverviewQuoteStatus();
    const { key, descending } = overviewSort;
    const rows = marketHoldings.map(overviewPosition).sort((a, b) => {
      const group = a.currency.localeCompare(b.currency);
      if (group && ['cost', 'price', 'value', 'pnl'].includes(key)) return group;
      const left = a[key], right = b[key];
      if (left == null || right == null) return Number(left == null) - Number(right == null);
      const order = key === 'symbol' ? (left || a.name).localeCompare(right || b.name, 'zh-TW') : left - right;
      return (descending ? -order : order) || a.name.localeCompare(b.name, 'zh-TW');
    });
    $('overviewPositionCount').textContent = `${rows.length} 筆`;
    $('overviewTable').hidden = !rows.length;
    $('overviewColumns').hidden = !rows.length;
    $('overviewTableHelp').hidden = !rows.length || $('overviewColumns').getAttribute('aria-expanded') !== 'true';
    $('overviewEmpty').hidden = Boolean(rows.length);
    $('overviewEmpty').textContent = rows.length ? '' : `尚無${marketLabels[market]}持股。可使用上方「新增持股」。`;
    for (const button of $('overviewTable').querySelectorAll('[data-desk-sort]')) {
      const header = button.closest('th');
      if (button.dataset.deskSort === key) header.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      else header.removeAttribute('aria-sort');
    }
    const focusedId = document.activeElement?.dataset.deskPosition;
    $('overviewHoldings').innerHTML = rows.map((row) => {
      const { item, symbol, name, shares, cost, price, value, pnl, pnlPct, currency } = row;
      const valueText = (amount) => amount == null ? '—' : esc(currencyMoney(amount, currency));
      return `<tr>
        <th scope="row"><button type="button" class="desk-position-link" data-desk-position="${esc(item.id)}">${symbol ? `<strong>${esc(symbol)}</strong>` : ''}<span>${esc(name)}</span></button></th>
        <td>${shares.toLocaleString('zh-TW')}</td><td>${valueText(cost)}</td>
        <td title="${esc(overviewPriceSource(row))}">${valueText(price)}${!row.quote && price != null ? '<small>備用價</small>' : ''}</td>
        <td>${valueText(value)}</td><td class="${pnlClass(pnl)}">${valueText(pnl)}${pnlPct == null ? '' : `<small>${pct(pnlPct)}</small>`}</td>
      </tr>`;
    }).join('');
    if (focusedId) [...$('overviewHoldings').querySelectorAll('button')].find((button) => button.dataset.deskPosition === focusedId)?.focus({ preventScroll: true });
    if ($('overviewHoldingDialog').open) renderOverviewHoldingDetail();
  }
  function setQuoteFreshness(state, label, title = '') {
    taiwanQuoteFreshness = { state, label, title };
    renderOverviewQuoteStatus();
  }
  function quoteChangePct(quote) {
    const price = num(quote.price), change = Number(quote.change);
    return quote.change != null && price - change > 0 && Number.isFinite(change) ? change / (price - change) * 100 : null;
  }
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
      if (data.warnings?.length) {
        const note = document.createElement('p');
        note.className = 'source-warning'; note.textContent = data.warnings.join(' ');
        panel.prepend(note);
      }
    } catch (error) {
      panel.innerHTML = `<span class="feature-empty">${esc(error.message)}</span>`; button.textContent = '重試基本面';
    } finally { button.disabled = false; }
  }
  function renderStockWatchlist() {
    marketPerformance.refresh();
    $('watchlistCount').textContent = `${state.watchlist.length} 檔`;
    if (!state.watchlist.length) { $('stockWatchlist').innerHTML = '<div class="stock-watch-empty">還沒有待觀察股票。查詢個股後按「加入自選」。</div>'; return; }
    const selectedGroup = $('watchlistGroupFilter').value || 'all', visibleCodes = state.watchlist.filter((code) => selectedGroup === 'all' || (state.watchlistGroups[code] || '觀察中') === selectedGroup);
    const order = $('watchlistSort').value;
    if (order === 'code') visibleCodes.sort((a, b) => String(a).localeCompare(String(b), 'zh-TW', { numeric: true }));
    if (order === 'gain' || order === 'loss') {
      const quoteMove = (code) => { const quote = quoteMap.get(String(code)); return quote ? quoteChangePct(quote) : null; };
      visibleCodes.sort((a, b) => {
        const first = quoteMove(a), second = quoteMove(b);
        if (first == null || second == null) return Number(first == null) - Number(second == null);
        return order === 'gain' ? second - first : first - second;
      });
    }
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
    const cards = [];
    holdings.forEach((item) => {
      const code = stockCode(item.name), quote = quoteMap.get(code), value = livePrice(item) * num(item.shares);
      const cost = num(item.cost) * num(item.shares), rate = cost ? ((value - cost) / cost) * 100 : 0;
      const dailyMove = quote ? quoteChangePct(quote) : null;
      if (dailyMove != null && Math.abs(dailyMove) >= 5) cards.push(`<article class="insight-item"><span class="insight-mark warn">↕</span><div><b>${esc(item.name)}：最近交易日波動較大</b><p>官方行情顯示漲跌 ${pct(dailyMove)}。可核對公告、新聞與事件日期。</p></div></article>`);
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
      const badgeText = data.stale ? '沿用收盤資料 ' + dataDate : data.warnings?.length ? '部分市場有更新 ' + dataDate : '官方收盤 ' + dataDate;
      setQuoteFreshness(data.stale ? 'stale' : data.warnings?.length ? 'error' : 'fresh', badgeText, data.warnings?.join(' · ') || '最近查詢 ' + new Date(lastQuoteFetchAt).toLocaleString('zh-TW'));
      if (data.warnings?.length) $('quoteStatus').textContent += ` · ${data.warnings.join('、')}`;
      if (taiwanHoldings.length && !matched) showToast('行情已連線，但台股持股名稱中需要有 4–6 碼股票代號才能配對。');
    } catch (error) { const detail = error.message.includes('Failed to fetch') ? '無法連到資料服務，請確認服務已啟動。' : error.message; const previousDate = [...quoteMap.values()].map((row) => row.date).filter(Boolean).sort().at(-1); $('quoteStatus').textContent = previousDate ? `更新失敗，暫沿用 ${previousDate} 的舊資料 · ${detail}` : `行情更新失敗 · ${detail}`; setQuoteFreshness('error', previousDate ? `更新失敗 · 沿用 ${previousDate}` : '行情更新失敗', detail); $('candidateContent').innerHTML = `<div class="news-empty">公開行情暫時無法取得：${esc(error.message)}</div>`; showToast('行情更新失敗；總覽已標出目前資料日期。'); }
    finally { button.disabled = false; candidateButton.disabled = false; button.textContent = '↻ 更新行情'; candidateButton.textContent = '更新市場行情'; }
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
    $('newsContent').innerHTML = items.map((item) => `<article class="news-item"><span class="news-date">${esc(item.publishedAt || '最新')}</span><div class="news-main"><a class="news-story-link" href="${esc(webLink(item.link) || webLink(item.searchLink) || 'https://news.google.com/')}" target="_blank" rel="noopener noreferrer"><b>${esc(item.title)}</b></a><small>${esc(item.source || 'Google News RSS')}</small><div class="news-actions">${webLink(item.sourceUrl) ? `<a href="${esc(webLink(item.sourceUrl))}" target="_blank" rel="noopener noreferrer">來源網站 ↗</a>` : ''}<a href="${esc(webLink(item.searchLink) || `https://news.google.com/search?q=${encodeURIComponent(`\"${item.title}\"`)}&hl=zh-TW&gl=TW`)}" target="_blank" rel="noopener noreferrer">Google News 備用連結 ↗</a></div></div></article>`).join('');
  }
  async function refreshNews() {
    const selected = $('newsStockFilter').value;
    const matching = selected === 'all' ? state.holdings : state.holdings.filter((item) => item.id === selected);
    const chosen = matching.slice(-12);
    const keyword = $('newsKeyword').value.trim();
    if (!chosen.length && !keyword) { $('newsFreshness').dataset.state = 'pending'; $('newsFreshness').textContent = '等待查詢條件'; return renderNews([], '請先新增持股，或輸入關鍵字搜尋新聞。'); }
    const button = $('refreshNews'); button.disabled = true; button.textContent = '載入中…';
    $('newsFreshness').dataset.state = 'loading'; $('newsFreshness').textContent = '查詢中…';
    try {
      const stocks = chosen.map((item) => holdingMarket(item) === 'tw'
        ? { name: item.name.replace(/\b\d{4,6}\b/g, '').trim(), code: stockCode(item.name) }
        : { name: item.name, code: '' });
      const terms = stocks.flatMap((item) => [item.name.slice(0, 32), item.code].filter(Boolean));
      const query = [terms.length ? `(${terms.map((term) => `"${term}"`).join(' OR ')})` : '', keyword].filter(Boolean).join(' ');
      const params = new URLSearchParams({ stocks: JSON.stringify(stocks), keyword });
      const response = await fetch(`/api/news?${params}`, { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.error || '動態更新失敗');
      const searchUrl = `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW`;
      $('newsSourceLinks').innerHTML = `<a class="mops-chip" href="${esc(searchUrl)}" target="_blank" rel="noopener noreferrer">在 Google News 開啟完整搜尋結果 ↗</a>`;
      renderNews(data.items);
      const queriedAt = new Date(); $('newsFreshness').dataset.state = 'fresh'; $('newsFreshness').textContent = `查詢於 ${queriedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}${matching.length > chosen.length ? ' · 查詢最近新增的 12 筆持股' : ''}`; $('newsFreshness').title = `最近成功查詢：${queriedAt.toLocaleString('zh-TW')}`;
    } catch (error) { $('newsFreshness').dataset.state = 'error'; $('newsFreshness').textContent = '查詢失敗'; $('newsFreshness').title = error.message; $('newsSourceLinks').innerHTML = ''; renderNews([], error.message || '新聞來源暫時無法連線，請稍後重試。'); }
    finally { button.disabled = false; button.textContent = '⌕ 搜尋新聞'; }
  }
  $('globalDemoFill').addEventListener('click', () => {
    $('globalEvent').value = 'NVIDIA AI 晶片出口限制';
    for (const id of ['globalCompany', 'globalTicker', 'globalTaiwanCodes', 'globalRelation']) $(id).value = '';
    $('globalResearchStatus').textContent = '已填入範例。送出後會查詢公開新聞。';
    $('globalEvent').focus();
  });
  const updateGlobalResearchMode = () => {
    const sourcesOnly = $('globalAiProvider').value === 'sources';
    $('globalResearchConsent').closest('label').hidden = sourcesOnly;
    $('globalResearchConsent').checked = false;
    $('globalResearchStatus').textContent = sourcesOnly ? '以新聞標題比對上市櫃公司名稱，台股代號可留白。' : '模型可補充產業傳導，個股仍須有可核對的事件來源。';
  };
  $('globalAiProvider').addEventListener('change', updateGlobalResearchMode);
  updateGlobalResearchMode();
  $('globalResearchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const selector = $('globalAiProvider'), button = $('globalResearchSubmit');
    if (button.disabled) return;
    const provider = selector.value, consent = $('globalResearchConsent').checked;
    const query = { event: $('globalEvent').value.trim(), companyName: $('globalCompany').value.trim(),
      ticker: $('globalTicker').value.trim(), taiwanCodes: $('globalTaiwanCodes').value.trim(), relation: $('globalRelation').value.trim() };
    if (!query.event) { $('globalResearchStatus').textContent = '請輸入海外事件或新聞標題。'; $('globalEvent').focus(); return; }
    if (provider !== 'sources' && !consent) { $('globalResearchStatus').textContent = '請先閱讀並勾選資料傳送同意。'; $('globalResearchConsent').focus(); return; }
    button.disabled = true; selector.disabled = true; button.textContent = '查詢與整理中…'; $('globalResearchResult').hidden = true;
    $('globalResearchConsent').checked = false;
    $('globalResearchStatus').textContent = '正在查詢新聞與上市櫃公司名錄…';
    try {
      const { data: sessionData } = await supabaseClient?.auth.getSession() || {};
      const headers = { 'Content-Type': 'application/json' };
      if (sessionData?.session?.access_token) headers.Authorization = `Bearer ${sessionData.session.access_token}`;
      const response = await fetch('/api/international-research', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ ...query, provider, aiConsent: consent }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '國際事件查詢失敗，請稍後重試。');
      const research = data.research || {}, sec = research.sec || {};
      const filings = (sec.filings || []).map((filing) => `<li><a href="${esc(webLink(filing.url) || 'https://www.sec.gov/edgar/search/')}" target="_blank" rel="noopener noreferrer">${esc(filing.form)} · 申報 ${esc(filing.date)}${filing.period ? ` · 期間 ${esc(filing.period)}` : ''}</a>${filing.description ? `<small>${esc(filing.description)}</small>` : ''}</li>`).join('');
      const financials = (sec.financials || []).map((metric) => `<span class="global-metric"><small>${esc(metric.label)} · ${esc(metric.end)} · ${esc(metric.form)}</small><b>${Number(metric.value).toLocaleString('zh-TW')} ${esc(metric.unit)}</b></span>`).join('');
      const newsItems = (research.headlines || []).map((item) => `<li><a href="${esc(webLink(item.link) || webLink(item.searchLink) || 'https://news.google.com/')}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a><small>${esc(item.publishedAt || '')} · ${esc(item.source || 'Google News')}${item.description ? ` · ${esc(item.description)}` : ''}</small></li>`).join('');
      const analysis = data.impactAnalysis || {}, impactStocks = analysis.stocks || [], industries = analysis.industries || [];
      const isSourceMode = data.provider === 'sources';
      const modeLabel = isSourceMode ? '公開新聞比對' : data.provider === 'ollama' ? '公開新聞比對與 Ollama 推論' : '公開新聞比對與 Gemini 推論';
      const replayStocks = [...new Map([...impactStocks, ...(analysis.requestedStocks || [])].map((item) => [item.code, item])).values()];
      const researchSources = new Map([
        ...(research.headlines || []).map((item, index) => [`N${index + 1}`, { title: item.title, url: item.link, date: item.publishedAt }]),
        ...(sec.filings || []).map((item, index) => [`F${index + 1}`, { title: `${item.form} ${item.date || ''} ${item.description || ''}`.trim(), url: item.url, date: item.date }]),
        ...(sec.financials || []).map((item, index) => [`M${index + 1}`, { title: `${item.label} ${item.end || ''}`.trim(), date: item.end }])
      ]);
      const showEvidence = (evidence) => Array.isArray(evidence) && evidence.length ? `<div class="global-evidence"><b>核對來源</b>${evidence.map((id) => { const source = researchSources.get(id); if (!source) return ''; const label = `${esc(source.title)}${source.date ? ` · ${esc(source.date)}` : ''}`; return webLink(source.url) ? `<a href="${esc(webLink(source.url))}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : `<div class="global-evidence-text">${label}</div>`; }).join('')}</div>` : '';
      const directionClass = (value) => value === '可能受惠' ? 'positive' : value === '可能承壓' ? 'negative' : 'uncertain';
      const industryCards = industries.map((item) => `<article class="global-impact-industry"><header><b>${esc(item.name)}</b></header><p>${esc(item.impact || '')}</p><small>${esc(item.transmission)}</small>${showEvidence(item.evidence)}</article>`).join('');
      const impactStockCards = impactStocks.map((item) => {
        const price = Number(item.dailyClose);
        const priceLabel = price > 0 ? ['收盤 ' + money(price), item.dailyDate].filter(Boolean).join(' · ') : '暫無收盤價';
        const details = [['事件線索', item.fact], ['可能作用途徑', item.mechanism], ['仍待確認', item.uncertainty]]
          .filter(([, value]) => value).map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('');
        return `<article class="global-impact-stock"><header><b>${esc(item.code)} ${esc(item.name || '')}</b><span class="global-impact-badge ${directionClass(item.impact)}">${esc(item.impact || '方向未定')}</span></header><small>${esc([item.connection === 'mention' ? '新聞標題提及' : '模型產業推論', item.industry, item.market, priceLabel, item.horizon].filter(Boolean).join(' · '))}</small><p>${esc(item.reason || '')}</p>${details ? `<dl class="global-impact-reason">${details}</dl>` : ''}${showEvidence(item.evidence)}</article>`;
      }).join('');
      const requestedStockCards = (analysis.requestedStocks || []).map((item) => `<article class="global-impact-stock"><header><b>${esc(item.code)} ${esc(item.name || '')}</b><span class="global-impact-badge uncertain">證據不足</span></header><p>${esc(item.reason || '')}</p></article>`).join('');
      const risks = (analysis.risks || []).map((risk) => `<li>${esc(risk)}</li>`).join('');
      const invalidCodes = (research.unrecognizedCodes || []).length ? `<p class="global-source-note">以下代號未出現在目前上市櫃個股名單：${esc(research.unrecognizedCodes.join('、'))}</p>` : '';
      const replayNews = (research.headlines || []).filter((item) => item.publishedAt && item.link).slice(0, 10);
      const replayPanel = replayStocks.length && replayNews.length ? `<section class="global-replay"><h3>歷史事件回放</h3><p>以台灣時間的新聞日期為準，比較第 5／20 個交易日收盤價。若當天開盤，當天算第 1 個交易日。</p><div class="global-replay-form"><label>事件新聞<select id="globalReplayNews">${replayNews.map((item, index) => `<option value="${index}">${esc(item.publishedAt)} · ${esc(item.title)}</option>`).join('')}</select></label><label>觀察台股<select id="globalReplayStock">${replayStocks.map((item) => `<option value="${esc(item.code)}">${esc(item.code)} ${esc(item.name)}</option>`).join('')}</select></label><button type="button" class="secondary-button" id="globalReplayRun">比較事件前後</button></div><div id="globalReplayResult" class="global-replay-result" aria-live="polite"></div></section>` : '';
      const title = research.event || query.event;
      const emptyStocks = isSourceMode
        ? '本次新聞標題沒有比對到具名台股。可改用更具體的事件標題，或選擇模型查看間接影響。'
        : '目前來源不足以判斷個股關聯。';
      const optionalCompanySources = query.companyName || query.ticker;
      $('globalResearchResult').innerHTML = `
        <div class="global-result-summary"><h3>${esc(title)}</h3><p>${esc(analysis.summary || '目前沒有足夠資料判斷事件關聯。')}</p><small>${modeLabel}</small></div>
        <section><h3>可能相關的台股 · ${impactStocks.length} 檔</h3>${impactStockCards ? `<div class="global-impact-grid">${impactStockCards}</div>` : `<p>${emptyStocks}</p>`}</section>
        ${industryCards ? `<section><h3>可能影響的產業</h3><div class="global-impact-grid">${industryCards}</div></section>` : ''}
        ${invalidCodes}${requestedStockCards ? `<section><h3>指定檢視 · 尚無關聯證據</h3><div class="global-impact-grid">${requestedStockCards}</div></section>` : ''}
        ${risks ? `<section><h3>仍需查證</h3><ul class="global-links">${risks}</ul></section>` : ''}${replayPanel}
        <section><h3>相關新聞 · ${esc(research.headlines?.length || 0)} 則</h3><ul class="global-links">${newsItems || '<li>目前找不到相關新聞。</li>'}</ul></section>
        ${optionalCompanySources ? `<section><h3>SEC 申報與財務資料</h3>${sec.available ? `<p class="global-source-note">SEC EDGAR · ${esc(sec.company)}</p>${financials ? `<div class="global-metrics">${financials}</div>` : ''}<ul class="global-links">${filings || '<li>目前沒有近期申報文件。</li>'}</ul>` : `<p>${esc(sec.reason || '未取得 SEC 資料。')}</p>`}</section>` : ''}
        <small class="global-updated">新聞來源 Google News RSS · 公司名錄及收盤資料 TWSE／TPEx · 查詢時間 ${esc(research.generatedAt ? new Date(research.generatedAt).toLocaleString('zh-TW') : '—')}</small>`;
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
          const eventDate = replayDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
          const replayResponse = await fetch('/api/event-replay', { method: 'POST', headers: replayHeaders, cache: 'no-store', body: JSON.stringify({ code, name: $('globalReplayStock').selectedOptions[0]?.textContent || '', eventDate }) });
          const replayData = await replayResponse.json();
          if (!replayResponse.ok) throw new Error(replayData.error || '歷史回放暫時無法讀取。');
          const rows = replayData.comparisons || [];
          resultNode.innerHTML = `<div class="global-replay-heading"><b>${esc(replayData.code)} ${esc(replayData.name || '')}</b><span>新聞日 ${esc(replayData.eventDate)} · 基準日 ${esc(replayData.baselineDate || '無資料')} · 基準收盤 ${replayData.baseline !== null && replayData.baseline !== undefined ? money(replayData.baseline) : '無資料'}</span></div><div class="global-replay-metrics">${rows.map((row) => `<article><small>事件後 ${row.tradingDays} 個交易日 · ${esc(row.date || '尚未累積')}</small><b class="${Number(row.changePercent) >= 0 ? 'positive' : 'negative'}">${row.close ? `${money(row.close)}　${Number(row.changePercent) >= 0 ? '+' : ''}${Number(row.changePercent).toFixed(2)}%` : '尚未有足夠後續資料'}</b></article>`).join('')}</div><small>${esc(replayData.note || '')} 來源：${esc(replayData.source)}；事件日前後價格比較只呈現時間關聯，不代表因果關係。</small>`;
        } catch (error) { resultNode.textContent = error.message || '歷史回放讀取失敗。'; }
        finally { replayButton.disabled = false; replayButton.textContent = '比較事件前後'; }
      });
      $('globalResearchResult').hidden = false;
      const incompleteNews = Number(research.newsStatus?.failedSearches) || 0;
      $('globalResearchStatus').textContent = [data.warning, `取得 ${research.headlines?.length || 0} 則新聞，列出 ${impactStocks.length} 檔台股。`, incompleteNews ? '部分新聞查詢未成功。' : ''].filter(Boolean).join(' ');
      if (!isSourceMode) void refreshAssistantMetrics();
    } catch (error) { $('globalResearchStatus').textContent = error.message || '查詢失敗，請稍後再試。'; }
    finally { button.disabled = false; selector.disabled = false; button.textContent = '找相關台股'; }
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
  mountHoldingImport({
    getHoldings: () => state.holdings,
    getQuotes: () => quoteMap,
    getTransactions: () => state.transactions.map((row) => ({ ...row, code: stockCode(row.stock) })),
    today: isoToday,
    saveTrades: (rows, applyToHoldings) => {
      if ($('appShell').hidden || (supabaseClient && !cloudReady)) return false;
      const batch = { holdings: state.holdings.map((item) => ({ ...item })), transactions: [...state.transactions] };
      for (const { issues, ...trade } of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
        if (applyToHoldings) {
          const error = applyTransaction(batch, trade);
          if (error) {
            showToast(`${trade.date} ${trade.stock}：${error}`);
            return false;
          }
        } else {
          batch.transactions.push({ ...trade, id: crypto.randomUUID(), recordOnly: true, realizedPnl: null });
        }
      }
      state.holdings = batch.holdings;
      state.transactions = batch.transactions;
      persist();
      render();
      showToast(`已匯入 ${rows.length} 筆成交。${applyToHoldings ? '持股已更新。' : ''}`);
      return true;
    },
    escape: esc,
    requestCloudScan: async (provider, image, signal) => {
      const { data, error } = await supabaseClient?.auth.getSession() || {};
      const token = data?.session?.access_token;
      if (supabaseClient && (error || !token)) throw new Error('請重新登入後再使用整圖辨識。');
      const response = await fetch('/api/holdings/image', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ provider, aiConsent: true, image })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(result?.rows)) {
        const scanError = new Error(result?.error || '暫時無法辨識圖片，請稍後再試。');
        scanError.retryAfterSeconds = result?.retryAfterSeconds;
        throw scanError;
      }
      return result.rows;
    },
    saveHoldings: (rows) => {
      if ($('appShell').hidden || (supabaseClient && !cloudReady)) return false;
      const replacements = new Map(), additions = [];
      const updated = new Date().toLocaleDateString('zh-TW');
      for (const { action, existing, code, name, shares, cost, price, quote } of rows) {
        const prior = action === 'update' ? existing[0] : null;
        const fallbackPrice = Number(prior?.price) > 0 ? Number(prior.price) : Number(quote?.price) || 0;
        const position = { shares, cost, price: price ?? fallbackPrice, updated };
        if (prior) replacements.set(prior, { ...prior, ...position });
        else additions.push({
          id: crypto.randomUUID(), market: 'tw', currency: 'TWD', symbol: code, exchange: '', micCode: '',
          name: `${code} ${name}`.slice(0, 80), targetWeight: 0, ...position
        });
      }
      state.holdings = state.holdings.map((holding) => replacements.get(holding) || holding).concat(additions);
      $('overviewMarketFilter').value = 'tw';
      persist();
      render();
      showToast(`已新增 ${additions.length} 筆、更新 ${replacements.size} 筆持股。`);
      if (!quoteMap.size) void refreshQuotes();
      return true;
    }
  });
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
  $('overviewMarketFilter').addEventListener('change', () => {
    renderOverviewHoldings();
    if ($('overviewMarketFilter').value === 'tw' && Date.now() - lastQuoteFetchAt > 60000) refreshQuotes();
    else refreshSelectedMarketHoldings();
  });
  $('refreshMarketHoldings').addEventListener('click', () => refreshSelectedMarketHoldings(true));
  $('overviewColumns').addEventListener('click', (event) => {
    const button = event.currentTarget;
    const expanded = button.getAttribute('aria-expanded') === 'false';
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? '精簡欄位' : '完整欄位';
    $('overviewTable').classList.toggle('show-all-columns', expanded);
    $('overviewTable').scrollLeft = 0;
    $('overviewTableHelp').hidden = !expanded;
  });
  $('overviewTable').addEventListener('click', (event) => {
    const button = event.target.closest('[data-desk-sort]');
    if (!button) return;
    const key = button.dataset.deskSort;
    overviewSort = { key, descending: key === overviewSort.key ? !overviewSort.descending : key !== 'symbol' };
    renderOverviewHoldings();
  });
  const overviewHoldingDialog = $('overviewHoldingDialog');
  const selectedOverviewHolding = () => state.holdings.find((item) => item.id === overviewHoldingId);
  function renderOverviewHoldingDetail() {
    const item = selectedOverviewHolding();
    if (!item) { if (overviewHoldingDialog.open) overviewHoldingDialog.close(); return; }
    const row = overviewPosition(item);
    $('overviewHoldingIdentity').textContent = [row.symbol, marketLabels[holdingMarket(item)], row.currency, item.exchange].filter(Boolean).join(' · ');
    $('overviewHoldingTitle').textContent = row.name || row.symbol;
    const amount = (value) => value == null ? '—' : currencyMoney(value, row.currency);
    const stats = [
      ['持有股數', row.shares.toLocaleString('zh-TW')],
      ['每股均價', amount(row.cost)], ['最新價格', amount(row.price)],
      ['持倉市值', amount(row.value)], ['投入成本', amount(row.shares * row.cost)],
      ['未實現損益', [amount(row.pnl), row.pnlPct == null ? '' : pct(row.pnlPct)].filter(Boolean).join(' · '), pnlClass(row.pnl)]
    ];
    $('overviewHoldingStats').innerHTML = stats.map(([label, value, color]) => `<div><dt>${label}</dt><dd class="${color || ''}">${esc(value)}</dd></div>`).join('');
    $('overviewHoldingSource').textContent = overviewPriceSource(row);
    $('overviewHoldingTrend').disabled = !row.symbol;
    $('overviewHoldingTrend').textContent = holdingMarket(item) === 'tw' ? '技術趨勢' : '個股行情';
    $('overviewHoldingScenario').dataset.simulateHolding = item.id;
  }
  $('overviewHoldings').addEventListener('click', (event) => {
    const button = event.target.closest('[data-desk-position]');
    if (!button) return;
    overviewHoldingId = button.dataset.deskPosition;
    renderOverviewHoldingDetail();
    if (selectedOverviewHolding()) overviewHoldingDialog.showModal();
  });
  $('overviewHoldingEdit').addEventListener('click', () => {
    const item = selectedOverviewHolding();
    overviewHoldingDialog.close();
    if (item) openHolding(item);
  });
  $('overviewHoldingTrend').addEventListener('click', () => {
    const item = selectedOverviewHolding();
    if (!item) return;
    const { symbol } = overviewPosition(item);
    const market = holdingMarket(item);
    overviewHoldingDialog.close();
    if (market === 'tw') openStockAnalysis(symbol);
    else openMarketLookup(symbol, market);
  });
  $('overviewHoldingScenario').addEventListener('click', () => overviewHoldingDialog.close());
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
    if (remove) {
      state.watchlist = state.watchlist.filter((code) => code !== remove.dataset.watchRemove);
      delete state.watchlistGroups[remove.dataset.watchRemove]; persist(); renderStockWatchlist();
      if ($('stockLookupMarket').value === 'tw' && $('stockLookupInput').value.trim()) showStockLookup($('stockLookupInput').value);
      showToast('已從待觀察清單移除。');
    }
    if (analyze) openStockAnalysis(analyze.dataset.stockAnalyze);
  });
  $('stockWatchlist').addEventListener('change', (event) => { const select = event.target.closest('[data-watch-group]'); if (!select) return; state.watchlistGroups[select.dataset.watchGroup] = select.value; persist(); renderStockWatchlist(); showToast(`已移至「${select.value}」分組。`); });
  $('watchlistGroupFilter').addEventListener('change', renderStockWatchlist);
  $('watchlistSort').addEventListener('change', renderStockWatchlist);
  $('reloadPage').addEventListener('click', () => window.location.reload());
  const deskSettings = $('deskSettings');
  document.addEventListener('click', (event) => {
    if (!deskSettings.open) return;
    if (!deskSettings.contains(event.target) || event.target.closest('#importBtn, #exportBtn, #installAppBtn, #accountProfileBtn, #logoutBtn, .desk-settings-panel a')) {
      deskSettings.open = false;
    }
  });
  deskSettings.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !deskSettings.open) return;
    event.preventDefault();
    deskSettings.open = false;
    deskSettings.querySelector('summary').focus();
  });
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
    if (item.market === 'tw') refreshQuotes();
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
    event.preventDefault();
    const type = $('transactionType').value;
    const transaction = {
      type, stock: $('transactionStock').value.trim(), date: $('transactionDate').value,
      shares: num($('transactionShares').value), price: num($('transactionPrice').value),
      fees: num($('transactionFees').value), tax: num($('transactionTax').value), note: $('transactionNote').value.trim()
    };
    const error = applyTransaction(state, transaction);
    if (error) return showToast(error);
    persist(); render(); $('transactionDialog').close(); showToast(type === 'buy' ? '買進紀錄已儲存，持股成本已更新。' : type === 'sell' ? '賣出紀錄已儲存。' : '股利紀錄已儲存。');
  });
  function applyTransaction(portfolio, transaction) {
    const { type, stock, date, shares, price, fees, tax } = transaction;
    if (!stock || shares <= 0 || price < 0 || fees < 0 || tax < 0) return '請檢查交易資料。';
    if (!date || date > isoToday()) return '交易日期不能晚於今天。';
    const code = stockCode(stock);
    if (type !== 'dividend' && portfolio.transactions.some((row) => row.type !== 'dividend' && !row.recordOnly && row.date > date
        && ((code && stockCode(row.stock) === code) || row.stock.toLowerCase() === stock.toLowerCase()))) {
      return '此股票已有較晚的成交紀錄。請按成交日期順序記錄，避免平均成本與已實現損益錯置。';
    }
    const taiwanHoldings = portfolio.holdings.filter((item) => holdingMarket(item) === 'tw');
    if (portfolio.holdings.some((item) => holdingMarket(item) !== 'tw' && [item.symbol, item.name].some((name) => name?.toLowerCase() === stock.toLowerCase())) &&
        !taiwanHoldings.some((item) => item.name.toLowerCase() === stock.toLowerCase())) {
      return '交易與股利紀錄適用台股。海外持股可在「我的持股」編輯。';
    }
    let holding = taiwanHoldings.find((item) => code && stockCode(item.name) === code);
    if (!holding) holding = taiwanHoldings.find((item) => item.name.toLowerCase() === stock.toLowerCase());
    let realizedPnl = 0;
    if (type === 'buy') {
      if (!holding) { holding = { id: crypto.randomUUID(), name: stock, shares: 0, cost: 0, price, targetWeight: 0, updated: isoToday() }; portfolio.holdings.push(holding); }
      holding.cost = (num(holding.shares) * num(holding.cost) + shares * price + fees + tax) / (num(holding.shares) + shares); holding.shares = num(holding.shares) + shares; holding.price = price;
    } else if (type === 'sell') {
      if (!holding || shares > num(holding.shares)) return '賣出股數不能多於目前持有股數。';
      realizedPnl = shares * (price - num(holding.cost)) - fees - tax; holding.shares = num(holding.shares) - shares; holding.price = price;
      if (holding.shares <= 0.0000001) portfolio.holdings = portfolio.holdings.filter((item) => item.id !== holding.id);
    }
    portfolio.transactions.push({ ...transaction, id: crypto.randomUUID(), realizedPnl });
    return '';
  }
  $('addAlert').addEventListener('click', () => {
    $('alertForm').reset();
    const holdings = state.holdings.filter((item) => holdingMarket(item) === 'tw');
    if (holdings.length === 1) $('alertStock').value = holdings[0].name;
    $('alertDialog').showModal();
  });
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
  let fugleConfigured = false, trendData = null, heldStockData = null, heldStockRequest = 0;
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
  const assistantHistory = { fugle: [], ollama: [], gemini: [] };
  const assistantLabels = { fugle: 'Fugle 摘要', ollama: 'Ollama', gemini: 'Gemini' };
  function renderAssistantMetrics(data) {
    let node = $('assistantMetrics');
    if (!node) { node = document.createElement('p'); node.id = 'assistantMetrics'; $('assistantMetricsInfo').append(node); }
    const provider = $('assistantProvider').value;
    $('assistantMetricsInfo').hidden = !['ollama', 'gemini'].includes(provider);
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
      .replace(/\b(NT|US|HK|CA|AU|SG|NZ)\$/gi, '$1' + currencyMarker)
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
  function addAssistantMessage(role, content, provider) {
    const list = $('assistantMessages');
    list.querySelector('.assistant-empty')?.remove();
    const bubble = document.createElement('div');
    bubble.className = `assistant-message assistant-message-${role}`;
    const label = document.createElement('b');
    label.textContent = role === 'user' ? (provider === 'fugle' ? '查詢' : '你') : assistantLabels[provider];
    const text = document.createElement('p'); text.textContent = formatAssistantText(content);
    bubble.append(label, text); list.append(bubble); list.scrollTop = list.scrollHeight;
    return bubble;
  }
  let assistantProviderAvailability = { fugle: false, ollama: false, gemini: false };
  function updateAssistantProviderCopy() {
    const provider = $('assistantProvider').value, useOllama = provider === 'ollama', useFugle = provider === 'fugle';
    const name = useFugle ? 'Fugle 行情服務' : useOllama ? 'Ollama' : 'Gemini';
    $('assistantDisclosure').textContent = useFugle
      ? '摘要由程式根據行情和歷史日 K 計算。查詢會將股票代號送到行情服務。'
      : `送出後，${name} 會收到主題、本次問題和此模型最近 4 組問答。填入代號時，也會附上行情與技術指標。程式不會自動附上持倉資料。對話留在目前頁面。`;
    $('assistantConsentLabel').textContent = useFugle
      ? '同意以此代號查詢行情'
      : `同意把上述資料送給 ${name}`;
    $('assistantConsent').checked = false;
    const assistantInput = $('assistantInput');
    assistantInput.disabled = useFugle;
    assistantInput.required = !useFugle;
    $('assistantQuestionField').hidden = useFugle;
    $('assistantTopicRow').hidden = useFugle;
    $('assistantSymbol').required = useFugle;
    $('assistantSymbolLabel').textContent = useFugle ? '股票代號' : '股票代號（選填）';
    $('assistantSend').textContent = useFugle ? '查詢行情摘要' : '送出問題';
    $('assistantBadge').textContent = assistantProviderAvailability[provider] ? `${name}已設定` : `${name}尚未設定`;
    $('assistantBadge').classList.toggle('source-warning', !assistantProviderAvailability[provider]);
    $('assistantSend').disabled = !assistantProviderAvailability[provider];
    $('assistantMetricsInfo').hidden = useFugle;
    $('assistantStatus').textContent = assistantProviderAvailability[provider] ? '' : '目前沒有設定這項服務。';
    const log = $('assistantMessages');
    log.replaceChildren();
    const history = assistantHistory[provider] || [];
    if (history.length) history.forEach(({ role, content }) => addAssistantMessage(role, content, provider));
    else {
      const hint = document.createElement('p');
      hint.className = 'assistant-empty';
      hint.textContent = useFugle ? '輸入股票代號查看行情與技術摘要。' : '輸入問題後，回答會顯示在這裡。';
      log.append(hint);
    }
  }
  async function checkAssistantStatus() {
    try {
      const response = await fetch('/api/assistant/status', { cache: 'no-store' }), data = await response.json();
      assistantProviderAvailability = data.providers || { fugle: false, ollama: data.provider === 'ollama' && data.configured, gemini: data.provider === 'gemini' && data.configured };
      $('assistantBadge').dataset.ollamaModel = data.ollamaModel || (data.provider === 'ollama' ? data.model : '') || '本機模型';
      const select = $('assistantProvider');
      [...select.options].forEach((option) => { option.disabled = !assistantProviderAvailability[option.value]; });
      const ollamaAssistantOption = select.querySelector('option[value="ollama"]');
      ollamaAssistantOption.textContent = assistantProviderAvailability.ollama ? `Ollama（${$('assistantBadge').dataset.ollamaModel}）` : 'Ollama（尚未設定）';
      $('globalAiProvider').querySelector('option[value="ollama"]').disabled = !assistantProviderAvailability.ollama;
      $('globalAiProvider').querySelector('option[value="gemini"]').disabled = !assistantProviderAvailability.gemini;
      if ($('globalAiProvider').selectedOptions[0]?.disabled) { $('globalAiProvider').value = 'sources'; updateGlobalResearchMode(); }
      const ollamaTopupOption = $('topupMode').querySelector('option[value="ollama"]');
      ollamaTopupOption.disabled = !assistantProviderAvailability.ollama;
      if (!assistantProviderAvailability.ollama) ollamaTopupOption.textContent = 'Ollama 分析（尚未設定）';
      if (ollamaTopupOption.disabled && $('topupMode').value === 'ollama') { $('topupMode').value = 'fugle'; updateTopupMode(); }
      if (!assistantProviderAvailability[select.value]) select.value = assistantProviderAvailability[data.provider] ? data.provider : assistantProviderAvailability.ollama ? 'ollama' : assistantProviderAvailability.gemini ? 'gemini' : 'fugle';
      select.addEventListener('change', () => {
        updateAssistantProviderCopy();
        $('assistantMetrics')?.replaceChildren();
        void refreshAssistantMetrics();
      });
      updateAssistantProviderCopy();
      renderAssistantMetrics(data);
      if (!assistantProviderAvailability.ollama && !assistantProviderAvailability.gemini && !assistantProviderAvailability.fugle) $('assistantStatus').textContent = '尚未設定 Fugle 或可用的助理服務。';
    } catch { $('assistantBadge').textContent = '助理設定無法讀取'; $('assistantSend').disabled = true; $('assistantStatus').textContent = '目前無法讀取助理設定，請重新整理後再試。'; }
  }
  $('assistantForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const selector = $('assistantProvider'), provider = selector.value, button = $('assistantSend');
    if (button.disabled || !assistantProviderAvailability[provider]) return;
    const symbol = $('assistantSymbol').value.trim();
    const question = provider === 'fugle' ? `查詢 ${symbol} 行情與技術摘要` : $('assistantInput').value.trim();
    if (!question) return;
    if (provider === 'fugle' && !/^\d{4,6}$/.test(symbol)) { $('assistantStatus').textContent = 'Fugle 摘要需要 4–6 位數股票代號，例如 2330。'; $('assistantSymbol').focus(); return; }
    if (!$('assistantConsent').checked) { $('assistantStatus').textContent = '請先閱讀並勾選資料傳送同意，再送出問題。'; $('assistantConsent').focus(); return; }
    $('assistantConsent').checked = false;
    button.disabled = true; selector.disabled = true;
    $('assistantStatus').textContent = provider === 'fugle' ? '正在查詢行情…' : `等待 ${assistantLabels[provider]} 回覆…`;
    const history = assistantHistory[provider];
    const userMessage = { role: 'user', content: question };
    const earlier = history.slice(-8).map(({ role, content }) => ({ role, content: content.trim().slice(0, 2000) }));
    const topic = $('assistantTopic').value;
    try {
      const { data } = await supabaseClient?.auth.getSession() || {};
      const headers = { 'Content-Type': 'application/json' };
      if (data?.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
      const response = await fetch('/api/assistant', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ topic, provider, symbol, aiConsent: true, messages: provider === 'fugle' ? [] : [...earlier, userMessage] }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '助理暫時無法回答，請稍後再試。');
      if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('服務沒有回傳可顯示的結果。');
      history.push(userMessage, { role: 'assistant', content: result.answer });
      history.splice(0, Math.max(0, history.length - 10));
      if (provider !== 'fugle' && $('assistantInput').value.trim() === question) $('assistantInput').value = '';
      updateAssistantProviderCopy();
      $('assistantStatus').textContent = '';
      void refreshAssistantMetrics();
    } catch (error) {
      $('assistantStatus').textContent = error.message || '連線失敗，請稍後再試。'; void refreshAssistantMetrics();
    } finally { button.disabled = false; selector.disabled = false; }
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
    $('topupMode').querySelector('[value="ollama"]').disabled = !assistantProviderAvailability.ollama || Boolean(item && holdingMarket(item) !== 'tw');
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
          ...input, symbol: input.symbolOrName, name: overviewPosition(holding).name, price, currency: holdingCurrency(holding),
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
      $('topupResult').innerHTML = `<div class="topup-result-heading"><div><b>${esc(item.symbol)} ${esc(item.name || '')}</b><small>${esc([item.quoteDate || item.quoteUpdatedAt || '行情時間未提供', item.quoteDate && item.quoteUpdatedAt !== item.quoteDate ? item.quoteUpdatedAt : '', item.priceType].filter(Boolean).join(' · '))}</small></div><strong>${money(item.price)}<small>${esc(item.quoteSource || 'Fugle')} 價格參考</small></strong></div><div class="topup-result-grid"><article><small>預算可買股數</small><b>${Number(item.sharesToBuy).toLocaleString('zh-TW')} 股</b></article><article><small>加碼支出（含買入手續費）</small><b>${money(item.purchaseTotal)}</b></article><article><small>加碼後總股數</small><b>${Number(item.totalShares).toLocaleString('zh-TW')} 股</b></article><article><small>加碼後均價（未含交易費）</small><b>${money(item.newAverageCost)}／股</b></article><article><small>剩餘預算</small><b>${money(item.remainingBudget)}</b></article><article><small>目前市值估算淨損益</small><b class="${item.projectedUnrealizedPnl < 0 ? 'negative' : 'positive'}">${money(item.projectedUnrealizedPnl)}</b></article><article><small>估算損益兩平價</small><b>${money(item.estimatedBreakEvenPrice)}／股</b></article><article><small>買入手續費</small><b>${money(item.buyCommission)}</b></article></div><section id="topupComparison" class="scenario-comparison" aria-label="加碼方案比較"></section>${topupScenarioMarkup(item)}<small class="topup-calculation-note">股數依 ${item.shareUnit === 1000 ? '整張（1,000 股）' : '零股（1 股）'}計算；已依你設定的費率估算交易成本，不含券商最低手續費與滑價。</small>${dataResult.analysis ? `<section class="topup-analysis"><b>Ollama 趨勢觀察</b><p>${esc(formatAssistantText(dataResult.analysis))}</p></section>` : ''}`;
      bindTopupScenario(item, holding);
      $('topupResult').hidden = false;
      $('topupStatus').textContent = dataResult.analysisWarning
        || (dataResult.analysis ? '試算完成。Ollama 的整理附在試算結果下方。' : '試算完成。');
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
    const request = ++heldStockRequest;
    const holding = state.holdings.find((item) => item.id === $('heldStockSelect').value), code = holding ? stockCode(holding.name) : '';
    const button = $('loadHeldStock');
    button.disabled = false; button.textContent = '載入個股資料';
    if (!holding) { $('heldStockStatus').textContent = '目前沒有持股可分析，請先到「我的持股」新增股票。'; $('heldStockResult').hidden = true; return; }
    if (!code) { $('heldStockStatus').textContent = '無法從持股名稱辨識股票代號。請在持股名稱中包含 4–6 碼代號，例如「2330 台積電」。'; $('heldStockResult').hidden = true; return; }
    button.disabled = true; button.textContent = '載入中…'; $('heldStockStatus').textContent = '正在讀取所選股票的歷史日 K…'; $('heldStockResult').hidden = true;
    try {
      const days = $('heldStockRange').value;
      const response = await fugleFetch(`/api/fugle/trend?symbol=${encodeURIComponent(code)}&days=${encodeURIComponent(days)}`), data = await response.json();
      if (request !== heldStockRequest) return;
      if (!response.ok) throw new Error(data.error || '個股資料讀取失敗');
      if (!data.configured) throw new Error('尚未設定 Fugle API 金鑰。請先於本機設定金鑰並重新啟動程式。');
      if (!data.candles?.length) throw new Error('此股票目前沒有可用的歷史日 K。');
      heldStockData = { ...data, holdingId: holding.id };
      $('heldStockStatus').textContent = `${holding.name}（${code}） · ${data.market || '台股'} · ${data.candles.length} 個交易日 · ${data.candles.at(-1).date} 收盤資料 · Fugle 歷史日 K`;
      $('heldStockResult').hidden = false; requestAnimationFrame(() => { if (request === heldStockRequest) renderHeldStock(data, holding); });
    } catch (error) { if (request === heldStockRequest) $('heldStockStatus').textContent = error.message; }
    finally { if (request === heldStockRequest) { button.disabled = false; button.textContent = '載入個股資料'; } }
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
    const notes = [signal, last.rsi14 == null ? 'RSI（相對強弱指標）資料累積中' : last.rsi14 >= 70 ? 'RSI（相對強弱指標）偏高' : last.rsi14 <= 30 ? 'RSI（相對強弱指標）偏低' : 'RSI（相對強弱指標）位於中間區間', last.macdHistogram == null ? 'MACD（指數平滑異同移動平均線）資料累積中' : last.macdHistogram >= 0 ? 'MACD（指數平滑異同移動平均線）動能為正' : 'MACD（指數平滑異同移動平均線）動能為負'];
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
  const pageTitles = { overview: '投資總覽', holdings: '我的持股', ledger: '交易與股利', allocation: '資產配置', alerts: '價格提醒', events: '公司事件', journal: '投資日誌', insights: '持股健檢', riskLab: '持倉壓力測試', trendAnalysis: '技術趨勢', holdingAnalysis: '持股分析', topup: '加碼試算', stockDesk: '個股查詢與自選', performance: '區間績效比較', candidates: '候選股篩選', watchlist: '價格觀察紀錄', news: '新聞與公告', globalTaiwanResearch: '國際事件與台股', assistant: '詢問助理', references: '研究來源', workspace: '多功能工作區' };
  const workspaceGrid = $('workspacePanelGrid'), workspaceHome = new Map();
  const workspaceTouch = window.matchMedia('(pointer: coarse)');
  const workspaceStacked = () => workspaceGrid.clientWidth < (workspaceTouch.matches ? 920 : 700);
  const workspaceFeatureIds = Object.keys(pageTitles).filter((id) => !['overview', 'workspace'].includes(id));
  workspaceFeatureIds.forEach((id) => { const element = $(id); if (element?.parentElement) workspaceHome.set(id, { parent: element.parentElement, next: element.nextElementSibling }); });
  let workspaceOpenPages = [];
  try { workspaceOpenPages = [...new Set(JSON.parse(localStorage.getItem('duanguWorkspacePages') || '[]').filter((id) => workspaceFeatureIds.includes(id)))]; } catch { workspaceOpenPages = []; }
  let workspacePositions = {}, workspaceColumns = {}, workspaceZIndex = 1;
  try { workspacePositions = JSON.parse(localStorage.getItem('duanguWorkspacePositions') || '{}') || {}; } catch { workspacePositions = {}; }
  try { workspaceColumns = JSON.parse(localStorage.getItem('duanguWorkspaceColumns') || '{}') || {}; } catch { workspaceColumns = {}; }
  const workspaceLayoutsKey = 'duanguWorkspaceLayouts';
  const workspacePresets = [
    { id: 'portfolio', name: '持倉檢查', pages: ['holdings', 'insights', 'riskLab'], columns: { holdings: 0, insights: 1, riskLab: 1 } },
    { id: 'research', name: '盤前研究', pages: ['stockDesk', 'trendAnalysis', 'news'], columns: { stockDesk: 0, trendAnalysis: 1, news: 1 } },
    { id: 'holdingResearch', name: '持股研究', pages: ['holdings', 'holdingAnalysis', 'news'], columns: { holdings: 0, holdingAnalysis: 1, news: 1 } }
  ];
  let customWorkspaceLayouts = [];
  try {
    const stored = JSON.parse(localStorage.getItem(workspaceLayoutsKey) || '[]');
    if (Array.isArray(stored)) customWorkspaceLayouts = stored.filter((row) => row?.id && row?.name && Array.isArray(row.pages)).slice(0, 8);
  } catch { /* A malformed saved layout does not block the workbench. */ }
  const persistWorkspacePositions = () => {
    try {
      localStorage.setItem('duanguWorkspacePositions', JSON.stringify(workspacePositions));
      localStorage.setItem('duanguWorkspaceColumns', JSON.stringify(workspaceColumns));
    } catch { /* The current layout is still usable. */ }
  };
  const persistWorkspace = () => { try { localStorage.setItem('duanguWorkspacePages', JSON.stringify(workspaceOpenPages)); } catch { /* Workspace layout remains usable without browser storage. */ } };
  function saveWorkspacePosition(panel) {
    const width = workspaceGrid.clientWidth || 1;
    if (workspaceStacked()) return;
    workspacePositions[panel.dataset.page] = { x: panel.offsetLeft / width, y: panel.offsetTop, w: panel.offsetWidth / width };
    persistWorkspacePositions();
  }
  function updateWorkspaceCanvasHeight() {
    if (workspaceGrid.classList.contains('is-stacked')) { workspaceGrid.style.height = ''; return; }
    const bottom = [...workspaceGrid.querySelectorAll('.workspace-panel')].reduce((max, panel) => Math.max(max, panel.offsetTop + panel.offsetHeight), 0);
    workspaceGrid.style.height = bottom ? (bottom + 18) + 'px' : '0px';
  }
  function enablePanelDragging(panel, heading, resizeHandle) {
    let operation = null;
    panel.addEventListener('pointerdown', () => { workspaceZIndex += 1; panel.style.zIndex = String(workspaceZIndex); });
    heading.addEventListener('pointerdown', (event) => {
      if (workspaceStacked() || event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      operation = { type: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
      activeWorkspacePanel = panel;
      heading.classList.add('is-dragging');
      heading.setPointerCapture(event.pointerId);
    });
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (workspaceStacked() || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      operation = { type: 'resize', pointerId: event.pointerId, startX: event.clientX, width: panel.offsetWidth };
      activeWorkspacePanel = panel;
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
      operation = null; activeWorkspacePanel = null; heading.classList.remove('is-dragging'); saveWorkspacePosition(panel); scheduleWorkspaceLayout();
    };
    heading.addEventListener('pointermove', move); heading.addEventListener('pointerup', finish); heading.addEventListener('pointercancel', finish);
    resizeHandle.addEventListener('pointermove', move); resizeHandle.addEventListener('pointerup', finish); resizeHandle.addEventListener('pointercancel', finish);
    resizeHandle.addEventListener('keydown', (event) => {
      if (workspaceStacked() || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const available = workspaceGrid.clientWidth - panel.offsetLeft;
      const width = Math.max(Math.min(available, 300), Math.min(available, panel.offsetWidth + (event.key === 'ArrowRight' ? 32 : -32)));
      panel.style.width = width / workspaceGrid.clientWidth * 100 + '%';
      saveWorkspacePosition(panel); updateWorkspaceCanvasHeight();
    });
  }
  let workspaceFrame = 0, activeWorkspacePanel = null;
  const chartWidths = new WeakMap();
  const workspaceObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleWorkspaceLayout) : null;
  function scheduleWorkspaceLayout() {
    if (workspaceFrame || $('workspace').hidden) return;
    workspaceFrame = requestAnimationFrame(() => {
      workspaceFrame = 0;
      if ($('workspace').hidden) return;
      flowWorkspacePanels();
    });
  }
  function flowWorkspacePanels() {
    if (activeWorkspacePanel) return;
    if (!workspaceGrid.clientWidth) return;
    const narrow = workspaceStacked(), bottoms = [0, 0], automatic = [];
    workspaceGrid.classList.toggle('is-stacked', narrow);
    for (const panel of workspaceGrid.querySelectorAll('.workspace-panel')) {
      panel.querySelector('.workspace-panel-resize').hidden = narrow;
      const saved = workspacePositions[panel.dataset.page];
      if (narrow) continue;
      if (!saved || ![saved.x, saved.y, saved.w].every(Number.isFinite)) {
        automatic.push(panel);
        continue;
      }
      const span = Math.max(0.32, Math.min(1, saved.w));
      const left = Math.max(0, Math.min(1 - span, saved.x));
      panel.style.left = left * 100 + '%'; panel.style.width = span * 100 + '%'; panel.style.top = Math.max(0, saved.y) + 'px';
      const bottom = panel.offsetTop + panel.offsetHeight + 14;
      if (left < 0.5) bottoms[0] = Math.max(bottoms[0], bottom);
      if (left + span > 0.5) bottoms[1] = Math.max(bottoms[1], bottom);
    }
    for (const panel of automatic) {
      const preferred = workspaceColumns[panel.dataset.page];
      const col = preferred === 0 || preferred === 1 ? preferred : Number(bottoms[1] < bottoms[0]);
      panel.style.left = col ? '51%' : '0%'; panel.style.width = '49%'; panel.style.top = bottoms[col] + 'px';
      bottoms[col] += panel.offsetHeight + 14;
    }
    for (const [id, data, redraw] of [['trendChart', trendData, drawTrendChart], ['heldStockChart', heldStockData, drawHoldingCandles]]) {
      const canvas = $(id);
      if (!data || !workspaceGrid.contains(canvas)) continue;
      const chartWidth = canvas.clientWidth;
      if (chartWidth && chartWidth !== chartWidths.get(canvas)) {
        chartWidths.set(canvas, chartWidth); redraw(data.candles);
      }
    }
    updateWorkspaceCanvasHeight();
  }
  function restoreWorkspacePanels() {
    [...workspaceGrid.querySelectorAll('.workspace-panel')].forEach((panel) => {
      const id = panel.dataset.page, element = $(id), home = workspaceHome.get(id);
      if (panel === activeWorkspacePanel) activeWorkspacePanel = null;
      workspaceObserver?.unobserve(panel);
      if (element && home) { home.parent.insertBefore(element, home.next?.parentElement === home.parent ? home.next : null); element.hidden = true; }
      panel.remove();
    });
  }
  function updateWorkspaceControls() {
    [...$('workspaceFeatureSelect').options].forEach((option) => { if (option.value) option.disabled = workspaceOpenPages.includes(option.value); });
    $('workspaceCount').textContent = workspaceOpenPages.length ? `${workspaceOpenPages.length} 個面板` : '尚未開啟面板';
    $('workspaceEmpty').hidden = workspaceOpenPages.length > 0;
    $('saveWorkspaceLayout').disabled = !workspaceOpenPages.length;
    $('workspaceReset').disabled = !workspaceOpenPages.length;
    $('workspaceAddFeature').disabled = !$('workspaceFeatureSelect').value;
    [...workspaceGrid.children].forEach((panel, index, panels) => {
      panel.querySelector('[data-panel-move="-1"]').disabled = index === 0;
      panel.querySelector('[data-panel-move="1"]').disabled = index === panels.length - 1;
    });
  }
  function moveStackedWorkspacePanel(panel, step) {
    const target = step < 0 ? panel.previousElementSibling : panel.nextElementSibling;
    if (!target) return;
    const index = workspaceOpenPages.indexOf(panel.dataset.page);
    if (index < 0) return;
    [workspaceOpenPages[index], workspaceOpenPages[index + step]] = [workspaceOpenPages[index + step], workspaceOpenPages[index]];
    if (step < 0) target.before(panel);
    else target.after(panel);
    persistWorkspace();
    updateWorkspaceControls();
    panel.querySelector(`[data-panel-move="${step}"]:not([disabled])`)?.focus({ preventScroll: true });
    if (!panel.contains(document.activeElement)) panel.querySelector('.workspace-panel-heading').focus({ preventScroll: true });
    scheduleWorkspaceLayout();
  }
  function renderWorkspacePanels() {
    restoreWorkspacePanels();
    workspaceOpenPages.forEach((id) => {
      const element = $(id), home = workspaceHome.get(id);
      if (!element || !home) return;
      const panel = document.createElement('article'); panel.className = 'workspace-panel'; panel.dataset.page = id;
      const heading = document.createElement('header'); heading.className = 'workspace-panel-heading'; heading.tabIndex = -1;
      const title = document.createElement('b'); title.textContent = pageTitles[id];
      const close = document.createElement('button'); close.type = 'button'; close.className = 'workspace-panel-close'; close.setAttribute('aria-label', `關閉${pageTitles[id]}`); close.textContent = '×';
      close.addEventListener('click', () => { workspaceOpenPages = workspaceOpenPages.filter((item) => item !== id); persistWorkspace(); renderWorkspacePanels(); updateWorkspaceControls(); });
      const actions = document.createElement('div');
      actions.className = 'workspace-panel-actions';
      for (const [step, label, glyph] of [[-1, '上移', '↑'], [1, '下移', '↓']]) {
        const move = document.createElement('button');
        move.type = 'button';
        move.className = 'workspace-panel-move';
        move.dataset.panelMove = String(step);
        move.textContent = glyph;
        move.setAttribute('aria-label', `${label}${pageTitles[id]}面板`);
        move.addEventListener('click', () => moveStackedWorkspacePanel(panel, step));
        actions.append(move);
      }
      actions.append(close);
      heading.append(title, actions);
      const resizeHandle = document.createElement('button'); resizeHandle.type = 'button'; resizeHandle.className = 'workspace-panel-resize'; resizeHandle.setAttribute('aria-label', `拖曳調整${pageTitles[id]}視窗大小`); resizeHandle.title = '拖曳調整大小'; resizeHandle.textContent = '◢';
      panel.append(heading, element, resizeHandle); workspaceGrid.append(panel); element.hidden = false;
      enablePanelDragging(panel, heading, resizeHandle);
      workspaceObserver?.observe(panel);
    });
    updateWorkspaceControls();
    scheduleWorkspaceLayout();
    if (workspaceOpenPages.includes('insights')) marketPerformance.openHealth();
    if (servicesStarted) maybeLoadWorkspaceHolding();
  }
  function maybeLoadWorkspaceHolding() {
    const id = $('heldStockSelect').value;
    if (workspaceOpenPages.includes('holdingAnalysis') && id && !($('loadHeldStock').disabled || heldStockData?.holdingId === id)) {
      loadHeldStock();
    }
  }
  const workspaceSelect = $('workspaceFeatureSelect');
  workspaceFeatureIds.forEach((id) => { const option = document.createElement('option'); option.value = id; option.textContent = pageTitles[id]; workspaceSelect.append(option); });
  workspaceSelect.addEventListener('change', updateWorkspaceControls);
  $('workspaceAddFeature').addEventListener('click', () => {
    const id = workspaceSelect.value;
    if (!id || workspaceOpenPages.includes(id)) return;
    workspaceOpenPages.push(id); persistWorkspace(); workspaceSelect.value = ''; renderWorkspacePanels();
  });
  $('workspaceReset').addEventListener('click', () => {
    workspaceOpenPages = []; workspacePositions = {}; workspaceColumns = {};
    persistWorkspace(); persistWorkspacePositions(); renderWorkspacePanels();
    $('workspaceLayoutMenu').open = false;
  });
  window.addEventListener('resize', scheduleWorkspaceLayout);
  workspaceTouch.addEventListener('change', scheduleWorkspaceLayout);
  const workspaceLayoutSelect = $('workspaceLayout');
  const allWorkspaceLayouts = () => [...workspacePresets, ...customWorkspaceLayouts];
  function refreshWorkspaceLayouts(selection = workspaceLayoutSelect.value) {
    workspaceLayoutSelect.replaceChildren(new Option('選擇版型', ''), ...allWorkspaceLayouts().map((row) => new Option(row.name, row.id)));
    workspaceLayoutSelect.value = allWorkspaceLayouts().some((row) => row.id === selection) ? selection : '';
    $('applyWorkspaceLayout').disabled = !workspaceLayoutSelect.value;
    $('deleteWorkspaceLayout').disabled = !customWorkspaceLayouts.some((row) => row.id === workspaceLayoutSelect.value);
  }
  function storeWorkspaceLayouts() {
    try { localStorage.setItem(workspaceLayoutsKey, JSON.stringify(customWorkspaceLayouts)); return true; }
    catch { showToast('瀏覽器儲存空間不足，此版型只保留在目前頁面。'); return false; }
  }
  workspaceLayoutSelect.addEventListener('change', () => refreshWorkspaceLayouts());
  function applyWorkspaceLayout(layout) {
    workspaceOpenPages = [...new Set(layout.pages.filter((id) => workspaceFeatureIds.includes(id)))];
    workspacePositions = layout.positions && typeof layout.positions === 'object' ? structuredClone(layout.positions) : {};
    workspaceColumns = layout.columns && typeof layout.columns === 'object' ? { ...layout.columns } : {};
    workspaceSelect.value = '';
    refreshWorkspaceLayouts(layout.id);
    persistWorkspace(); persistWorkspacePositions(); renderWorkspacePanels(); showToast('已套用「' + layout.name + '」。');
  }
  for (const layout of workspacePresets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button';
    button.textContent = layout.name;
    button.addEventListener('click', () => applyWorkspaceLayout(layout));
    $('workspacePresetActions').append(button);
  }
  $('applyWorkspaceLayout').addEventListener('click', () => {
    const layout = allWorkspaceLayouts().find((row) => row.id === workspaceLayoutSelect.value);
    if (!layout) return;
    applyWorkspaceLayout(layout);
    $('workspaceLayoutMenu').open = false;
  });
  $('saveWorkspaceLayout').addEventListener('click', () => {
    if (!workspaceOpenPages.length) return;
    const name = prompt('為這個工作區版型命名')?.trim().slice(0, 36);
    if (!name) return;
    const other = customWorkspaceLayouts.find((row) => row.name === name);
    if (!other && customWorkspaceLayouts.length >= 8) return showToast('最多儲存 8 組自訂版型。');
    const id = other?.id || crypto.randomUUID();
    const positions = Object.fromEntries(workspaceOpenPages.filter((page) => workspacePositions[page]).map((page) => [page, { ...workspacePositions[page] }]));
    const columns = Object.fromEntries(workspaceOpenPages.filter((page) => workspaceColumns[page] === 0 || workspaceColumns[page] === 1)
      .map((page) => [page, workspaceColumns[page]]));
    customWorkspaceLayouts = [...customWorkspaceLayouts.filter((row) => row.id !== id), { id, name, pages: [...workspaceOpenPages], positions, columns }];
    const saved = storeWorkspaceLayouts();
    refreshWorkspaceLayouts(id);
    if (saved) showToast('已儲存版型至此裝置。');
  });
  $('deleteWorkspaceLayout').addEventListener('click', () => {
    const item = customWorkspaceLayouts.find((row) => row.id === workspaceLayoutSelect.value);
    if (!item || !confirm('刪除「' + item.name + '」版型？')) return;
    customWorkspaceLayouts = customWorkspaceLayouts.filter((row) => row.id !== item.id);
    storeWorkspaceLayouts(); refreshWorkspaceLayouts();
  });
  refreshWorkspaceLayouts();
  function showPage(page, updateHash = false) {
    if (!Object.hasOwn(pageTitles, page)) page = 'overview';
    const main = $('top'), grid = document.querySelector('.lower-grid');
    if (page !== 'workspace') restoreWorkspacePanels();
    main.querySelectorAll(':scope > section').forEach((section) => { section.hidden = section.id !== page; });
    grid.hidden = page !== 'watchlist' && page !== 'references';
    grid.classList.toggle('single-page', !grid.hidden);
    $('watchlist').hidden = page !== 'watchlist';
    $('references').hidden = page !== 'references';
    if (page === 'workspace') renderWorkspacePanels();
    if (page === 'insights') marketPerformance.openHealth();
    if (page === 'holdingAnalysis' && $('heldStockSelect').value && (!heldStockData || heldStockData.holdingId !== $('heldStockSelect').value)) loadHeldStock();
    if (page === 'riskLab') stressLab.refresh();
    const activeNavGroup = [...document.querySelectorAll('.sidebar nav .nav-link')].find((link) => link.hash === `#${page}`)?.closest('.nav-group');
    document.querySelectorAll('.sidebar nav .nav-group').forEach((group) => {
      group.open = group === activeNavGroup;
      group.toggleAttribute('data-active-group', group === activeNavGroup);
    });
    document.querySelectorAll('.sidebar nav .nav-link').forEach((link) => {
      const active = link.hash === `#${page}`; link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    $('breadcrumbGroup').textContent = activeNavGroup?.querySelector('summary').textContent || '端股';
    document.querySelector('.breadcrumb b').textContent = pageTitles[page];
    if (updateHash && location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
    if (page === 'overview' && servicesStarted) {
      if ($('overviewMarketFilter').value === 'tw' && Date.now() - lastQuoteFetchAt > 60000) refreshQuotes();
      else refreshSelectedMarketHoldings();
    }
    if (window.scrollY > 0) window.scrollTo(0, 0);
  }
  function setMobileNav(open) {
    $('appSidebar').toggleAttribute('data-mobile-open', open);
    $('mobileNavToggle').setAttribute('aria-expanded', String(open));
  }
  $('mobileNavToggle').addEventListener('click', () => setMobileNav(!$('appSidebar').hasAttribute('data-mobile-open')));
  $('appSidebar').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !$('appSidebar').hasAttribute('data-mobile-open')) return;
    event.preventDefault();
    setMobileNav(false);
    $('mobileNavToggle').focus();
  });
  document.querySelector('.sidebar nav').addEventListener('click', (event) => {
    const link = event.target.closest('.nav-link');
    if (!link) return;
    event.preventDefault(); setMobileNav(false); showPage(link.hash.slice(1), true);
  });
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); setMobileNav(false); showPage('overview', true); });
  window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
  const marketPerformance = mountMarketPerformance({
    element: $('performance'), health: $('insights'), escape: esc, fetchMarket: fugleFetch,
    getIdentity: () => cloudUser?.id || 'local',
    getWatchlist: () => state.watchlist.map(String).map((code) => ({ code, name: [code, quoteMap.get(code)?.name].filter(Boolean).join(' ') })),
    getPositions: () => state.holdings.filter((item) => holdingMarket(item) === 'tw').map((item) => {
      const code = String(item.symbol || item.name.match(/^\s*(\d{4,6}[A-Z]?)(?=$|\s)/i)?.[1] || stockCode(item.name)).toUpperCase();
      const quote = quoteMap.get(code);
      return { code, name: item.name, shares: num(item.shares), price: quote?.price ?? num(item.price), backup: !quote };
    })
  });
  const stressLab = mountPortfolioStress($('riskLab'), {
    getPositions: () => state.holdings.map((item) => {
      const quote = holdingQuote(item), currency = holdingCurrency(item);
      return { id: item.id, name: item.name, shares: num(item.shares), price: livePrice(item), market: holdingMarket(item),
        marketName: marketLabels[holdingMarket(item)] || '其他市場', currency,
        fallback: !quote, source: quote ? (quote.source || 'TWSE／TPEx') + ' · ' + (quote.datetime || quote.date || '日期未提供') : '備用價格'
      };
    }).filter((row) => row.currency),
    onSave: ({ group, change, current, stressed, difference, rows, excluded }) => {
      const amount = (value) => formatScenarioMoney(value, group.currency);
      $('journalForm').reset();
      $('journalTitle').value = group.label + ' 持倉壓力測試';
      $('journalThesis').value = [
        '基準情境 ' + pct(change) + '。參考市值 ' + amount(current) + '，情境市值 ' + amount(stressed) + '，差額 ' + amount(difference) + '。',
        ...rows.slice(0, 5).map((row) => row.name + ' · ' + pct(row.shock) + ' · 影響 ' + amount(row.difference) + ' · ' + row.source),
        excluded ? excluded + ' 筆缺少可用價格。' : '',
        '股數固定，未計匯率、稅費及股利。'
      ].filter(Boolean).join('\n').slice(0, 1200);
      $('journalDialog').showModal();
    }
  });
  $('overviewRiskLink').addEventListener('click', (event) => {
    event.preventDefault(); showPage('riskLab', true); stressLab.refresh($('overviewMarketFilter').value);
  });
  function openMarketLookup(query, market) {
    showPage('stockDesk', true);
    if (Object.hasOwn(marketLabels, market)) $('stockLookupMarket').value = market;
    $('stockLookupMarket').dispatchEvent(new Event('change'));
    $('stockLookupInput').value = query;
    $('stockLookupForm').requestSubmit();
  }
  const quickAliases = { riskLab: '風險壓力回落持股風險 stress', insights: '投資檢視回撤波動集中度產業價值成長籌碼技術', performance: '自選股報酬區間漲跌', workspace: '版型面板排版 desk', stockDesk: '報價個股行情自選 lookup',
    ledger: '交易買進賣出股利', topup: '加倉補倉回本試算', news: '市場動態新聞公告', candidates: '選股推薦股號', watchlist: '趨勢觀察價格' };
  mountQuickSearch({
    button: $('openQuickSearch'), dialog: $('quickSearchDialog'), input: $('quickSearchInput'), results: $('quickSearchResults'),
    canOpen: () => !$('appShell').hidden,
    getEntries: (query) => {
      const features = Object.entries(pageTitles).map(([id, label]) => ({ id, label, kind: 'feature', detail: '功能',
        keywords: quickAliases[id] || id, featured: ['overview','holdings','stockDesk','riskLab','workspace'].includes(id), run: () => showPage(id, true) }));
      if (!query) return features;
      const held = state.holdings.map((item) => ({ id: 'holding:' + item.id, label: item.name,
        detail: (marketLabels[holdingMarket(item)] || '個股') + ' · 編輯持股', keywords: item.symbol || '', run: () => openHolding(item) }));
      const watched = state.watchlist.map((code) => ({ id: 'watch:' + code, label: code + ' ' + (quoteMap.get(String(code))?.name || ''),
        detail: '台灣 · 自選股票', run: () => openMarketLookup(code, 'tw') }));
      const lookup = { id: 'lookup', kind: 'lookup', label: '在個股查詢搜尋「' + query + '」', detail: '使用個股頁目前的市場設定',
        run: () => openMarketLookup(query, $('stockLookupMarket').value) };
      return [...features, ...held, ...watched, lookup];
    }
  });
  function updateTransactionLabel() { const dividend = $('transactionType').value === 'dividend'; $('transactionPriceLabel').firstChild.textContent = dividend ? '每股股利' : '成交價（每股）'; }
  function openStockAnalysis(code) { $('trendSymbol').value = code; showPage('trendAnalysis', true); $('loadTrend').click(); }
  function netDividend(row) { return num(row.shares) * num(row.price) - num(row.fees) - num(row.tax); }
  function renderLedger() {
    const typeFilter = $('ledgerTypeFilter').value, query = $('ledgerTextFilter').value.trim().toLocaleLowerCase();
    const rows = [...state.transactions].reverse().filter((row) => (!typeFilter || row.type === typeFilter) && String(row.stock).toLocaleLowerCase().includes(query))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    $('transactionsBody').innerHTML = rows.map((row) => {
      const type = { buy: '買進', sell: '賣出', dividend: '股利' }[row.type] || '其他';
      const fees = num(row.fees) + num(row.tax);
      const amount = row.type === 'dividend' ? netDividend(row) : row.type === 'sell' ? num(row.realizedPnl) : -(num(row.shares) * num(row.price) + fees);
      const amountCell = row.type === 'sell' && row.recordOnly ? '<td>待核算</td>' : `<td class="${amount < 0 ? 'negative' : 'positive'}">${money(amount)}</td>`;
      return `<tr><td>${esc(row.date)}</td><td>${esc(row.stock)}${row.note || row.recordOnly ? `<small class="stock-sub">${esc(row.note || '僅存紀錄')}</small>` : ''}</td><td>${type}</td><td>${num(row.shares).toLocaleString('zh-TW')}</td><td>${money(row.price)}</td><td>${money(fees)}</td>${amountCell}</tr>`;
    }).join('');
    $('emptyTransactions').hidden = rows.length > 0;
    $('emptyTransactions').querySelector('b').textContent = state.transactions.length ? '沒有符合篩選的交易' : '還沒有交易紀錄';
    $('emptyTransactions').querySelector('p').textContent = state.transactions.length ? '試試清除關鍵字或切換交易類型。' : '初始持股可先新增，再記錄之後的交易。';
  }
  $('ledgerTypeFilter').addEventListener('change', renderLedger);
  $('ledgerTextFilter').addEventListener('input', renderLedger);
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
