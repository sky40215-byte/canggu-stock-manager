import { isTaiwanImportCode, matchHoldingNames, maxImageHoldings, parseTradeDate, readHoldingTable, readPaddleHoldingTable, readPaddleTradeTable, reviewImageHoldings } from './holding-image-import.js?v=20261126h';

const allowedImages = new Set(['image/png', 'image/jpeg', 'image/webp']);
const maxFileBytes = 12 * 1024 * 1024;
const maxFiles = 5;
const maxDrafts = maxImageHoldings * maxFiles;
const maxCloudImageLength = 4 * Math.ceil((4 * 1024 * 1024) / 3);
const providerLabels = { openai: 'OpenAI', gemini: 'Gemini' };
const fields = [
  { key: 'code', label: '代號', attributes: 'inputmode="numeric" maxlength="6" autocomplete="off"' },
  { key: 'name', label: '名稱', attributes: 'maxlength="60" autocomplete="off"' },
  { key: 'shares', label: '股數', attributes: 'type="number" inputmode="numeric" min="1" step="1"' },
  { key: 'cost', label: '均價／股', attributes: 'type="number" inputmode="decimal" min="0" step="any"' },
  { key: 'price', label: '備用價', attributes: 'type="number" inputmode="decimal" min="0" step="any" placeholder="選填"' }
];
const tradeFields = [
  ...fields.slice(0, 2),
  { key: 'date', label: '成交日期', attributes: 'type="date"' },
  { key: 'type', label: '方向', options: '<option value="">選擇</option><option value="buy">買進</option><option value="sell">賣出</option>' },
  fields[2],
  { key: 'price', label: '成交價／股', attributes: 'type="number" inputmode="decimal" min="0" step="any"' },
  { key: 'fees', label: '手續費', attributes: 'type="number" inputmode="decimal" min="0" step="any"' },
  { key: 'tax', label: '交易稅', attributes: 'type="number" inputmode="decimal" min="0" step="any"' }
];
const tradeKey = (row, code) => JSON.stringify([row.date, row.type, code, Number(row.shares), Number(row.price), Number(row.fees), Number(row.tax)]);

