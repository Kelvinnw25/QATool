import {
  DASH,
  formatAge,
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  sparkPaths,
} from './format.js';

/**
 * The dashboard. Plain DOM, no framework, no build step.
 *
 * Every value from the server is put on the page with `textContent` or an attribute set by
 * `setAttribute`, never as HTML, so nothing a monitored system returned can become markup.
 * The page only reads `/api/status` and posts `/api/refresh`; it holds no credentials.
 */

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const replace = (node, ...children) => node.replaceChildren(...children.flat().filter(Boolean));

let view = null;
let lastFetchOk = null;
let failures = 0;
let timer = null;

// --- components ---------------------------------------------------------------------------------

const COMPONENT_LABELS = {
  backend: 'QATOOL backend',
  apayee: 'Apayee gateway',
  frontend: 'Vercel frontend',
  tunnel: 'Cloudflare Tunnel',
  docker: 'Containers',
};

const STATUS_WORD = {
  up: 'up',
  degraded: 'degraded',
  down: 'down',
  stale: 'stale',
  unknown: 'n/a',
};

function componentDetail(name, reading) {
  if (reading.state === 'not_configured' || reading.state === 'no_source')
    return reading.error?.message ?? 'Not configured.';
  if (reading.state === 'pending') return 'Waiting for first poll…';
  if (reading.state === 'unavailable') {
    const known = reading.lastKnown ? ` Last good ${formatAge(reading.lastSuccessAgeMs)}.` : '';
    return `No answer (${reading.error?.code ?? 'error'}).${known}`;
  }
  const d = reading.data;
  switch (name) {
    case 'backend':
    case 'frontend':
      return `HTTP ${formatNumber(d.httpStatus)} · ${formatDuration(d.latencyMs)}`;
    case 'apayee':
      return `${d.provider ?? 'provider'} · ${d.providerReady ? 'ready' : `not ready (${d.providerState ?? 'unknown'})`}${d.version ? ` · v${d.version}` : ''}${d.viaBackend ? ' · via backend' : ''}`;
    case 'tunnel': {
      const proc =
        d.processRunning === null
          ? 'cloudflared: unknown'
          : d.processRunning
            ? 'cloudflared running'
            : 'cloudflared not running';
      const pub = !d.publicConfigured
        ? 'address not set'
        : d.public?.healthy
          ? `reachable · ${formatDuration(d.public.latencyMs)}`
          : `unreachable${d.public?.error ? ` (${d.public.error})` : ''}`;
      return `${proc} · ${pub}`;
    }
    case 'docker': {
      const running = d.containers.filter((c) => c.running).length;
      return `${running} of ${d.containers.length} running${d.resourcesError ? ' · CPU/memory unavailable' : ''}`;
    }
    default:
      return '';
  }
}

function renderComponents(v) {
  replace(
    $('components'),
    Object.keys(COMPONENT_LABELS).map((name) => {
      const status = v.components[name];
      const reading = v.readings[name];
      return el(
        'div',
        { class: `card component${reading.stale ? ' is-stale' : ''}` },
        el(
          'div',
          { class: 'head' },
          el('span', {}, COMPONENT_LABELS[name]),
          el(
            'span',
            { class: `pill pill-${status}` },
            reading.stale ? 'stale' : STATUS_WORD[status]
          )
        ),
        el('div', { class: 'detail' }, componentDetail(name, reading))
      );
    })
  );
}

// --- jobs ---------------------------------------------------------------------------------------

function kpi(label, value, sub, stale) {
  return el(
    'div',
    { class: `card${stale ? ' is-stale' : ''}` },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, value),
    el('div', { class: 'sub' }, sub)
  );
}

function stage(count, label, cls = '') {
  return el(
    'div',
    { class: `stage ${cls}` },
    el('div', { class: 'n' }, count),
    el('div', { class: 'l' }, label)
  );
}

