/* Bank statement parsing: CSV / Excel / OFX / PDF -> [{date, text, amount (+in / -out), balance}] */
const Importer = (() => {
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');

  // ---------- Lazy-loaded libraries (only fetched when an Excel/PDF file is used) ----------
  const LIBS = {
    xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  };
  const loaded = {};
  function loadScript(src) {
    return (loaded[src] ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete loaded[src]; reject(new Error('Could not load the file reader. Check your internet connection.')); };
      document.head.appendChild(s);
    }));
  }

  // ---------- Dates ----------
  function makeDate(y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1970 && y <= 2100)) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  const RE_YMD = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/;
  const RE_NUM = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})(?!\d)/;
  const RE_DMONY = /^(\d{1,2})(?:st|nd|rd|th)?[-\/ ]([A-Za-z]{3,9})[-\/ ,]+(\d{2}|\d{4})(?!\d)/;
  const RE_MONDY = /^([A-Za-z]{3,9})[ -](\d{1,2})(?:st|nd|rd|th)?,?[ -](\d{2}|\d{4})(?!\d)/;
  const RE_COMPACT = /^(\d{4})(\d{2})(\d{2})(?!\d)/;

  /** Parse a date at the START of s. fmt: 'dmy' | 'mdy' (for ambiguous numeric dates). Returns {iso, length} */
  function parseDateAt(s, fmt = 'dmy') {
    s = String(s ?? '').trim();
    let m;
    if ((m = RE_YMD.exec(s))) return wrap(makeDate(m[1], m[2], m[3]), m);
    if ((m = RE_NUM.exec(s))) return wrap(fmt === 'mdy' ? makeDate(m[3], m[1], m[2]) : makeDate(m[3], m[2], m[1]), m);
    if ((m = RE_DMONY.exec(s))) { const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()]; return wrap(mo && makeDate(m[3], mo, m[1]), m); }
    if ((m = RE_MONDY.exec(s))) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()]; return wrap(mo && makeDate(m[3], mo, m[2]), m); }
    if ((m = RE_COMPACT.exec(s))) return wrap(makeDate(m[1], m[2], m[3]), m);
    return null;
  }
  const wrap = (iso, m) => (iso ? { iso, length: m[0].length } : null);

  function parseDate(v, fmt) {
    if (v instanceof Date && !isNaN(v)) return makeDate(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date
      const d = new Date(Math.round((v - 25569) * 86400000));
      return makeDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return parseDateAt(v, fmt)?.iso || null;
  }

  /** Decide day-first vs month-first from sample values. */
  function detectDateFormat(values) {
    let dmy = false, mdy = false;
    values.forEach(v => {
      const m = RE_NUM.exec(String(v ?? '').trim());
      if (!m) return;
      if (+m[1] > 12) dmy = true;
      if (+m[2] > 12) mdy = true;
    });
    if (dmy && !mdy) return 'dmy';
    if (mdy && !dmy) return 'mdy';
    return /^en-US|^en-PH|^es-US/i.test(navigator.language || '') ? 'mdy' : 'dmy';
  }

  // ---------- Amounts ----------
  /** Returns {value (>=0), neg, drcr: 'dr'|'cr'|null} or null. */
  function parseAmount(v) {
    if (typeof v === 'number') return isFinite(v) && v !== 0 ? { value: Math.abs(v), neg: v < 0, drcr: null } : null;
    let s = String(v ?? '').trim();
    if (!s || s === '-') return null;
    let drcr = null;
    const ind = /\s*\b(cr|dr)\.?$/i.exec(s) || /^(cr|dr)\.?\s*/i.exec(s);
    if (ind) { drcr = ind[1].toLowerCase(); s = s.replace(ind[0], ''); }
    let neg = /^\(.*\)$/.test(s) || /^-|^−|-$/.test(s.replace(/[^\d\-−().,]/g, ''));
    s = s.replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) return null;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const value = parseFloat(s);
    if (!isFinite(value) || value === 0) return null;
    return { value: Math.round(value * 100) / 100, neg, drcr };
  }

  // ---------- Tables (CSV / Excel) ----------
  function parseDelimited(text) {
    text = text.replace(/^﻿/, '');
    const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
    const delim = [',', ';', '\t', '|'].map(d => [d, sample.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"' && cell.trim() === '') { q = true; cell = ''; }
      else if (c === delim) { row.push(cell.trim()); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell.trim()); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
    return rows.filter(r => r.some(c => c !== ''));
  }

  const KEYS = {
    drcr: /^(dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|credit\s*\/\s*debit|type|transaction type|txn type|d\/c|c\/d)\.?$/i,
    debit: /debit|withdraw|paid out|money out|^dr\.?$|outflow|spent|payments?$/i,
    credit: /credit|deposit|paid in|money in|^cr\.?$|inflow|received|receipts?$/i,
    balance: /balance/i,
    amount: /amount|amt|value$/i,
    date: /date|^dt\.?$|posted|txn dt|tran dt/i,
    desc: /narration|description|particulars|details|remarks|memo|payee|merchant|transaction$|^name$|reference/i,
  };

  function detectHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const cells = rows[i].map(c => String(c ?? '').trim()).filter(Boolean);
      const hasDate = cells.some(c => KEYS.date.test(c) && c.length < 30);
      const others = cells.filter(c => c.length < 40 && (KEYS.debit.test(c) || KEYS.credit.test(c) || KEYS.amount.test(c) || KEYS.balance.test(c) || KEYS.desc.test(c))).length;
      if (hasDate && others >= 1) return i;
    }
    return -1;
  }

  function autoMap(header) {
    const map = { date: -1, desc: -1, debit: -1, credit: -1, amount: -1, drcr: -1, balance: -1 };
    const used = new Set();
    const cells = header.map(h => String(h ?? '').trim().replace(/\s+/g, ' '));
    const take = (key, test) => {
      if (map[key] >= 0) return;
      const i = cells.findIndex((c, idx) => !used.has(idx) && c && test(c));
      if (i >= 0) { map[key] = i; used.add(i); }
    };
    take('drcr', c => KEYS.drcr.test(c));
    take('balance', c => KEYS.balance.test(c));
    take('debit', c => KEYS.debit.test(c) && !KEYS.date.test(c));
    take('credit', c => KEYS.credit.test(c) && !KEYS.date.test(c));
    if (map.debit < 0 || map.credit < 0) take('amount', c => KEYS.amount.test(c) && !KEYS.date.test(c));
    take('date', c => /(txn|transaction|tran|posting|post|trans)\.?\s*(date|dt)/i.test(c));
    take('date', c => /^date$/i.test(c));
    take('date', c => KEYS.date.test(c) && !/value/i.test(c));
    take('date', c => KEYS.date.test(c));
    take('desc', c => /narration|description|particulars|details|remarks|memo|payee|merchant/i.test(c));
    take('desc', c => KEYS.desc.test(c));
    // A lone debit-or-credit column without its partner is really a signed amount column.
    if (map.amount < 0 && (map.debit < 0) !== (map.credit < 0)) {
      map.amount = map.debit >= 0 ? map.debit : map.credit;
      map.debit = map.credit = -1;
    }
    return map;
  }

  /** Apply a column mapping. opts: {fmt, invert} */
  function mapTable(rows, headerIdx, map, { fmt = 'dmy', invert = false } = {}) {
    const out = [];
    const cell = (r, i) => (i >= 0 ? r[i] : '');
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const date = parseDate(cell(r, map.date), fmt);
      if (!date) continue;
      let amount = null;
      if (map.debit >= 0 || map.credit >= 0) {
        const o = parseAmount(cell(r, map.debit)), n = parseAmount(cell(r, map.credit));
        amount = (n ? n.value : 0) - (o ? o.value : 0);
      } else if (map.amount >= 0) {
        const a = parseAmount(cell(r, map.amount));
        if (a) {
          const ind = String(cell(r, map.drcr) || '').trim();
          if (/^(d|dr|debit|withdrawal|out)/i.test(ind)) amount = -a.value;
          else if (/^(c|cr|credit|deposit|in)/i.test(ind)) amount = a.value;
          else if (a.drcr) amount = a.drcr === 'dr' ? -a.value : a.value;
          else amount = a.neg ? -a.value : a.value;
        }
      }
      if (!amount) continue;
      if (invert) amount = -amount;
      const b = parseAmount(cell(r, map.balance));
      out.push({
        date,
        text: String(cell(r, map.desc) ?? '').replace(/\s+/g, ' ').trim(),
        amount: Math.round(amount * 100) / 100,
        balance: b ? (b.neg || b.drcr === 'dr' ? -b.value : b.value) : null,
      });
    }
    return out;
  }

  // ---------- OFX / QFX ----------
  function parseOFX(text) {
    const tag = (block, name) => (new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block) || [])[1]?.trim() || '';
    const txs = [];
    const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi;
    let m;
    while ((m = re.exec(text))) {
      const b = m[1];
      const date = parseDate(tag(b, 'DTPOSTED').slice(0, 8));
      const amount = parseFloat(tag(b, 'TRNAMT').replace(',', '.'));
      if (!date || !isFinite(amount) || !amount) continue;
      const text1 = [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');
      txs.push({ date, text: decodeEntities(text1), amount: Math.round(amount * 100) / 100, balance: null });
    }
    const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(text);
    let closing = null;
    if (ledger) {
      const amt = parseFloat(tag(ledger[1], 'BALAMT')), dt = parseDate(tag(ledger[1], 'DTASOF').slice(0, 8));
      if (isFinite(amt) && dt) closing = { date: dt, balance: amt };
    }
    return { txs, closing };
  }
  const decodeEntities = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");

  // ---------- PDF ----------
  async function pdfLines(buffer, askPassword) {
    await loadScript(LIBS.pdf);
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    let doc, password;
    for (let attempt = 0; ; attempt++) {
      try {
        doc = await pdfjs.getDocument({ data: buffer.slice(0), password, isEvalSupported: false }).promise;
        break;
      } catch (e) {
        if (e?.name !== 'PasswordException' || attempt > 4) throw e.name === 'PasswordException' ? new Error('Wrong password for this PDF.') : e;
        password = await askPassword(attempt > 0);
        if (password == null) throw new Error('This PDF is password protected.');
      }
    }
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const rows = [];
      content.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const x = it.transform[4], y = it.transform[5];
        let row = rows.find(r => Math.abs(r.y - y) < 3);
        if (!row) rows.push((row = { y, items: [] }));
        row.items.push({ x, w: it.width || 0, s: it.str });
      });
      rows.sort((a, b) => b.y - a.y).forEach(r => {
        r.items.sort((a, b) => a.x - b.x);
        let line = '', end = null;
        r.items.forEach(it => {
          if (end != null) line += it.x - end > 1.5 ? '  ' : '';
          line += it.s;
          end = it.x + it.w;
        });
        lines.push(line.replace(/\s{3,}/g, '  ').trim());
      });
    }
    return lines;
  }

  const AMOUNT_RE = /(?<![\w.,\/-])\(?-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}\)?(?:\s?(?:cr|dr)\.?)?(?![\w\/]|\.\d)/gi;
  const OPENING_RE = /opening\s+balance|balance\s+(b\/f|brought\s+forward|forward)|previous\s+balance|^b\/f\b/i;
  const CREDIT_HINT = /\b(credit|cr|deposit|salary|refund|interest|neft cr|imps cr|received|reversal|cashback)\b/i;

  /** Heuristic: rows starting with a date; last amount = running balance when 2+ amounts. */
  function parsePdfLines(lines, fmt) {
    const txs = [];
    let prevBal = null, pending = [];
    for (const line of lines) {
      const d = parseDateAt(line, fmt);
      const amounts = [...line.matchAll(AMOUNT_RE)].map(m => ({ raw: m[0], ...parseAmount(m[0]) })).filter(a => a.value);
      if (!d) {
        if (OPENING_RE.test(line) && amounts.length) {
          const a = amounts.at(-1);
          prevBal = a.neg || a.drcr === 'dr' ? -a.value : a.value;
        } else if (txs.length && !amounts.length && line.length < 120) {
          pending.push(line);
        }
        continue;
      }
      if (!amounts.length) continue;
      if (pending.length && txs.length) txs.at(-1).text = (txs.at(-1).text + ' ' + pending.join(' ')).replace(/\s+/g, ' ').trim();
      pending = [];
      // Strip leading date (and a second "value date" right after it) and the amounts.
      let text = line.slice(d.length).trim();
      const d2 = parseDateAt(text, fmt);
      if (d2) text = text.slice(d2.length).trim();
      amounts.forEach(a => { text = text.replace(a.raw, ' '); });
      text = text.replace(/\s+/g, ' ').trim();

      const amt = amounts.length >= 2 ? amounts.at(-2) : amounts[0];
      const balA = amounts.length >= 2 ? amounts.at(-1) : null;
      const bal = balA ? (balA.neg || balA.drcr === 'dr' ? -balA.value : balA.value) : null;
      let sign = null, certain = true;
      if (bal != null && prevBal != null) {
        const delta = Math.round((bal - prevBal) * 100) / 100;
        if (Math.abs(Math.abs(delta) - amt.value) < 0.011) sign = delta >= 0 ? 1 : -1;
      }
      if (sign == null && amt.drcr) sign = amt.drcr === 'cr' ? 1 : -1;
      if (sign == null && amt.neg) sign = -1;
      if (sign == null) { sign = CREDIT_HINT.test(text) ? 1 : -1; certain = false; }
      txs.push({ date: d.iso, text, amount: sign * amt.value, balance: bal, uncertain: !certain });
      if (bal != null) prevBal = bal;
    }
    return txs;
  }

  // ---------- File entry point ----------
  /**
   * Reads a statement file. Returns one of:
   *  {kind:'table', rows}  — needs column mapping
   *  {kind:'pdf', lines}
   *  {kind:'ofx', txs, closing}
   */
  async function readFile(file, askPassword) {
    const name = file.name.toLowerCase();
    if (/\.(ofx|qfx|qbo)$/.test(name)) return { kind: 'ofx', ...parseOFX(await file.text()) };
    if (/\.pdf$/.test(name)) return { kind: 'pdf', lines: await pdfLines(await file.arrayBuffer(), askPassword) };
    if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) {
      await loadScript(LIBS.xlsx);
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      for (const sn of wb.SheetNames) {
        const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' })
          .map(r => r.map(c => String(c ?? '').trim())).filter(r => r.some(Boolean));
        if (rows.length > 1) return { kind: 'table', rows };
      }
      throw new Error('The spreadsheet looks empty.');
    }
    const text = await file.text();
    if (/<OFX>|OFXHEADER/i.test(text.slice(0, 2000))) return { kind: 'ofx', ...parseOFX(text) };
    return { kind: 'table', rows: parseDelimited(text) };
  }

  /** Closing balance = balance on the latest row (respects newest-first statements). */
  function closingFrom(txs) {
    const withBal = txs.filter(t => t.balance != null);
    if (!withBal.length) return null;
    const ascending = txs[0].date <= txs.at(-1).date;
    const last = ascending ? withBal.at(-1) : withBal[0];
    return { date: last.date, balance: last.balance };
  }

  return { readFile, detectHeader, autoMap, mapTable, detectDateFormat, parsePdfLines, parseDate, parseAmount, closingFrom };
})();
