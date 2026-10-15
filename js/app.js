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
  const accountName = id => Store.accountById(id)?.name || 'No account';
  // Signed effect of a transaction on one account's balance.
  function effectOn(t, accId) {
    if (t.type === 'transfer') return t.toAccountId === accId ? t.amount : t.accountId === accId ? -t.amount : 0;
    if (t.accountId !== accId) return 0;
    return t.type === 'income' ? t.amount : -t.amount;
  }
  const touches = (t, accId) => t.accountId === accId || t.toAccountId === accId;
  function balanceOf(acc, upTo) {
    return Store.transactions.reduce((b, t) => (!upTo || t.date <= upTo ? b + effectOn(t, acc.id) : b), acc.openingBalance);
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
    const cats = Store.categories[type] || [];
    select.innerHTML = cats.map(c => `<option${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
    if (selected && !cats.includes(selected)) select.insertAdjacentHTML('beforeend', `<option selected>${esc(selected)}</option>`);
  }

  function fillAccountSelect(select, selected, { allowNone = true, exclude } = {}) {
    const list = Store.accounts.filter(a => (!a.archived || a.id === selected) && a.id !== exclude);
    select.innerHTML = (allowNone ? '<option value="">— No account —</option>' : '') +
      list.map(a => `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  }

  // Show/hide fields for income/expense vs. transfer and refresh the dropdowns.
  function syncFormType(accountId, toAccountId) {
    const f = form.elements, transfer = formType() === 'transfer';
    $$('.transfer-only', form).forEach(e => (e.hidden = !transfer));
    $$('.not-transfer', form).forEach(e => (e.hidden = transfer));
    f.category.required = !transfer;
    $('#account-label').textContent = transfer ? 'From account' : 'Account';
    const from = accountId ?? (f.accountId.value || Store.settings.lastAccountId || '');
    fillAccountSelect(f.accountId, from, { allowNone: !transfer });
    if (transfer) {
      const fromId = f.accountId.value;
      const to = toAccountId ?? f.toAccountId.value;
      fillAccountSelect(f.toAccountId, to, { allowNone: false, exclude: fromId });
    } else {
      fillCategorySelect(f.category, formType(), f.category.value);
    }
  }

  function resetForm() {
    form.reset();
    form.elements.id.value = '';
    form.elements.date.value = today();
    form.elements.category.innerHTML = '';
    syncFormType();
    $('#tx-submit').textContent = 'Add transaction';
    $('#tx-cancel').hidden = true;
  }

  $$('input[name="type"]', form).forEach(r => r.addEventListener('change', () => {
    form.elements.category.innerHTML = '';
    syncFormType();
  }));
  form.elements.accountId.addEventListener('change', () => { if (formType() === 'transfer') syncFormType(); });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = form.elements;
    const editing = !!f.id.value;
    const transfer = formType() === 'transfer';
    if (transfer && Store.accounts.filter(a => !a.archived).length < 2) {
      return toast('Add at least two accounts (Accounts tab) to record a transfer.');
    }
    const before = Store.transactions.find(x => x.id === f.id.value);
    const saved = Store.upsertTx({
      statementText: before?.statementText,
      statementAccountId: before?.statementAccountId,
      linkedText: before?.linkedText,
      linkedDate: before?.linkedDate,
      id: f.id.value || Store.uid(),
      type: formType(),
      amount: f.amount.value,
      date: f.date.value,
      accountId: f.accountId.value || null,
      toAccountId: transfer ? f.toAccountId.value : undefined,
      category: f.category.value,
      method: transfer ? '' : f.method.value,
      description: f.description.value,
      notes: f.notes.value,
    });
    if (!saved) return toast(transfer ? 'Choose two different accounts for the transfer.' : 'Please enter a valid amount and date.');
    const keep = { date: f.date.value, type: formType(), method: f.method.value, account: f.accountId.value };
    if (!transfer) Store.setSetting('lastAccountId', keep.account || null);
    resetForm();
    if (!editing) {
      // keep the context for quick consecutive entries
      f.date.value = keep.date;
      form.querySelector(`input[name="type"][value="${keep.type}"]`).checked = true;
      syncFormType(keep.account);
      f.method.value = keep.method;
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
    f.category.innerHTML = '';
    if (t.type !== 'transfer') fillCategorySelect(f.category, t.type, t.category);
    syncFormType(t.accountId || '', t.toAccountId);
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
    if (!t || !confirm(`Delete "${t.description || (t.type === 'transfer' ? 'transfer' : t.category)}" (${money(t.amount)})?`)) return;
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
    const row = t => {
      const transfer = t.type === 'transfer';
      const route = transfer ? `${accountName(t.accountId)} → ${accountName(t.toAccountId)}` : '';
      const meta = transfer
        ? `<span class="tag">Transfer</span>${esc(route)}`
        : `<span class="tag">${esc(t.category)}</span>${[t.accountId ? accountName(t.accountId) : '', t.method].filter(Boolean).map(esc).join(' · ')}`;
      return `
      <div class="tx">
        <div style="min-width:0">
          <div class="desc${t.description ? '' : ' faint'}">${esc(t.description || (transfer ? route : t.statementText || t.category))}</div>
          <div class="meta">${t.needsReview ? '<span class="pill warn">To review</span>' : ''}${meta}${t.notes ? ' · ' + esc(t.notes) : ''}${t.statementText && t.description ? ` · <span title="Bank description">${esc(t.statementText)}</span>` : ''}</div>
        </div>
        <div class="amt ${t.type}">${transfer ? '⇄ ' : t.type === 'income' ? '+' : '−'}${money(t.amount)}</div>
        <div class="actions">
          <button data-edit="${t.id}" title="Edit" aria-label="Edit">Edit</button>
          <button data-del="${t.id}" title="Delete" aria-label="Delete">Delete</button>
        </div>
      </div>`;
    };
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

    renderAccountSummary($('#dash-accounts'));
    renderTxList($('#dash-recent'), sortedTx(Store.transactions).slice(0, 8));
  }

  function categoryTotals(expenses) {
    const m = groupBy(expenses, t => t.category);
    return [...m].map(([label, items]) => ({ label, value: sum(items), count: items.length, detail: `${items.length} transaction${items.length > 1 ? 's' : ''}` }))
      .sort((a, b) => b.value - a.value);
  }

  // ---------- Transactions view ----------
  const filters = { search: $('#f-search'), from: $('#f-from'), to: $('#f-to'), type: $('#f-type'), account: $('#f-account'), category: $('#f-category') };
  Object.values(filters).forEach(i => i.addEventListener('input', renderTransactions));
  $('#f-clear').addEventListener('click', () => { Object.values(filters).forEach(i => (i.value = '')); renderTransactions(); });

  function renderTransactions() {
    const sel = filters.category.value;
    const allCats = [...new Set([...Store.categories.expense, ...Store.categories.income, ...Store.transactions.map(t => t.category)])].sort();
    filters.category.innerHTML = '<option value="">All</option>' + allCats.map(c => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');

    const accSel = filters.account.value;
    filters.account.innerHTML = '<option value="">All</option><option value="none">No account</option>' +
      Store.accounts.map(a => `<option value="${a.id}">${esc(a.name)}${a.archived ? ' (archived)' : ''}</option>`).join('');
    filters.account.value = [...filters.account.options].some(o => o.value === accSel) ? accSel : '';

    const q = filters.search.value.trim().toLowerCase();
    const list = sortedTx(Store.transactions).filter(t =>
      inRange(filters.from.value, filters.to.value)(t) &&
      (!filters.type.value || t.type === filters.type.value) &&
      (!filters.account.value || (filters.account.value === 'none' ? !t.accountId : touches(t, filters.account.value))) &&
      (!filters.category.value || t.category === filters.category.value) &&
      (!q || `${t.description} ${t.notes} ${t.category} ${t.statementText || ''}`.toLowerCase().includes(q)));
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

  function periodRange(p, customFrom = rFrom.value, customTo = rTo.value) {
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
        let from = customFrom || first(y, m), to = customTo || last(y, m);
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

    const accs = [...groupBy(expenses, t => t.accountId || '')]
      .map(([id, items]) => ({ label: id ? accountName(id) : 'No account', value: sum(items), detail: `${items.length} transaction${items.length > 1 ? 's' : ''} · ${((sum(items) / tt.expense) * 100).toFixed(0)}%` }))
      .sort((a, b) => b.value - a.value);
    Charts.hbars($('#r-account'), accs, v => money(v));

    // Largest expenses
    renderTxList($('#r-largest'), [...expenses].sort((a, b) => b.amount - a.amount).slice(0, 10), { grouped: false });
  }

  // ---------- Accounts ----------
  const accForm = $('#acc-form');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const signedMoney = v => (v < 0 ? '−' : '') + money(Math.abs(v));
  const accSubtitle = a => [Store.ACCOUNT_TYPES[a.type], a.institution, a.number && `••${a.number.slice(-4)}`].filter(Boolean).join(' · ');

  function accountTotals() {
    const active = Store.accounts.filter(a => !a.archived);
    const bals = active.map(a => balanceOf(a));
    const assets = bals.filter(b => b > 0).reduce((s, b) => s + b, 0);
    const owed = -bals.filter(b => b < 0).reduce((s, b) => s + b, 0);
    return { assets, owed, net: assets - owed };
  }

  function renderAccountSummary(container) {
    const active = Store.accounts.filter(a => !a.archived);
    if (!active.length) {
      container.innerHTML = `<div class="empty">Add your bank accounts, cards and cash to track balances.<br><button class="btn small" data-goto-accounts>Add an account</button></div>`;
      return;
    }
    const t = accountTotals();
    container.innerHTML = active.map(a => {
      const b = balanceOf(a);
      return `<button class="acc-row" data-statement="${a.id}" title="View statement">
        <span><span class="acc-name">${esc(a.name)}</span><span class="meta">${esc(Store.ACCOUNT_TYPES[a.type])}</span></span>
        <span class="acc-bal${b < 0 ? ' neg' : ''}">${signedMoney(b)}</span></button>`;
    }).join('') + `<div class="acc-row total"><span>Net worth</span><span class="acc-bal${t.net < 0 ? ' neg' : ''}">${signedMoney(t.net)}</span></div>`;
  }

  function renderAccounts() {
    const showArchived = $('#acc-show-archived').checked;
    const list = Store.accounts.filter(a => showArchived || !a.archived);
    const t = accountTotals();
    $('#acc-totals').innerHTML = Store.accounts.length
      ? statTile('Net worth', signedMoney(t.net)) + statTile('Money you have', money(t.assets), 'accounts in credit') + statTile('Money you owe', money(t.owed), 'accounts below zero')
      : '';
    const mKey = today().slice(0, 7);
    $('#acc-list').innerHTML = list.length ? list.map(a => {
      const b = balanceOf(a);
      const month = Store.transactions.filter(x => monthKey(x.date) === mKey && touches(x, a.id));
      const inflow = month.reduce((s, x) => s + Math.max(0, effectOn(x, a.id)), 0);
      const outflow = month.reduce((s, x) => s + Math.max(0, -effectOn(x, a.id)), 0);
      const count = Store.transactions.filter(x => touches(x, a.id)).length;
      return `<div class="acc-card${a.archived ? ' archived' : ''}">
        <div class="acc-card-head">
          <div style="min-width:0"><div class="acc-name">${esc(a.name)}${a.archived ? ' <span class="tag">Archived</span>' : ''}</div><div class="meta">${esc(accSubtitle(a))}</div></div>
        </div>
        <div class="acc-card-bal${b < 0 ? ' neg' : ''}">${signedMoney(b)}</div>
        <div class="meta">This month: in ${money(inflow)} · out ${money(outflow)}</div>
        <div class="meta">${count} transaction${count === 1 ? '' : 's'}</div>
        <div class="btn-row"><button class="btn small" data-statement="${a.id}">Statement</button><button class="btn small" data-edit-acc="${a.id}">Edit</button></div>
      </div>`;
    }).join('') : `<div class="empty">No accounts yet. Click <b>+ Add account</b> to add your first bank account, card or cash wallet.</div>`;

    // Unassigned transactions helper (e.g. entries recorded before accounts existed)
    const unassigned = Store.transactions.filter(x => !x.accountId);
    const active = Store.accounts.filter(a => !a.archived);
    $('#unassigned-card').hidden = !unassigned.length || !active.length;
    if (unassigned.length && active.length) {
      $('#unassigned-text').textContent = `${unassigned.length} transaction${unassigned.length === 1 ? ' is' : 's are'} not linked to any account, so ${unassigned.length === 1 ? 'it does' : 'they do'} not affect balances. You can assign them all to one account, or edit them one by one.`;
      fillAccountSelect($('#unassigned-account'), $('#unassigned-account').value, { allowNone: false });
    }
    renderStatement();
  }

  function openAccountForm(acc) {
    const f = accForm.elements;
    accForm.reset();
    f.type.innerHTML = Object.entries(Store.ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    f.id.value = acc?.id || '';
    f.name.value = acc?.name || '';
    f.type.value = acc?.type || 'bank';
    f.institution.value = acc?.institution || '';
    f.number.value = acc?.number || '';
    f.openingBalance.value = acc ? acc.openingBalance : '';
    f.archived.checked = !!acc?.archived;
    $('#acc-form-title').textContent = acc ? `Edit ${acc.name}` : 'Add account';
    $('#acc-delete').hidden = !acc;
    $('#acc-form-card').hidden = false;
    $('#acc-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.name.focus();
  }
  const closeAccountForm = () => { $('#acc-form-card').hidden = true; };

  $('#acc-new').addEventListener('click', () => openAccountForm());
  $('#acc-cancel').addEventListener('click', closeAccountForm);
  $('#acc-show-archived').addEventListener('change', renderAccounts);
  accForm.addEventListener('submit', e => {
    e.preventDefault();
    const f = accForm.elements;
    const name = f.name.value.trim();
    if (Store.accounts.some(a => a.id !== f.id.value && a.name.toLowerCase() === name.toLowerCase())) {
      return toast('An account with that name already exists.');
    }
    const saved = Store.upsertAccount({
      id: f.id.value || Store.uid(), name, type: f.type.value, institution: f.institution.value,
      number: f.number.value, openingBalance: f.openingBalance.value, archived: f.archived.checked,
    });
    if (!saved) return;
    closeAccountForm();
    if (!$('#st-account').value) stAccountId = saved.id;
    toast(f.id.value ? 'Account updated' : 'Account added');
    syncFormType();
    render();
  });
  $('#acc-delete').addEventListener('click', () => {
    const id = accForm.elements.id.value, acc = Store.accountById(id);
    if (!acc || !confirm(`Delete the account "${acc.name}"?`)) return;
    if (!Store.deleteAccount(id)) {
      alert('This account has transactions, so it can’t be deleted. Tick "Archived" instead to hide it while keeping its history.');
      return;
    }
    closeAccountForm();
    syncFormType();
    toast('Account deleted');
    render();
  });
  $('#unassigned-assign').addEventListener('click', () => {
    const id = $('#unassigned-account').value, acc = Store.accountById(id);
    const ids = Store.transactions.filter(x => !x.accountId).map(x => x.id);
    if (!acc || !confirm(`Assign ${ids.length} transaction${ids.length === 1 ? '' : 's'} to "${acc.name}"?`)) return;
    Store.assignAccount(ids, id);
    toast('Transactions assigned');
    render();
  });

  document.addEventListener('click', e => {
    const st = e.target.closest('[data-statement]');
    const ed = e.target.closest('[data-edit-acc]');
    if (e.target.closest('[data-goto-accounts]')) { showView('accounts'); openAccountForm(); }
    if (st) {
      stAccountId = st.dataset.statement;
      if (currentView !== 'accounts') showView('accounts'); else renderStatement();
      $('#statement').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (ed) openAccountForm(Store.accountById(ed.dataset.editAcc));
  });

  // ---------- Statements ----------
  let stAccountId = null;
  const stPeriod = $('#st-period'), stFrom = $('#st-from'), stTo = $('#st-to');
  $('#st-account').addEventListener('change', e => { stAccountId = e.target.value; renderStatement(); });
  stPeriod.addEventListener('change', () => {
    const custom = stPeriod.value === 'custom';
    $$('.st-custom').forEach(l => (l.hidden = !custom));
    if (custom && !stFrom.value) { const r = periodRange('this-month'); stFrom.value = r.from; stTo.value = r.to; }
    renderStatement();
  });
  [stFrom, stTo].forEach(i => i.addEventListener('change', renderStatement));

  function statementData() {
    const acc = Store.accountById(stAccountId);
    if (!acc) return null;
    let { from, to } = periodRange(stPeriod.value, stFrom.value, stTo.value);
    if (stPeriod.value === 'all') {
      const dates = Store.transactions.filter(t => touches(t, acc.id)).map(t => t.date).sort();
      if (dates.length) { from = dates[0]; to = dates.at(-1) > today() ? dates.at(-1) : today(); }
    }
    const prevDay = isoDate(new Date(parseDate(from).getTime() - 86400000));
    const opening = balanceOf(acc, prevDay);
    let running = opening;
    const rows = Store.transactions
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => touches(t, acc.id) && t.date >= from && t.date <= to)
      .sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i)
      .map(({ t }) => {
        const amt = effectOn(t, acc.id);
        running += amt;
        const transfer = t.type === 'transfer';
        const other = transfer ? accountName(amt < 0 ? t.toAccountId : t.accountId) : '';
        return {
          t, date: t.date,
          description: t.description || (transfer ? (amt < 0 ? `Transfer to ${other}` : `Transfer from ${other}`) : t.category),
          category: transfer ? (amt < 0 ? `Transfer to ${other}` : `Transfer from ${other}`) : t.category,
          out: amt < 0 ? -amt : 0, in: amt > 0 ? amt : 0, balance: running,
        };
      });
    const totalIn = rows.reduce((s, r) => s + r.in, 0), totalOut = rows.reduce((s, r) => s + r.out, 0);
    return { acc, from, to, opening, closing: running, rows, totalIn, totalOut };
  }

  function renderStatement() {
    const sel = $('#st-account');
    if (!Store.accountById(stAccountId)) stAccountId = (Store.accounts.find(a => !a.archived) || Store.accounts[0])?.id || null;
    sel.innerHTML = Store.accounts.map(a => `<option value="${a.id}">${esc(a.name)}${a.archived ? ' (archived)' : ''}</option>`).join('');
    if (stAccountId) sel.value = stAccountId;
    const d = statementData();
    const body = $('#st-body');
    $('#st-csv').disabled = $('#st-print').disabled = !d;
    if (!d) { body.innerHTML = '<div class="empty">Add an account to see its statement.</div>'; return; }
    body.innerHTML = `
      <div class="st-head">
        <div><div class="st-title">${esc(d.acc.name)}</div><div class="meta">${esc(accSubtitle(d.acc))}</div></div>
        <div class="st-period"><div>Statement period</div><b>${shortDate(d.from)} – ${shortDate(d.to)}</b></div>
      </div>
      <div class="stats st-stats">
        ${statTile('Opening balance', signedMoney(d.opening), `on ${shortDate(d.from)}`)}
        ${statTile('Money in', money(d.totalIn), plural(d.rows.filter(r => r.in).length, 'credit'))}
        ${statTile('Money out', money(d.totalOut), plural(d.rows.filter(r => r.out).length, 'debit'))}
        ${statTile('Closing balance', signedMoney(d.closing), `on ${shortDate(d.to)}`)}
      </div>
      <div class="table-wrap"><table class="st-table">
        <thead><tr><th>Date</th><th>Description</th><th class="hide-sm">Category</th><th class="num hide-sm">Money out</th><th class="num hide-sm">Money in</th><th class="num show-sm">Amount</th><th class="num">Balance</th></tr></thead>
        <tbody>
          <tr class="st-sub"><td>${shortDate(d.from)}</td><td>Opening balance</td><td class="hide-sm"></td><td class="hide-sm"></td><td class="hide-sm"></td><td class="show-sm"></td><td class="num">${signedMoney(d.opening)}</td></tr>
          ${d.rows.map(r => `<tr>
            <td class="nowrap">${shortDate(r.date)}</td>
            <td>${esc(r.description)}${r.t.notes ? `<div class="meta">${esc(r.t.notes)}</div>` : ''}</td>
            <td class="hide-sm">${esc(r.category)}</td>
            <td class="num hide-sm">${r.out ? money(r.out) : ''}</td>
            <td class="num in hide-sm">${r.in ? money(r.in) : ''}</td>
            <td class="num show-sm${r.in ? ' in' : ''}">${r.in ? '+' + money(r.in) : '−' + money(r.out)}</td>
            <td class="num">${signedMoney(r.balance)}</td></tr>`).join('')}
          ${d.rows.length ? '' : '<tr><td colspan="7" class="empty">No transactions in this period.</td></tr>'}
        </tbody>
        <tfoot><tr><th colspan="2">Closing balance</th><th class="hide-sm"></th><th class="num hide-sm">${money(d.totalOut)}</th><th class="num hide-sm">${money(d.totalIn)}</th><th class="show-sm"></th><th class="num">${signedMoney(d.closing)}</th></tr></tfoot>
      </table></div>
      <p class="muted print-only">Generated by Atlas Money on ${shortDate(today())}.</p>`;
  }

  $('#st-csv').addEventListener('click', () => {
    const d = statementData();
    if (!d) return;
    const lines = [['Date', 'Description', 'Category', 'Money out', 'Money in', 'Balance']];
    lines.push([d.from, 'Opening balance', '', '', '', d.opening.toFixed(2)]);
    d.rows.forEach(r => lines.push([r.date, r.description, r.category, r.out ? r.out.toFixed(2) : '', r.in ? r.in.toFixed(2) : '', r.balance.toFixed(2)]));
    lines.push([d.to, 'Closing balance', '', d.totalOut.toFixed(2), d.totalIn.toFixed(2), d.closing.toFixed(2)]);
    const safe = d.acc.name.replace(/[^\w-]+/g, '-').toLowerCase();
    download(`statement-${safe}-${d.from}-to-${d.to}.csv`, lines.map(l => l.map(csvCell).join(',')).join('\n'), 'text/csv');
  });
  $('#st-print').addEventListener('click', () => {
    document.body.classList.add('print-statement');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('print-statement'));

  // ---------- Bulk add accounts ----------
  function bulkRowHtml() {
    const types = Object.entries(Store.ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    return `<tr>
      <td><input type="text" data-f="name" maxlength="60" placeholder="e.g. SBI Savings" aria-label="Account name"></td>
      <td><select data-f="type" aria-label="Type">${types}</select></td>
      <td><input type="text" data-f="institution" maxlength="60" placeholder="Optional" aria-label="Bank"></td>
      <td><input type="text" data-f="number" maxlength="8" placeholder="1234" aria-label="Last 4 digits" class="w-sm"></td>
      <td><input type="number" data-f="openingBalance" step="0.01" placeholder="0.00" aria-label="Starting balance" class="num-input"></td>
      <td><button class="btn small" data-bulk-remove aria-label="Remove row">×</button></td>
    </tr>`;
  }
  $('#acc-bulk-open').addEventListener('click', () => {
    $('#acc-bulk-rows').innerHTML = bulkRowHtml().repeat(4);
    $('#acc-bulk-card').hidden = false;
    $('#acc-bulk-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#acc-bulk-rows input').focus();
  });
  $('#acc-bulk-row').addEventListener('click', () => $('#acc-bulk-rows').insertAdjacentHTML('beforeend', bulkRowHtml()));
  $('#acc-bulk-cancel').addEventListener('click', () => { $('#acc-bulk-card').hidden = true; });
  $('#acc-bulk-rows').addEventListener('click', e => {
    if (e.target.closest('[data-bulk-remove]')) e.target.closest('tr').remove();
  });
  $('#acc-bulk-save').addEventListener('click', () => {
    const rows = $$('#acc-bulk-rows tr').map(tr => Object.fromEntries($$('[data-f]', tr).map(i => [i.dataset.f, i.value.trim()])));
    const named = rows.filter(r => r.name);
    if (!named.length) return toast('Enter at least one account name.');
    const existing = new Set(Store.accounts.map(a => a.name.toLowerCase()));
    const seen = new Set(), clashes = [];
    named.forEach(r => {
      const k = r.name.toLowerCase();
      if (existing.has(k) || seen.has(k)) clashes.push(r.name);
      seen.add(k);
    });
    if (clashes.length) return alert(`These names are already used: ${clashes.join(', ')}. Please give each account a different name.`);
    named.forEach(r => Store.upsertAccount({ ...r, id: Store.uid() }));
    $('#acc-bulk-card').hidden = true;
    toast(`${plural(named.length, 'account')} added`);
    syncFormType();
    render();
  });

  // ---------- Statement import ----------
  const imp = { files: [], current: 0, overrides: new Map(), rows: [], closing: null };
  const impAccount = $('#imp-account');
  const MAP_FIELDS = [
    ['date', 'Date'], ['desc', 'Bank description'], ['debit', 'Money out'], ['credit', 'Money in'],
    ['amount', 'Amount (+/−)'], ['drcr', 'Debit/Credit marker'], ['balance', 'Balance'],
  ];

  function fillImportAccounts() {
    const prev = impAccount.value || Store.settings.lastImportAccountId;
    const active = Store.accounts.filter(a => !a.archived);
    impAccount.innerHTML = active.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('') + '<option value="__new">+ New account…</option>';
    impAccount.value = [...impAccount.options].some(o => o.value === prev) ? prev : (active[0]?.id || '__new');
    $('#imp-new-wrap').hidden = impAccount.value !== '__new';
  }
  impAccount.addEventListener('change', () => {
    $('#imp-new-wrap').hidden = impAccount.value !== '__new';
    if (impAccount.value !== '__new') Store.setSetting('lastImportAccountId', impAccount.value);
    if (imp.files.length) buildPreview();
  });

  const drop = $('#imp-drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); loadStatementFiles([...e.dataTransfer.files]); });
  $('#imp-files').addEventListener('change', e => { loadStatementFiles([...e.target.files]); e.target.value = ''; });

  async function loadStatementFiles(files) {
    if (!files.length) return;
    const status = $('#imp-status');
    status.textContent = `Reading ${plural(files.length, 'file')}…`;
    const ok = [], errors = [];
    for (const file of files) {
      try {
        const data = await Importer.readFile(file, retry =>
          Promise.resolve(prompt(`${retry ? 'That password didn’t work. ' : ''}"${file.name}" is password protected. Enter its password:`)));
        const f = { name: file.name, ...data };
        if (f.kind === 'table') {
          f.headerIdx = Importer.detectHeader(f.rows);
          f.map = Importer.autoMap(f.headerIdx >= 0 ? f.rows[f.headerIdx] : []);
        }
        ok.push(f);
      } catch (err) {
        console.error(err);
        errors.push(`${file.name}: ${err.message || 'could not be read'}`);
      }
    }
    imp.files = ok;
    imp.current = Math.max(0, ok.findIndex(f => f.kind === 'table'));
    imp.overrides = new Map();
    $('#imp-datefmt').value = Importer.detectDateFormat(sampleDates());
    $('#imp-invert').checked = false;
    status.textContent = errors.length ? `Couldn't read: ${errors.join(' · ')}` : '';
    renderMapping();
    buildPreview();
    if (ok.length) $((ok.some(f => f.kind === 'table') ? '#imp-mapping' : '#imp-preview')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function sampleDates() {
    return imp.files.flatMap(f => {
      if (f.kind === 'table') return f.map.date >= 0 ? f.rows.slice(f.headerIdx + 1, f.headerIdx + 200).map(r => r[f.map.date]) : [];
      if (f.kind === 'pdf') return f.lines.map(l => l.slice(0, 12));
      return [];
    });
  }

  function renderMapping() {
    const tables = imp.files.filter(f => f.kind === 'table');
    $('#imp-mapping').hidden = !tables.length;
    if (!tables.length) return;
    const pick = $('#imp-file-pick');
    $('#imp-file-pick-wrap').hidden = tables.length < 2;
    pick.innerHTML = imp.files.map((f, i) => f.kind === 'table' ? `<option value="${i}">${esc(f.name)}</option>` : '').join('');
    pick.value = imp.current;
    const f = imp.files[imp.current];
    const width = Math.max(...f.rows.slice(0, 50).map(r => r.length));
    const header = f.headerIdx >= 0 ? f.rows[f.headerIdx] : [];
    const colName = i => (header[i] ? `${header[i]}` : `Column ${i + 1}`);
    const opts = sel => '<option value="-1">— none —</option>' +
      [...Array(width)].map((_, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(colName(i))}</option>`).join('');
    $('#imp-map-fields').innerHTML =
      `<label>Header row<input type="number" min="0" max="${f.rows.length}" value="${f.headerIdx + 1}" data-map-header title="0 = no header row"></label>` +
      MAP_FIELDS.map(([k, label]) => `<label>${label}<select data-map="${k}">${opts(f.map[k])}</select></label>`).join('');
    const start = Math.max(0, f.headerIdx);
    const shown = f.rows.slice(start, start + 6);
    $('#imp-raw').innerHTML = `<caption class="muted">First rows of ${esc(f.name)}</caption>` + shown.map((r, i) =>
      `<tr${i === 0 && f.headerIdx >= 0 ? ' class="hdr"' : ''}>${[...Array(width)].map((_, c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('');
  }
  $('#imp-file-pick').addEventListener('change', e => { imp.current = +e.target.value; renderMapping(); });
  $('#imp-map-fields').addEventListener('change', e => {
    const f = imp.files[imp.current];
    if (e.target.matches('[data-map-header]')) {
      f.headerIdx = Math.min(f.rows.length - 1, Math.max(0, parseInt(e.target.value, 10) || 0)) - 1;
      f.map = Importer.autoMap(f.headerIdx >= 0 ? f.rows[f.headerIdx] : []);
      renderMapping();
    } else if (e.target.matches('[data-map]')) {
      f.map[e.target.dataset.map] = +e.target.value;
    }
    imp.overrides = new Map();
    buildPreview();
  });
  $('#imp-datefmt').addEventListener('change', buildPreview);
  $('#imp-invert').addEventListener('change', buildPreview);

  const NO_TEXT = '(no bank description)';
  const normText = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const fingerprint = (date, signed, text) => `${date}|${signed.toFixed(2)}|${normText(text)}`;

  function buildPreview() {
    const fmt = $('#imp-datefmt').value, invert = $('#imp-invert').checked;
    const rows = [];
    let closing = null;
    imp.files.forEach((f, fi) => {
      let txs = f.kind === 'table' ? Importer.mapTable(f.rows, f.headerIdx, f.map, { fmt })
        : f.kind === 'pdf' ? Importer.parsePdfLines(f.lines, fmt) : f.txs.map(t => ({ ...t }));
      const c = f.closing || Importer.closingFrom(txs);
      if (c && (!closing || c.date >= closing.date)) closing = c;
      if (invert) txs = txs.map(t => ({ ...t, amount: -t.amount, balance: t.balance == null ? null : -t.balance }));
      txs.forEach((t, ri) => rows.push({ ...t, key: `${fi}:${ri}`, file: f.name }));
    });
    if (closing && invert) closing = { ...closing, balance: -closing.balance };
    rows.sort((a, b) => a.date.localeCompare(b.date));

    // Duplicates: against what's already in the account, and between overlapping files.
    const accId = impAccount.value !== '__new' ? impAccount.value : null;
    const existing = new Map(), loose = new Map();
    if (accId) Store.transactions.forEach(t => {
      const amt = effectOn(t, accId);
      if (!amt) return;
      const linkedSide = t.type === 'transfer' && t.statementAccountId && t.statementAccountId !== accId;
      const text = linkedSide ? t.linkedText : t.statementText;
      const date = linkedSide && t.linkedDate ? t.linkedDate : t.date;
      const key = text != null ? fingerprint(date, amt, text) : `${date}|${amt.toFixed(2)}`;
      const map = text != null ? existing : loose;
      map.set(key, (map.get(key) || 0) + 1);
    });
    // Overlapping files: a row is new up to the most copies any single file has, minus copies already imported.
    const perFile = new Map(), maxInFiles = new Map();
    rows.forEach(r => {
      r.fp = fingerprint(r.date, r.amount, r.text || NO_TEXT);
      const k = `${r.fp}#${r.file}`, n = (perFile.get(k) || 0) + 1;
      perFile.set(k, n);
      maxInFiles.set(r.fp, Math.max(maxInFiles.get(r.fp) || 0, n));
    });
    const keepLeft = new Map();
    rows.forEach(r => {
      if (!keepLeft.has(r.fp)) keepLeft.set(r.fp, Math.max(0, maxInFiles.get(r.fp) - (existing.get(r.fp) || 0)));
      if (!keepLeft.get(r.fp)) { r.status = 'duplicate'; return; }
      keepLeft.set(r.fp, keepLeft.get(r.fp) - 1);
      // Same date + amount as something typed in by hand: likely the same transaction.
      const lk = `${r.date}|${r.amount.toFixed(2)}`;
      if (loose.get(lk) > 0) { r.status = 'possible'; loose.set(lk, loose.get(lk) - 1); }
      else r.status = r.uncertain ? 'check' : 'new';
    });
    rows.forEach(r => {
      const o = imp.overrides.get(r.key) || {};
      if (o.flip) r.amount = -r.amount;
      r.include = o.include ?? (r.status === 'new' || r.status === 'check');
    });
    imp.rows = rows;
    imp.closing = closing;
    renderPreview();
  }

  function renderPreview() {
    const card = $('#imp-preview');
    card.hidden = !imp.files.length;
    if (!imp.files.length) return;
    const rows = imp.rows;
    const inc = rows.filter(r => r.include);
    const totIn = inc.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const totOut = inc.filter(r => r.amount < 0).reduce((s, r) => s - r.amount, 0);
    const dups = rows.filter(r => r.status === 'duplicate').length;
    const checks = rows.filter(r => r.status === 'check').length;
    $('#imp-summary').textContent = rows.length
      ? `${plural(inc.length, 'transaction')} selected · in ${money(totIn)} · out ${money(totOut)}${dups ? ` · ${plural(dups, 'duplicate')} skipped` : ''}`
      : '';
    $('#imp-confirm').disabled = !inc.length;
    $('#imp-confirm').textContent = inc.length ? `Import ${plural(inc.length, 'transaction')}` : 'Import';

    // Starting-balance helper when the statement shows a running balance.
    const accId = impAccount.value !== '__new' ? impAccount.value : null;
    const acc = accId && Store.accountById(accId);
    const wrap = $('#imp-balance-wrap');
    wrap.hidden = !imp.closing;
    if (imp.closing) {
      const fresh = !acc || !Store.transactions.some(t => touches(t, acc.id));
      $('#imp-balance-text').innerHTML = `Set this account's starting balance so its balance on ${shortDate(imp.closing.date)} matches the statement (<b>${signedMoney(imp.closing.balance)}</b>)`;
      if (!wrap.dataset.touched) $('#imp-set-balance').checked = fresh;
    }

    const STATUS = {
      new: '', check: '<span class="pill warn" title="Atlas couldn’t tell if this was money in or out. Use ⇄ to swap it if needed.">Check in/out</span>',
      duplicate: '<span class="pill">Already imported</span>', possible: '<span class="pill warn" title="An entry with the same date and amount already exists in this account.">Possible duplicate</span>',
    };
    $('#imp-table').innerHTML = rows.length ? `
      <thead><tr><th><input type="checkbox" id="imp-all" aria-label="Select all"${inc.length === rows.length ? ' checked' : ''}></th><th>Date</th><th>Bank description</th><th class="num">Money out</th><th class="num">Money in</th><th class="num hide-sm">Balance</th><th></th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr class="${r.include ? '' : 'off'}">
        <td><input type="checkbox" data-imp-inc="${r.key}"${r.include ? ' checked' : ''} aria-label="Include"></td>
        <td class="nowrap">${shortDate(r.date)}</td>
        <td class="wrap-text">${esc(r.text || '—')}${imp.files.length > 1 ? `<div class="meta">${esc(r.file)}</div>` : ''}</td>
        <td class="num">${r.amount < 0 ? money(-r.amount) : ''}</td>
        <td class="num in">${r.amount > 0 ? money(r.amount) : ''}</td>
        <td class="num hide-sm">${r.balance != null ? signedMoney(r.balance) : ''}</td>
        <td>${STATUS[r.status] || ''}</td>
        <td><button class="btn small" data-imp-flip="${r.key}" title="Swap money in / out">⇄</button></td>
      </tr>`).join('')}</tbody>`
      : `<tbody><tr><td class="empty">No transactions found. ${imp.files.some(f => f.kind === 'table') ? 'Check the column choices above, especially Date and the amount columns.' : 'If this is a scanned (image) PDF, download the CSV or Excel version of the statement from your bank instead.'}</td></tr></tbody>`;
  }

  $('#imp-table').addEventListener('change', e => {
    if (e.target.id === 'imp-all') {
      imp.rows.forEach(r => imp.overrides.set(r.key, { ...imp.overrides.get(r.key), include: e.target.checked }));
    } else if (e.target.dataset.impInc) {
      const k = e.target.dataset.impInc;
      imp.overrides.set(k, { ...imp.overrides.get(k), include: e.target.checked });
    } else return;
    buildPreview();
  });
  $('#imp-table').addEventListener('click', e => {
    const b = e.target.closest('[data-imp-flip]');
    if (!b) return;
    const o = imp.overrides.get(b.dataset.impFlip) || {};
    imp.overrides.set(b.dataset.impFlip, { ...o, flip: !o.flip });
    buildPreview();
  });
  $('#imp-set-balance').addEventListener('change', () => { $('#imp-balance-wrap').dataset.touched = '1'; });

  function resetImport() {
    imp.files = []; imp.rows = []; imp.overrides = new Map(); imp.closing = null;
    delete $('#imp-balance-wrap').dataset.touched;
    $('#imp-mapping').hidden = $('#imp-preview').hidden = true;
    $('#imp-status').textContent = '';
  }
  $('#imp-cancel').addEventListener('click', resetImport);

  $('#imp-confirm').addEventListener('click', () => {
    const rows = imp.rows.filter(r => r.include);
    if (!rows.length) return;
    let accId = impAccount.value;
    if (accId === '__new') {
      const name = $('#imp-new-name').value.trim();
      if (!name) { $('#imp-new-name').focus(); return toast('Enter a name for the new account.'); }
      if (Store.accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) return toast('An account with that name already exists.');
      accId = Store.upsertAccount({ id: Store.uid(), name, type: 'bank' }).id;
      $('#imp-new-name').value = '';
    }
    Store.setSetting('lastImportAccountId', accId);
    const added = Store.addImported(rows.map(r => ({
      date: r.date, type: r.amount > 0 ? 'income' : 'expense', amount: Math.abs(r.amount), accountId: accId,
      category: Store.UNCATEGORIZED, description: '', method: '', statementText: r.text || NO_TEXT, needsReview: true,
    })));
    if (imp.closing && $('#imp-set-balance').checked) {
      const acc = Store.accountById(accId);
      const movement = balanceOf({ ...acc, openingBalance: 0 }, imp.closing.date);
      Store.upsertAccount({ ...acc, openingBalance: Math.round((imp.closing.balance - movement) * 100) / 100 });
    }
    resetImport();
    fillImportAccounts();
    syncFormType();
    toast(`Imported ${plural(added.length, 'transaction')} into ${accountName(accId)}`);
    render();
    $('#review').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- Review imported transactions ----------
  const reviewList = $('#review-list');
  const needsReview = () => Store.transactions.filter(t => t.needsReview);

  function updateReviewIndicators() {
    const n = needsReview().length;
    $('#review-badge').hidden = !n;
    $('#review-badge').textContent = n;
    $('#review-banner').hidden = !n || !['dashboard', 'transactions'].includes(currentView);
    $('#review-banner-text').textContent = `${plural(n, 'imported transaction')} ${n === 1 ? 'needs' : 'need'} a description and category.`;
  }

  function categoryOptions(type, selected = '') {
    return `<option value="">Choose category…</option>` + (Store.categories[type] || []).map(c => `<option${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
  }

  function renderReview() {
    const accSel = $('#review-account');
    const prev = accSel.value;
    const all = needsReview();
    const accIds = [...new Set(all.map(t => t.accountId).filter(Boolean))];
    accSel.innerHTML = '<option value="">All accounts</option>' + accIds.map(id => `<option value="${id}">${esc(accountName(id))}</option>`).join('');
    accSel.value = accIds.includes(prev) ? prev : '';
    const items = sortedTx(all.filter(t => !accSel.value || t.accountId === accSel.value));
    $('#review-tools').hidden = !all.length;
    $('#review-count').textContent = all.length ? `${all.length} to go` : '';
    $('#review-bulk-cat').innerHTML = '<option value="">Choose…</option>' +
      `<optgroup label="Money out">${Store.categories.expense.map(c => `<option value="expense|${esc(c)}">${esc(c)}</option>`).join('')}</optgroup>` +
      `<optgroup label="Money in">${Store.categories.income.map(c => `<option value="income|${esc(c)}">${esc(c)}</option>`).join('')}</optgroup>`;
    if (!all.length) {
      reviewList.innerHTML = '<div class="empty">Nothing to review. Imported transactions will appear here so you can add descriptions and categories.</div>';
      return;
    }
    reviewList.innerHTML = items.map(t => {
      const out = t.type === 'expense';
      const others = Store.accounts.filter(a => a.id !== t.accountId && !a.archived);
      return `<div class="rv" data-id="${t.id}">
        <div class="rv-top">
          <input type="checkbox" class="rv-check" aria-label="Select">
          <span class="rv-date">${shortDate(t.date)}</span>
          <span class="tag">${esc(accountName(t.accountId))}</span>
          <span class="rv-text" title="${esc(t.statementText || '')}">${esc(t.statementText || '')}</span>
          <span class="amt ${t.type}">${out ? '−' : '+'}${money(t.amount)}</span>
        </div>
        <div class="rv-fields">
          <select class="rv-type" aria-label="Type">
            <option value="${t.type}">${out ? 'Expense' : 'Income'}</option>
            ${others.length ? `<option value="transfer">${out ? 'Transfer to my account' : 'Transfer from my account'}</option>` : ''}
          </select>
          <input type="text" class="rv-desc" maxlength="120" placeholder="Description" aria-label="Description" value="${esc(t.description || '')}">
          <select class="rv-cat" aria-label="Category">${categoryOptions(t.type)}</select>
          <select class="rv-other" aria-label="${out ? 'To account' : 'From account'}" hidden>
            <option value="">${out ? 'To account…' : 'From account…'}</option>
            ${others.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}
          </select>
          <button class="btn small primary rv-save">Save</button>
          <button class="btn small rv-del" title="Delete this transaction">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  $('#review-account').addEventListener('change', renderReview);
  reviewList.addEventListener('change', e => {
    if (!e.target.matches('.rv-type')) return;
    const row = e.target.closest('.rv'), transfer = e.target.value === 'transfer';
    $('.rv-cat', row).hidden = transfer;
    $('.rv-other', row).hidden = !transfer;
  });
  reviewList.addEventListener('click', e => {
    const row = e.target.closest('.rv');
    if (!row) return;
    if (e.target.closest('.rv-save')) {
      const msg = saveReviewRow(row, true);
      if (msg) toast(msg);
    }
    if (e.target.closest('.rv-del')) {
      const t = Store.transactions.find(x => x.id === row.dataset.id);
      if (t && confirm(`Delete this ${money(t.amount)} transaction from ${shortDate(t.date)}?`)) {
        Store.deleteTx(t.id);
        removeReviewRow(row);
      }
    }
  });
  reviewList.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('.rv-desc')) {
      e.preventDefault();
      const row = e.target.closest('.rv');
      const next = row.nextElementSibling;
      const msg = saveReviewRow(row, true);
      if (msg) toast(msg);
      else $('.rv-desc', next || document.body)?.focus();
    }
  });

  function removeReviewRow(row) {
    row.remove();
    if (!$('.rv', reviewList)) renderReview();
    else $('#review-count').textContent = `${needsReview().length} to go`;
    updateReviewIndicators();
  }

  /** Saves one review row. Returns an error message, or '' on success. */
  function saveReviewRow(row, interactive) {
    const t = Store.transactions.find(x => x.id === row.dataset.id);
    if (!t) { row.remove(); return ''; }
    const type = $('.rv-type', row).value;
    const description = $('.rv-desc', row).value.trim();
    if (type === 'transfer') {
      const other = $('.rv-other', row).value;
      if (!other) return interactive ? 'Choose the other account for this transfer.' : 'skip';
      const out = t.type === 'expense';
      // If the other account's statement has the matching entry, merge it instead of double counting.
      const match = Store.transactions.find(x => x.id !== t.id && x.type !== 'transfer' && x.accountId === other &&
        x.amount === t.amount && x.type === (out ? 'income' : 'expense') &&
        Math.abs(parseDate(x.date) - parseDate(t.date)) <= 4 * 86400000);
      if (match) Store.deleteTx(match.id);
      Store.upsertTx({
        ...t, type: 'transfer', accountId: out ? t.accountId : other, toAccountId: out ? other : t.accountId,
        category: 'Transfer', description, needsReview: false,
        statementAccountId: t.accountId, linkedText: match?.statementText, linkedDate: match?.date,
      });
      if (match) {
        const el = $(`.rv[data-id="${match.id}"]`, reviewList);
        if (el) el.remove();
        if (interactive) toast(`Saved, and matched with the same amount in ${accountName(other)}`);
      }
    } else {
      const category = $('.rv-cat', row).value;
      if (!category) return interactive ? 'Choose a category first.' : 'skip';
      Store.upsertTx({ ...t, category, description, needsReview: false });
    }
    removeReviewRow(row);
    return '';
  }

  $('#review-save-all').addEventListener('click', () => {
    let saved = 0, skipped = 0;
    $$('.rv', reviewList).forEach(row => {
      if (!row.isConnected) return;
      if (saveReviewRow(row, false)) skipped++; else saved++;
    });
    toast(saved ? `Saved ${plural(saved, 'transaction')}${skipped ? ` · ${skipped} still need a category` : ''}` : 'Choose a category on at least one row first.');
    render();
  });

  $('#review-bulk-apply').addEventListener('click', () => {
    const v = $('#review-bulk-cat').value;
    if (!v) return toast('Choose a category to apply.');
    const [type, cat] = [v.slice(0, v.indexOf('|')), v.slice(v.indexOf('|') + 1)];
    let applied = 0, wrong = 0;
    $$('.rv', reviewList).filter(r => $('.rv-check', r).checked).forEach(row => {
      const t = Store.transactions.find(x => x.id === row.dataset.id);
      if (!t || t.type !== type) { wrong++; return; }
      $('.rv-type', row).value = t.type;
      $('.rv-cat', row).hidden = false; $('.rv-other', row).hidden = true;
      $('.rv-cat', row).value = cat;
      $('.rv-check', row).checked = false;
      applied++;
    });
    toast(applied ? `Category set on ${plural(applied, 'row')}${wrong ? ` · ${wrong} skipped (wrong direction)` : ''}. Click "Save all completed" when ready.`
      : 'Tick some rows first (money-out categories only apply to money-out rows).');
  });

  function renderImport() {
    fillImportAccounts();
    renderReview();
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
  const CSV_COLS = ['date', 'type', 'amount', 'account', 'to_account', 'category', 'description', 'method', 'notes', 'statement_text'];
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
    const named = t => ({ ...t, statement_text: t.statementText || '', account: t.accountId ? accountName(t.accountId) : '', to_account: t.toAccountId ? accountName(t.toAccountId) : '' });
    const csv = [CSV_COLS.join(',')].concat(rows.map(named).map(t => CSV_COLS.map(c => csvCell(t[c] ?? '')).join(','))).join('\n');
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
        const added = Store.mergeTransactions(rows.map(r => ({
          ...r,
          accountId: Store.ensureAccount(r.account),
          statementText: r.statement_text,
          toAccountId: Store.ensureAccount(r.to_account),
        })));
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
    const bank = Store.ensureAccount('Main Bank Account');
    const card = Store.ensureAccount('Credit Card');
    const cash = Store.ensureAccount('Cash Wallet');
    [[bank, 'bank', 2500], [card, 'credit', 0], [cash, 'cash', 100]].forEach(([id, type, openingBalance]) => {
      const a = Store.accountById(id);
      if (a.openingBalance === 0 && !Store.transactions.some(t => touches(t, id))) Store.upsertAccount({ ...a, type, openingBalance });
    });
    const accFor = method => method === 'Credit card' ? card : method === 'Cash' ? cash : bank;
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
      out.push({ date: d(10), type: 'transfer', amount: 200, accountId: bank, toAccountId: cash, description: 'ATM withdrawal' });
      if (mo > 0) out.push({ date: d(25), type: 'transfer', amount: 400, accountId: bank, toAccountId: card, description: 'Credit card bill payment' });
    }
    return out.map(t => ({ accountId: accFor(t.method), ...t }));
  }

  // ---------- Render loop ----------
  let started = false;
  function render() {
    if (!started) return; // locked: nothing to draw yet
    if (currentView === 'dashboard') renderDashboard();
    if (currentView === 'transactions') renderTransactions();
    if (currentView === 'reports') renderReports();
    if (currentView === 'accounts') renderAccounts();
    if (currentView === 'import') renderImport();
    updateReviewIndicators();
    if (currentView === 'settings') renderSettings();
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
  // Started by Cloud once the user has signed in and the encrypted data is decrypted.
  window.AtlasApp = {
    start() { started = true; setupFormatters(); resetForm(); render(); },
  };
  Cloud.onRemoteChange(() => { setupFormatters(); syncFormType(); render(); });
  $('#sign-out').addEventListener('click', () => Cloud.signOut());
  $('#lock-now').addEventListener('click', () => Cloud.lockNow());
  Cloud.boot();
})();
