export function mountQuickSearch({ button, dialog, input, results, getEntries, canOpen }) {
  const collator = new Intl.Collator('zh-TW', { sensitivity: 'base' });
  const normalize = (text) => String(text || '').normalize('NFKC').toLocaleLowerCase();
  let recent = [];
  const search = () => {
    const query = normalize(input.value).trim();
    const words = query.split(/\s+/).filter(Boolean);
    const entries = getEntries(input.value.trim());
    const matches = query
      ? entries.filter((entry) => words.every((word) => normalize(entry.label + ' ' + (entry.keywords || '')).includes(word)))
        .sort((a, b) => Number(a.kind === 'lookup') - Number(b.kind === 'lookup') ||
          Number(normalize(b.label).startsWith(query)) - Number(normalize(a.label).startsWith(query)) || collator.compare(a.label, b.label))
      : [...recent.map((id) => entries.find((row) => row.id === id)).filter(Boolean), ...entries.filter((row) => row.featured)];
    const unique = [...new Map(matches.map((entry) => [entry.id, entry])).values()].slice(0, 10);
    results.replaceChildren();
    for (const entry of unique) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'quick-result';
      const label = document.createElement('strong'), detail = document.createElement('span');
      label.textContent = entry.label; detail.textContent = entry.detail;
      row.append(label, detail);
      row.addEventListener('click', () => {
        if (entry.kind === 'feature') recent = [entry.id, ...recent.filter((id) => id !== entry.id)].slice(0, 5);
        dialog.close();
        entry.run();
      });
      results.append(row);
    }
    if (!unique.length) {
      const message = document.createElement('p');
      message.textContent = '找不到符合的功能或持股。';
      results.append(message);
    }
  };
  const open = () => {
    if (dialog.open || !canOpen() || document.querySelector('dialog[open]')) return;
    input.value = '';
    search(); dialog.showModal(); input.focus();
  };
  button.addEventListener('click', open);
  input.addEventListener('input', search);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k' && canOpen()) {
      event.preventDefault();
      open();
    }
  });
  dialog.addEventListener('keydown', (event) => {
    const rows = [...results.querySelectorAll('button')];
    if (!rows.length) return;
    if (event.key === 'Enter' && event.target === input && input.value.trim() && !event.isComposing) {
      event.preventDefault();
      rows[0].click();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = rows.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') rows[Math.min(index + 1, rows.length - 1)].focus();
      else if (index <= 0) input.focus();
      else rows[index - 1].focus();
    }
  });
}
