/* GRAWITA GW Superevent summary (GUI-CLEANUP-08): distance of the active BAYESTAR and the alert metadata of the bundled
 * superevent, in one compact section.
 *
 * Two approved sources, kept apart:
 *  A. the ACTIVE BAYESTAR: DISTMEAN and DISTSTD as decoded by the unchanged CoverageMath.decodePosterior (the posterior
 *     announced by 'vst-posterior-loaded'); shown as "mean ± std Mpc" over the whole sky, never a FoV value;
 *  B. the alert metadata of scripts/event-alert-data.js, generated offline by tools/build_event_alert_summary.py from ONE
 *     alert message: source classification, source properties and the alert fields. The browser never reads Avro.
 * B is shown only while it is associated with certainty with the active sky map: its sky-map SHA-256 must equal the
 * declared and the recomputed SHA-256 of the bundled BAYESTAR, and the active posterior must be, cell by cell, the one
 * decoded from those bundled bytes. Otherwise only A is shown: nothing of a previous superevent is kept and nothing is
 * invented. Probabilities are displayed with the GraceDB rounding (0 %, <1 %, n %, >99 %, 100 %); the stored values are
 * never rounded. Source properties are independent probabilities: never normalised together. Nothing scientific is
 * computed here and no network request is made. */
(function (global) {
'use strict';
const CLASSIFICATION = ['BNS', 'NSBH', 'BBH', 'Terrestrial'];
const PROPERTIES = ['HasNS', 'HasRemnant', 'HasMassGap'];
const ALERT_TYPES = ['PRELIMINARY', 'INITIAL', 'UPDATE'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
// Definitions shown with each row (LVK public alert definitions; component masses in solar masses).
const DEFINITIONS = {
  BNS: 'Binary neutron star: both components below 3 M☉',
  NSBH: 'Neutron star – black hole: one component below 3 M☉, the other above',
  BBH: 'Binary black hole: both components above 3 M☉',
  Terrestrial: 'Terrestrial origin: instrumental or environmental noise',
  HasNS: 'At least one component below 3 M☉, consistent with a neutron star',
  HasRemnant: 'Some neutron-star matter remains outside the final compact object',
  HasMassGap: 'At least one component between 3 and 5 M☉'
};
const HEX64 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------------------- pure helpers (tested in Node) ---- */
function formatProbability(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  if (p === 0) return '0%';
  if (p === 1) return '100%';
  if (p < 0.01) return '<1%';
  if (p > 0.99) return '>99%';
  return Math.round(p * 100) + '%';
}
function formatDistance(mean, std) {
  if (!Number.isFinite(mean) || mean <= 0) return null;
  return Number.isFinite(std) && std >= 0 ? Math.round(mean) + ' ± ' + Math.round(std) + ' Mpc' : Math.round(mean) + ' Mpc';
}
function formatFar(far) { return Number.isFinite(far) && far >= 0 ? far.toExponential(2) + ' Hz' : null; }
function formatUtc(t) { return typeof t === 'string' && ISO_UTC.test(t) ? t.replace('T', ' ').replace('Z', ' UTC') : null; }
// Only valid rows are kept, in the fixed display order; a missing or invalid value is omitted, never replaced.
function probabilityRows(map, keys) {
  if (!map || typeof map !== 'object') return [];
  return keys.filter(k => Object.prototype.hasOwnProperty.call(map, k) && formatProbability(map[k]) !== null)
    .map(k => ({ key: k, value: map[k], text: formatProbability(map[k]) }));
}
// The alert metadata as far as it can be shown: null when the summary itself is unusable.
function readSummary(s) {
  if (!s || typeof s !== 'object' || s.format !== 'GRAWITA event alert summary' || s.version !== 1) return null;
  if (typeof s.superevent_id !== 'string' || !/^[A-Z]{0,2}S\d{6}[a-z]{1,3}$/.test(s.superevent_id)) return null;
  if (!s.skymap || !HEX64.test(String(s.skymap.sha256))) return null;
  const ev = s.event && typeof s.event === 'object' ? s.event : {};
  return {
    supereventId: s.superevent_id,
    alertType: ALERT_TYPES.includes(s.alert_type) ? s.alert_type : null,
    alertTime: formatUtc(s.time_created),
    eventTime: formatUtc(ev.time),
    classification: probabilityRows(s.classification, CLASSIFICATION),
    properties: probabilityRows(s.properties, PROPERTIES),
    detectors: Array.isArray(ev.instruments) && ev.instruments.every(x => typeof x === 'string' && /^[A-Z]\d$/.test(x)) ? ev.instruments.slice() : null,
    pipeline: typeof ev.pipeline === 'string' ? ev.pipeline : null,
    group: typeof ev.group === 'string' ? ev.group : null,
    search: typeof ev.search === 'string' ? ev.search : null,
    far: formatFar(ev.far),
    significant: typeof ev.significant === 'boolean' ? ev.significant : null,
    skymapSha256: s.skymap.sha256
  };
}
// Association of the alert metadata with the active sky map. Every condition must hold.
function associate(summary, declaredSha, computedSha, activeIsBundled) {
  if (!summary) return { ok: false, reason: 'no usable alert metadata is bundled' };
  if (summary.skymapSha256 !== declaredSha) return { ok: false, reason: 'the alert sky map is not the bundled BAYESTAR' };
  if (computedSha !== null && computedSha !== declaredSha) return { ok: false, reason: 'the bundled BAYESTAR bytes do not match their fingerprint' };
  if (!activeIsBundled) return { ok: false, reason: 'the loaded sky map is not the one of this alert' };
  return { ok: true, reason: null };
}
// Same posterior cell by cell (the same bytes decoded by the same unchanged function give identical numbers).
function samePosterior(a, b) {
  if (!a || !b || a.tableRows !== b.tableRows || !Array.isArray(a.cells) || !Array.isArray(b.cells) || a.cells.length !== b.cells.length) return false;
  if (!Object.is(a.originalSum, b.originalSum) || !Object.is(a.distmean, b.distmean) || !Object.is(a.diststd, b.diststd)) return false;
  for (let i = 0; i < a.cells.length; i++) {
    const x = a.cells[i], y = b.cells[i];
    if (x.order !== y.order || x.pixel !== y.pixel || !Object.is(x.p, y.p) || !Object.is(x.distmu, y.distmu) ||
        !Object.is(x.distsigma, y.distsigma) || !Object.is(x.distnorm, y.distnorm)) return false;
  }
  return true;
}
const api = { DEFINITIONS, formatProbability, formatDistance, formatFar, formatUtc, probabilityRows, readSummary, associate, samePosterior, CLASSIFICATION, PROPERTIES };
global.GrawitaSupereventSummary = Object.freeze(api);

/* ------------------------------------------------------------------------------------------------- page --------- */
const doc = global.document;
if (!doc || !doc.getElementById('gw-superevent')) return;
const $ = id => doc.getElementById(id);
let bundled = null;   // {declared, computed, posterior} of the embedded BAYESTAR, prepared once
let seq = 0;
function bundledBytes() {
  const b64 = global.GRAWITA_EVENT_BAYESTAR_B64;
  if (typeof b64 !== 'string' || !b64) return null;
  return Uint8Array.from(global.atob(b64), ch => ch.charCodeAt(0));
}
async function sha256Hex(bytes) {
  const subtle = global.crypto && global.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return null;   // not a secure context: the declared value, verified in CI, is used
  try {
    const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
    return Array.from(d, x => x.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}
async function prepareBundled() {
  if (bundled) return bundled;
  const declared = typeof global.GRAWITA_EVENT_BAYESTAR_SHA256 === 'string' ? global.GRAWITA_EVENT_BAYESTAR_SHA256 : null;
  const bytes = bundledBytes();
  let posterior = null, computed = null;
  if (bytes && global.CoverageMath) {
    computed = await sha256Hex(bytes);
    try { posterior = global.CoverageMath.decodePosterior(bytes.buffer); } catch (e) { posterior = null; }
  }
  bundled = { declared, computed, posterior };
  return bundled;
}
function el(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function group(id, title, rows, help) {
  const sec = el('section', 'gws-group'); sec.setAttribute('aria-labelledby', id);
  const h = el('h3', null, title); h.id = id; sec.appendChild(h);
  if (help) { const p = el('p', 'gws-def', help); sec.appendChild(p); }
  for (const r of rows) {
    const row = el('div', 'gws-row'), name = el('span', 'gws-name', r.key), m = doc.createElement('meter'), pct = el('span', 'gws-pct', r.text);
    name.id = id + '-' + r.key; name.title = DEFINITIONS[r.key] || '';
    m.min = 0; m.max = 1; m.value = r.value;
    m.setAttribute('aria-labelledby', name.id); m.setAttribute('aria-valuetext', r.text);
    m.title = (DEFINITIONS[r.key] ? DEFINITIONS[r.key] + '. ' : '') + r.key + ' = ' + r.value;
    row.append(name, m, pct); sec.appendChild(row);
  }
  return sec;
}
function render(posterior, info, summary) {
  const title = $('gw-superevent-title'), body = $('gw-superevent-body');
  title.textContent = info.ok ? 'GW Superevent — ' + summary.supereventId : 'GW Superevent';
  const parts = [];
  if (info.ok) {
    const head = el('p', 'gws-head');
    if (summary.alertType) head.appendChild(el('span', 'gws-chip', summary.alertType + ' alert'));
    if (summary.search === 'MDC') head.appendChild(el('span', 'gws-mdc', 'Mock Data Challenge: simulated, not an astrophysical detection'));
    if (head.childNodes.length) parts.push(head);
  }
  const dist = formatDistance(posterior && posterior.distmean, posterior && posterior.diststd);
  if (dist) {
    const p = el('p', 'gws-distance');
    p.append(el('span', 'gws-label', 'Distance (BAYESTAR, whole sky)'), el('strong', null, dist));
    p.title = 'Posterior mean ± standard deviation of the luminosity distance over the whole sky (DISTMEAN ' + posterior.distmean +
      ' Mpc, DISTSTD ' + posterior.diststd + ' Mpc) of the loaded BAYESTAR; not a distance along a field of view.';
    parts.push(p);
  }
  if (info.ok) {
    const groups = el('div', 'gws-groups');
    if (summary.classification.length) groups.appendChild(group('gws-classification', 'Source classification', summary.classification,
      'Probability that the event is terrestrial or of each astrophysical category; the four values sum to 1.'));
    if (summary.properties.length) groups.appendChild(group('gws-properties', 'Source properties', summary.properties,
      'Independent probabilities, assuming an astrophysical source; not normalised together.'));
    if (groups.childNodes.length) parts.push(groups);
    const meta = [];
    if (summary.detectors) meta.push('Detectors ' + summary.detectors.join(', '));
    if (summary.pipeline) meta.push('Pipeline ' + summary.pipeline);
    if (summary.group) meta.push('Group ' + summary.group);
    if (summary.search) meta.push('Search ' + summary.search);
    if (summary.far) meta.push('FAR ' + summary.far);
    if (summary.significant !== null) meta.push('Significant: ' + (summary.significant ? 'yes' : 'no'));
    if (meta.length) parts.push(el('p', 'gws-meta', meta.join(' · ')));
    const times = [];
    if (summary.eventTime) times.push('Event time ' + summary.eventTime);
    if (summary.alertTime) times.push((summary.alertType ? summary.alertType + ' alert' : 'Alert') + ' issued ' + summary.alertTime);
    if (times.length) parts.push(el('p', 'gws-meta', times.join(' · ')));
  } else {
    parts.push(el('p', 'gws-note', 'Source classification and properties are not shown: ' + info.reason + '.'));
  }
  body.replaceChildren(...parts);
  $('gw-superevent').dataset.associated = String(info.ok);
}
async function update(posterior) {
  const token = ++seq;
  const summary = readSummary(global.GRAWITA_EVENT_ALERT_SUMMARY);
  const b = await prepareBundled();
  if (token !== seq) return;   // a newer sky map arrived meanwhile
  const info = associate(summary, b.declared, b.computed, samePosterior(posterior, b.posterior));
  render(posterior, info, summary);
}
global.addEventListener('vst-posterior-loaded', ev => { update(ev.detail && ev.detail.posterior); });
if (global.GRAWITA_CURRENT_POSTERIOR) update(global.GRAWITA_CURRENT_POSTERIOR);
})(typeof window !== 'undefined' ? window : globalThis);
