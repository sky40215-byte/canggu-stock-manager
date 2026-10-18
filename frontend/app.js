(() => {
  'use strict';
  const STORAGE_KEY = 'canggu.v1.portfolio';
  const $ = (id) => document.getElementById(id);
  const initialState = { holdings: [], observations: [], transactions: [], alerts: [], journal: [], watchlist: [], watchlistGroups: {}, events: [], settings: { eyeComfort: false } };
  const hadLocalState = localStorage.getItem(STORAGE_KEY) !== null;
  let state = loadState();
  let quoteMap = new Map();
  let toastTimer;
  let supabaseClient = null, cloudUser = null, cloudReady = false, cloudSyncEnabled = false, cloudSyncTimer = null, lastCloudUpdatedAt = '';
  let servicesStarted = false, accountMode = 'login';

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || !Array.isArray(parsed.holdings) || !Array.isArray(parsed.observations)) return structuredClone(initialState);
      return { ...initialState, ...parsed, transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [], alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [], journal: Array.isArray(parsed.journal) ? parsed.journal : [], watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [], watchlistGroups: parsed.watchlistGroups && typeof parsed.watchlistGroups === 'object' && !Array.isArray(parsed.watchlistGroups) ? parsed.watchlistGroups : {}, events: Array.isArray(parsed.events) ? parsed.events : [], settings: parsed.settings && typeof parsed.settings === 'object' ? { ...initialState.settings, ...parsed.settings } : { ...initialState.settings } };
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
  function hasPortfolioContent(value) { return ['holdings','observations','transactions','alerts','journal','watchlist','events'].some((key) => Array.isArray(value?.[key]) && value[key].length > 0); }
  function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function normalizePortfolio(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(initialState);
    return { ...Object.fromEntries(['holdings','observations','transactions','alerts','journal','watchlist','events'].map((key) => [key, Array.isArray(value[key]) ? value[key] : []])), watchlistGroups: value.watchlistGroups && typeof value.watchlistGroups === 'object' && !Array.isArray(value.watchlistGroups) ? value.watchlistGroups : {}, settings: value.settings && typeof value.settings === 'object' ? { ...initialState.settings, ...value.settings } : { ...initialState.settings } };
  }
  function showAccountGate(message = '') {
    $('accountGate').hidden = false; $('appShell').hidden = true; $('logoutBtn').hidden = true;
    if (message) $('accountStatus').textContent = message;
  }
  function showSyncedApp() {
    $('accountGate').hidden = true; $('appShell').hidden = false; $('logoutBtn').hidden = false;
    $('syncBadge').innerHTML = '<i></i>雲端同步已開啟';
  }
  function startAppServices() {
    if (servicesStarted) return;
    servicesStarted = true; checkFugleStatus(); renderCandidates(); refreshQuotes();
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
    lastCloudUpdatedAt = data.updated_at || new Date().toISOString(); $('syncBadge').innerHTML = '<i></i>雲端同步已開啟';
    return true;
  }
  async function pullCloudData() {
    if (!cloudSyncEnabled || !cloudReady || !cloudUser || cloudSyncTimer || document.querySelector('dialog[open]')) return;
    const { data, error } = await supabaseClient.from('portfolio_data').select('data,updated_at').eq('user_id', cloudUser.id).maybeSingle();
    if (error) { $('syncBadge').innerHTML = '<i></i>同步檢查失敗'; return; }
    if (data?.data && data.updated_at > lastCloudUpdatedAt) { state = normalizePortfolio(data.data); lastCloudUpdatedAt = data.updated_at; persistLocalOnly(); render(); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pullCloudData(); });
  window.addEventListener('focus', pullCloudData);
  setInterval(pullCloudData, 45000);
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const money = (value) => 'NT$ ' + num(value).toLocaleString('zh-TW', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const marketTickPrice = (value) => { const n = num(value), tick = n < 10 ? 0.01 : n < 50 ? 0.05 : n < 100 ? 0.1 : n < 500 ? 0.5 : n < 1000 ? 1 : 5; return Math.round((n + Number.EPSILON) / tick) * tick; };
  const marketRefMoney = (value) => money(marketTickPrice(value));
  const pct = (value) => `${num(value) > 0 ? '+' : ''}${num(value).toFixed(2)}%`;
  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const stockCode = (name) => String(name).match(/\b\d{4,6}\b/)?.[0] || '';
  const livePrice = (item) => quoteMap.get(stockCode(item.name))?.price ?? num(item.price);
  function showToast(message) { const toast = $('toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2500); }
  function pnl(item) { return (num(item.price) - num(item.cost)) * num(item.shares); }
  function render() {
    const holdings = state.holdings;
    const cost = holdings.reduce((sum, item) => sum + num(item.cost) * num(item.shares), 0);
    const value = holdings.reduce((sum, item) => sum + livePrice(item) * num(item.shares), 0);
    const profit = value - cost;
    $('marketValue').textContent = money(value); $('costValue').textContent = money(cost); $('totalPnl').textContent = money(profit);
    $('totalPnl').className = `metric ${profit < 0 ? 'negative' : profit > 0 ? 'positive' : ''}`;
    $('totalPnlPct').textContent = pct(cost ? profit / cost * 100 : 0); $('totalPnlPct').className = `pnl-pill ${profit < 0 ? 'negative' : ''}`;
    const realized = state.transactions.filter((row) => row.type === 'sell').reduce((sum, row) => sum + num(row.realizedPnl), 0);
    const dividends = state.transactions.filter((row) => row.type === 'dividend').reduce((sum, row) => sum + num(row.shares) * num(row.price), 0);
    $('realizedPnl').textContent = money(realized); $('realizedPnl').className = `metric ${realized < 0 ? 'negative' : realized > 0 ? 'positive' : ''}`; $('dividendTotal').textContent = money(dividends);
    $('pnlBasis').textContent = quoteMap.size ? '以最新官方收盤價估算' : '依備用價格估算';
    $('holdingCount').textContent = String(holdings.length);
    const heldSelect = $('heldStockSelect'), selectedHeldId = heldSelect.value;
    heldSelect.innerHTML = holdings.length ? holdings.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('') : '<option value="">請先新增持股</option>';
    if (holdings.some((item) => item.id === selectedHeldId)) heldSelect.value = selectedHeldId;
    $('holdingsBody').innerHTML = holdings.map((item, index) => {
      const code = stockCode(item.name), quote = quoteMap.get(code), price = livePrice(item);
      const valueNow = price * num(item.shares), currentPnl = (price - num(item.cost)) * num(item.shares), rate = num(item.cost) * num(item.shares) ? currentPnl / (num(item.cost) * num(item.shares)) * 100 : 0;
      const colors = ['','blue','gold','pink']; const initial = esc(item.name.trim().slice(0, 1) || '股');
      return `<tr><td><div class="stock-name"><span class="stock-avatar ${colors[index % colors.length]}">${initial}</span><span>${esc(item.name)}<small class="stock-sub">${quote ? `${esc(quote.market)} · ${esc(quote.date)}` : item.updated ? `備用價 · ${esc(item.updated)}` : '個人持倉'}</small></span></div></td><td>${num(item.shares).toLocaleString('zh-TW')}</td><td>${money(item.cost)}</td><td>${money(price)}${quote?.change !== null && quote?.change !== undefined ? `<small class="quote-change ${quote.change < 0 ? 'negative' : 'positive'}">${quote.change > 0 ? '+' : ''}${num(quote.change).toFixed(2)}</small>` : ''}</td><td>${money(valueNow)}</td><td class="${currentPnl < 0 ? 'negative' : 'positive'}">${money(currentPnl)} <small>(${pct(rate)})</small></td><td>${num(item.targetWeight) ? `${num(item.targetWeight).toFixed(1)}%` : '—'}</td><td><div class="row-actions"><button class="row-action" data-edit="${esc(item.id)}" title="編輯">✎</button><button class="row-action" data-delete="${esc(item.id)}" title="刪除">×</button></div></td></tr>`;
    }).join('');
    $('emptyHoldings').style.display = holdings.length ? 'none' : 'block';
    $('stockOptions').innerHTML = holdings.map((item) => `<option value="${esc(item.name)}"></option>`).join('');
    $('mopsQuickLinks').innerHTML = holdings.filter((item) => stockCode(item.name)).map((item) => `<a class="mops-chip" href="https://mops.twse.com.tw/mops/web/t05st01?TYPEK=all&co_id=${encodeURIComponent(stockCode(item.name))}" target="_blank" rel="noopener noreferrer">${esc(item.name)} 公告 ↗</a>`).join('');
    const filter = $('newsStockFilter'), selected = filter.value || 'all';
    filter.innerHTML = `<option value="all">全部持股</option>` + holdings.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    filter.value = holdings.some((item) => item.id === selected) || selected === 'all' ? selected : 'all';
    if (!holdings.length) $('quoteStatus').textContent = '新增持股後可更新最新交易日行情';
    renderInsights();
    renderTrend();
    renderLedger(); renderAllocation(); renderAlerts(); renderJournal();
    renderStockWatchlist(); renderEvents(); applyEyeComfort();
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
  function renderInsights() {
    const holdings = state.holdings;
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
      if (weight >= 40) cards.push(`<article class="insight-item"><span class="insight-mark warn">!</span><div><b>${esc(item.name)}：部位集中度偏高</b><p>約占目前持倉市值 ${weight.toFixed(1)}%。可檢視分散程度、資金用途與可承受波動。</p></div></article>`);
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
  async function refreshQuotes() {
    const button = $('refreshQuotes'), candidateButton = $('refreshCandidates'); button.disabled = true; candidateButton.disabled = true; button.textContent = '載入中…'; candidateButton.textContent = '載入中…'; $('quoteStatus').textContent = '正在讀取官方市場資料…';
    try {
      const response = await fetch('/api/quotes', { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.error || '行情更新失敗');
      quoteMap = new Map(data.quotes.map((row) => [String(row.code), row])); render(); renderCandidates(data.quotes, data.updatedAt);
      $('stockDeskQuoteDate').textContent = `最近交易日：${data.quotes.map((row) => row.date).filter(Boolean).sort().at(-1) || data.updatedAt.slice(0, 10)}`;
      if ($('stockLookupInput').value.trim()) showStockLookup($('stockLookupInput').value);
      evaluateAlerts();
      const dates = [...new Set(state.holdings.map((item) => quoteMap.get(stockCode(item.name))?.date).filter(Boolean))];
      const matched = state.holdings.filter((item) => quoteMap.has(stockCode(item.name))).length;
      const dataDate = data.quotes.map((row) => row.date).filter(Boolean).sort().at(-1) || '最近交易日';
      $('quoteStatus').textContent = state.holdings.length ? `${matched}/${state.holdings.length} 檔比對成功 · ${dates.sort().at(-1) || dataDate} 收盤資料` : `全市場 ${data.quotes.length.toLocaleString('zh-TW')} 檔 · ${dataDate} 收盤資料`;
      if (data.warnings?.length) $('quoteStatus').textContent += ` · ${data.warnings.join('、')}`;
      if (state.holdings.length && !matched) showToast('行情已連線，但持股名稱中需要有 4–6 碼股票代號才能配對。');
    } catch (error) { $('quoteStatus').textContent = error.message.includes('Failed to fetch') ? '無法連到本機資料服務；請用 run_local.ps1 啟動程式。' : error.message; $('candidateContent').innerHTML = `<div class="news-empty">公開行情暫時無法取得：${esc(error.message)}</div>`; showToast('行情更新失敗，請確認網路後重試。'); }
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
  function renderScreenCandidates(data, sizing) {
    const container = $('screenContent'), candidates = data.candidates || [];
    if (!candidates.length) { container.innerHTML = `<div class="screen-empty">${esc(data.message || '目前沒有符合條件的候選，試著放寬每股價格上限或稍後再查。')}</div>`; return; }
    container.innerHTML = candidates.map((item, index) => {
      const newsUrl = `https://news.google.com/search?q=${encodeURIComponent(`"${item.code}" "${item.name}"`)}&hl=zh-TW&gl=TW`;
      const noticeUrl = `https://mops.twse.com.tw/mops/web/t05st01?TYPEK=all&co_id=${encodeURIComponent(item.code)}`;
      const entryLow = marketTickPrice(item.entryLow), entryHigh = marketTickPrice(item.entryHigh), stop = marketTickPrice(item.stop), entry = marketTickPrice((entryLow + entryHigh) / 2), riskPerShare = Math.max(0, entry - stop);
      const riskShares = riskPerShare > 0 ? Math.floor(sizing.maxLoss / riskPerShare) : 0, budgetShares = Math.floor(sizing.budget / entry), unitShares = Math.floor(Math.min(riskShares, budgetShares) / sizing.unit) * sizing.unit;
      const invested = unitShares * entry, plannedLoss = unitShares * riskPerShare;
      const target1 = marketTickPrice(item.target1), target2 = marketTickPrice(item.target2), gross1 = unitShares * (target1 - entry), gross2 = unitShares * (target2 - entry);
      const noSharesReason = unitShares ? '' : sizing.unit === 1000 ? '目前預算或虧損上限不足以估算 1 張（1000 股）' : '目前預算或虧損上限不足以估算 1 股';
      return `<article class="screen-row"><div class="screen-row-top"><div class="candidate-stock"><b><span class="screen-rank">${index + 1}</span>${esc(item.code)} ${esc(item.name || '')}</b><small>${esc(item.market || '台股')} · 日 K ${esc(item.date || '')} · 成交值 ${money(item.turnover)}</small></div><div class="screen-quote">${money(item.price)}<small class="${item.horizonReturn >= 0 ? 'positive' : 'negative'}">${data.horizon === 5 ? '5 日' : '20 日'} ${pct(item.horizonReturn)}</small></div><span class="screen-score">技術條件 ${item.score} 分</span></div><div class="screen-state">${esc(item.status)}</div><div class="screen-levels"><span>買入觀察區 <b>${marketRefMoney(item.entryLow)} – ${marketRefMoney(item.entryHigh)}</b></span><span>風險失效價 <b>${marketRefMoney(item.stop)}</b></span><span>假設停利 1R / 2R <b>${marketRefMoney(target1)} / ${marketRefMoney(target2)}</b></span></div><div class="screen-sizing"><b>部位試算（假設單檔使用整筆預算）</b><div><span>估算買入 <strong>${unitShares.toLocaleString('zh-TW')} 股</strong></span><span>假設進場均價 <strong>${marketRefMoney(entry)}</strong></span><span>預估投入 <strong>${money(invested)}</strong></span><span>觸及失效價估損 <strong>${money(plannedLoss)}</strong></span><span>全數停利 1R 毛利 <strong>${money(gross1)}</strong></span><span>全數停利 2R 毛利 <strong>${money(gross2)}</strong></span></div>${noSharesReason ? `<small class="sizing-warning">${noSharesReason}</small>` : ''}</div><div class="screen-reasons"><span>RSI ${item.rsi == null ? '資料不足' : Number(item.rsi).toFixed(1)}</span><span>${item.smaTrend ? '均線偏多' : '均線未偏多'}</span><span>${item.improving ? 'MACD 動能改善' : 'MACD 動能未改善'}</span><span>${item.volumeOK ? '成交量放大' : '量能未達確認'}</span></div><div class="candidate-links screen-links"><a href="${esc(newsUrl)}" target="_blank" rel="noopener noreferrer">相關新聞 ↗</a><a href="${esc(noticeUrl)}" target="_blank" rel="noopener noreferrer">公司公告 ↗</a></div></article>`;
    }).join('');
  }
  $('screenForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const priceLimit = Number($('screenPriceLimit').value), horizon = Number($('screenHorizon').value), budget = Number($('screenBudget').value), maxLoss = Number($('screenMaxLoss').value), unit = Number($('screenShareUnit').value), button = $('runScreen');
    if (!Number.isFinite(priceLimit) || priceLimit <= 0) return showToast('請輸入大於 0 的每股價格上限。');
    if (!Number.isFinite(budget) || budget <= 0) return showToast('請輸入大於 0 的投入預算。');
    if (!Number.isFinite(maxLoss) || maxLoss <= 0) return showToast('請輸入大於 0 的單筆最大可承受虧損。');
    button.disabled = true; button.textContent = '正在篩選…'; $('screenStatus').textContent = '正在讀取公開成交資料，並向 Fugle 查詢候選股歷史日 K…'; $('screenContent').innerHTML = '';
    try {
      const response = await fugleFetch(`/api/fugle/screen?priceLimit=${encodeURIComponent(priceLimit)}&horizon=${encodeURIComponent(horizon)}`), data = await response.json();
      if (!response.ok) throw new Error(data.error || '條件篩選失敗');
      if (!data.configured) throw new Error('尚未設定 Fugle API 金鑰。');
      renderScreenCandidates(data, { budget, maxLoss, unit });
      $('screenStatus').textContent = `依每股上限 ${money(priceLimit)} · ${horizon === 5 ? '約一週' : '約一個月'} · 預算 ${money(budget)} · 單筆虧損上限 ${money(maxLoss)} · ${unit === 1 ? '零股' : '整股'}估算 · 最近交易日資料${data.warnings?.length ? ` · ${data.warnings.join('、')}` : ''}`;
    } catch (error) { $('screenStatus').textContent = error.message; }
    finally { button.disabled = false; button.textContent = '篩選候選股'; }
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
    if (!chosen.length && !keyword) return renderNews([], '請先新增持股，或輸入關鍵字搜尋新聞。');
    const button = $('refreshNews'); button.disabled = true; button.textContent = '載入中…';
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
    } catch (error) { $('newsSourceLinks').innerHTML = ''; renderNews([], error.message || '新聞來源暫時無法連線，請稍後重試。'); }
    finally { button.disabled = false; button.textContent = '⌕ 搜尋新聞'; }
  }
  function openHolding(item) {
    $('holdingForm').reset(); $('holdingId').value = item?.id || ''; $('holdingDialogTitle').textContent = item ? '編輯持股' : '新增持股';
    if (item) { $('stockName').value = item.name; $('shares').value = item.shares; $('avgCost').value = item.cost; $('currentPrice').value = item.price; $('targetWeight').value = item.targetWeight || ''; }
    $('holdingDialog').showModal();
  }
  function openPrice() {
    $('priceForm').reset(); $('priceDate').value = isoToday();
    if (state.holdings.length === 1) $('priceStock').value = state.holdings[0].name;
    $('priceDialog').showModal();
  }
  ['addHolding','addHoldingTop','emptyAdd'].forEach((id) => $(id).addEventListener('click', () => openHolding()));
  $('addPrice').addEventListener('click', openPrice);
  $('stockLookupForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const query = $('stockLookupInput').value.trim();
    if (!quoteMap.size) { $('stockLookupResult').innerHTML = '<div class="feature-empty">正在更新全市場行情…</div>'; await refreshQuotes(); }
    showStockLookup(query);
  });
  $('stockLookupResult').addEventListener('click', (event) => {
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
    const item = { id, name: $('stockName').value.trim(), shares: num($('shares').value), cost: num($('avgCost').value), price: num($('currentPrice').value), targetWeight: num($('targetWeight').value), updated: new Date().toLocaleDateString('zh-TW') };
    if (!item.name || item.shares <= 0 || item.cost < 0 || item.price < 0) return showToast('請檢查輸入內容。');
    const index = state.holdings.findIndex((row) => row.id === id); if (index >= 0) state.holdings[index] = item; else state.holdings.push(item);
    persist(); render(); $('holdingDialog').close(); showToast('持股已儲存於此裝置。');
    if (state.holdings.length) { refreshQuotes(); refreshNews(); }
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
    let holding = state.holdings.find((item) => stockCode(item.name) && stockCode(item.name) === stockCode(stock));
    if (!holding) holding = state.holdings.find((item) => item.name.toLowerCase() === stock.toLowerCase());
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
  $('backupForm').addEventListener('submit', async (event) => { event.preventDefault(); const password = $('backupPassword').value; if (password !== $('backupPasswordConfirm').value) return showToast('兩次輸入的密碼不一致。'); try { const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), key = await backupKey(password, salt); const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ ...state, exportedAt: new Date().toISOString(), schema: 2 }))); const file = { format: 'canggu-encrypted-backup', version: 1, algorithm: 'AES-GCM', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000 }, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }; downloadJson(file, `藏股加密備份-${isoToday()}.json`); $('backupDialog').close(); $('backupForm').reset(); showToast('加密備份已下載；請妥善保存密碼與檔案。'); } catch { showToast('加密失敗，請使用本機網頁重新操作。'); } });
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
  function addAssistantMessage(role, content) {
    const list = $('assistantMessages');
    list.querySelector('.assistant-empty')?.remove();
    const bubble = document.createElement('div');
    bubble.className = `assistant-message assistant-message-${role}`;
    const label = document.createElement('b'); label.textContent = role === 'user' ? '你' : '助理';
    const text = document.createElement('p'); text.textContent = content;
    bubble.append(label, text); list.append(bubble); list.scrollTop = list.scrollHeight;
    return bubble;
  }
  async function checkAssistantStatus() {
    try {
      const response = await fetch('/api/assistant/status', { cache: 'no-store' }), data = await response.json();
      $('assistantBadge').textContent = data.configured ? 'Gemini 已設定' : '尚未設定助理';
      $('assistantBadge').classList.toggle('source-warning', !data.configured);
      if (!data.configured) $('assistantStatus').textContent = '管理者尚未設定 GEMINI_API_KEY。請在 Google AI Studio 建立金鑰，再加入 Render 環境變數或本機 %LOCALAPPDATA%\\Canggu\\config.env。';
    } catch { $('assistantBadge').textContent = '助理設定無法讀取'; $('assistantStatus').textContent = '目前無法連線到助理設定，請重新整理後再試。'; }
  }
  $('assistantForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = $('assistantInput').value.trim();
    if (!question) return;
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
      const response = await fetch('/api/assistant', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ messages: assistantHistory.slice(-10) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '助理暫時無法回答，請稍後再試。');
      pending.querySelector('p').textContent = result.answer;
      assistantHistory.push({ role: 'assistant', content: result.answer });
      $('assistantStatus').textContent = '';
    } catch (error) {
      pending.remove(); assistantHistory.pop(); addAssistantMessage('assistant', error.message || '連線失敗，請稍後再試。'); $('assistantStatus').textContent = '這次沒有取得回答；你可以稍後重新送出。';
    } finally { button.disabled = false; $('assistantInput').focus(); }
  });
  checkAssistantStatus();
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
  const pageTitles = { overview: '投資總覽', holdings: '我的持股', ledger: '交易與股利', allocation: '目標配置', alerts: '價格提醒', events: '公司事件', journal: '投資日誌', insights: '投資檢視', trendAnalysis: '技術趨勢', holdingAnalysis: '持股分析', stockDesk: '個股查詢／自選', candidates: '推薦股號', watchlist: '趨勢觀察', news: '市場動態', assistant: '詢問助理', references: '研究資料' };
  function showPage(page, updateHash = false) {
    if (!pageTitles[page]) page = 'overview';
    const mainSections = [...document.querySelectorAll('.main-content > section')];
    mainSections.forEach((section) => { section.hidden = true; });
    if (page === 'overview') { $('overview').hidden = false; $('summaryGrid').hidden = false; $('workflowStrip').hidden = false; }
    else if (page === 'watchlist' || page === 'references') {
      const grid = document.querySelector('.lower-grid'); grid.hidden = false; grid.classList.add('single-page');
      $('watchlist').hidden = page !== 'watchlist'; $('references').hidden = page !== 'references';
    } else { $(page).hidden = false; }
    if (page === 'holdingAnalysis' && state.holdings.length && (!heldStockData || heldStockData.holdingId !== $('heldStockSelect').value)) loadHeldStock();
    if (page !== 'watchlist' && page !== 'references') document.querySelector('.lower-grid').classList.remove('single-page');
    document.querySelectorAll('.sidebar nav .nav-link').forEach((link) => link.classList.toggle('active', link.hash === `#${page}`));
    document.querySelector('.breadcrumb b').textContent = pageTitles[page];
    if (updateHash && location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.querySelector('.sidebar nav').addEventListener('click', (event) => { const link = event.target.closest('.nav-link'); if (!link) return; event.preventDefault(); showPage(link.hash.slice(1), true); });
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); showPage('overview', true); });
  window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
  function updateTransactionLabel() { const dividend = $('transactionType').value === 'dividend'; $('transactionPriceLabel').firstChild.textContent = dividend ? '每股股利' : '成交價（每股）'; }
  function openStockAnalysis(code) { $('trendSymbol').value = code; showPage('trendAnalysis', true); $('loadTrend').click(); }
  function renderLedger() { const rows = [...state.transactions].sort((a,b) => b.date.localeCompare(a.date)); $('transactionsBody').innerHTML = rows.map((row) => { const type = { buy: '買進', sell: '賣出', dividend: '股利' }[row.type] || row.type, amount = row.type === 'dividend' ? num(row.shares) * num(row.price) : row.type === 'sell' ? num(row.realizedPnl) : -(num(row.shares) * num(row.price) + num(row.fees) + num(row.tax)); return `<tr><td>${esc(row.date)}</td><td>${esc(row.stock)}${row.note ? `<small class="stock-sub">${esc(row.note)}</small>` : ''}</td><td>${type}</td><td>${num(row.shares).toLocaleString('zh-TW')}</td><td>${money(row.price)}</td><td>${money(num(row.fees)+num(row.tax))}</td><td class="${amount < 0 ? 'negative' : 'positive'}">${money(amount)}</td></tr>`; }).join(''); $('emptyTransactions').style.display = rows.length ? 'none' : 'block'; }
  function renderAllocation() { const holdings = state.holdings, total = holdings.reduce((sum,item) => sum + livePrice(item)*num(item.shares),0), targets = holdings.reduce((sum,item) => sum + num(item.targetWeight),0); $('allocationContent').innerHTML = holdings.length ? `<div class="allocation-summary">已設定目標 ${targets.toFixed(1)}%${targets > 0 && Math.abs(targets-100)>0.5 ? ' · 目標比例合計未達 100%' : ''}</div>` + holdings.map((item) => { const actual = total ? livePrice(item)*num(item.shares)/total*100 : 0, target = num(item.targetWeight), diff = actual-target; return `<div class="allocation-row"><div class="allocation-label"><b>${esc(item.name)}</b><span>目前 ${actual.toFixed(1)}% · 目標 ${target ? `${target.toFixed(1)}%` : '未設定'} · 差距 ${target ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%` : '—'}</span></div><div class="allocation-track"><i style="width:${Math.min(actual,100)}%"></i></div></div>`; }).join('') : '<div class="feature-empty">新增持股後可設定每檔目標比例。</div>'; }
  function renderAlerts() { $('alertsContent').innerHTML = state.alerts.length ? [...state.alerts].reverse().map((row) => `<article class="record-card"><div><b>${esc(row.stock)} · ${row.direction === 'above' ? '到達／高於' : '到達／低於'} ${money(row.target)}</b><p>${row.active ? '等待行情觸發' : `已於 ${esc(row.triggeredAt || '')} 觸發，當時 ${money(row.triggeredPrice)}`}</p></div><button class="row-action" data-delete-alert="${esc(row.id)}" title="刪除提醒">×</button></article>`).join('') : '<div class="feature-empty">尚未設定價格提醒。</div>'; }
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
