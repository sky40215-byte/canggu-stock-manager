import { marketTotals } from './portfolio-math.js?v=20261125d';
import { formatScenarioMoney, mountScenarioComparison } from './scenario-compare.js?v=20261125d';
import { mountPortfolioStress } from './portfolio-stress.js?v=20261125d';

const markets = {
  tw: { currency: 'TWD', budget: 20000, items: [
    { id: 'tw1', name: '示範半導體', shares: 200, cost: 120, price: 100 },
    { id: 'tw2', name: '示範工業', shares: 100, cost: 68, price: 72 }
  ] },
  us: { currency: 'USD', budget: 1000, items: [
    { id: 'us1', name: 'Demo Technology', shares: 20, cost: 115, price: 100 },
    { id: 'us2', name: 'Demo Utilities', shares: 10, cost: 48, price: 50 }
  ] }
};
const date = '2026-11-24';
const $ = (id) => document.getElementById(id);
const activeMarket = () => markets[$('demoMarket').value];
let comparison;

function renderDemoMarket() {
  const { items, currency } = activeMarket();
  const { cost, value } = marketTotals(items, (item) => item.price, () => currency).get(currency);
  const money = (number) => formatScenarioMoney(number, currency);
  $('demoMetrics').innerHTML = `
    <div><span>持倉市值</span><strong>${money(value)}</strong></div>
    <div><span>投入成本</span><strong>${money(cost)}</strong></div>
    <div><span>未實現損益</span><strong class="${value < cost ? 'negative' : 'positive'}">${money(value - cost)}</strong></div>`;
  $('demoHoldings').innerHTML = items.map((item) => {
    const weight = item.shares * item.price / value * 100;
    return `<article>
      <div><b>${item.name}</b><small>${item.shares} 股 · 參考價 ${money(item.price)}／股</small></div>
      <span class="${weight >= 40 ? 'demo-concentration' : ''}">占持倉 ${weight.toFixed(1)}%</span>
      <button type="button" class="secondary-button" data-demo-holding="${item.id}">試算這筆持倉</button>
    </article>`;
  }).join('');
  $('demoScenario').hidden = true;
  comparison = null;
  demoStress.refresh($('demoMarket').value);
}

function saveDemoEntry(title, text) {
  const entry = document.createElement('article');
  const heading = document.createElement('h3'), detail = document.createElement('p');
  heading.textContent = title;
  detail.textContent = text;
  entry.append(heading, detail);
  $('demoJournalEntries').prepend(entry);
  $('demoJournal').hidden = false;
}
function saveDemoScenario(item, scenario) {
  const money = (number) => formatScenarioMoney(number, item.currency);
  saveDemoEntry(item.name + ' · 持倉情境', `示範資料 ${date}。假設於 ${money(scenario.buyPrice)} 買入、未來股價 ${money(scenario.futurePrice)}。不加碼損益 ${money(scenario.baseline.pnl)}，加碼損益 ${money(scenario.added.pnl)}。`);
  $('demoSaveStatus').textContent = '已存入這次的示範日誌。';
}

function openDemoScenario(holding) {
  const { items, currency, budget } = activeMarket();
  const item = {
    ...holding, currency, budget, currentShares: holding.shares, averageCost: holding.cost,
    shareUnit: 1, commissionRatePercent: 0.1, sellTaxRatePercent: currency === 'TWD' ? 0.3 : 0
  };
  const context = {
    otherSameSymbolShares: 0,
    otherStockValue: items.filter((row) => row !== holding).reduce((sum, row) => sum + row.price * row.shares, 0)
  };
  $('demoBudget').value = budget;
  $('demoBuy').value = holding.price;
  $('demoScenarioIntro').textContent = `${holding.name} · ${holding.shares} 股 · 參考價 ${formatScenarioMoney(holding.price, currency)}／股。示範手續費 0.1%，估計賣出稅 ${item.sellTaxRatePercent}%。`;
  $('demoSaveStatus').textContent = '';
  $('demoScenario').hidden = false;
  comparison = mountScenarioComparison($('demoComparison'), {
    item, buyPrice: () => $('demoBuy').validity.valid && Number($('demoBuy').value) > 0 ? Number($('demoBuy').value) : holding.price,
    portfolio: context, onSave: (scenario) => saveDemoScenario(item, scenario), saveLabel: '存入示範日誌'
  });
  $('demoBudget').oninput = () => {
    if ($('demoBudget').validity.valid) {
      item.budget = Number($('demoBudget').value);
      comparison.refresh();
    }
  };
  $('demoBuy').oninput = () => comparison.refresh();
  $('demoScenario').scrollIntoView({ block: 'start' });
  $('demoBudget').focus({ preventScroll: true });
}

$('demoNotice').prepend(`固定資料日期 ${date}。`);
$('demoMarket').addEventListener('change', renderDemoMarket);
$('demoHoldings').addEventListener('click', (event) => {
  const button = event.target.closest('[data-demo-holding]');
  if (!button) return;
  const holding = activeMarket().items.find((item) => item.id === button.dataset.demoHolding);
  if (holding) openDemoScenario(holding);
});
const demoStress = mountPortfolioStress($('demoStress'), {
  getPositions: () => Object.entries(markets).flatMap(([market, group]) => group.items.map((item) => ({
    ...item, currency: group.currency, market, marketName: market === 'tw' ? '台灣' : '美國', source: '固定示範 · ' + date
  }))),
  onSave: ({ group, change, difference }) => {
    saveDemoEntry(group.label + ' · 持倉壓力測試', '基準情境 ' + change + '%，估算市值變動 ' + formatScenarioMoney(difference, group.currency) + '。');
    $('demoJournal').scrollIntoView({ block: 'start' });
  }
});
renderDemoMarket();
$('demoMarket').disabled = false;
$('demoStress').hidden = false;
$('demoLoading').hidden = true;

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
