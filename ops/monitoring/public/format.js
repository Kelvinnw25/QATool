/**
 * Display helpers. Pure functions, no DOM, so they can be tested in Node.
 * Every unavailable value renders as an en dash, never as 0: "no data" and "zero" differ.
 */

export const DASH = '–';

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${Math.round(s - m * 60)} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m - h * 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return DASH;
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatPercent(fraction, digits = 0) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return DASH;
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : DASH;
}

export function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DASH;
  return ms < 1500 ? 'just now' : `${formatDuration(ms)} ago`;
}

/** Points for an SVG polyline in a width x height box. Null samples break the line. */
export function sparkPaths(values, width, height, { max } = {}) {
  const real = values.filter((v) => typeof v === 'number');
  if (real.length === 0 || values.length < 2) return [];
  const top = Math.max(max ?? 0, ...real, 1);
  const step = width / (values.length - 1);
  const paths = [];
  let current = [];
  values.forEach((v, i) => {
    if (typeof v !== 'number') {
      if (current.length) paths.push(current);
      current = [];
      return;
    }
    const x = Number((i * step).toFixed(1));
    const y = Number((height - 2 - (v / top) * (height - 4)).toFixed(1));
    current.push(`${x},${y}`);
  });
  if (current.length) paths.push(current);
  return paths.map((p) => p.join(' '));
}
