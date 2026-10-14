/* Atlas Money — UI wiring. */
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = Charts.esc;

  // ---------- Dates & formatting ----------
  const pad = n => String(n).padStart(2, '0');
  const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => isoDate(new Date());
  const monthKey = s => s.slice(0, 7);
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const monthLabel = (key, withYear) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  };
  const longDate = s => parseDate(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const shortDate = s => parseDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000) + 1;

  let fmtFull, fmtCompact;
  function setupFormatters() {
    const currency = Store.settings.currency || 'USD';
    fmtFull = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    fmtCompact = new Intl.NumberFormat(undefined, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
  }
  const money = (v, compact) => (compact ? fmtCompact : fmtFull).format(v || 0);

  // ---------- Aggregation helpers ----------
  const inRange = (from, to) => t => (!from || t.date >= from) && (!to || t.date <= to);
  const sum = list => list.reduce((s, t) => s + t.amount, 0);
  const totals = list => {
    const income = sum(list.filter(t => t.type === 'income'));
    const expense = sum(list.filter(t => t.type === 'expense'));
    return { income, expense, net: income - expense };
  };
  function groupBy(list, keyFn) {
    const m = new Map();
    list.forEach(t => { const k = keyFn(t); m.set(k, (m.get(k) || []).concat(t)); });
    return m;
  }
  const byNewest = (a, b) => b.date.localeCompare(a.date) || (b._seq ?? 0) - (a._seq ?? 0);

  // ---------- Tabs ----------
  let currentView = 'dashboard';
  function showView(name) {
    currentView = name;
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    Charts.hideTip();
    render();
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => showView(b.dataset.goto)));

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }

  // ---------- Transaction form ----------
  const form = $('#tx-form');
  const formType = () => form.elements.type.value;

  function fillCategorySelect(select, type, selected) {
    const cats = Store.categories[type];
    select.innerHTML = cats.map(c => `<option${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
    if (selected && !cats.includes(selected)) select.insertAdjacentHTML('beforeend', `<option selected>${esc(selected)}</option>`);
  }

  function resetForm() {
    form.reset();
    form.elements.id.value = '';
    form.elements.date.value = today();
    fillCategorySelect(form.elements.category, formType());
    $('#tx-submit').textContent = 'Add transaction';
    $('#tx-cancel').hidden = true;
  }

  $$('input[name="type"]', form).forEach(r => r.addEventListener('change', () => fillCategorySelect(form.elements.category, formType())));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = form.elements;
    const editing = !!f.id.value;
    const saved = Store.upsertTx({
      id: f.id.value || Store.uid(),
      type: formType(),
      amount: f.amount.value,
      date: f.date.value,
      category: f.category.value,
      method: f.method.value,
      description: f.description.value,
      notes: f.notes.value,
    });
    if (!saved) return toast('Please enter a valid amount and date.');
    const keepDate = f.date.value, keepType = formType(), keepMethod = f.method.value;
    resetForm();
    if (!editing) {
      // keep the context for quick consecutive entries
      f.date.value = keepDate;
      form.querySelector(`input[name="type"][value="${keepType}"]`).checked = true;
      fillCategorySelect(f.category, keepType);
      f.method.value = keepMethod;
    }
    toast(editing ? 'Transaction updated' : 'Transaction added');
    render();
    f.amount.focus();
  });
  $('#tx-cancel').addEventListener('click', resetForm);

  function editTx(id) {
    const t = Store.transactions.find(x => x.id === id);
    if (!t) return;
    showView('dashboard');
    const f = form.elements;
    f.id.value = t.id;
    form.querySelector(`input[name="type"][value="${t.type}"]`).checked = true;
    fillCategorySelect(f.category, t.type, t.category);
    f.amount.value = t.amount;
    f.date.value = t.date;
    f.method.value = t.method || 'Other';
    f.description.value = t.description;
    f.notes.value = t.notes;
    $('#tx-submit').textContent = 'Save changes';
    $('#tx-cancel').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.amount.focus();
  }

  function deleteTx(id) {
    const t = Store.transactions.find(x => x.id === id);
    if (!t || !confirm(`Delete "${t.description || t.category}" (${money(t.amount)})?`)) return;
    Store.deleteTx(id);
    if (form.elements.id.value === id) resetForm();
    toast('Transaction deleted');
    render();
  }

  // Shared list renderer (grouped by day)
  function renderTxList(container, list, { grouped = true } = {}) {
    if (!list.length) {
      container.innerHTML = `<div class="empty">No transactions yet. Add one using the form${Store.transactions.length ? ' or adjust your filters' : ''}.</div>`;
      return;
    }
    const row = t => `
      <div class="tx">
        <div style="min-width:0">
          <div class="desc">${esc(t.description || t.category)}</div>
          <div class="meta"><span class="tag">${esc(t.category)}</span>${esc(t.method || '')}${t.notes ? ' · ' + esc(t.notes) : ''}</div>
        </div>
        <div class="amt ${t.type}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</div>
        <div class="actions">
          <button data-edit="${t.id}" title="Edit" aria-label="Edit">Edit</button>
          <button data-del="${t.id}" title="Delete" aria-label="Delete">Delete</button>
        </div>
      </div>`;
    if (!grouped) { container.innerHTML = list.map(row).join(''); return; }
    const days = groupBy(list, t => t.date);
    container.innerHTML = [...days].map(([d, items]) => {
      const tt = totals(items);
      return `<div class="tx-day"><span>${longDate(d)}</span><span>${tt.expense ? '−' + money(tt.expense) : ''}${tt.income ? ' +' + money(tt.income) : ''}</span></div>${items.map(row).join('')}`;
    }).join('');
  }

  document.addEventListener('click', e => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) editTx(edit.dataset.edit);
    if (del) deleteTx(del.dataset.del);
  });

  function sortedTx(list) {
    return list.map((t, i) => ({ ...t, _seq: i })).sort(byNewest);
  }

  // ---------- Dashboard ----------
  function statTile(label, value, sub = '', swatch) {
    return `<div class="stat"><div class="label">${swatch ? `<i class="swatch" style="background:${swatch}"></i>` : ''}${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  function renderDashboard() {
    const now = new Date();
    const mKey = isoDate(now).slice(0, 7);
    const prevKey = isoDate(addMonths(now, -1)).slice(0, 7);
    const month = Store.transactions.filter(t => monthKey(t.date) === mKey);
    const prev = Store.transactions.filter(t => monthKey(t.date) === prevKey);
    const tt = totals(month), pt = totals(prev);

    $('#dash-month-title').textContent = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    let change = '';
    if (pt.expense > 0) {
      const pct = ((tt.expense - pt.expense) / pt.expense) * 100;
      change = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs last month`;
    }
    const budget = Number(Store.settings.budget) || 0;
    let budgetTile = '';
    if (budget > 0) {
      const used = tt.expense / budget;
      budgetTile = `<div class="stat"><div class="label">Budget left</div><div class="value">${money(budget - tt.expense)}</div>
        <div class="budget-bar${used > 1 ? ' over' : ''}"><div style="width:${Math.min(100, used * 100)}%"></div></div>
        <div class="sub">${(used * 100).toFixed(0)}% of ${money(budget)} used</div></div>`;
    }
    $('#dash-stats').innerHTML =
      statTile('Spent', money(tt.expense), change) +
      statTile('Earned', money(tt.income)) +
      statTile('Net', money(tt.net), tt.income ? `${((tt.net / tt.income) * 100).toFixed(0)}% saved` : '') +
      budgetTile;

    const cats = categoryTotals(month.filter(t => t.type === 'expense'));
    Charts.hbars($('#dash-cats'), cats.slice(0, 5), v => money(v));

    renderTxList($('#dash-recent'), sortedTx(Store.transactions).slice(0, 8));
  }

  function categoryTotals(expenses) {
    const m = groupBy(expenses, t => t.category);
    return [...m].map(([label, items]) => ({ label, value: sum(items), count: items.length, detail: `${items.length} transaction${items.length > 1 ? 's' : ''}` }))
      .sort((a, b) => b.value - a.value);
  }

  // ---------- Transactions view ----------
  const filters = { search: $('#f-search'), from: $('#f-from'), to: $('#f-to'), type: $('#f-type'), category: $('#f-category') };
  Object.values(filters).forEach(i => i.addEventListener('input', renderTransactions));
  $('#f-clear').addEventListener('click', () => { Object.values(filters).forEach(i => (i.value = '')); renderTransactions(); });

  function renderTransactions() {
    const sel = filters.category.value;
    const allCats = [...new Set([...Store.categories.expense, ...Store.categories.income, ...Store.transactions.map(t => t.category)])].sort();
    filters.category.innerHTML = '<option value="">All</option>' + allCats.map(c => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');

    const q = filters.search.value.trim().toLowerCase();
    const list = sortedTx(Store.transactions).filter(t =>
      inRange(filters.from.value, filters.to.value)(t) &&
      (!filters.type.value || t.type === filters.type.value) &&
      (!filters.category.value || t.category === filters.category.value) &&
      (!q || `${t.description} ${t.notes} ${t.category}`.toLowerCase().includes(q)));
    const tt = totals(list);
    $('#tx-summary').innerHTML = list.length
      ? `${list.length} transaction${list.length > 1 ? 's' : ''} · Spent <b>${money(tt.expense)}</b> · Earned <b>${money(tt.income)}</b> · Net <b>${money(tt.net)}</b>`
      : '';
    renderTxList($('#tx-list'), list);
  }

  // ---------- Reports ----------
  const rPeriod = $('#r-period'), rFrom = $('#r-from'), rTo = $('#r-to');
  rPeriod.addEventListener('change', () => {
    const custom = rPeriod.value === 'custom';
    $$('.custom-range').forEach(l => (l.hidden = !custom));
    if (custom && !rFrom.value) {
      const r = periodRange('this-month');
      rFrom.value = r.from; rTo.value = r.to;
    }
    renderReports();
  });
  [rFrom, rTo].forEach(i => i.addEventListener('change', renderReports));

  function periodRange(p) {
    const now = new Date();
    const first = (y, m) => isoDate(new Date(y, m, 1));
    const last = (y, m) => isoDate(new Date(y, m + 1, 0));
    const y = now.getFullYear(), m = now.getMonth();
    switch (p) {
      case 'this-month': return { from: first(y, m), to: last(y, m) };
      case 'last-month': return { from: first(y, m - 1), to: last(y, m - 1) };
      case 'last-3': return { from: first(y, m - 2), to: last(y, m) };
      case 'this-year': return { from: `${y}-01-01`, to: `${y}-12-31` };
      case 'last-12': return { from: first(y, m - 11), to: last(y, m) };
      case 'all': {
        const dates = Store.transactions.map(t => t.date).sort();
        return { from: dates[0] || first(y, m), to: dates.at(-1) > today() ? dates.at(-1) : last(y, m) };
      }
      case 'custom': {
        let from = rFrom.value || first(y, m), to = rTo.value || last(y, m);
        if (from > to) [from, to] = [to, from];
        return { from, to };
      }
    }
  }

  function monthsBetween(from, to) {
    const out = [];
    let d = new Date(parseDate(from).getFullYear(), parseDate(from).getMonth(), 1);
    const end = monthKey(to);
    while (isoDate(d).slice(0, 7) <= end) { out.push(isoDate(d).slice(0, 7)); d = addMonths(d, 1); }
    return out;
  }

  function renderReports() {
    const { from, to } = periodRange(rPeriod.value);
    const list = Store.transactions.filter(inRange(from, to));
    const expenses = list.filter(t => t.type === 'expense');
    const tt = totals(list);
    const days = daysBetween(from, to);
    const elapsed = to > today() ? Math.max(1, daysBetween(from, today())) : days;

    $('#r-range-label').textContent = `${shortDate(from)} – ${shortDate(to)} · ${list.length} transaction${list.length === 1 ? '' : 's'}`;
    $('#r-stats').innerHTML =
      statTile('Total spent', money(tt.expense), '', 'var(--expense)') +
      statTile('Total earned', money(tt.income), '', 'var(--income)') +
      statTile('Net savings', money(tt.net), tt.income ? `${((tt.net / tt.income) * 100).toFixed(0)}% savings rate` : '') +
      statTile('Avg. per day', money(tt.expense / Math.max(1, elapsed)), `over ${elapsed} day${elapsed > 1 ? 's' : ''}`);

    // Category breakdown
    const cats = categoryTotals(expenses);
    Charts.hbars($('#r-cat-chart'), cats, v => money(v), { limit: 10 });
    $('#r-cat-table').innerHTML = cats.length ? `
      <table>
        <thead><tr><th>Category</th><th class="num">Txns</th><th class="num">Amount</th><th class="num">Share</th></tr></thead>
        <tbody>${cats.map(c => `<tr><td>${esc(c.label)}</td><td class="num">${c.count}</td><td class="num">${money(c.value)}</td><td class="num">${((c.value / tt.expense) * 100).toFixed(1)}%</td></tr>`).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${expenses.length}</th><th class="num">${money(tt.expense)}</th><th class="num">100%</th></tr></tfoot>
      </table>` : '<div class="empty">No expenses in this period.</div>';

    // Monthly trend: months in range (at least the 6 months leading up to the end)
    let months = monthsBetween(from, to);
    if (months.length < 6) months = monthsBetween(isoDate(addMonths(parseDate(to), -5)), to);
    const byMonth = groupBy(Store.transactions.filter(t => months.includes(monthKey(t.date))), t => monthKey(t.date));
    const multiYear = months[0].slice(0, 4) !== months.at(-1).slice(0, 4);
    Charts.columns($('#r-monthly'), months.map(k => {
      const t = totals(byMonth.get(k) || []);
      return {
        label: monthLabel(k, multiYear), values: [t.income, t.expense],
        tip: `${monthLabel(k, true)}<br>Income: <b>${money(t.income)}</b><br>Expenses: <b>${money(t.expense)}</b><br>Net: <b>${money(t.net)}</b>`,
      };
    }), [{ name: 'Income', color: 'var(--income)' }, { name: 'Expenses', color: 'var(--expense)' }], money,
    { tickEvery: Math.ceil(months.length / 12) });

    // Daily spending (or weekday averages for long periods)
    const dailyTitle = $('#r-daily').previousElementSibling;
    if (days <= 62) {
      dailyTitle.textContent = 'Daily spending';
      const byDay = groupBy(expenses, t => t.date);
      const groups = [];
      for (let d = parseDate(from); isoDate(d) <= to; d.setDate(d.getDate() + 1)) {
        const k = isoDate(d), items = byDay.get(k) || [];
        groups.push({
          label: String(d.getDate()), values: [sum(items)],
          tip: `${longDate(k)}<br>Spent: <b>${money(sum(items))}</b>${items.length ? `<br>${items.length} transaction${items.length > 1 ? 's' : ''}` : ''}`,
        });
      }
      Charts.columns($('#r-daily'), groups, [{ name: 'Spent', color: 'var(--expense)' }], money, { tickEvery: Math.ceil(groups.length / 10) });
    } else {
      dailyTitle.textContent = 'Average spending by weekday';
      const names = [...Array(7)].map((_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })); // Sun..Sat
      const totalsByDow = Array(7).fill(0), countDow = Array(7).fill(0);
      for (let d = parseDate(from); isoDate(d) <= to && isoDate(d) <= today(); d.setDate(d.getDate() + 1)) countDow[d.getDay()]++;
      expenses.forEach(t => (totalsByDow[parseDate(t.date).getDay()] += t.amount));
      const order = [1, 2, 3, 4, 5, 6, 0];
      Charts.columns($('#r-daily'), order.map(i => ({
        label: names[i], values: [countDow[i] ? totalsByDow[i] / countDow[i] : 0],
        tip: `${names[i]}<br>Average: <b>${money(countDow[i] ? totalsByDow[i] / countDow[i] : 0)}</b><br>Total: ${money(totalsByDow[i])}`,
      })), [{ name: 'Average', color: 'var(--expense)' }], money);
    }

    // Payment methods
    const methods = [...groupBy(expenses, t => t.method || 'Unspecified')]
      .map(([label, items]) => ({ label, value: sum(items), detail: `${items.length} transaction${items.length > 1 ? 's' : ''} · ${((sum(items) / tt.expense) * 100).toFixed(0)}%` }))
      .sort((a, b) => b.value - a.value);
    Charts.hbars($('#r-method'), methods, v => money(v));

    // Largest expenses
    renderTxList($('#r-largest'), [...expenses].sort((a, b) => b.amount - a.amount).slice(0, 10), { grouped: false });
  }

  // ---------- Settings ----------
  function renderSettings() {
    ['expense', 'income'].forEach(type => {
      const used = new Set(Store.transactions.filter(t => t.type === type).map(t => t.category));
      $(`#cats-${type}`).innerHTML = Store.categories[type].map(c => `
        <li>${esc(c)}
          <button data-rename-cat="${esc(c)}" data-type="${type}" title="Rename" aria-label="Rename ${esc(c)}">✎</button>
          <button data-remove-cat="${esc(c)}" data-type="${type}" data-used="${used.has(c) ? 1 : ''}" title="Remove" aria-label="Remove ${esc(c)}">×</button>
        </li>`).join('');
    });
    $('#s-currency').value = Store.settings.currency;
    $('#s-budget').value = Store.settings.budget ?? '';
  }

  $$('.inline-form').forEach(f => f.addEventListener('submit', e => {
    e.preventDefault();
    const input = $('input', f);
    if (Store.addCategory(f.dataset.catType, input.value)) { input.value = ''; render(); refreshFormCategories(); }
    else toast('That category already exists.');
  }));

  document.addEventListener('click', e => {
    const rm = e.target.closest('[data-remove-cat]');
    const rn = e.target.closest('[data-rename-cat]');
    if (rm) {
      const name = rm.dataset.removeCat;
      const msg = rm.dataset.used
        ? `Remove "${name}" from the list? Existing transactions keep this category.`
        : `Remove "${name}"?`;
      if (confirm(msg)) { Store.removeCategory(rm.dataset.type, name); render(); refreshFormCategories(); }
    }
    if (rn) {
      const from = rn.dataset.renameCat;
      const to = prompt(`Rename "${from}" to (also updates existing transactions):`, from);
      if (to && Store.renameCategory(rn.dataset.type, from, to)) { render(); refreshFormCategories(); toast('Category renamed'); }
    }
  });

  function refreshFormCategories() {
    fillCategorySelect(form.elements.category, formType(), form.elements.category.value);
  }

  $('#s-currency').addEventListener('change', e => { Store.setSetting('currency', e.target.value); setupFormatters(); toast('Currency updated'); });
  $('#s-budget').addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    Store.setSetting('budget', isFinite(v) && v > 0 ? v : null);
    toast('Budget saved');
  });

  // ---------- Import / export ----------
  const CSV_COLS = ['date', 'type', 'amount', 'category', 'description', 'method', 'notes'];
  const csvCell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#export-csv').addEventListener('click', () => {
    const rows = [...Store.transactions].sort((a, b) => a.date.localeCompare(b.date));
    const csv = [CSV_COLS.join(',')].concat(rows.map(t => CSV_COLS.map(c => csvCell(t[c] ?? '')).join(','))).join('\n');
    download(`atlas-money-${today()}.csv`, csv, 'text/csv');
  });
  $('#export-json').addEventListener('click', () => {
    download(`atlas-money-backup-${today()}.json`, JSON.stringify(Store.exportData(), null, 2), 'application/json');
  });

  function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [header, ...body] = rows.filter(r => r.some(c => c.trim()));
    const keys = header.map(h => h.trim().toLowerCase());
    return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
  }

  $('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(text);
        if (!Array.isArray(data.transactions)) throw new Error('Not an Atlas Money backup');
        if (!confirm(`Replace all current data with this backup (${data.transactions.length} transactions)?`)) return;
        Store.replaceAll(data);
        toast('Backup restored');
      } else {
        const rows = parseCSV(text);
        if (!rows.length || !('date' in rows[0]) || !('amount' in rows[0])) throw new Error('CSV needs at least "date" and "amount" columns');
        const added = Store.mergeTransactions(rows);
        toast(`Imported ${added} transaction${added === 1 ? '' : 's'}`);
      }
      setupFormatters();
      resetForm();
      render();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });

  $('#clear-all').addEventListener('click', () => {
    if (!confirm('Delete ALL transactions, categories and settings? This cannot be undone.')) return;
    Store.clear();
    setupFormatters();
    resetForm();
    render();
    toast('All data deleted');
  });

  $('#load-sample').addEventListener('click', () => {
    if (!confirm('Add about 3 months of sample transactions? You can delete them later with "Delete all data".')) return;
    Store.mergeTransactions(sampleData());
    render();
    toast('Sample data added');
  });

  function sampleData() {
    const out = [];
    const rnd = (a, b) => Math.round((a + Math.random() * (b - a)) * 100) / 100;
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const now = new Date();
    for (let mo = 2; mo >= 0; mo--) {
      const base = addMonths(now, -mo);
      const y = base.getFullYear(), m = base.getMonth();
      const lastDay = mo === 0 ? now.getDate() : new Date(y, m + 1, 0).getDate();
      const d = day => isoDate(new Date(y, m, Math.min(day, lastDay)));
      out.push({ date: d(1), type: 'income', amount: 4200, category: 'Salary', description: 'Monthly salary', method: 'Bank transfer' });
      out.push({ date: d(2), type: 'expense', amount: 1350, category: 'Housing & Rent', description: 'Rent', method: 'Bank transfer' });
      out.push({ date: d(5), type: 'expense', amount: rnd(60, 110), category: 'Utilities', description: 'Electricity bill', method: 'Debit card' });
      out.push({ date: d(8), type: 'expense', amount: 45, category: 'Utilities', description: 'Internet', method: 'Credit card' });
      for (let day = 1; day <= lastDay; day++) {
        if (Math.random() < 0.55) out.push({ date: d(day), type: 'expense', amount: rnd(6, 28), category: 'Food & Dining', description: pick(['Lunch', 'Coffee', 'Dinner out', 'Takeaway']), method: pick(['Cash', 'UPI / Wallet', 'Credit card']) });
        if (Math.random() < 0.3) out.push({ date: d(day), type: 'expense', amount: rnd(3, 18), category: 'Transport', description: pick(['Bus', 'Metro', 'Taxi', 'Fuel']), method: pick(['Cash', 'UPI / Wallet', 'Debit card']) });
        if (day % 7 === 3) out.push({ date: d(day), type: 'expense', amount: rnd(55, 120), category: 'Groceries', description: 'Weekly groceries', method: 'Debit card' });
        if (Math.random() < 0.08) out.push({ date: d(day), type: 'expense', amount: rnd(20, 160), category: 'Shopping', description: pick(['Clothes', 'Household items', 'Electronics accessory']), method: 'Credit card' });
        if (Math.random() < 0.07) out.push({ date: d(day), type: 'expense', amount: rnd(12, 60), category: 'Entertainment', description: pick(['Movie', 'Concert', 'Streaming', 'Games']), method: 'Credit card' });
      }
      if (Math.random() < 0.6) out.push({ date: d(18), type: 'expense', amount: rnd(25, 90), category: 'Health', description: 'Pharmacy', method: 'Debit card' });
      if (mo === 1) out.push({ date: d(20), type: 'income', amount: 350, category: 'Business', description: 'Freelance project', method: 'Bank transfer' });
    }
    return out;
  }

  // ---------- Render loop ----------
  function render() {
    if (currentView === 'dashboard') renderDashboard();
    if (currentView === 'transactions') renderTransactions();
    if (currentView === 'reports') renderReports();
    if (currentView === 'settings') renderSettings();
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
  // Keep tabs in sync if data changes in another tab
  window.addEventListener('storage', () => location.reload());

  setupFormatters();
  resetForm();
  render();
})();
