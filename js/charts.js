// Small hand-rolled SVG charts (no libraries, so they work offline).
// Colors come from CSS custom properties so light/dark mode swap in one place.
// Each chart has a static readout line above the plot (never a floating tooltip that
// covers the marks). It starts filled with the latest month / last point; tapping,
// hovering or arrow keys change it.
import { esc, peso, pesoShort, fmtDate, monthLabel } from './util.js';

const registry = new Map();
let nextId = 0;

const W = 340;

function niceMax(v) {
  if (!(v > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Rounded-top bar path anchored to the baseline.
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function yAxis(max, y, left, right) {
  return [0, max / 2, max]
    .map((t, i) => `<line class="grid${i ? '' : ' base'}" x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${pesoShort(t)}</text>`)
    .join('');
}

// Horizontal bars for "where the money went" — one hue, magnitude only; labels carry identity.
export function categoryBars(rows) {
  rows = (rows || []).filter((r) => r.value > 0);
  if (!rows.length) return `<p class="empty">No spending this month yet.</p>`;
  const max = Math.max(...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return `<ul class="hbars">${rows
    .map(
      (r) => `<li>
        <div class="hbar-label"><span>${esc(r.emoji || '')} ${esc(r.name)}</span><span class="num">${peso(r.value)} <small>${Math.round((r.value / total) * 100)}%</small></span></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(1, (r.value / max) * 100)}%"></div></div>
      </li>`
    )
    .join('')}</ul>`;
}

// Income vs spending per month, grouped bars. Two series: legend + readout.
export function incomeVsSpending(months) {
  months = months || [];
  if (!months.length || months.every((m) => !(m.income > 0) && !(m.spent > 0))) {
    return `<p class="empty">Income and spending show here once you add entries.</p>`;
  }
  const id = `c${nextId++}`;
  const H = 172, top = 8, bottom = 24, left = 42, right = 4;
  const ph = H - top - bottom, pw = W - left - right;
  const max = niceMax(Math.max(...months.flatMap((m) => [m.income || 0, m.spent || 0])));
  const gw = pw / months.length;
  const bw = Math.min(16, (gw - 10) / 2);
  const y = (v) => top + ph - (Math.max(0, v || 0) / max) * ph;
  let svg = yAxis(max, y, left, right);
  months.forEach((m, i) => {
    const cx = left + gw * i + gw / 2;
    svg += `<path class="s1" data-g="${i}" d="${barPath(cx - bw - 1, y(m.income), bw, top + ph - y(m.income))}"/>`;
    svg += `<path class="s2" data-g="${i}" d="${barPath(cx + 1, y(m.spent), bw, top + ph - y(m.spent))}"/>`;
    svg += `<text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(monthLabel(m.key))}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${left + gw * i}" y="0" width="${gw}" height="${H}"/>`;
  });
  const readout = (i) => {
    const m = months[i];
    return `<b>${esc(monthLabel(m.key, true))}</b><span class="vals">` +
      `<span class="val"><i class="key s1"></i>Income <span class="num">${peso(m.income || 0, { whole: true })}</span></span>` +
      `<span class="val"><i class="key s2"></i>Spent <span class="num">${peso(m.spent || 0, { whole: true })}</span></span></span>`;
  };
  registry.set(id, { type: 'groups', count: months.length, readout, last: months.length - 1 });
  return `<div class="legend"><span><i class="sw s1"></i>Income</span><span><i class="sw s2"></i>Spent</span></div>
    <div class="chart" data-chart="${id}" tabindex="0" aria-label="Income and spending by month. Use the arrow keys to read each month.">
      <div class="readout" aria-live="polite">${readout(months.length - 1)}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and spending by month">${svg}</svg>
    </div>`;
}

// Total debt over time, single line with a crosshair.
export function debtLine(points) {
  points = points || [];
  if (points.length < 2) return `<p class="empty">Your debt trend appears here after a few days of tracking.</p>`;
  if (points.every((p) => !(p.value > 0))) return `<p class="empty">Your total debt was ₱0 over this period.</p>`;
  const id = `c${nextId++}`;
  const H = 160, top = 8, bottom = 24, left = 44, right = 10;
  const ph = H - top - bottom, pw = W - left - right;
  const max = niceMax(Math.max(...points.map((p) => p.value || 0)));
  const t0 = new Date(points[0].date).getTime(), t1 = new Date(points[points.length - 1].date).getTime();
  const x = (p) => left + ((new Date(p.date).getTime() - t0) / Math.max(1, t1 - t0)) * pw;
  const y = (v) => top + ph - (Math.max(0, v || 0) / max) * ph;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  let svg = yAxis(max, y, left, right);
  svg += `<text class="tick" x="${left}" y="${H - 6}">${esc(fmtDate(points[0].date))}</text><text class="tick" x="${W - right}" y="${H - 6}" text-anchor="end">${esc(fmtDate(last.date))}</text>`;
  svg += `<line class="cross" x1="${x(last)}" x2="${x(last)}" y1="${top}" y2="${top + ph}" hidden/>`;
  svg += `<path class="line" d="${d}"/><circle class="dot" cx="${x(last)}" cy="${y(last.value)}" r="4.5"/>`;
  svg += `<rect class="hit" x="0" y="0" width="${W}" height="${H}"/>`;
  const pts = points.map((p) => ({ ...p, px: x(p), py: y(p.value) }));
  const readout = (i) => `<b>${esc(fmtDate(pts[i].date))}</b><span class="val">Total debt <span class="num">${peso(pts[i].value || 0, { whole: true })}</span></span>`;
  registry.set(id, { type: 'line', count: pts.length, points: pts, readout, last: pts.length - 1 });
  return `<div class="chart" data-chart="${id}" tabindex="0" aria-label="Total debt over time. Use the arrow keys to read each day.">
      <div class="readout one" aria-live="polite">${readout(pts.length - 1)}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Total debt over time">${svg}</svg>
    </div>`;
}

// Wire up the readouts after the charts are in the DOM.
export function mountCharts(root) {
  for (const el of root.querySelectorAll('[data-chart]')) {
    const spec = registry.get(el.dataset.chart);
    if (!spec || el.dataset.mounted) continue;
    el.dataset.mounted = '1';
    const svg = el.querySelector('svg');
    const out = el.querySelector('.readout');
    let current = spec.last;

    const select = (i, highlight = true) => {
      current = Math.max(0, Math.min(spec.count - 1, i));
      out.innerHTML = spec.readout(current);
      el.classList.toggle('has-sel', highlight);
      if (spec.type === 'groups') {
        svg.querySelectorAll('path[data-g]').forEach((n) => n.classList.toggle('sel', highlight && Number(n.dataset.g) === current));
      } else {
        const p = spec.points[current];
        const cross = svg.querySelector('.cross'), dot = svg.querySelector('.dot');
        cross.toggleAttribute('hidden', !highlight);
        cross.setAttribute('x1', p.px); cross.setAttribute('x2', p.px);
        dot.setAttribute('cx', p.px); dot.setAttribute('cy', p.py);
      }
    };
    const reset = () => select(spec.last, false);

    const fromPointer = (e) => {
      if (spec.type === 'groups') {
        const hit = e.target.closest?.('.hit');
        if (hit) select(Number(hit.dataset.i));
        return;
      }
      const r = svg.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * W;
      let best = 0;
      spec.points.forEach((p, i) => { if (Math.abs(p.px - sx) < Math.abs(spec.points[best].px - sx)) best = i; });
      select(best);
    };
    svg.addEventListener('pointerdown', fromPointer);
    svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) fromPointer(e); });
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') reset(); });
    el.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step) { e.preventDefault(); select(current + step); }
      else if (e.key === 'Home') { e.preventDefault(); select(0); }
      else if (e.key === 'End') { e.preventDefault(); select(spec.count - 1); }
      else if (e.key === 'Escape') reset();
    });
    el.addEventListener('blur', reset);
  }
}

export function resetCharts() {
  registry.clear();
}