function renderJobs(v) {
  const reading = v.readings.jobs;
  const unavailable = reading.state !== 'ok';
  $('jobs-unavailable').hidden = !unavailable;
  $('jobs-body').hidden = unavailable;
  if (unavailable) {
    $('jobs-unavailable').textContent =
      reading.state === 'unavailable'
        ? `Job metrics cannot be read right now: ${reading.error?.message ?? 'no answer'} (${reading.error?.code ?? 'error'}).`
        : (reading.error?.message ?? 'Job metrics are not available.');
    return;
  }

  const j = reading.data;
  const s = v.jobs;
  const stale = reading.stale;
  replace($('job-kpis'), [
    kpi('Processing', formatNumber(j.now.processing), 'now', stale),
    kpi('Queued', formatNumber(j.now.queued), 'now', stale),
    kpi('Completed', formatNumber(s.completed), 'since start', stale),
    kpi('Failed', formatNumber(s.failed), 'since start', stale),
    kpi('Cancelled', formatNumber(s.cancelled), 'since start', stale),
    kpi(
      'Success rate',
      s.successRate === null ? DASH : formatPercent(s.successRate, 1),
      'completed ÷ (completed + failed)',
      stale
    ),
  ]);

  replace($('lifecycle'), [
    stage(j.now.queued, 'queued (now)'),
    el('span', { class: 'arrow' }, '→'),
    stage(j.now.processing, 'processing (now)'),
    el('span', { class: 'arrow' }, '→'),
    el(
      'div',
      { class: 'outcomes' },
      stage(s.completed, 'completed (since start)', 'good'),
      stage(s.failed, 'failed (since start)', 'bad'),
      stage(s.cancelled, 'cancelled (since start)')
    ),
    el(
      'dl',
      { class: 'facts' },
      ...[
        [
          'Processing time p50 / p95',
          `${formatDuration(s.processingMs?.p50)} / ${formatDuration(s.processingMs?.p95)}`,
        ],
        [
          'Queue wait p50 / p95',
          `${formatDuration(s.queueWaitMs?.p50)} / ${formatDuration(s.queueWaitMs?.p95)}`,
        ],
        ['Submitted', formatNumber(s.submitted)],
        ['Backend up for', formatDuration(s.sinceBootMs)],
        ['Active visitors (2 min)', formatNumber(j.activeSessions)],
      ].flatMap(([k, val]) => [el('dt', {}, k), el('dd', {}, val)])
    ),
  ]);
}

// --- capacity -----------------------------------------------------------------------------------

/**
 * `alarm` is for a queue, where fuller is worse. Workers and call slots are the opposite: all of
 * them busy is the system doing its job, so they stay blue and only the waiting room turns amber/red.
 */
function meter(label, used, max, text, { alarm = false } = {}) {
  const ratio = max > 0 ? Math.min(1, used / max) : 0;
  const cls = !alarm ? 'info' : ratio >= 0.8 ? 'crit' : ratio >= 0.5 ? 'warn' : '';
  const fill = el('span');
  fill.style.width = `${Math.round(ratio * 100)}%`;
  return el(
    'div',
    { class: 'meter' },
    el('div', { class: 'row' }, el('span', {}, label), el('b', {}, text ?? `${used} / ${max}`)),
    el(
      'div',
      { class: `bar ${cls}`, role: 'img', 'aria-label': `${label}: ${used} of ${max}` },
      fill
    )
  );
}

function facts(rows) {
  return el(
    'dl',
    { class: 'facts' },
    ...rows.flatMap(([k, val]) => [el('dt', {}, k), el('dd', {}, val)])
  );
}

function renderCapacity(v) {
  const q = v.capacity.qatool;
  replace(
    $('cap-qatool'),
    q
      ? [
          q.workersEffective === null
            ? null
            : meter('Workers busy', q.workersBusy, q.workersEffective),
          facts([
            [
              'Configured / effective',
              `${formatNumber(q.workersConfigured)} / ${formatNumber(q.workersEffective)}`,
            ],
            ['Free workers', formatNumber(q.workersFree)],
            ['Queued jobs', formatNumber(q.queued)],
            ['Utilization (last minute)', formatPercent(q.utilization)],
          ]),
        ]
      : el('p', { class: 'empty' }, 'Not available: the backend exposes no job metrics yet.')
  );

  const a = v.capacity.apayee;
  replace(
    $('cap-apayee'),
    a
      ? [
          a.maxActive === null ? null : meter('Active calls', a.active, a.maxActive),
          a.capacity === null
            ? null
            : meter('Waiting room', a.pending, a.capacity, undefined, { alarm: true }),
          facts([
            ['Available slots', formatNumber(a.available)],
            ['Pending', formatNumber(a.pending)],
            ['Provider', v.readings.apayee.data?.providerReady ? 'ready' : 'not ready'],
          ]),
        ]
      : el(
          'p',
          { class: 'empty' },
          v.readings.apayee.state === 'unavailable'
            ? 'Apayee cannot be read right now.'
            : 'No data yet.'
        )
  );

  replace(
    $('warnings'),
    v.warnings.map((w) => el('div', { class: `warning ${w.level}` }, w.text))
  );
}

// --- history ------------------------------------------------------------------------------------

const COLORS = ['#58a6ff', '#d29922', '#3fb950', '#f85149', '#bc8cff'];

