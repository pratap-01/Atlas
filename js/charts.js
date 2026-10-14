/* Small dependency-free SVG charts with hover tooltips. */
const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const tip = () => document.getElementById('tooltip');

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function showTip(evt, html) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const pad = 12;
    const { innerWidth: W, innerHeight: H } = window;
    const r = t.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > W - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > H - 8) y = evt.clientY - r.height - pad;
    t.style.left = Math.max(8, x) + 'px';
    t.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { tip().hidden = true; }

  function bindHover(container, hit, marks, html) {
    const on = e => {
      container.classList.add('hovering');
      marks.forEach(m => m.classList.add('on'));
      showTip(e, html);
    };
    const off = () => {
      container.classList.remove('hovering');
      marks.forEach(m => m.classList.remove('on'));
      hideTip();
    };
    hit.addEventListener('pointerenter', on);
    hit.addEventListener('pointermove', e => showTip(e, html));
    hit.addEventListener('pointerleave', off);
  }

  function empty(container, msg = 'No data for this period yet.') {
    container.innerHTML = `<div class="empty">${msg}</div>`;
  }

  // Rounded-end bar path: square at the baseline, 4px radius at the data end.
  function hBarPath(x, y, w, h, r = 4) {
    r = Math.min(r, w, h / 2);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  function vBarPath(x, y, w, h, r = 4) {
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function niceStep(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * p;
  }

  /** Horizontal bar list, sorted by caller. items: [{label, value, detail}] */
  function hbars(container, items, fmt, { color = 'var(--bar)', limit } = {}) {
    container.innerHTML = '';
    if (!items.length) return empty(container);
    if (limit && items.length > limit) {
      const rest = items.slice(limit - 1);
      items = items.slice(0, limit - 1).concat({
        label: `Other (${rest.length})`,
        value: rest.reduce((s, i) => s + i.value, 0),
        detail: rest.map(r => r.label).join(', '),
      });
    }
    const W = Math.max(280, container.clientWidth || 480);
    const labelW = Math.min(150, W * 0.34), valueW = 90, rowH = 30, barH = 14;
    const H = items.length * rowH;
    const max = Math.max(...items.map(i => i.value));
    const plotW = W - labelW - valueW;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    svg.setAttribute('aria-label', items.map(i => `${i.label}: ${fmt(i.value)}`).join('; '));
    items.forEach((it, i) => {
      const y = i * rowH;
      const label = el('text', { x: 0, y: y + rowH / 2 + 4 }, svg);
      label.textContent = truncate(it.label, Math.floor(labelW / 7.2));
      const w = Math.max(2, (it.value / max) * plotW);
      const bar = el('path', { d: hBarPath(labelW, y + (rowH - barH) / 2, w, barH), fill: color, class: 'mark' }, svg);
      const val = el('text', { x: labelW + w + 8, y: y + rowH / 2 + 4, class: 'value-label' }, svg);
      val.textContent = fmt(it.value);
      const hit = el('rect', { x: 0, y, width: W, height: rowH, class: 'hit' }, svg);
      bindHover(container, hit, [bar], `${esc(it.label)}<br><b>${fmt(it.value)}</b>${it.detail ? `<br>${esc(it.detail)}` : ''}`);
    });
    container.appendChild(svg);
  }

  /** Vertical columns, optionally grouped. groups: [{label, values:[...], tip}], series: [{name, color}] */
  function columns(container, groups, series, fmt, { tickEvery = 1 } = {}) {
    container.innerHTML = '';
    if (!groups.length || groups.every(g => g.values.every(v => !v))) return empty(container);
    if (series.length > 1) {
      const legend = document.createElement('div');
      legend.className = 'legend';
      legend.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
      container.appendChild(legend);
    }
    const W = Math.max(280, container.clientWidth || 600);
    const H = 220, top = 8, bottom = 24, left = 56, right = 4;
    const plotW = W - left - right, plotH = H - top - bottom;
    const step = niceStep(Math.max(...groups.flatMap(g => g.values)) / 4);
    const ticks = Math.max(1, Math.ceil(Math.max(...groups.flatMap(g => g.values)) / step));
    const max = step * ticks;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    svg.setAttribute('aria-label', groups.map(g => `${g.label}: ${g.values.map((v, i) => `${series[i].name} ${fmt(v)}`).join(', ')}`).join('; '));

    // gridlines + y ticks
    for (let i = 0; i <= ticks; i++) {
      const v = step * i, y = top + plotH - (v / max) * plotH;
      el('line', { x1: left, x2: W - right, y1: y, y2: y, class: i === 0 ? 'baseline' : 'gridline' }, svg);
      const t = el('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'axis-label' }, svg);
      t.textContent = fmt(v, true);
    }

    const slot = plotW / groups.length;
    const gap = 2, n = series.length;
    const groupW = Math.max(2, Math.min(slot * 0.7, 56));
    const barW = Math.max(1, (groupW - gap * (n - 1)) / n);
    groups.forEach((g, gi) => {
      const x0 = left + gi * slot + (slot - groupW) / 2;
      const marks = g.values.map((v, si) => {
        const h = (v / max) * plotH;
        const x = x0 + si * (barW + gap);
        return v > 0 ? el('path', { d: vBarPath(x, top + plotH - h, barW, h, Math.min(4, barW / 2)), fill: series[si].color, class: 'mark' }, svg) : null;
      }).filter(Boolean);
      if (gi % tickEvery === 0) {
        const t = el('text', { x: left + gi * slot + slot / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, svg);
        t.textContent = g.label;
      }
      const hit = el('rect', { x: left + gi * slot, y: top, width: slot, height: plotH, class: 'hit' }, svg);
      const html = g.tip || `${esc(g.label)}<br>` + g.values.map((v, i) => `${esc(series[i].name)}: <b>${fmt(v)}</b>`).join('<br>');
      bindHover(container, hit, marks, html);
    });
    container.appendChild(svg);
  }

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  return { hbars, columns, esc, hideTip };
})();