function normalizedImage(image) {
  if (image.naturalWidth * image.naturalHeight > 48_000_000) throw new Error('請裁切截圖後再試，圖片的解析度過大。');
  const scale = Math.min(2.2, 3200 / Math.max(image.naturalWidth, image.naturalHeight), Math.max(1, 1750 / image.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function cloudJpeg(image) {
  const canvas = normalizedImage(image);
  for (const quality of [.95, .85, .75]) {
    const encoded = canvas.toDataURL('image/jpeg', quality).slice('data:image/jpeg;base64,'.length);
    if (encoded && encoded.length <= maxCloudImageLength) return encoded;
  }
  throw new Error('圖片過大，請縮小圖片後再試。');
}

async function scanImage(canvas, signal, report) {
  const vendorUrl = new URL('/vendor/ocr/v7/', location.origin).href;
  const { default: { createWorker, PSM } } = await import(vendorUrl + 'tesseract.esm.min.js');
  if (signal.aborted) return '';
  let worker, stopped = false, timeout, stop, workerError;
  const interrupted = new Promise((_, reject) => {
    stop = () => reject(signal.reason);
    workerError = reject;
    signal.addEventListener('abort', stop, { once: true });
    timeout = setTimeout(() => reject(new Error('辨識超時。可以裁切到持股表格後重新選擇。')), 90_000);
  });
  const recognize = async () => {
    worker = await createWorker('chi_tra', 1, {
      workerPath: vendorUrl + 'worker.min.js',
      corePath: vendorUrl,
      langPath: vendorUrl.slice(0, -1),
      workerBlobURL: false,
      errorHandler: workerError,
      logger: ({ status, progress }) => {
        if (!stopped && !signal.aborted && status === 'recognizing text') report(progress);
      }
    });
    if (stopped) {
      await worker.terminate();
      return '';
    }
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const result = await worker.recognize(canvas, {}, { text: false, tsv: true });
    return result.data.tsv || '';
  };
  try {
    return await Promise.race([recognize(), interrupted]);
  } finally {
    stopped = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
    await worker?.terminate();
  }
}

async function scanPaddle(sources, signal, progress, scanSource, failedSource) {
  const root = new URL('/vendor/ocr/paddle-v1/', location.origin).href;
  let worker, timeout, stop, stopped = false, failed;
  const interruption = new Promise((_, reject) => {
    stop = () => reject(signal.reason);
    failed = () => reject(new Error('PaddleOCR 無法在此瀏覽器完成辨識。請重新選擇清晰截圖。'));
    signal.addEventListener('abort', stop, { once: true });
    timeout = setTimeout(() => reject(new Error('PaddleOCR 辨識超時。可裁切到資料表格後再試。')), 120_000);
  });
  const run = async () => {
    const { PaddleOCR } = await import(root + 'client.js').catch(() => {
      throw new Error('無法載入 PaddleOCR 辨識元件。請確認網路連線後再試。');
    });
    if (stopped || signal.aborted) return [];
    worker = new Worker(root + 'worker.js', { type: 'module' });
    worker.addEventListener('error', failed, { once: true });
    worker.addEventListener('messageerror', failed, { once: true });
    let ocr;
    try {
      ocr = await PaddleOCR.create({
        worker: { createWorker: () => worker },
        textDetectionModelName: 'PP-OCRv6_small_det',
        textDetectionModelAsset: { url: root + 'detector.tar' },
        textRecognitionModelName: 'PP-OCRv6_small_rec',
        textRecognitionModelAsset: { url: root + 'recognizer.tar' },
        textRecognitionBatchSize: 4,
        ortOptions: { backend: 'wasm', numThreads: 1, wasmPaths: root }
      });
    } catch {
      throw new Error('PaddleOCR 無法啟動。請確認網路連線後再試。');
    }
    for (const [index, source] of sources.entries()) {
      if (stopped || signal.aborted) break;
      clearTimeout(timeout);
      timeout = setTimeout(() => failed(), 120_000);
      progress(index);
      try {
        const original = new Image();
        original.src = source.url;
        await original.decode();
        if (stopped || signal.aborted) break;
        const canvas = normalizedImage(original);
        const [result] = await ocr.predict(canvas);
        if (!stopped && !signal.aborted) scanSource(result?.items ?? [], canvas, index);
      } catch {
        if (!stopped && !signal.aborted) failedSource(index);
      }
    }
  };
  try {
    return await Promise.race([run(), interruption]);
  } finally {
    stopped = true;
    signal.removeEventListener('abort', stop);
    clearTimeout(timeout);
    worker?.terminate();
  }
}

export function mountHoldingImport({ getHoldings, getQuotes, getTransactions, saveHoldings, saveTrades, requestCloudScan, today, escape }) {
  const byId = (id) => document.getElementById('holdingImport' + id);
  const dialog = byId('Dialog'), form = byId('Form'), file = byId('File'), review = byId('Review');
  const image = byId('Image'), zoom = byId('Zoom'), body = byId('Rows'), status = byId('Status');
  const submit = byId('Submit'), count = byId('Count'), addRow = byId('AddRow');
  const cloud = byId('Cloud'), provider = byId('Provider'), consent = byId('Consent'), consentText = byId('ConsentText');
  const scanButton = byId('Scan'), cloudHint = byId('CloudHint'), grid = byId('Grid');
  const paddleButton = byId('Paddle'), paddleHint = byId('PaddleHint');
  const sourceSelect = byId('Source'), frame = byId('Frame'), highlight = byId('Highlight'), evidenceHint = byId('EvidenceHint');
  const tradeOptions = byId('TradeOptions'), applyTrades = byId('ApplyTrades');
  let sources = [], imageReady = false, scan = null, advancedBusy = false, available = null, drafts = [], trade = false;
  let openAIRetryAt = 0, retryTimer;

  function setStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }
  function refreshScanControls() {
    clearTimeout(retryTimer);
    const service = provider.value;
    const ready = Boolean(available?.[service]);
    const waitSeconds = service === 'openai' ? Math.max(0, Math.ceil((openAIRetryAt - Date.now()) / 1000)) : 0;
    cloud.hidden = !imageReady || trade || sources.length !== 1;
    paddleButton.hidden = paddleHint.hidden = !imageReady;
    paddleButton.disabled = advancedBusy;
    provider.disabled = advancedBusy || !Object.values(available || {}).some(Boolean);
    consent.disabled = advancedBusy || !ready;
    scanButton.disabled = cloud.hidden || !ready || !consent.checked || advancedBusy || waitSeconds > 0;
    scanButton.textContent = ready ? `用 ${providerLabels[service]} 掃描整張圖` : '掃描整張圖';
    if (dialog.open && !cloud.hidden && waitSeconds > 0) {
      scanButton.textContent = `OpenAI ${waitSeconds} 秒後可重試`;
      retryTimer = setTimeout(refreshScanControls, 1000);
    }
    const recipient = ready ? (service === 'gemini' ? 'Google Gemini' : 'OpenAI') : '所選服務';
    consentText.textContent = `我同意將這張圖片傳給 ${recipient}。若有帳號或姓名，請先遮蔽。`;
    cloudHint.hidden = available?.openai === true;
    cloudHint.textContent = available === null ? '正在確認雲端辨識服務…'
      : available.openai === false ? 'OpenAI 尚未設定 API 金鑰。' : '暫時無法確認雲端辨識服務。';
    grid.inert = advancedBusy;
  }

  function reset() {
    scan?.abort();
    scan = null;
    advancedBusy = false;
    imageReady = false;
    consent.checked = false;
    for (const source of sources) URL.revokeObjectURL(source.url);
    sources = [];
    sourceSelect.replaceChildren();
    highlight.hidden = true;
    evidenceHint.textContent = '';
    image.removeAttribute('src');
    frame.style.removeProperty('min-width');
    zoom.setAttribute('aria-pressed', 'false');
    zoom.textContent = '放大截圖';
    drafts = [];
    body.replaceChildren();
    review.hidden = true;
    review.classList.toggle('holding-import-trades', trade);
    submit.disabled = true;
    count.textContent = '';
    byId('FileName').textContent = '一次最多 5 張 PNG、JPG 或 WebP，每張上限 12 MB。';
    byId('Choose').textContent = '選擇截圖';
    setStatus('');
    refreshScanControls();
  }

  function renderRows() {
    const columns = trade ? tradeFields : fields;
    byId('Head').innerHTML = columns.map(({ label }) => `<th scope="col">${label}</th>`).join('') + '<th scope="col">處理方式</th>';
    body.innerHTML = drafts.map((row, index) => `<tr data-index="${index}">
      ${columns.map(({ key, label, attributes, options }) => {
        const access = `data-field="${key}" aria-label="第 ${index + 1} 筆${label}" aria-describedby="holdingImportNote${index}"`;
        return `<td data-label="${label}">${options ? `<select ${access}>${options}</select>` : `<input ${access} ${attributes} value="${escape(row[key] ?? '')}">`}</td>`;
      }).join('')}
      <td data-label="處理方式"><select data-field="action" aria-label="第 ${index + 1} 筆處理方式" aria-describedby="holdingImportNote${index}"></select></td>
    </tr><tr class="holding-import-row-note" hidden><td colspan="${columns.length + 1}" id="holdingImportNote${index}"></td></tr>`).join('');
    if (trade) body.querySelectorAll('[data-field="type"]').forEach((input, index) => { input.value = drafts[index].type || ''; });
    addRow.disabled = drafts.length >= maxDrafts;
    return refreshReview();
  }

  function refreshReview() {
    if (trade) return refreshTradeReview();
    const holdings = getHoldings(), quotes = getQuotes();
    const byCode = new Map();
    drafts.forEach((draft, index) => {
      const code = draft.code.normalize('NFKC').trim();
      if (isTaiwanImportCode(code)) byCode.set(code, [...(byCode.get(code) || []), index]);
    });
    const reviewDrafts = () => reviewImageHoldings(drafts.map((draft) => draft.action === 'merge' ? { ...draft, action: 'skip' } : draft), holdings, quotes);
    const results = reviewDrafts();
    let normalizedActions = false;
    results.forEach(({ code, existing }, index) => {
      const draft = drafts[index];
      const mode = existing.length > 1 ? 'blocked' : existing.length === 1 ? 'update' : 'add';
      const group = byCode.get(code) || [];
      const canMerge = mode !== 'blocked' && group.some((position) => drafts[position].sourceIndex !== draft.sourceIndex && drafts[position].sourceIndex !== undefined);
      const matched = draft.action === mode || draft.action === 'skip' || (canMerge && draft.action === 'merge');
      if (!draft.action || !matched || (draft.mode && draft.mode !== mode)) {
        draft.action = draft.action === undefined && mode === 'add' && (!group.length || group[0] === index) ? 'add' : 'skip';
        normalizedActions = true;
      }
      draft.mode = mode;
      draft.canMerge = canMerge;
    });
    const current = normalizedActions ? reviewDrafts() : results;
    for (const group of byCode.values()) {
      const merges = group.filter((index) => drafts[index].action === 'merge');
      if (!merges.length) continue;
      const bases = group.filter((index) => ['add', 'update'].includes(drafts[index].action));
      const sourcesInUse = [...bases, ...merges].map((index) => drafts[index].sourceIndex);
      if (bases.length !== 1 || sourcesInUse.includes(undefined) || new Set(sourcesInUse).size !== sourcesInUse.length) {
        for (const index of merges) current[index].issues.push('請保留一筆新增或更新，且每張截圖最多合併一筆');
        continue;
      }
      const base = current[bases[0]];
      if ([base, ...merges.map((index) => current[index])].some((row) => row.issues.length)) {
        base.issues.push('請先修正要合併的資料');
        continue;
      }
      let totalCost = base.shares * base.cost;
      for (const index of merges) {
        const row = current[index];
        base.shares += row.shares;
        totalCost += row.shares * row.cost;
      }
      base.cost = totalCost / base.shares;
      if (!Number.isSafeInteger(base.shares) || !Number.isFinite(base.cost)) base.issues.push('合併後的股數或成本超出有效範圍');
      base.notes.unshift(`合併後 ${base.shares.toLocaleString('zh-TW')} 股，均價 ${displayCost(base.cost)} 元／股`);
    }
    current.forEach((result, index) => {
      const draft = drafts[index], row = body.querySelector(`[data-index="${index}"]`);
      const selector = row.querySelector('[data-field="action"]'), mode = draft.mode;
      const options = mode + String(draft.canMerge);
      if (selector.dataset.mode !== options) {
        selector.innerHTML = (mode === 'blocked' ? '' : `<option value="${mode}">${mode === 'add' ? '新增持股' : '更新持股'}</option>`)
          + (draft.canMerge ? '<option value="merge">合併不同帳戶</option>' : '') + '<option value="skip">略過</option>';
        selector.dataset.mode = options;
      }
      selector.value = draft.action;
      const prior = result.existing[0];
      const comparison = result.existing.length === 1
        ? `股數 ${Number(prior.shares).toLocaleString('zh-TW')} → ${draft.shares ? result.shares.toLocaleString('zh-TW') : '待填'} 股，均價 ${displayCost(prior.cost)} → ${draft.cost ? displayCost(result.cost) : '待填'} 元／股` : '';
      const repeat = byCode.get(result.code)?.length > 1
        ? draft.canMerge ? '同代號出現在多張截圖。重疊請略過，確認是不同帳戶再合併' : '同代號有多筆，請保留一筆'
        : '';
      const note = row.nextElementSibling;
      note.querySelector('td').textContent = [sourceLabel(draft), comparison, repeat, ...result.issues, ...result.notes].filter(Boolean).join('。');
      note.hidden = !note.textContent.trim();
      row.classList.toggle('holding-import-needs-review', draft.action !== 'skip' && result.issues.length > 0);
    });
    const selected = current.map((row, index) => ({ ...row, action: drafts[index].action })).filter((row) => ['add', 'update'].includes(row.action));
    const incomplete = current.filter((row, index) => drafts[index].action !== 'skip' && row.issues.length).length;
    count.textContent = !drafts.length ? '' : `待匯入 ${selected.length} 檔${incomplete ? `，${incomplete} 筆待修正` : ''}`;
    submit.disabled = advancedBusy || !selected.length || Boolean(incomplete);
    return selected;
  }

  const displayCost = (value) => Number(value).toLocaleString('zh-TW', { maximumFractionDigits: 4 });
  const sourceLabel = (row) => row.sourceIndex === undefined ? '' : `第 ${row.sourceIndex + 1} 張截圖`;

  function refreshTradeReview() {
    const existing = new Set(getTransactions().filter((row) => row.code).map((row) => tradeKey(row, row.code)));
    const batch = new Set();
    const selected = [];
    let incomplete = 0;
    for (const [index, draft] of drafts.entries()) {
      const code = draft.code.normalize('NFKC').trim();
      const name = draft.name.trim();
      const { date, type } = draft;
      const key = tradeKey(draft, code);
      const duplicate = isTaiwanImportCode(code) && Boolean(date && type && draft.shares && draft.price) && (existing.has(key) || batch.has(key));
      batch.add(key);
      const row = body.querySelector(`[data-index="${index}"]`);
      const selector = row.querySelector('[data-field="action"]');
      if (selector.dataset.duplicate !== String(duplicate)) {
        selector.innerHTML = `<option value="add">${duplicate ? '仍匯入此筆' : '匯入'}</option><option value="skip">略過</option>`;
        selector.dataset.duplicate = String(duplicate);
      }
      const issues = [];
      if (duplicate && !draft.duplicate) draft.action = 'skip';
      draft.action ||= 'add';
      draft.duplicate = duplicate;
      selector.value = draft.action;
      if (!isTaiwanImportCode(code)) issues.push('請填 4–6 碼台股代號');
      if (!date || parseTradeDate(date) !== date || date > today()) issues.push('請核對成交日期，不可晚於今天');
      if (!['buy', 'sell'].includes(type)) issues.push('請確認買進或賣出');
      if (!Number.isSafeInteger(Number(draft.shares)) || Number(draft.shares) <= 0) issues.push('請填整數股數');
      if (!Number.isFinite(Number(draft.price)) || Number(draft.price) <= 0) issues.push('請填正數成交價');
      for (const [field, label] of [['fees', '手續費'], ['tax', '交易稅']]) {
        if (draft[field] === '' || !Number.isFinite(Number(draft[field])) || Number(draft[field]) < 0) issues.push(`請核對${label}（沒有請填 0）`);
      }
      const note = row.nextElementSibling;
      note.querySelector('td').textContent = [sourceLabel(draft), duplicate ? '疑似重複成交，請核對是否為同一筆' : '', ...issues].filter(Boolean).join('。');
      note.hidden = !note.textContent.trim();
      row.classList.toggle('holding-import-needs-review', draft.action !== 'skip' && issues.length > 0);
      if (draft.action === 'skip') continue;
      incomplete += Number(Boolean(issues.length));
      selected.push({ type, date, stock: name ? `${code} ${name}` : code, shares: Number(draft.shares), price: Number(draft.price), fees: Number(draft.fees), tax: Number(draft.tax), note: '', issues });
    }
    count.textContent = `待匯入 ${selected.length} 筆成交${incomplete ? `，${incomplete} 筆待修正` : ''}`;
    submit.disabled = advancedBusy || !selected.length || Boolean(incomplete);
    return selected;
  }

  function addDraft(row = {}) {
    drafts.push({ code: '', name: '', shares: '', cost: '', price: '', date: '', type: '', fees: '', tax: '', ...row });
  }

  function showCandidates(rows) {
    drafts = [];
    matchHoldingNames(rows, getQuotes()).forEach((row) => addDraft(row));
    if (!drafts.length) addDraft({ action: 'skip' });
    highlight.hidden = true;
    evidenceHint.textContent = '點選辨識欄位可在原圖查看位置。';
    review.hidden = false;
    renderRows();
  }

  function showSource(index) {
    if (!sources[index]) return;
    sourceSelect.value = String(index);
    if (image.getAttribute('src') === sources[index].url) return;
    image.src = sources[index].url;
    highlight.hidden = true;
    evidenceHint.textContent = '點選辨識欄位可在原圖查看位置。';
  }

  function locateField(event) {
    const key = event.target.dataset.field;
    const tr = event.target.closest('[data-index]');
    if (!tr || !key || key === 'action') return;
    const draft = drafts[Number(tr.dataset.index)];
    if (draft.sourceIndex !== undefined) showSource(draft.sourceIndex);
    const box = draft.evidence?.[key];
    highlight.hidden = !box;
    evidenceHint.textContent = box ? '已框出這個欄位在原圖的位置。' : '此欄位沒有可定位的原圖文字。';
    if (!box) return;
    const [left, top, right, bottom] = box;
    Object.assign(highlight.style, { left: `${left * 100}%`, top: `${top * 100}%`, width: `${(right - left) * 100}%`, height: `${(bottom - top) * 100}%` });
    const src = image.src;
    void image.decode().then(() => {
      if (highlight.hidden || src !== image.src || document.activeElement !== event.target) return;
      const pane = frame.parentElement;
      pane.scrollTop = Math.max(0, highlight.offsetTop - pane.clientHeight / 2);
      pane.scrollLeft = Math.max(0, highlight.offsetLeft - pane.clientWidth / 2);
    }).catch(() => {});
  }
  sourceSelect.addEventListener('change', () => showSource(Number(sourceSelect.value)));
  body.addEventListener('focusin', locateField);
  body.addEventListener('click', locateField);

  function openImport(forTrades) {
    trade = forTrades;
    byId('Title').textContent = trade ? '從截圖匯入成交明細' : '從截圖匯入持股';
    byId('Intro').textContent = trade
      ? '選擇含欄位標題的台股券商成交明細。請核對成交日期、方向、股數、單價與費用。'
      : '選擇台股券商的庫存截圖或照片，核對股數及每股平均成本後匯入「我的持股」。';
    byId('PaddleHint').textContent = trade ? '成交明細在此裝置辨識。第一次使用會下載模型。'
      : '可辨識有表頭的庫存表格，或標有股數和均價的卡片。多張截圖一律在此裝置辨識。';
    byId('ReviewHint').textContent = trade ? '金額以新台幣計。若截圖沒有列出手續費或交易稅，請確認金額後填入。'
      : '備用價可留空，有收盤行情時會優先使用行情。';
    tradeOptions.hidden = !trade;
    applyTrades.checked = false;
    available = null;
    reset();
    dialog.showModal();
    if (trade) return;
    fetch('/api/holdings/image', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Cloud scan status unavailable');
      const config = await response.json();
      available = { openai: config.providers?.openai?.configured === true, gemini: (config.providers?.gemini?.configured ?? config.configured) === true };
    }).catch(() => { available = {}; }).finally(() => {
      for (const option of provider.options) {
        option.disabled = !available[option.value];
        option.textContent = option.disabled ? option.dataset.label + '（未設定）' : option.dataset.label;
      }
      provider.value = available.openai || !available.gemini ? 'openai' : 'gemini';
      consent.checked = false;
      refreshScanControls();
    });
  }
  document.getElementById('openHoldingImport').addEventListener('click', () => openImport(false));
  document.getElementById('openTradeImport').addEventListener('click', () => openImport(true));
  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
  byId('Choose').addEventListener('click', () => file.click());
  zoom.addEventListener('click', () => {
    const enlarged = zoom.getAttribute('aria-pressed') !== 'true';
    frame.style.minWidth = enlarged ? Math.max(760, Math.min(image.naturalWidth, 1500)) + 'px' : '';
    zoom.setAttribute('aria-pressed', String(enlarged));
    zoom.textContent = enlarged ? '縮回截圖' : '放大截圖';
  });
  addRow.addEventListener('click', () => {
    if (drafts.length >= maxDrafts) return;
    addDraft();
    renderRows();
    body.querySelector(`[data-index="${drafts.length - 1}"] input`).focus();
  });

  file.addEventListener('change', async () => {
    const selected = Array.from(file.files || []);
    file.value = '';
    if (!selected.length) return;
    if (selected.length > maxFiles || selected.some((item) => !allowedImages.has(item.type) || item.size > maxFileBytes)) {
      setStatus('一次最多選 5 張 PNG、JPG 或 WebP，每張不超過 12 MB。');
      return;
    }
    reset();
    sources = selected.map((item) => ({ url: URL.createObjectURL(item), name: item.name }));
    sources.forEach(({ name }, index) => sourceSelect.add(new Option(`第 ${index + 1} 張 · ${name}`, String(index))));
    showSource(0);
    byId('FileName').textContent = sources.length === 1 ? sources[0].name : `已選擇 ${sources.length} 張截圖`;
    byId('Choose').textContent = '更換截圖';
    if (trade || sources.length > 1) {
      imageReady = true;
      await runAdvancedScan('paddle');
      return;
    }
    const controller = new AbortController();
    scan = controller;
    setStatus('正在載入辨識工具和繁體中文資料，首次使用可能稍久…');
    let decoded = false;
    try {
      await image.decode();
      if (controller.signal.aborted) return;
      decoded = true;
      const canvas = normalizedImage(image);
      imageReady = true;
      refreshScanControls();
      const tsv = await scanImage(canvas, controller.signal, (progress) => {
        setStatus(`正在辨識持股欄位… ${Math.round(progress * 100)}%`);
      });
      if (controller.signal.aborted) return;
      const found = readHoldingTable(tsv, getQuotes(), canvas);
      showCandidates(found.map((row) => ({ ...row, sourceIndex: 0 })));
      setStatus(found.length
        ? `裝置辨識找到 ${found.length} 筆候選持股。請對照原圖核對代號、股數與均價。${found.length === maxImageHoldings ? ' 單張截圖最多處理 50 筆。' : ''}`
        : '裝置辨識找不到持股欄位。可以改用整圖辨識，或對照圖片手動填寫。');
    } catch {
      if (controller.signal.aborted) return;
      if (decoded) {
        showCandidates([]);
      }
      setStatus(decoded
        ? '這張圖片暫時無法辨識。可縮小或裁切截圖後重試，也可對照原圖填寫。'
        : '無法開啟這張圖片，請重新截圖後再試。');
    } finally {
      if (scan === controller) {
        scan = null;
        refreshScanControls();
      }
    }
  });

  consent.addEventListener('change', refreshScanControls);
  provider.addEventListener('change', () => {
    consent.checked = false;
    refreshScanControls();
  });
  async function runAdvancedScan(service) {
    const label = providerLabels[service] || 'PaddleOCR';
    const cloudScan = service !== 'paddle';
    scan?.abort();
    const controller = new AbortController();
    scan = controller;
    advancedBusy = true;
    refreshScanControls();
    if (!review.hidden) refreshReview();
    setStatus(cloudScan ? `${label} 正在掃描整張圖並找出持股…` : '正在載入 PaddleOCR，首次使用需要下載辨識模型…');
    const rows = [], empty = [], failures = [];
    const activeSources = sources;
    const forTrades = trade;
    const describe = (indexes) => indexes.map((index) => `第 ${index + 1} 張`).join('、');
    function updateResults() {
      showCandidates(rows);
      setStatus([
        `${label} 找到 ${rows.length} 筆候選${forTrades ? '成交' : '持股'}。請核對原圖再匯入。`,
        empty.length ? `${describe(empty)}找不到可辨識欄位。` : '',
        failures.length ? `${describe(failures)}未完成辨識。` : '',
        rows.length >= maxImageHoldings ? '每張最多回傳 50 筆。' : ''
      ].filter(Boolean).join(' '));
    }
    try {
      if (cloudScan) {
        const result = await requestCloudScan(service, cloudJpeg(image), controller.signal);
        rows.push(...result.map((row) => ({ ...row, sourceIndex: 0 })));
      } else {
        await scanPaddle(activeSources, controller.signal, (index) => {
          setStatus(`PaddleOCR 正在辨識第 ${index + 1}／${activeSources.length} 張截圖…`);
        }, (items, canvas, index) => {
          const result = forTrades ? readPaddleTradeTable(items, canvas) : readPaddleHoldingTable(items, getQuotes(), canvas);
          if (!result.length) empty.push(index);
          rows.push(...result.map((row) => ({ ...row, sourceIndex: index })));
        }, (index) => failures.push(index));
      }
      if (!dialog.open || controller.signal.aborted) return;
      if (rows.length) {
        updateResults();
      } else {
        if (!drafts.length) showCandidates([]);
        setStatus(forTrades
          ? '無法辨識成交明細。可選擇有完整表頭的截圖，或放大原圖後手動填寫。'
          : `${label} 找不到可確認的台股持股。可保留目前預覽，或換張較清楚的圖片。`);
      }
      if (cloudScan) consent.checked = false;
    } catch (error) {
      if (!controller.signal.aborted) {
        if (rows.length) showCandidates(rows);
        else if (!drafts.length) showCandidates([]);
        if (service === 'openai' && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 86400) {
          openAIRetryAt = Date.now() + error.retryAfterSeconds * 1000;
        }
        setStatus([error.message || '整圖辨識暫時無法使用。', rows.length ? `已保留辨識成功的 ${rows.length} 筆。` : '仍可使用目前的預覽。'].join(' '));
      }
    } finally {
      if (scan === controller) {
        scan = null;
        advancedBusy = false;
        refreshScanControls();
        refreshReview();
      }
    }
  }
  scanButton.addEventListener('click', () => {
    if (dialog.open && !scanButton.disabled) void runAdvancedScan(provider.value);
  });
  paddleButton.addEventListener('click', () => {
    if (dialog.open && imageReady && !paddleButton.disabled) void runAdvancedScan('paddle');
  });

  body.addEventListener('input', (event) => {
    const key = event.target.dataset.field;
    if (!key) return;
    const row = drafts[Number(event.target.closest('[data-index]').dataset.index)];
    row[key] = event.target.value;
    if (row.evidence && key !== 'action') {
      delete row.evidence[key];
      highlight.hidden = true;
      evidenceHint.textContent = '已手動修改此欄位。';
    }
    if (key === 'code' && isTaiwanImportCode(row.code) && !row.name.trim()) {
      row.name = getQuotes().get(row.code.normalize('NFKC').trim())?.name || '';
      event.target.closest('tr').querySelector('[data-field="name"]').value = row.name;
    }
    refreshReview();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!dialog.open || review.hidden || advancedBusy) return;
    const selected = refreshReview();
    if (submit.disabled) return;
    if (trade ? saveTrades(selected, applyTrades.checked) : saveHoldings(selected)) dialog.close();
  });
}