function spark(title, series, { max } = {}) {
  const width = 300;
  const height = 56;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title);
  const top = Math.max(
    max ?? 0,
    ...series.flatMap((s) => s.values.filter((x) => typeof x === 'number')),
    1
  );
  series.forEach((s, i) => {
    for (const points of sparkPaths(s.values, width, height, { max: top })) {
      const line = document.createElementNS(SVG, 'polyline');
      line.setAttribute('points', points);
      line.setAttribute('stroke', COLORS[i % COLORS.length]);
      svg.append(line);
    }
  });
  const hasData = series.some((s) => s.values.some((x) => typeof x === 'number'));
  return el(
    'div',
    { class: 'spark' },
    el('div', { class: 'label muted small' }, title),
    hasData ? svg : el('p', { class: 'empty' }, 'No data collected.'),
    el(
      'div',
      { class: 'legend' },
      series.map((s, i) => {
        const last = [...s.values].reverse().find((x) => typeof x === 'number');
        const sw = el('span', { class: 'swatch' });
        sw.style.background = COLORS[i % COLORS.length];
        return el(
          'span',
          {},
          sw,
          `${s.label}: ${last === undefined ? DASH : s.format ? s.format(last) : last}`
        );
      })
    )
  );
}

function renderHistory(v) {
  const h = v.history;
  const first = h[0]?.t;
  const last = h.at(-1)?.t;
  $('history-span').textContent = first && last ? formatDuration(last - first) : DASH;
  const services = [...new Set(h.flatMap((p) => Object.keys(p.services)))].sort();
  replace($('spark-grid'), [
    spark('Jobs', [
      { label: 'queued', values: h.map((p) => p.queued) },
      { label: 'processing', values: h.map((p) => p.processing) },
    ]),
    spark('Apayee', [
      { label: 'active', values: h.map((p) => p.apayeeActive) },
      { label: 'pending', values: h.map((p) => p.apayeePending) },
    ]),
    spark(
      'Container CPU',
      services.map((s) => ({
        label: s,
        values: h.map((p) => p.services[s]?.cpu ?? null),
        format: (x) => `${x.toFixed(1)}%`,
      })),
      { max: 100 }
    ),
  ]);
}

// --- infrastructure -----------------------------------------------------------------------------

/**
 * The one resource reading that exists without Docker's API: the backend reports its own process
 * (memory, event-loop delay) and uptime in the job snapshot. Shown only while that is current.
 */
function renderBackendProcess(v) {
  const node = $('backend-process');
  const jobs = v.readings.jobs;
  const docker = v.readings.docker;
  const show = jobs.state === 'ok' && !jobs.stale && docker.state !== 'ok';
  node.hidden = !show;
  if (!show) return;
  const p = jobs.data.process;
  const loop = p?.eventLoopDelayMs?.p95;
  node.textContent =
    `QATOOL backend process (reported by the backend itself): memory ${formatBytes(p?.rssBytes)} resident, ` +
    `${formatBytes(p?.heapUsedBytes)} heap, event-loop delay p95 ${loop == null ? DASH : `${loop} ms`}, ` +
    `up ${formatDuration(jobs.data.uptimeMs)}. Other containers: no figures (Docker API not available here).`;
}

function renderInfra(v) {
  renderBackendProcess(v);
  const reading = v.readings.docker;
  const note = $('infra-note');
  const body = $('containers').tBodies[0];
  if (reading.state !== 'ok') {
    note.hidden = false;
    note.textContent =
      reading.state === 'unavailable'
        ? `Docker cannot be read (${reading.error?.code ?? 'error'}). Is Docker Desktop running? CPU, memory, restarts and uptime need it, and are shown as ${DASH} rather than guessed.`
        : (reading.error?.message ?? 'No container data.');
    replace(body);
    return;
  }
  note.hidden = !reading.data.resourcesError;
  if (reading.data.resourcesError)
    note.textContent = `CPU and memory could not be read (${reading.data.resourcesError}).`;

  replace(
    body,
    reading.data.containers
      .slice()
      .sort((a, b) => a.service.localeCompare(b.service))
      .map((c) => {
        const r = c.resources;
        const mem =
          r?.memUsedBytes == null
            ? DASH
            : `${formatBytes(r.memUsedBytes)}${r.memLimitBytes ? ` / ${formatBytes(r.memLimitBytes)}` : ''}`;
        return el(
          'tr',
          {},
          el('td', {}, c.service),
          el(
            'td',
            {},
            el(
              'span',
              { class: `pill pill-${c.running ? 'up' : 'down'}` },
              c.running ? 'running' : c.status
            )
          ),
          el('td', {}, c.health ?? 'no check'),
          el('td', {}, r?.cpuPercent == null ? DASH : `${r.cpuPercent.toFixed(1)}%`),
          el('td', {}, mem),
          el('td', {}, String(c.restarts) + (c.oomKilled ? ' (OOM)' : '')),
          el('td', {}, formatDuration(c.uptimeMs))
        );
      })
  );
}

