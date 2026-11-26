import { compareTopup } from './portfolio-math.js?v=20261125d';

export function formatScenarioMoney(amount, currency = 'TWD') {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const unit = currency === 'TWD' ? 'NT$' : /^[A-Z]{3}$/.test(currency) ? currency : '';
  const digits = currency === 'JPY' || currency === 'KRW' ? 0 : Number(amount) !== 0 && Math.abs(amount) < 1 ? 4 : 2;
  return [unit, Number(amount).toLocaleString('zh-TW', { maximumFractionDigits: digits })].filter(Boolean).join(' ');
}

export function mountScenarioComparison(container, { item, buyPrice, portfolio = null, onSave, saveLabel = '寫入投資日誌' }) {
  const money = (amount) => formatScenarioMoney(amount, item.currency || 'TWD');
  const weight = (value) => value == null ? '—' : value.toFixed(1) + '%';
  container.innerHTML = `
    <h3>不加碼與加碼比較</h3>
    <p>兩種方案用同一個假設未來股價。淨損益含估計買入及賣出費用與稅，結果是情境估算。</p>
    <label class="scenario-future-label">
      <span>假設未來股價</span><strong data-scenario-future></strong>
      <input data-future-change type="range" min="-40" max="40" step="1" value="0">
      <small><span>−40%</span><span>現價</span><span>+40%</span></small>
    </label>
    <div class="scenario-quick-actions" aria-label="快速設定股價變動">
      <button type="button" class="secondary-button" data-set-future="-10">下跌 10%</button>
      <button type="button" class="secondary-button" data-set-future="0">維持現價</button>
      <button type="button" class="secondary-button" data-set-future="10">上漲 10%</button>
    </div>
    <div class="scenario-comparison-table">
      <table><thead><tr><th scope="col">比較項目</th><th scope="col">不加碼</th><th scope="col">加碼</th></tr></thead><tbody data-scenario-rows></tbody></table>
    </div>
    <p class="scenario-difference" data-scenario-difference></p>
    <details class="method-note">
      <summary>計算明細</summary>
      <div class="scenario-comparison-table"><table>
        <thead><tr><th scope="col">金額項目</th><th scope="col">不加碼</th><th scope="col">加碼</th></tr></thead>
        <tbody data-scenario-amounts></tbody>
      </table></div>
      <p>估算淨損益＝情境市值 − 帳面成本 − 買入手續費 − 預估賣出手續費 − 預估賣出稅。</p>
    </details>
    ${portfolio ? '<small>持倉比重按同市場、同幣別的股票市值估算。其餘股票價格固定，加碼資金另投入。</small>' : ''}
    ${onSave ? `<div class="scenario-quick-actions"><button type="button" class="secondary-button" data-save-scenario>${saveLabel}</button></div>` : ''}`;

  const slider = container.querySelector('[data-future-change]');
  let current;
  const refresh = () => {
    const change = Number(slider.value);
    const futurePrice = Number(item.price) * (1 + change / 100);
    const selectedPrice = buyPrice();
    const comparison = compareTopup(item, selectedPrice, futurePrice, portfolio);
    current = { ...comparison, buyPrice: selectedPrice, futurePrice, change };
    const { baseline, added, baselineWeight, addedWeight, pnlDifference } = comparison;
    const sign = (value) => value > 0 ? '+' : '';
    container.querySelector('[data-scenario-future]').textContent = `${money(futurePrice)}（${sign(change)}${change}%）`;
    slider.setAttribute('aria-valuetext', `${sign(change)}${change}%，${money(futurePrice)}`);
    const rows = [
      ['持有股數', baseline.totalShares.toLocaleString('zh-TW'), added.totalShares.toLocaleString('zh-TW')],
      ['假設加碼買入價／股', '—', money(selectedPrice)],
      ['額外投入（含買入費用）', money(0), money(added.purchaseTotal)],
      ['估算損益兩平價／股', money(baseline.breakEven), money(added.breakEven)],
      ['估算淨損益', money(baseline.pnl), money(added.pnl)]
    ];
    if (portfolio) rows.splice(3, 0, ['持倉比重', weight(baselineWeight), weight(addedWeight)]);
    container.querySelector('[data-scenario-rows]').innerHTML = rows.map(([label, before, after]) => `<tr><th scope="row">${label}</th><td>${before}</td><td>${after}</td></tr>`).join('');
    const amounts = [
      ['情境市值', 'marketValue'], ['帳面成本', 'totalCost'], ['新增買入手續費', 'buyCommission'],
      ['預估賣出手續費', 'saleCommission'], ['預估賣出稅', 'saleTax']
    ];
    container.querySelector('[data-scenario-amounts]').innerHTML = amounts.map(([label, key]) =>
      `<tr><th scope="row">${label}</th><td>${money(baseline[key])}</td><td>${money(added[key])}</td></tr>`).join('');
    const summary = container.querySelector('[data-scenario-difference]');
    summary.textContent = pnlDifference === 0 ? '在這個情境下，兩方案的估算淨損益相同。'
      : `相較於不加碼，加碼的估算淨損益${pnlDifference > 0 ? '高' : '低'} ${money(Math.abs(pnlDifference))}。`;
  };

  slider.addEventListener('input', refresh);
  container.querySelectorAll('[data-set-future]').forEach((button) => {
    button.addEventListener('click', () => { slider.value = button.dataset.setFuture; refresh(); });
  });
  container.querySelector('[data-save-scenario]')?.addEventListener('click', () => onSave(current));
  refresh();
  return { refresh };
}
