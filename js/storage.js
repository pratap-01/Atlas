/* In-memory data model. Nothing is written to the browser: every change is handed
   to the cloud sync layer (js/cloud.js), which encrypts it and saves it to Supabase. */
const Store = (() => {
  const LEGACY_KEY = 'atlas-money-v1'; // older versions kept data in localStorage
  const listeners = [];

  const DEFAULT_CATEGORIES = {
    expense: ['Food & Dining', 'Groceries', 'Transport', 'Housing & Rent', 'Utilities',
      'Shopping', 'Entertainment', 'Health', 'Education', 'Travel', 'Bills & Fees', 'Other'],
    income: ['Salary', 'Business', 'Interest', 'Gifts', 'Refunds', 'Other income'],
  };

  const UNCATEGORIZED = 'Uncategorized';

  const ACCOUNT_TYPES = {
    bank: 'Bank account', savings: 'Savings account', credit: 'Credit card',
    cash: 'Cash', wallet: 'Digital wallet', other: 'Other',
  };

  const defaults = () => ({
    version: 2,
    accounts: [],
    transactions: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
    settings: { currency: 'USD', budget: null },
  });

  let state = defaults();

  function normalize(data) {
    const base = defaults();
    const accounts = Array.isArray(data.accounts) ? data.accounts.map(cleanAccount).filter(Boolean) : [];
    const ids = new Set(accounts.map(a => a.id));
    return {
      version: 2,
      accounts,
      transactions: Array.isArray(data.transactions)
        ? data.transactions.map(t => cleanTx(t, ids)).filter(Boolean) : [],
      categories: {
        expense: Array.isArray(data.categories?.expense) ? data.categories.expense : base.categories.expense,
        income: Array.isArray(data.categories?.income) ? data.categories.income : base.categories.income,
      },
      settings: { ...base.settings, ...(data.settings || {}) },
    };
  }

  function cleanAccount(a) {
    const name = String(a?.name || '').trim();
    if (!name) return null;
    const opening = parseFloat(a.openingBalance);
    return {
      id: a.id || uid(),
      name,
      type: ACCOUNT_TYPES[a.type] ? a.type : 'bank',
      institution: String(a.institution || '').trim(),
      number: String(a.number || '').trim(),
      openingBalance: isFinite(opening) ? Math.round(opening * 100) / 100 : 0,
      archived: !!a.archived,
    };
  }

  // accountIds: set of valid account ids; unknown references are dropped.
  function cleanTx(t, accountIds = new Set(state.accounts.map(a => a.id))) {
    if (!t) return null;
    const amount = Math.abs(parseFloat(t.amount));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !isFinite(amount) || amount === 0) return null;
    const type = ['income', 'expense', 'transfer'].includes(t.type) ? t.type : 'expense';
    const accountId = accountIds.has(t.accountId) ? t.accountId : null;
    const toAccountId = type === 'transfer' && accountIds.has(t.toAccountId) ? t.toAccountId : null;
    if (type === 'transfer' && (!accountId || !toAccountId || accountId === toAccountId)) return null;
    return {
      id: t.id || uid(),
      date: t.date,
      type,
      amount: Math.round(amount * 100) / 100,
      accountId,
      ...(type === 'transfer' ? { toAccountId } : {}),
      category: type === 'transfer' ? 'Transfer' : String(t.category || 'Other').trim(),
      description: String(t.description || '').trim(),
      method: String(t.method || '').trim(),
      notes: String(t.notes || '').trim(),
      ...(t.statementText ? { statementText: String(t.statementText).trim() } : {}),
      ...(t.needsReview ? { needsReview: true } : {}),
      // transfers built from imports: which account statementText came from, and the other side's bank text
      ...(type === 'transfer' && t.statementAccountId ? { statementAccountId: t.statementAccountId } : {}),
      ...(type === 'transfer' && t.linkedText ? { linkedText: String(t.linkedText), linkedDate: t.linkedDate || t.date } : {}),
    };
  }

  function save() {
    listeners.forEach(fn => fn());
  }

  function uid() {
    return (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  return {
    get transactions() { return state.transactions; },
    get accounts() { return state.accounts; },
    ACCOUNT_TYPES,
    UNCATEGORIZED,

    accountById(id) { return state.accounts.find(a => a.id === id); },
    upsertAccount(acc) {
      const clean = cleanAccount(acc);
      if (!clean) return null;
      const i = state.accounts.findIndex(a => a.id === clean.id);
      if (i >= 0) state.accounts[i] = clean; else state.accounts.push(clean);
      save();
      return clean;
    },
    // Only accounts without transactions can be deleted; others get archived.
    deleteAccount(id) {
      if (state.transactions.some(t => t.accountId === id || t.toAccountId === id)) return false;
      state.accounts = state.accounts.filter(a => a.id !== id);
      save();
      return true;
    },
    assignAccount(txIds, accountId) {
      const ids = new Set(txIds);
      state.transactions.forEach(t => { if (ids.has(t.id) && t.type !== 'transfer') t.accountId = accountId; });
      save();
    },
    /** Find an account by name (case-insensitive), creating it if needed. */
    ensureAccount(name) {
      name = String(name || '').trim();
      if (!name) return null;
      const found = state.accounts.find(a => a.name.toLowerCase() === name.toLowerCase());
      if (found) return found.id;
      const acc = cleanAccount({ name });
      state.accounts.push(acc);
      save();
      return acc.id;
    },
    get categories() { return state.categories; },
    get settings() { return state.settings; },

    upsertTx(tx) {
      const clean = cleanTx(tx);
      if (!clean) return null;
      const i = state.transactions.findIndex(t => t.id === clean.id);
      if (i >= 0) state.transactions[i] = clean; else state.transactions.push(clean);
      // make sure the category exists in the list for that type
      if (clean.type !== 'transfer' && clean.category !== UNCATEGORIZED && !state.categories[clean.type].includes(clean.category)) state.categories[clean.type].push(clean.category);
      save();
      return clean;
    },
    deleteTx(id) {
      state.transactions = state.transactions.filter(t => t.id !== id);
      save();
    },
    addCategory(type, name) {
      name = name.trim();
      if (!name || state.categories[type].some(c => c.toLowerCase() === name.toLowerCase())) return false;
      state.categories[type].push(name);
      save();
      return true;
    },
    removeCategory(type, name) {
      state.categories[type] = state.categories[type].filter(c => c !== name);
      save();
    },
    renameCategory(type, from, to) {
      to = to.trim();
      if (!to || from === to) return false;
      const list = state.categories[type];
      if (list.includes(to)) state.categories[type] = list.filter(c => c !== from);
      else list[list.indexOf(from)] = to;
      state.transactions.forEach(t => { if (t.type === type && t.category === from) t.category = to; });
      save();
      return true;
    },
    setSetting(key, value) {
      state.settings[key] = value;
      save();
    },
    replaceAll(data) {
      state = normalize(data);
      save();
    },
    /** Replace the in-memory data without triggering a save (used when loading from the cloud). */
    load(data) { state = data ? normalize(data) : defaults(); },
    onChange(fn) { listeners.push(fn); },
    normalize,
    /** Data left in this browser by older versions of Atlas, if any. */
    legacyData() {
      try {
        const raw = localStorage.getItem(LEGACY_KEY);
        if (!raw) return null;
        const data = normalize(JSON.parse(raw));
        return data.transactions.length || data.accounts.length ? data : null;
      } catch { return null; }
    },
    clearLegacy() { try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ } },
    mergeTransactions(list) {
      const before = state.transactions.length;
      list.forEach(t => {
        const c = cleanTx({ ...t, id: undefined });
        if (!c) return;
        state.transactions.push(c);
        if (c.type !== 'transfer' && c.category !== UNCATEGORIZED && !state.categories[c.type].includes(c.category)) state.categories[c.type].push(c.category);
      });
      save();
      return state.transactions.length - before;
    },
    /** Add already-validated imported rows in one save. Returns the added transactions. */
    addImported(list) {
      const added = list.map(t => cleanTx({ ...t, id: undefined })).filter(Boolean);
      state.transactions.push(...added);
      save();
      return added;
    },
    exportData() { return structuredClone(state); },
    clear() { state = defaults(); save(); },
    uid,
  };
})();