// --- activity -----------------------------------------------------------------------------------

function renderActivity(v) {
  const list = $('events');
  if (v.events.length === 0) {
    replace(
      list,
      el(
        'li',
        {},
        el('span'),
        el('span'),
        el('span', { class: 'empty' }, 'No events yet. Changes appear here as they happen.')
      )
    );
  } else {
    replace(
      list,
      v.events.map((e) =>
        el(
          'li',
          {},
          el('span', { class: 't' }, new Date(e.t).toLocaleTimeString([], { hour12: false })),
          el('span', { class: `lv ${e.level}` }),
          el('span', {}, e.text)
        )
      )
    );
  }

  const jobs = v.readings.jobs;
  const pairs = (obj) =>
    Object.entries(obj ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
  const rows = (entries, emptyText) =>
    entries.length === 0
      ? el('p', { class: 'empty' }, emptyText)
      : entries.map(([k, n]) =>
          el('div', { class: 'kv' }, el('span', {}, k), el('span', {}, String(n)))
        );
  if (jobs.state !== 'ok') {
    replace($('failures'), el('p', { class: 'empty' }, 'Not available without job metrics.'));
    replace($('rejections'), el('p', { class: 'empty' }, 'Not available without job metrics.'));
  } else {
    replace($('failures'), rows(pairs(jobs.data.errorsByCode), 'None recorded.'));
    replace($('rejections'), rows(pairs(jobs.data.rejections), 'None recorded.'));
  }
}

// --- header, banner, timers ---------------------------------------------------------------------

function renderHeader(v) {
  const status = v.overall.status;
  $('overall-dot').className = `dot dot-${status === 'starting' ? 'unknown' : status}`;
  const word = {
    ok: 'All systems operational',
    degraded: 'Degraded',
    critical: 'Critical',
    starting: 'Starting',
  }[status];
  $('overall-text').textContent = v.overall.reasons.length
    ? `${word}: ${v.overall.reasons[0]}`
    : word;

  const unavailable = Object.entries(v.readings)
    .filter(([, r]) => r.state === 'unavailable')
    .map(([n]) => n);
  $('overview-meta').textContent =
    `Last poll ${v.monitor.lastCycleAt ? formatAge(v.monitor.ageMs) : DASH} (took ${formatDuration(v.monitor.lastCycleMs)}). ` +
    `Monitor started ${new Date(v.monitor.startedAt).toLocaleTimeString([], { hour12: false })}; history and events start empty after a restart of this monitor.` +
    (unavailable.length ? ` Unreadable: ${unavailable.join(', ')}.` : '');
}

function renderBanner() {
  const banner = $('banner');
  if (failures >= 2) {
    banner.hidden = false;
    banner.textContent =
      'The monitor itself is not answering. Everything below is the last data received.';
  } else if (view?.monitor.stale) {
    banner.hidden = false;
    banner.textContent =
      'The collector has not completed a poll recently. Values may be out of date.';
  } else {
    banner.hidden = true;
  }
}

function renderIndicator() {
  const node = $('refresh-indicator');
  if (!view || lastFetchOk === null) return void (node.textContent = DASH);
  const age = Date.now() - lastFetchOk;
  node.textContent = `${view.monitor.refreshing ? 'Polling… ' : ''}Updated ${formatAge(age)} · auto every ${Math.round(view.monitor.pollMs / 1000)} s`;
}

function render(v) {
  view = v;
  renderHeader(v);
  renderComponents(v);
  renderJobs(v);
  renderCapacity(v);
  renderHistory(v);
  renderInfra(v);
  renderActivity(v);
  renderBanner();
  renderIndicator();
}

async function load(refresh = false) {
  try {
    // Refresh asks the collector to poll now and answers with the same view as the GET.
    const res = await (refresh
      ? fetch('/api/refresh', { method: 'POST', headers: { 'x-ops-monitor': '1' } })
      : fetch('/api/status'));
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
    lastFetchOk = Date.now();
    failures = 0;
  } catch {
    failures += 1;
    renderBanner();
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await load();
    schedule();
  }, view?.monitor.pollMs ?? 4000);
}

$('refresh').addEventListener('click', async () => {
  const button = $('refresh');
  button.disabled = true;
  await load(true);
  button.disabled = false;
  schedule();
});

setInterval(renderIndicator, 1000);
await load();
schedule();
