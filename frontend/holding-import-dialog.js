import { isTaiwanImportCode, matchHoldingNames, maxImageHoldings, readHoldingTable, reviewImageHoldings } from './holding-image-import.js?v=20261125f';

const allowedImages = new Set(['image/png', 'image/jpeg', 'image/webp']);
const maxFileBytes = 12 * 1024 * 1024;
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

export function mountHoldingImport({ getHoldings, getQuotes, saveHoldings, escape }) {
  const byId = (id) => document.getElementById('holdingImport' + id);
  const dialog = byId('Dialog'), form = byId('Form'), file = byId('File'), review = byId('Review');
  const image = byId('Image'), zoom = byId('Zoom'), body = byId('Rows'), status = byId('Status');
  const submit = byId('Submit'), count = byId('Count'), addRow = byId('AddRow');
  let imageUrl = '', scan = null, drafts = [];

  function setStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function reset() {
    scan?.abort();
    scan = null;
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
    byId('FileName').textContent = 'PNG、JPG 或 WebP，上限 12 MB。影像在此裝置辨識。';
    byId('Choose').textContent = '選擇截圖';
    setStatus('');
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
    submit.disabled = !selected.length || Boolean(incomplete);
    return selected;
  }

  function addDraft(row = {}) {
    drafts.push({ code: '', name: '', shares: '', cost: '', price: '', ...row });
  }

  document.getElementById('openHoldingImport').addEventListener('click', () => {
    reset();
    dialog.showModal();
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
    if (!allowedImages.has(selected.type) || selected.size > maxFileBytes) {
      setStatus('請選擇 12 MB 以內的 PNG、JPG 或 WebP 截圖。');
      return;
    }
    reset();
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
      const tsv = await scanImage(canvas, controller.signal, (progress) => {
        setStatus(`正在辨識持股欄位… ${Math.round(progress * 100)}%`);
      });
      if (controller.signal.aborted) return;
      const found = matchHoldingNames(readHoldingTable(tsv), getQuotes());
      found.forEach((row) => addDraft(row));
      if (!found.length) addDraft();
      review.hidden = false;
      renderRows();
      setStatus(found.length
        ? `找到 ${found.length} 筆候選持股。請對照原圖核對代號、股數與均價。${found.length === maxImageHoldings ? ' 單張截圖最多處理 50 筆。' : ''}`
        : '未辨識到持股表格。請試用含欄位標題的清楚截圖，或對照圖片手動填寫。');
    } catch {
      if (controller.signal.aborted) return;
      if (decoded) {
        addDraft();
        review.hidden = false;
        renderRows();
      }
      setStatus(decoded
        ? '這張圖片暫時無法辨識。可縮小或裁切截圖後重試，也可對照原圖填寫。'
        : '無法開啟這張圖片，請重新截圖後再試。');
    } finally {
      if (scan === controller) scan = null;
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
    if (!dialog.open || review.hidden) return;
    const selected = refreshReview();
    if (!selected.length || selected.some((row) => row.issues.length)) return;
    if (saveHoldings(selected)) dialog.close();
  });
}
