import { isTaiwanImportCode, matchHoldingNames, maxImageHoldings, readHoldingTable, reviewImageHoldings } from './holding-image-import.js?v=20261125f';

const allowedImages = new Set(['image/png', 'image/jpeg', 'image/webp']);
const maxFileBytes = 12 * 1024 * 1024;
const maxCloudImageLength = 4 * Math.ceil((4 * 1024 * 1024) / 3);
const providerLabels = { openai: 'OpenAI', gemini: 'Gemini' };
const fields = [
  { key: 'code', label: '代號', attributes: 'inputmode="numeric" maxlength="6" autocomplete="off"' },
  { key: 'name', label: '名稱', attributes: 'maxlength="60" autocomplete="off"' },
  { key: 'shares', label: '股數', attributes: 'type="number" inputmode="numeric" min="1" step="1"' },
  { key: 'cost', label: '均價／股', attributes: 'type="number" inputmode="decimal" min="0" step="any"' },
  { key: 'price', label: '備用價', attributes: 'type="number" inputmode="decimal" min="0" step="any" placeholder="選填"' }
];

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

export function mountHoldingImport({ getHoldings, getQuotes, saveHoldings, requestCloudScan, escape }) {
  const byId = (id) => document.getElementById('holdingImport' + id);
  const dialog = byId('Dialog'), form = byId('Form'), file = byId('File'), review = byId('Review');
  const image = byId('Image'), zoom = byId('Zoom'), body = byId('Rows'), status = byId('Status');
  const submit = byId('Submit'), count = byId('Count'), addRow = byId('AddRow');
  const cloud = byId('Cloud'), provider = byId('Provider'), consent = byId('Consent'), consentText = byId('ConsentText');
  const scanButton = byId('Scan'), cloudHint = byId('CloudHint'), grid = byId('Grid');
  let imageUrl = '', imageReady = false, scan = null, cloudBusy = false, available = null, drafts = [];

  function setStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }
  function refreshScanControls() {
    const service = provider.value;
    const ready = Boolean(available?.[service]);
    cloud.hidden = !imageReady;
    provider.disabled = cloudBusy || !Object.values(available || {}).some(Boolean);
    consent.disabled = cloudBusy || !ready;
    scanButton.disabled = !imageReady || !ready || !consent.checked || cloudBusy;
    scanButton.textContent = ready ? `用 ${providerLabels[service]} 掃描整張圖` : '掃描整張圖';
    const recipient = ready ? (service === 'gemini' ? 'Google Gemini' : 'OpenAI') : '所選服務';
    consentText.textContent = `我同意將這張圖片傳給 ${recipient}。若有帳號或姓名，請先遮蔽。`;
    cloudHint.hidden = available?.openai === true;
    cloudHint.textContent = available === null ? '正在確認雲端辨識服務…'
      : available.openai === false ? 'OpenAI 尚未設定 API 金鑰。' : '暫時無法確認雲端辨識服務。';
    grid.inert = cloudBusy;
  }

  function reset() {
    scan?.abort();
    scan = null;
    cloudBusy = false;
    imageReady = false;
    consent.checked = false;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = '';
    image.removeAttribute('src');
    image.style.removeProperty('min-width');
    zoom.setAttribute('aria-pressed', 'false');
    zoom.textContent = '放大截圖';
    drafts = [];
    body.replaceChildren();
    review.hidden = true;
    submit.disabled = true;
    count.textContent = '';
    byId('FileName').textContent = 'PNG、JPG 或 WebP，上限 12 MB。預設在此裝置進行文字辨識。';
    byId('Choose').textContent = '選擇截圖';
    setStatus('');
    refreshScanControls();
  }

  function renderRows() {
    body.innerHTML = drafts.map((row, index) => `<tr data-index="${index}">
      ${fields.map(({ key, label, attributes }) => `<td data-label="${label}"><input data-field="${key}" ${attributes} value="${escape(row[key] || '')}" aria-label="第 ${index + 1} 筆${label}" aria-describedby="holdingImportNote${index}"></td>`).join('')}
      <td data-label="處理方式"><select data-field="action" aria-label="第 ${index + 1} 筆處理方式" aria-describedby="holdingImportNote${index}"></select></td>
    </tr><tr class="holding-import-row-note" hidden><td colspan="6" id="holdingImportNote${index}"></td></tr>`).join('');
    addRow.disabled = drafts.length >= maxImageHoldings;
    return refreshReview();
  }

  function refreshReview() {
    const holdings = getHoldings(), quotes = getQuotes();
    const results = reviewImageHoldings(drafts, holdings, quotes);
    let normalizedActions = false;
    results.forEach(({ existing }, index) => {
      const draft = drafts[index];
      const mode = existing.length > 1 ? 'blocked' : existing.length === 1 ? 'update' : 'add';
      const matched = draft.action === mode || draft.action === 'skip';
      if (!draft.action || !matched || (draft.mode && draft.mode !== mode)) {
        draft.action = mode === 'add' ? 'add' : 'skip';
        normalizedActions = true;
      }
      draft.mode = mode;
    });
    const current = normalizedActions ? reviewImageHoldings(drafts, holdings, quotes) : results;
    current.forEach((result, index) => {
      const draft = drafts[index], row = body.querySelector(`[data-index="${index}"]`);
      const selector = row.querySelector('select'), mode = draft.mode;
      if (selector.dataset.mode !== mode) {
        selector.innerHTML = (mode === 'blocked' ? '' : `<option value="${mode}">${mode === 'add' ? '新增持股' : '更新持股'}</option>`) + '<option value="skip">略過</option>';
        selector.dataset.mode = mode;
      }
      selector.value = draft.action;
      const prior = result.existing[0];
      const comparison = result.existing.length === 1 ? `原持股 ${prior.shares} 股，均價 ${prior.cost} 元` : '';
      const note = row.nextElementSibling;
      note.querySelector('td').textContent = [comparison, ...result.issues, ...result.notes].filter(Boolean).join('。');
      note.hidden = !note.textContent.trim();
      row.classList.toggle('holding-import-needs-review', draft.action !== 'skip' && result.issues.length > 0);
    });
    const selected = current.map((row, index) => ({ ...row, action: drafts[index].action })).filter((row) => row.action !== 'skip');
    const incomplete = selected.filter((row) => row.issues.length).length;
    count.textContent = !drafts.length ? '' : `待匯入 ${selected.length} 筆${incomplete ? `，其中 ${incomplete} 筆待修正` : ''}`;
    submit.disabled = cloudBusy || !selected.length || Boolean(incomplete);
    return selected;
  }

  function addDraft(row = {}) {
    drafts.push({ code: '', name: '', shares: '', cost: '', price: '', ...row });
  }

  function showCandidates(rows) {
    drafts = [];
    matchHoldingNames(rows, getQuotes()).forEach((row) => addDraft(row));
    if (!drafts.length) addDraft();
    review.hidden = false;
    renderRows();
  }

  document.getElementById('openHoldingImport').addEventListener('click', () => {
    available = null;
    reset();
    dialog.showModal();
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
  });
  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
  byId('Choose').addEventListener('click', () => file.click());
  zoom.addEventListener('click', () => {
    const enlarged = zoom.getAttribute('aria-pressed') !== 'true';
    image.style.minWidth = enlarged ? Math.max(760, Math.min(image.naturalWidth, 1500)) + 'px' : '';
    zoom.setAttribute('aria-pressed', String(enlarged));
    zoom.textContent = enlarged ? '縮回截圖' : '放大截圖';
  });
  addRow.addEventListener('click', () => {
    if (drafts.length >= maxImageHoldings) return;
    addDraft();
    renderRows();
    body.querySelector(`[data-index="${drafts.length - 1}"] input`).focus();
  });

  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    file.value = '';
    if (!selected) return;
    reset();
    if (!allowedImages.has(selected.type) || selected.size > maxFileBytes) {
      setStatus('請選擇 12 MB 以內的 PNG、JPG 或 WebP 截圖。');
      return;
    }
    const controller = new AbortController();
    scan = controller;
    imageUrl = URL.createObjectURL(selected);
    image.src = imageUrl;
    byId('FileName').textContent = selected.name;
    byId('Choose').textContent = '更換截圖';
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
      const found = readHoldingTable(tsv);
      showCandidates(found);
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
  scanButton.addEventListener('click', async () => {
    if (!dialog.open || scanButton.disabled) return;
    const service = provider.value, label = providerLabels[service];
    scan?.abort();
    const controller = new AbortController();
    scan = controller;
    cloudBusy = true;
    refreshScanControls();
    refreshReview();
    setStatus(`${label} 正在掃描整張圖並找出持股…`);
    try {
      const rows = await requestCloudScan(service, cloudJpeg(image), controller.signal);
      if (!dialog.open || controller.signal.aborted) return;
      if (rows.length) {
        showCandidates(rows);
        setStatus(`${label} 找到 ${rows.length} 筆候選持股。請核對原圖再匯入。${rows.length === maxImageHoldings ? ' 單張圖片最多回傳 50 筆。' : ''}`);
      } else {
        if (!drafts.length) showCandidates([]);
        setStatus(`${label} 找不到可確認的台股持股。你可以保留目前預覽，或換張較清楚的圖片。`);
      }
      consent.checked = false;
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!drafts.length) showCandidates([]);
        setStatus(error.message || '整圖辨識暫時無法使用，仍可使用目前的預覽。');
      }
    } finally {
      if (scan === controller) {
        scan = null;
        cloudBusy = false;
        refreshScanControls();
        refreshReview();
      }
    }
  });

  body.addEventListener('input', (event) => {
    const key = event.target.dataset.field;
    if (!key) return;
    const row = drafts[Number(event.target.closest('[data-index]').dataset.index)];
    row[key] = event.target.value;
    if (key === 'code' && isTaiwanImportCode(row.code) && !row.name.trim()) {
      row.name = getQuotes().get(row.code.normalize('NFKC').trim())?.name || '';
      event.target.closest('tr').querySelector('[data-field="name"]').value = row.name;
    }
    refreshReview();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!dialog.open || review.hidden || cloudBusy) return;
    const selected = refreshReview();
    if (!selected.length || selected.some((row) => row.issues.length)) return;
    if (saveHoldings(selected)) dialog.close();
  });
}
