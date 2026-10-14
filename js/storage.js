/* Persistence layer: everything lives in localStorage under one key. */
const Store = (() => {
  const KEY = 'atlas-money-v1';

  const DEFAULT_CATEGORIES = {
    expense: ['Food & Dining', 'Groceries', 'Transport', 'Housing & Rent', 'Utilities',
      'Shopping', 'Entertainment', 'Health', 'Education', 'Travel', 'Bills & Fees', 'Other'],
    income: ['Salary', 'Business', 'Interest', 'Gifts', 'Refunds', 'Other income'],
  };

  const defaults = () => ({
    version: 1,
    transactions: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
    settings: { currency: 'USD', budget: null },
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const data = JSON.parse(raw);
      return normalize(data);
    } catch (e) {
      console.warn('Could not read saved data, starting fresh.', e);
      return defaults();
    }
  }

  function normalize(data) {
    const base = defaults();
    return {
      version: 1,
      transactions: Array.isArray(data.transactions) ? data.transactions.map(cleanTx).filter(Boolean) : [],
      categories: {
        expense: Array.isArray(data.categories?.expense) ? data.categories.expense : base.categories.expense,
        income: Array.isArray(data.categories?.income) ? data.categories.income : base.categories.income,
      },
      settings: { ...base.settings, ...(data.settings || {}) },
    };
  }

  function cleanTx(t) {
    const amount = Math.abs(parseFloat(t.amount));
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !isFinite(amount) || amount === 0) return null;
    return {
      id: t.id || uid(),
      date: t.date,
      type: t.type === 'income' ? 'income' : 'expense',
      amount: Math.round(amount * 100) / 100,
      category: String(t.category || 'Other').trim(),
      description: String(t.description || '').trim(),
      method: String(t.method || '').trim(),
      notes: String(t.notes || '').trim(),
    };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      alert('Could not save — browser storage may be full or disabled.');
    }
  }

  function uid() {
    return (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  return {
    get transactions() { return state.transactions; },
    get categories() { return state.categories; },
    get settings() { return state.settings; },

    upsertTx(tx) {
      const clean = cleanTx(tx);
      if (!clean) return null;
      const i = state.transactions.findIndex(t => t.id === clean.id);
      if (i >= 0) state.transactions[i] = clean; else state.transactions.push(clean);
      // make sure the category exists in the list for that type
      if (!state.categories[clean.type].includes(clean.category)) state.categories[clean.type].push(clean.category);
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
    mergeTransactions(list) {
      const before = state.transactions.length;
      list.forEach(t => {
        const c = cleanTx({ ...t, id: undefined });
        if (!c) return;
        state.transactions.push(c);
        if (!state.categories[c.type].includes(c.category)) state.categories[c.type].push(c.category);
      });
      save();
      return state.transactions.length - before;
    },
    exportData() { return structuredClone(state); },
    clear() { state = defaults(); save(); },
    uid,
  };
})();
