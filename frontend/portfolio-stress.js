import { formatScenarioMoney } from './scenario-compare.js?v=20261126k';

function safeShock(value) {
  const change = Number(value);
  return Number.isFinite(change) ? Math.min(100, Math.max(-100, change)) : 0;
}

export function calculateStress(positions, change, overrides = new Map()) {
  const priced = positions.filter((row) => Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.shares) && row.shares > 0);
  const rows = priced.map((row) => {
    const shock = safeShock(overrides.get(row.id) ?? change);
    const current = row.price * row.shares;
    const difference = current * shock / 100;
    return { ...row, shock, current, stressed: current + difference, difference };
  }).sort((a, b) => a.difference - b.difference || b.current - a.current);
  const current = rows.reduce((sum, row) => sum + row.current, 0);
  const difference = rows.reduce((sum, row) => sum + row.difference, 0);
  return { rows, current, difference, stressed: current + difference, excluded: positions.length - rows.length };
}

const signedPercent = (value) => (value > 0 ? '+' : '') + value.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) + '%';

export function mountPortfolioStress(section, { getPositions, onSave }) {
  const select = section.querySelector('[data-stress-scope]'), shock = section.querySelector('[data-stress-shock]');
  const form = section.querySelector('[data-stress-parameters]'), status = section.querySelector('[data-stress-status]');
  const metrics = section.querySelector('[data-stress-metrics]'), output = section.querySelector('[data-stress-rows]');
  const save = section.querySelector('[data-stress-save]'), clear = section.querySelector('[data-stress-clear]');
  const overrides = new Map();
  let groups = new Map(), current = null;
  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  const renderResults = () => {
    const group = groups.get(select.value);
    if (!group) {
      form.hidden = true; save.disabled = true; current = null; metrics.replaceChildren(); output.replaceChildren();
      status.textContent = '新增一筆持股後，就可以估算價格變動對持倉的影響。';
      return;
    }
    form.hidden = false;
    const change = safeShock(shock.value);
    const result = calculateStress(group.positions, change, overrides);
    const money = (amount) => formatScenarioMoney(amount, group.currency);
    current = { ...result, group, change };
    save.disabled = !result.rows.length;
    clear.disabled = !group.positions.some((item) => overrides.has(item.id));
    const fallbackCount = result.rows.filter((row) => row.fallback).length;
    status.textContent = group.label + ' · 已估算 ' + result.rows.length + ' 筆持倉'
      + (fallbackCount ? ' · ' + fallbackCount + ' 筆使用備用價' : '')
      + (result.excluded ? ' · ' + result.excluded + ' 筆缺少可用價格，未計入' : '');
    const changeClass = result.difference < 0 ? 'negative' : 'positive';
    const changePct = result.current ? signedPercent(result.difference / result.current * 100) : '—';
    metrics.innerHTML = result.rows.length ? `
      <article><small>參考市值</small><strong>${money(result.current)}</strong></article>
      <article><small>情境市值</small><strong>${money(result.stressed)}</strong></article>
      <article><small>市值變動 · ${changePct}</small><strong class="${changeClass}">${money(result.difference)}</strong></article>` : '';
    const maximum = Math.max(1, ...result.rows.map((row) => Math.abs(row.difference)));
    output.innerHTML = result.rows.map((row) => `<tr>
      <td><strong>${esc(row.name)}</strong><small>${esc(row.source)}</small></td>
      <td>${money(row.current)}</td>
      <td><input type="number" min="-100" max="100" step="0.1" data-stress-override="${esc(row.id)}" placeholder="${change}" value="${overrides.get(row.id) ?? ''}" aria-label="${esc(row.name)}個別價格變動百分比"></td>
      <td>${money(row.stressed)}</td>
      <td class="${row.difference < 0 ? 'negative' : 'positive'}"><strong>${money(row.difference)}</strong><span class="stress-effect-bar" aria-hidden="true" style="width:${(Math.abs(row.difference) / maximum * 100).toFixed(1)}%"></span></td>
    </tr>`).join('') || '<tr><td colspan="5">此市場的持股目前都缺少可用價格。</td></tr>';
  };

  const refresh = (preferredMarket) => {
    const previous = select.value;
    groups = new Map();
    for (const row of getPositions()) {
      const key = row.market + ':' + row.currency;
      if (!groups.has(key)) groups.set(key, { market: row.market, currency: row.currency, label: row.marketName + ' · ' + row.currency, positions: [] });
      groups.get(key).positions.push(row);
    }
    select.replaceChildren(...[...groups].map(([key, group]) => new Option(group.label, key)));
    if (preferredMarket && [...groups.keys()].some((key) => key.startsWith(preferredMarket + ':'))) select.value = [...groups.keys()].find((key) => key.startsWith(preferredMarket + ':'));
    else if (groups.has(previous)) select.value = previous;
    form.hidden = !groups.size;
    renderResults();
  };
  select.addEventListener('change', renderResults);
  shock.addEventListener('input', renderResults);
  form.querySelectorAll('[data-stress-preset]').forEach((button) => {
    button.addEventListener('click', () => { shock.value = button.dataset.stressPreset; renderResults(); });
  });
  output.addEventListener('change', (event) => {
    const control = event.target.closest('[data-stress-override]');
    if (!control) return;
    const id = control.dataset.stressOverride;
    if (control.value === '') overrides.delete(id);
    else overrides.set(id, safeShock(control.value));
    renderResults();
    [...output.querySelectorAll('[data-stress-override]')].find((node) => node.dataset.stressOverride === id)?.focus();
  });
  clear.addEventListener('click', () => { groups.get(select.value)?.positions.forEach((item) => overrides.delete(item.id)); renderResults(); });
  save.addEventListener('click', () => { if (current?.rows.length) onSave(current); });
  return { refresh };
}
