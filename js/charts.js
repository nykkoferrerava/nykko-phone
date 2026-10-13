// Small hand-rolled SVG charts (no libraries, so they work offline).
// Colors come from CSS custom properties so light/dark mode swap in one place.
import { esc, peso, pesoShort, fmtDate, monthLabel } from './util.js';

const registry = new Map();
let nextId = 0;

const W = 340;

function niceMax(v) {
  if (v <= 0) return 1;
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

// Horizontal bars for "where the money went" — one hue, magnitude only; labels carry identity.
export function categoryBars(rows) {
  if (!rows.length) return `<p class="empty">No spending this month yet.</p>`;
  const max = Math.max(...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return `<ul class="hbars">${rows
    .map(
      (r) => `<li>
        <div class="hbar-label"><span>${r.emoji} ${esc(r.name)}</span><span class="num">${peso(r.value)} <small>${Math.round((r.value / total) * 100)}%</small></span></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(1, (r.value / max) * 100)}%"></div></div>
      </li>`
    )
    .join('')}</ul>`;
}

// Income vs spending per month, grouped bars. Two series: legend + tap tooltip.
export function incomeVsSpending(months) {
  const id = `c${nextId++}`;
  const H = 180, top = 12, bottom = 22, left = 40, right = 4;
  const ph = H - top - bottom, pw = W - left - right;
  const max = niceMax(Math.max(1, ...months.flatMap((m) => [m.income, m.spent])));
  const gw = pw / months.length;
  const bw = Math.min(16, (gw - 10) / 2);
  const y = (v) => top + ph - (v / max) * ph;
  const ticks = [0, max / 2, max];
  let svg = ticks
    .map((t) => `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${pesoShort(t)}</text>`)
    .join('');
  months.forEach((m, i) => {
    const cx = left + gw * i + gw / 2;
    svg += `<path class="s1" d="${barPath(cx - bw - 1, y(m.income), bw, top + ph - y(m.income))}"/>`;
    svg += `<path class="s2" d="${barPath(cx + 1, y(m.spent), bw, top + ph - y(m.spent))}"/>`;
    svg += `<text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${monthLabel(m.key)}</text>`;
    svg += `<rect class="hit" data-i="${i}" x="${left + gw * i}" y="${top}" width="${gw}" height="${ph}"/>`;
  });
  registry.set(id, {
    type: 'groups',
    tip: (i) => {
      const m = months[i];
      return `<b>${monthLabel(m.key, true)}</b><div><i class="sw s1"></i>Income <span class="num">${peso(m.income)}</span></div><div><i class="sw s2"></i>Spent <span class="num">${peso(m.spent)}</span></div>`;
    },
    x: (i) => left + gw * i + gw / 2,
  });
  return `<div class="legend"><span><i class="sw s1"></i>Income</span><span><i class="sw s2"></i>Spent</span></div>
    <div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and spending by month">${svg}</svg><div class="tip" hidden></div></div>`;
}

// Total debt over time, single line with a crosshair tooltip.
export function debtLine(points) {
  if (points.length < 2) return `<p class="empty">Your debt trend appears here after a few days of tracking.</p>`;
  const id = `c${nextId++}`;
  const H = 170, top = 14, bottom = 22, left = 44, right = 10;
  const ph = H - top - bottom, pw = W - left - right;
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const t0 = new Date(points[0].date).getTime(), t1 = new Date(points[points.length - 1].date).getTime();
  const x = (p) => left + ((new Date(p.date).getTime() - t0) / Math.max(1, t1 - t0)) * pw;
  const y = (v) => top + ph - (v / max) * ph;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  let svg = [0, max / 2, max]
    .map((t) => `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${pesoShort(t)}</text>`)
    .join('');
  svg += `<text class="tick" x="${left}" y="${H - 6}">${fmtDate(points[0].date)}</text><text class="tick" x="${W - right}" y="${H - 6}" text-anchor="end">${fmtDate(last.date)}</text>`;
  svg += `<path class="line" d="${d}"/><circle class="dot" cx="${x(last)}" cy="${y(last.value)}" r="4"/>`;
  svg += `<line class="cross" x1="0" x2="0" y1="${top}" y2="${top + ph}" hidden/><circle class="dot hover" r="4" hidden/>`;
  svg += `<rect class="hit" x="${left}" y="${top}" width="${pw}" height="${ph}"/>`;
  registry.set(id, {
    type: 'line',
    points: points.map((p) => ({ ...p, px: x(p), py: y(p.value) })),
    tip: (p) => `<b>${fmtDate(p.date)}</b><div class="num">${peso(p.value)}</div>`,
  });
  return `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Total debt over time">${svg}</svg><div class="tip" hidden></div></div>`;
}

// Wire up tap/hover tooltips after the charts are in the DOM.
export function mountCharts(root) {
  for (const el of root.querySelectorAll('[data-chart]')) {
    const spec = registry.get(el.dataset.chart);
    if (!spec) continue;
    const svg = el.querySelector('svg');
    const tip = el.querySelector('.tip');
    const toSvgX = (e) => {
      const r = svg.getBoundingClientRect();
      return ((e.clientX - r.left) / r.width) * W;
    };
    const place = (sx) => {
      const r = svg.getBoundingClientRect();
      tip.hidden = false;
      const px = (sx / W) * r.width;
      tip.style.left = `${Math.min(Math.max(px - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      svg.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));
      svg.querySelectorAll('.cross, .hover').forEach((n) => n.setAttribute('hidden', ''));
    };
    const show = (e) => {
      if (spec.type === 'groups') {
        const hit = e.target.closest?.('.hit');
        if (!hit) return hide();
        const i = Number(hit.dataset.i);
        tip.innerHTML = spec.tip(i);
        place(spec.x(i));
      } else {
        const sx = toSvgX(e);
        let best = spec.points[0];
        for (const p of spec.points) if (Math.abs(p.px - sx) < Math.abs(best.px - sx)) best = p;
        const cross = svg.querySelector('.cross'), dot = svg.querySelector('.hover');
        cross.removeAttribute('hidden');
        cross.setAttribute('x1', best.px); cross.setAttribute('x2', best.px);
        dot.removeAttribute('hidden');
        dot.setAttribute('cx', best.px); dot.setAttribute('cy', best.py);
        tip.innerHTML = spec.tip(best);
        place(best.px);
      }
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  }
}

export function resetCharts() {
  registry.clear();
}
