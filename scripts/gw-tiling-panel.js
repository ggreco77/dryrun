/* GRAWITA GW Tiling panel (SCI-TILING-REDESIGN-01, stage I-4): the simplified tiling path of the Coverage panel.
 *
 * One overlap control (the rectangular FoV - width, height, position angle - comes from the shared "Telescope & Field
 * of View" section since GUI-CLEANUP-07B), GW credible region 10/50/90 %, the connected
 * zones actually found in it, an optional intersection with one to three MOCs of the left panel, one budget of new
 * FoVs and "Generate coverage". The plan comes from the GW region planner of stage I-3 (scripts/region-coverage-
 * planner.js), run in a Web Worker by scripts/gw-tiling-client.js; nothing scientific is computed here.
 *
 * The run is a guarded() action of the Coverage panel (CoverageLab.gwTiling): it shares the busy flag, the
 * cancellation ("Cancel" here, "Interrompi" in the classic block), the official P(FoV), P(new), P(cum) of the
 * application (sequenceMetrics, the same engine as every other FoV) and the transactional publication
 * (commitPlan): an interrupted or failed run publishes nothing. The FoVs and the observation
 * path are drawn by the existing overlays of the Coverage panel. The classic strategies keep their own controls.
 *
 * Labels: a zone is "North" or "South" only when the planner verified that every cell lies on that side of the celestial
 * equator and no other zone of the region has the same label; otherwise it is "Zone 1", "Zone 2", ... in the stable
 * geometric order of the planner (never by probability). */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const HEMISPHERE = { north: 'North', south: 'South' };
const MOC_CHOICES = [['kidsN', 'KiDS-N'], ['kidsS', 'KiDS-S'], ['kidsW2', 'KiDS-W2'], ['atlasN', 'ATLAS-N'], ['atlasS', 'ATLAS-S'], ['ipn', 'IPN (simulated)'], ['grb', 'Simulated Short GRB'], ['extra', 'Additional MOC']];
const LEVELS = { '0.1': '10%', '0.5': '50%', '0.9': '90%' };
// MAX_FOVS: temporary limit of 20 new FoVs, as the classic credible-region tiling (owner decision, stage I-4 polish).
const MAX_MOCS = 3, MAX_FOVS = 20;
// R1 (stage I-4): a FoV contiguous to the previous one is preferred to a branch when its exact ΔP is at least 99 % of
// the best one. 1 % is the scale of the approximations the plan already accepts: the 1 % negligible-gain rule, the
// +1 point overlap tolerance and the shortlist re-scoring (largest measured loss 0.57 % of the best FoV).
const CONTINUATION_TOLERANCE = 0.01;
const STATUS = {
  'no useful candidate': ['completed', 'no further useful contiguous FoV'],
  'already covered': ['completed', 'already covered by the accepted FoVs'],
  'budget reached': ['partial', 'budget exhausted'],
  'not-visited (budget)': ['not planned', 'budget exhausted before this target'],
  'below threshold (tiny target)': ['not planned', 'too small for a useful FoV (below the 1 % gain threshold)']
};
const pct = p => p == null || !Number.isFinite(p) ? '—' : (100 * p).toFixed(3) + ' %';
const area = a => a == null || !Number.isFinite(a) ? '—' : a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' deg²';
const two = n => String(n).padStart(2, '0');
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
function separation(a, b) {
  const v = o => [Math.cos(o.dec * RAD) * Math.cos(o.ra * RAD), Math.cos(o.dec * RAD) * Math.sin(o.ra * RAD), Math.sin(o.dec * RAD)];
  const u = v(a), w = v(b);
  return 2 * Math.asin(Math.min(1, Math.hypot(u[0] - w[0], u[1] - w[1], u[2] - w[2]) / 2)) * DEG;
}
function zoneLabels(zones) {
  const count = { north: 0, south: 0 };
  for (const z of zones) if (z.hemisphere === 'north' || z.hemisphere === 'south') count[z.hemisphere]++;
  return zones.map((z, k) => {
    const hemi = HEMISPHERE[z.hemisphere] || null;
    return { ...z, number: k + 1, label: hemi && count[z.hemisphere] === 1 ? hemi : 'Zone ' + (k + 1) + (hemi ? ' (' + hemi + ')' : '') };
  });
}
// Display name of a target: its zone, the intersected MOCs and, when the intersection split the zone, the part.
function targetLabels(targets, zoneById, mocNames) {
  const parts = new Map();
  for (const t of targets) parts.set(t.zoneId, (parts.get(t.zoneId) || 0) + 1);
  return new Map(targets.map(t => {
    const zone = zoneById.get(t.zoneId), base = zone ? zone.label : t.zoneId, n = parts.get(t.zoneId), k = t.id.includes('/') ? Number(t.id.split('/').pop()) : 1;
    return [t.id, base + (t.mocs && t.mocs.length ? ' ∩ ' + t.mocs.map(m => mocNames[m] || m).join(' ∩ ') : '') + (n > 1 ? ' · part ' + k + ' of ' + n : '')];
  }));
}
const MOC_NAMES = Object.fromEntries(MOC_CHOICES);
window.GrawitaGwTilingPanel = Object.freeze({ zoneLabels, targetLabels, separation, CONTINUATION_TOLERANCE, MAX_FOVS, MAX_MOCS, STATUS });

const rootEl = $('gw-tiling');
if (!rootEl) return;
const client = window.GrawitaGwTilingClient;
const lab = () => window.CoverageLab;
const hooks = () => window.CoverageLab && window.CoverageLab.gwTiling;
const posterior = () => lab() && lab().state.posterior;
const ui = { zones: null, zoneById: new Map(), level: null, selected: new Set(), targets: null, seq: 0, running: false, busy: false, unavailable: null,
  result: null, resultSignature: null, pool: null };

function feedback(text, type = '') { const el = $('gw-feedback'); el.textContent = text; el.dataset.type = type; }
function setWork(value, phase) { $('gw-work-progress').value = value; $('gw-work-text').textContent = phase + ' · ' + value + '%'; }
function updateControls() {
  const blocked = ui.running || ui.busy, off = blocked || !!ui.unavailable || !posterior();
  for (const el of rootEl.querySelectorAll('input,select')) {
    const mocBlocked = el.dataset.moc && !el.checked && selectedMocs().length >= MAX_MOCS;
    el.disabled = off || !!mocBlocked || (el.dataset.moc ? !mocAvailable(el.dataset.moc) : false);
    el.toggleAttribute('data-busy', blocked && !ui.unavailable);
  }
  $('gw-zones-all').disabled = off || !ui.zones;
  $('gw-zones-all').toggleAttribute('data-busy', blocked && !ui.unavailable);
  const b = $('gw-generate'), shapeOk = shapeSupported(), note = $('gw-shape-note');
  b.disabled = off || !shapeOk;
  // GUI-CLEANUP-07B: a circle or an ellipse in Telescope & Field of View disables the button, with its explanation.
  if (shapeOk) b.removeAttribute('aria-describedby'); else b.setAttribute('aria-describedby', 'gw-shape-note');
  if (note) note.hidden = shapeOk;
  b.toggleAttribute('data-busy', blocked && !ui.unavailable);
}
// Processing state of "Generate coverage": the orange of the other GRAWITA commands while they run (data-running,
// style/app.css), the text "Processing…" and aria-busy. It is set at once and always restored at the end.
function setRunning(on) {
  ui.running = on;
  const b = $('gw-generate');
  if (on) { b.setAttribute('data-running', ''); b.setAttribute('aria-busy', 'true'); b.textContent = 'Processing…'; }
  else { b.removeAttribute('data-running'); b.removeAttribute('aria-busy'); b.textContent = 'Generate coverage'; }
  $('gw-work-status').hidden = !on; $('gw-work-status').setAttribute('aria-busy', String(on));
  $('gw-cancel').disabled = !on;
  if (on) setWork(0, 'Preparing GW Tiling');
  updateControls();
}
// Metrics Workers of stage I-5: enough to keep up with the planner without loading the machine (the GW Tiling Worker
// and the main thread keep two cores).
const metricsPoolSize = () => Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
const afterPaint = () => new Promise(resolve => {
  let done = false; const end = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => requestAnimationFrame(end)); setTimeout(end, 250);   // hidden tab: no animation frames
});
function setUnavailable(reason) {
  ui.unavailable = reason;
  $('gw-engine').textContent = 'Unavailable';
  feedback('GW Tiling is unavailable here: ' + reason + '. The classic strategies remain available under Advanced tiling strategies.', 'error');
  updateControls();
}

/* ------------------------------------------------------------------------------------- inputs ---------------------- */
function selectedMocs() { return Array.from(rootEl.querySelectorAll('input[data-moc]:checked')).map(el => el.dataset.moc); }
function mocAvailable(key) { const m = lab() && lab().state.mocs[key]; return !!m && Object.values(m).some(p => p && p.length); }
function readNumber(id, label, lo, hi, integer = false) {
  const raw = String($(id).value).trim(), v = Number(raw);
  if (raw === '' || !Number.isFinite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) throw Error(label + ' must be ' + (integer ? 'a whole number' : 'a number') + ' from ' + lo + ' to ' + hi + '.');
  return v;
}
// GUI-CLEANUP-07B: the FoV is the shared "Telescope & Field of View" of the Coverage panel (cv-shape, cv-width,
// cv-height, cv-pa), read with the limits and messages GW Tiling has always used. GW Tiling plans rectangles only:
// another shape disables "Generate coverage" with an explanation and is never converted. Center RA/Dec, Overlap X/Y
// and the circle radius are not read: they cannot block a GW Tiling run.
const SHAPE_NOTE = 'GW Tiling plans rectangular FoVs only: choose Rectangle in Telescope & Field of View.';
function shapeSupported() { const s = $('cv-shape'); return !!s && s.value === 'rectangle'; }
function readParams() {
  if (!shapeSupported()) throw Error(SHAPE_NOTE);
  const width = readNumber('cv-width', 'FoV width (°)', 0.01, 40), height = readNumber('cv-height', 'FoV height (°)', 0.01, 40);
  const pa = readNumber('cv-pa', 'Position angle (°)', -360, 360), overlap = Number($('gw-overlap').value);
  const choices = window.ObservationalTiling ? window.ObservationalTiling.OVERLAP_CHOICES : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
  if (!choices.includes(overlap)) throw Error('Overlap must be 0–50 % in steps of 5 %.');
  const maxNew = readNumber('gw-max', 'Maximum FoVs', 1, MAX_FOVS, true);
  const key = $('gw-level').value; if (!LEVELS[key]) throw Error('Choose the 10%, 50% or 90% credible region.');
  if (!ui.zones || ui.level !== key) throw Error('The zones of the ' + LEVELS[key] + ' region are not ready yet.');
  const zoneIds = ui.zones.filter(z => ui.selected.has(z.id)).map(z => z.id);
  if (!zoneIds.length) throw Error('Select at least one zone.');
  const mocs = selectedMocs();
  if (mocs.length > MAX_MOCS) throw Error('At most three MOCs can be intersected.');
  for (const m of mocs) if (!mocAvailable(m)) throw Error('MOC ' + (MOC_NAMES[m] || m) + ' is not loaded.');
  return { width, height, pa, overlap, maxNew, level: Number(key), levelKey: key, zoneIds, mocs,
    fov: { shape: 'rectangle', width, height, radius: Math.min(width, height) / 2, pa } };
}

/* ------------------------------------------------------------------------------- zones and targets ----------------- */
function renderZones() {
  const box = $('gw-zones');
  if (!ui.zones) return;
  const rows = ui.zones.map(z => {
    const label = document.createElement('label'), box2 = document.createElement('input'), name = document.createElement('b'), info = document.createElement('span');
    label.className = 'gw-row'; box2.type = 'checkbox'; box2.dataset.zone = z.id; box2.checked = ui.selected.has(z.id); box2.autocomplete = 'off';
    box2.addEventListener('change', () => { if (box2.checked) ui.selected.add(z.id); else ui.selected.delete(z.id); refreshTargets(); });
    name.textContent = z.label;
    info.textContent = z.id + ' · P ' + pct(z.probability) + ' · ' + area(z.areaDeg2) + (z.hemisphere ? ' · entirely ' + (z.hemisphere === 'north' ? 'north' : 'south') + ' of the equator' : '');
    label.append(box2, name, info);
    return label;
  });
  const note = document.createElement('p'); note.className = 'gw-note';
  note.textContent = ui.zones.length + ' connected zone' + (ui.zones.length > 1 ? 's' : '') + ' (cells sharing an edge or a vertex) in the ' + LEVELS[ui.level] + ' region; probabilities are fractions of the whole BAYESTAR map.';
  box.replaceChildren(...rows, note);
  updateControls();
}
async function refreshZones() {
  const p = posterior(), key = $('gw-level').value, seq = ++ui.seq;
  ui.zones = null; ui.targets = null; ui.level = null; ui.zoneById = new Map();
  if (!p || ui.unavailable) { updateControls(); return; }
  $('gw-zones').replaceChildren(Object.assign(document.createElement('p'), { className: 'gw-note', textContent: 'Finding the connected zones of the ' + LEVELS[key] + ' region…' }));
  $('gw-targets').textContent = '';
  updateControls();
  try {
    const z = await client.zones(p, Number(key));
    if (seq !== ui.seq) return;
    ui.zones = zoneLabels(z.zones); ui.level = key; ui.zoneById = new Map(ui.zones.map(x => [x.id, x]));
    ui.selected = new Set(ui.zones.map(x => x.id));
    const info = client.info(); if (info) $('gw-engine').textContent = 'Web Worker · ' + info.engine + ' ' + info.version;
    renderZones(); await refreshTargets();
  } catch (error) {
    if (seq !== ui.seq || error.cancelled) return;
    if (!client.availability().ok) setUnavailable(client.availability().reason);
    else feedback('Zones could not be computed: ' + error.message, 'error');
  }
}
function targetsLine(text, cls) { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; return li; }
function renderTargets(t, mocs) {
  const box = $('gw-targets'), list = document.createElement('ul'), labels = targetLabels(t.targets, ui.zoneById, MOC_NAMES);
  for (const z of ui.zones.filter(x => ui.selected.has(x.id))) {
    const empty = t.empty.find(e => e.zoneId === z.id);
    if (empty) { list.append(targetsLine(z.label + ' ∩ ' + mocs.map(m => MOC_NAMES[m] || m).join(' ∩ ') + ': empty intersection — not planned', 'gw-empty')); continue; }
    for (const x of t.targets.filter(y => y.zoneId === z.id))
      list.append(targetsLine(labels.get(x.id) + ': P ' + pct(x.probability) + ' · ' + area(x.areaDeg2)));
  }
  const head = document.createElement('p');
  head.textContent = t.targets.length ? 'Objective: ' + t.targets.length + ' target' + (t.targets.length > 1 ? 's' : '') + ' · GW probability ' + pct(t.objectiveProbability) +
    ' · ' + area(t.objectiveAreaDeg2) + ' · planned in decreasing GW probability' : 'Objective: nothing to plan (every selected zone has an empty intersection).';
  if (!t.targets.length) head.className = 'gw-empty';
  box.replaceChildren(head, list);
}
async function refreshTargets() {
  if (!ui.zones) return;
  const p = posterior(), seq = ++ui.seq, mocs = selectedMocs(), zoneIds = ui.zones.filter(z => ui.selected.has(z.id)).map(z => z.id);
  ui.targets = null; updateControls();
  if (!zoneIds.length) { $('gw-targets').replaceChildren(Object.assign(document.createElement('p'), { className: 'gw-empty', textContent: 'Select at least one zone.' })); return; }
  $('gw-targets').replaceChildren(Object.assign(document.createElement('p'), { textContent: mocs.length ? 'Intersecting the selected zones with ' + mocs.map(m => MOC_NAMES[m]).join(' ∩ ') + '…' : 'Preparing the objective…' }));
  try {
    const t = await client.targets(p, { level: Number(ui.level), zoneIds, mocs: mocs.map(key => ({ key, json: lab().state.mocs[key] })) });
    if (seq !== ui.seq) return;
    ui.targets = t; renderTargets(t, mocs);
  } catch (error) {
    if (seq !== ui.seq || error.cancelled) return;
    if (!client.availability().ok) setUnavailable(client.availability().reason);
    else $('gw-targets').replaceChildren(Object.assign(document.createElement('p'), { className: 'gw-empty', textContent: 'Intersection failed: ' + error.message }));
  }
}

/* ------------------------------------------------------------------------------------- plan ------------------------ */
function phaseText(phase, labels, maxNew) {
  const m = /^Target (.+): FoV (\d+)$/.exec(phase || '');
  return m ? 'GW Tiling · FoV ' + m[2] + ' of at most ' + maxNew + ' · ' + (labels.get(m[1]) || m[1]) : 'GW Tiling · ' + (phase || 'planning');
}
function buildPath(plan, existing, added, labels, params, extra) {
  const O = window.ObservationalTiling, longAbove = O ? O.LONG_MOVE_DIAGONALS * O.diagonal(params.fov) : Infinity;
  const moves = plan.fovs.map((f, k) => {
    const prev = k ? added[k - 1] : existing[existing.length - 1] || null, distance = prev ? separation(prev, f) : null;
    return { index: k, kind: f.kind, from: prev ? { ra: prev.ra, dec: prev.dec } : null, to: { ra: f.ra, dec: f.dec }, distance, long: distance != null && f.kind !== 'start' && distance > longAbove,
      direction: f.direction, anchor: f.anchor, target: f.targetId };
  });
  const pathLength = moves.reduce((t, m) => t + (m.kind !== 'start' && m.distance != null ? m.distance : 0), 0);
  const ids0 = existing.map(p => p.id).concat(added.map(p => p.id));
  return {
    signature: ids0.join('|'), first: existing.length, pathLength, moves,
    legend: 'GW Tiling path, in observation order: solid = contiguous to the previous FoV · dashed = branch (contiguous to an earlier FoV: the telescope moves back) · dotted = transfer to the next target · thicker = longer than 3 FoV diagonals',
    exportPlan: ids => ({
      mode: 'GW Tiling — contiguous FoVs over the connected zones of the GW credible region', planner: 'scripts/region-coverage-planner.js (stage I-3, R1 continuation preference of stage I-4)',
      credibleRegion: LEVELS[params.levelKey], zones: params.zoneIds.map(id => ({ id, label: ui.zoneById.get(id)?.label || id, probability: ui.zoneById.get(id)?.probability ?? null, areaDeg2: ui.zoneById.get(id)?.areaDeg2 ?? null })),
      mocs: params.mocs, targets: extra.targets.map(t => ({ id: t.id, label: labels.get(t.id), zone: t.zoneId, probability: t.probability, areaDeg2: t.areaDeg2 })),
      emptyIntersections: extra.empty, fov: params.fov, areaOverlapPercent: params.overlap,
      areaOverlapDefinition: 'Omega(anchor FoV ∩ new FoV) / Omega(anchor FoV); 0 % = contact along an edge or at a vertex',
      continuationTolerance: plan.continuation.tolerance, maxNewFoVs: params.maxNew, stop: plan.stop, probabilityOrder: plan.probOrder,
      objectiveProbability: plan.objectiveProbability, objectiveCovered: plan.objectiveCovered, officialPcum: extra.officialPcum,
      perTarget: plan.perTarget, transfers: plan.transfers.map(t => ({ ...t, fromFoV: ids[existing.length + t.from], toFoV: ids[existing.length + t.to] })),
      totalAngularDistanceDeg: pathLength,
      moves: plan.fovs.map((f, k) => ({ to: ids[existing.length + k], position: existing.length + k + 1, target: f.targetId, zone: f.zoneId, kind: f.kind,
        anchor: f.anchor == null ? null : ids[existing.length + f.anchor], anchorPosition: f.anchor == null ? null : existing.length + f.anchor + 1, direction: f.direction,
        deltaPTarget: f.deltaPTarget, bestDeltaPTarget: f.bestDeltaPTarget, continuationPreferred: f.continuationPreferred,
        continuationDeltaPTarget: f.continuationDeltaPTarget === undefined ? null : f.continuationDeltaPTarget,
        angularDistanceFromPreviousDeg: moves[k].distance, longMove: moves[k].long,
        areaOverlapPercentBounds: f.overlap && !f.contact ? [100 * f.overlap.lo, 100 * f.overlap.hi] : null, contactGapDegAtMost: f.contact ? f.contact.gap : null })),
      note: 'Greedy heuristic: no global optimality is claimed. ΔP = GW probability of (FoV ∩ target) not covered by any previous FoV; every probability is a fraction of the whole BAYESTAR map (no renormalisation). Angular distance is not telescope slew time.'
    })
  };
}
function moveText(f, k, first, labels, added, existing) {
  const n = first + k + 1, prevNo = n - 1, d = k ? separation(added[k - 1], f) : existing.length ? separation(existing[existing.length - 1], f) : null;
  let s = two(n);
  if (f.kind === 'start') s += ' · start · ' + labels.get(f.targetId) + (d != null ? ' (' + d.toFixed(2) + '° from FoV ' + two(prevNo) + ', not part of the path)' : '');
  else if (f.kind === 'transfer') s += ' · transfer to ' + labels.get(f.targetId) + ' · telescope moves ' + d.toFixed(2) + '° from FoV ' + two(prevNo);
  else {
    const rel = f.contact ? 'contact' : f.overlap ? 'overlap ' + (100 * f.overlap.lo).toFixed(1) + '–' + (100 * f.overlap.hi).toFixed(1) + ' %' : '';
    if (f.kind === 'contiguous') s += ' ← ' + two(prevNo) + ' · contiguous ' + f.direction + ' · ' + rel + ' · ' + d.toFixed(2) + '°';
    else s += ' · branch: contiguous ' + f.direction + ' to FoV ' + two(first + f.anchor + 1) + ' (' + rel + ') · telescope moves ' + d.toFixed(2) + '° from FoV ' + two(prevNo);
  }
  s += ' · ΔP ' + pct(f.deltaPTarget);
  if (f.continuationPreferred) s += ' · continued from FoV ' + two(prevNo) + ' (best branch ΔP ' + pct(f.bestDeltaPTarget) + ', within ' + (100 * CONTINUATION_TOLERANCE) + ' %)';
  else if (f.kind === 'branch' && f.continuationDeltaPTarget !== undefined)
    s += f.continuationDeltaPTarget == null || !(f.continuationDeltaPTarget > 0) ? ' · no useful FoV contiguous to FoV ' + two(prevNo) : ' · best FoV contiguous to FoV ' + two(prevNo) + ': ΔP ' + pct(f.continuationDeltaPTarget);
  return s;
}
function renderResult(r, params, extra) {
  const box = $('gw-result'), plan = r.plan, labels = extra.labels, list = document.createElement('dl');
  const kinds = { start: 0, contiguous: 0, branch: 0, transfer: 0 };
  for (const f of plan ? plan.fovs : []) kinds[f.kind]++;
  const zonesText = params.zoneIds.map(id => (ui.zoneById.get(id)?.label || id) + ' (' + id + ')').join(', ');
  const share = plan && plan.objectiveProbability > 0 ? ' (' + (100 * plan.objectiveCovered / plan.objectiveProbability).toFixed(2) + ' % of the objective)' : '';
  const rows = [
    ['Credible region', LEVELS[params.levelKey] + ' · zones ' + zonesText],
    ['MOC intersection', params.mocs.length ? params.mocs.map(m => MOC_NAMES[m] || m).join(' ∩ ') : 'none'],
    ['New FoVs generated', (plan ? plan.fovs.length : 0) + ' (maximum ' + params.maxNew + ')' + (extra.existing ? ' · ' + extra.existing + ' accepted FoV' + (extra.existing > 1 ? 's' : '') + ' counted as covered' : '')],
    ['GW probability covered in the objective', plan ? pct(plan.objectiveCovered) + share : '—'],
    ['Total GW probability of the objective', pct(r.objectiveProbability) + ' · ' + area(r.objectiveAreaDeg2)],
    ['Official P(cum), whole BAYESTAR', pct(extra.officialPcum)],
    ['Moves', kinds.contiguous + ' contiguous · ' + kinds.branch + ' branch' + (kinds.branch === 1 ? '' : 'es') + ' · ' + kinds.transfer + ' transfer' + (kinds.transfer === 1 ? '' : 's') + ' between targets'],
    ['Continuation preference', plan ? 'previous FoV preferred within ' + (100 * CONTINUATION_TOLERANCE) + ' % of the best ΔP: ' + plan.continuation.preferred + ' FoV' + (plan.continuation.preferred === 1 ? '' : 's') +
      (plan.continuation.preferred ? ' · ΔP given up ' + pct(plan.continuation.deltaPGivenUp) : '') : '—'],
    ['Total angular distance', extra.path ? extra.path.pathLength.toFixed(2) + '° (not slew time)' : '—'],
    ['Stop', plan ? (plan.stop === 'budget' ? 'budget of ' + params.maxNew + ' FoVs reached' : 'every target finished') : 'nothing planned'],
    ['Resolution', 'ΔP and P at HEALPix order ' + extra.probOrder + '; geometric coverage at order 9; probabilities are fractions of the whole BAYESTAR map, not renormalised']];
  for (const [k, v] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; list.append(dt, dd); }
  // Targets: completed, partial, not planned (with the reason); empty intersections are listed too.
  const table = document.createElement('table'); table.className = 'gw-status';
  const head = table.createTHead().insertRow();
  for (const h of ['Target', 'GW probability', 'FoVs', 'ΔP covered', 'Status']) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
  const body = table.createTBody();
  for (const t of r.targets) {
    const s = plan ? plan.perTarget.find(x => x.id === t.id) : null, [cls, why] = s ? STATUS[s.status] || ['—', s.status] : ['not planned', 'nothing was planned'];
    const covered = s && s.deltaPTarget != null ? pct(s.deltaPTarget) + (t.probability > 0 ? ' (' + (100 * s.deltaPTarget / t.probability).toFixed(1) + ' %)' : '') : '—';
    const row = body.insertRow(); row.dataset.status = cls;
    for (const v of [labels.get(t.id) + ' · ' + t.id, pct(t.probability), String(s ? s.fovs : 0), covered, cls + ' — ' + why]) row.insertCell().textContent = v;
  }
  for (const e of r.empty) {
    const row = body.insertRow(); row.dataset.status = 'not planned';
    for (const v of [(ui.zoneById.get(e.zoneId)?.label || e.zoneId) + ' ∩ ' + e.mocs.map(m => MOC_NAMES[m] || m).join(' ∩ ') + ' · ' + e.zoneId, '0', '0', '—', 'not planned — empty intersection']) row.insertCell().textContent = v;
  }
  const parts = [list, table];
  if (plan && plan.transfers.length) {
    const p = document.createElement('p'); p.className = 'gw-note';
    p.textContent = 'Transfers: ' + plan.transfers.map(t => 'FoV ' + two(extra.existing + t.from + 1) + ' → ' + two(extra.existing + t.to + 1) + ' (' + labels.get(t.fromTarget) + ' → ' + labels.get(t.toTarget) + ', ' + t.distanceDeg.toFixed(2) + '°)').join(' · ') + '. A transfer is an explicit move between targets, never a contiguity.';
    parts.push(p);
  }
  if (plan && plan.fovs.length) {
    const details = document.createElement('details'), summary = document.createElement('summary'), ol = document.createElement('ol');
    details.className = 'cv-obs-moves'; summary.textContent = 'Moves (' + plan.fovs.length + ')';
    plan.fovs.forEach((f, k) => { const li = document.createElement('li'); li.dataset.kind = f.kind === 'branch' ? 'reposition' : f.kind === 'transfer' ? 'jump' : f.kind; li.textContent = moveText(f, k, extra.existing, labels, extra.added, extra.existingList); ol.appendChild(li); });
    details.append(summary, ol); parts.push(details);
  }
  const note = document.createElement('p'); note.className = 'cv-cr-note';
  note.textContent = 'Each FoV is contiguous to the FoV named in its move (its anchor); the observation order is the order of the sequence table. Greedy heuristic: no global optimality is claimed.';
  const outdated = document.createElement('p'); outdated.className = 'cv-cr-outdated'; outdated.id = 'gw-outdated'; outdated.hidden = true;
  outdated.textContent = 'The plan changed after this coverage: the values above describe the plan as generated.';
  box.replaceChildren(...parts, note, outdated); box.hidden = false;
  ui.resultSignature = lab().state.pointings.map(p => p.id).join('|');
}
async function runPlan(token, params) {
  const H = hooks(), S = lab().state, current = () => H.isCurrent(token);
  H.lockOrders(); const probOrder = H.orders().prob, areaOrder = H.orders().area;
  const existing = S.pointings.slice();
  const accepted = existing.map(p => ({ shape: p.shape, ra: p.ra, dec: p.dec, width: p.width, height: p.height, radius: p.radius, pa: p.pa }));
  const mocs = params.mocs.map(key => ({ key, json: S.mocs[key] }));
  // Names for the progress line: the preview of the same selection has the same deterministic target ids.
  let labels = ui.targets ? targetLabels(ui.targets.targets, ui.zoneById, MOC_NAMES) : new Map();
  feedback('GW Tiling ' + LEVELS[params.levelKey] + ': planning up to ' + params.maxNew + ' contiguous FoVs in the Web Worker…');
  H.progress(0, 'GW Tiling · zones and intersections');
  // Stage I-5: the official metrics of each new FoV start as soon as the planner has placed it (a placed FoV never
  // changes), in Workers running the unchanged Coverage Worker with the inputs sequenceMetrics() would use: the
  // FoV and the accepted FoVs plus the new FoVs before it. Same values, computed while the planning goes on.
  const pool = client.metricsPool ? client.metricsPool({ posterior: S.posterior, mocs: S.mocs, size: metricsPoolSize() }) : null;
  ui.pool = pool;
  const streamed = [], jobs = [];
  let planningPhase = '', metricsDone = 0;
  const showProgress = value => H.progress(value, planningPhase + (jobs.length ? ' · official metrics ' + metricsDone + ' of ' + jobs.length : ''));
  const onFov = f => {
    if (!pool || !current()) return;
    const config = { ...params.fov, ra: f.ra, dec: f.dec }, prefix = existing.concat(streamed);
    streamed.push(config);
    const job = pool.compute(config, prefix, probOrder, areaOrder);
    job.then(() => { metricsDone++; }, () => {});
    jobs.push(job);
  };
  let r;
  try {
    r = await client.plan(S.posterior, { level: params.level, zoneIds: params.zoneIds, mocs, fov: params.fov, overlap: params.overlap, maxNew: params.maxNew, accepted, probOrder,
      continuationTolerance: CONTINUATION_TOLERANCE }, (value, phase) => { if (current()) { planningPhase = phaseText(phase, labels, params.maxNew); showProgress(value); } }, onFov);
  } catch (error) { pool?.close(); if (!current() || error.cancelled) return; throw error; }
  if (!current()) { pool?.close(); return; }
  labels = targetLabels(r.targets, ui.zoneById, MOC_NAMES);
  const extra = { labels, existing: existing.length, existingList: existing, added: [], probOrder, officialPcum: existing.length ? existing[existing.length - 1].metrics?.pCum ?? null : 0, targets: r.targets, empty: r.empty, path: null };
  if (!r.plan || !r.plan.fovs.length) {
    pool?.close();
    renderResult(r, params, extra);
    feedback(r.plan ? 'GW Tiling: no FoV added — the selected targets are already covered or too small for a useful FoV. The plan is unchanged.'
      : 'GW Tiling: nothing to plan — every selected zone has an empty intersection with ' + params.mocs.map(m => MOC_NAMES[m]).join(' ∩ ') + '. The plan is unchanged.', r.plan ? '' : 'error');
    return;
  }
  const stamp = Date.now(), origin = 'GW Tiling ' + LEVELS[params.levelKey];
  const added = r.plan.fovs.map((f, k) => ({ ...params.fov, ra: f.ra, dec: f.dec, id: 'gwt-' + stamp + '-' + k, origin: origin + ' · ' + labels.get(f.targetId) + ' · ' + f.kind }));
  const plan = existing.concat(added);
  feedback('GW Tiling: ' + added.length + ' FoVs planned; completing the official P(FoV), P(new), P(cum) with the application engine…');
  let metrics = null;
  const sameFoVs = pool && streamed.length === added.length && streamed.every((c, k) => c.ra === added[k].ra && c.dec === added[k].dec);
  if (sameFoVs) {
    const all = Promise.all(jobs);
    all.catch(() => {});      // handled below; avoids an unhandled rejection while the progress loop waits
    try {
      while (metricsDone < jobs.length && current()) {
        H.progress(metricsDone / jobs.length, 'Official P(FoV), P(new), P(cum) · ' + metricsDone + ' of ' + jobs.length + ' FoVs');
        await Promise.race([all, new Promise(resolve => setTimeout(resolve, 200))]);
      }
      metrics = await all;
    } catch (error) { if (!current() || error.cancelled) return; metrics = null; console.warn('GW Tiling metrics Workers failed, using the Coverage Worker:', error); }
    finally { pool.close(); }
  } else pool?.close();
  if (!current()) return;
  // Without the pool (or after a failure of it): the usual sequence calculation, one FoV after the other.
  if (!metrics) metrics = await H.sequenceMetrics(plan, existing.length, token, 'Official P(FoV), P(new), P(cum)');
  if (!metrics || !current()) return;
  // Publication: plan, path and result in one synchronous step.
  H.commitPlan(plan, existing.length, metrics);
  extra.added = added; extra.officialPcum = metrics[metrics.length - 1].pCum;
  extra.path = buildPath(r.plan, existing, added, labels, params, extra);
  const pathError = H.setPath(extra.path);
  renderResult(r, params, extra);
  const k = r.plan.fovs.reduce((o, f) => (o[f.kind] = (o[f.kind] || 0) + 1, o), {});
  feedback('GW Tiling ' + LEVELS[params.levelKey] + ': ' + added.length + ' FoV' + (added.length > 1 ? 's' : '') + ' added (' + (k.contiguous || 0) + ' contiguous, ' + (k.branch || 0) + ' branches, ' + (k.transfer || 0) +
    ' transfers); objective covered ' + pct(r.plan.objectiveCovered) + ' of ' + pct(r.plan.objectiveProbability) + '; official P(cum) ' + pct(extra.officialPcum) + '. Greedy heuristic: no global optimality is claimed.' +
    (pathError ? ' The path could not be drawn in Aladin (' + pathError + '); the plan is not affected.' : ''), pathError ? 'error' : '');
}
async function generate() {
  if (ui.running) return;                          // a second click while it runs does nothing
  const H = hooks();
  if (!H) { feedback('The Coverage panel is not ready.', 'error'); return; }
  if (ui.unavailable) { setUnavailable(ui.unavailable); return; }
  if (H.isBusy()) { feedback('Another Coverage calculation is running: wait for it or cancel it.', 'error'); return; }
  if (!posterior()) { feedback('Load the BAYESTAR sky map first.', 'error'); return; }
  let params;
  try { params = readParams(); } catch (error) { feedback(error.message, 'error'); return; }
  if (!H.requireReady()) { feedback('Aladin Lite is not available: the plan could not be drawn. Check the official script connection.', 'error'); return; }
  setRunning(true);
  try {
    await H.run(async token => {
      try { await runPlan(token, params); }
      catch (error) { if (H.isCurrent(token) && !error.cancelled) { console.error(error); feedback('GW Tiling failed: ' + (error.message || String(error)) + '. The plan is unchanged.', 'error'); } }
    });
  } finally { await afterPaint(); setRunning(false); }
}

/* ------------------------------------------------------------------------------------- wiring ---------------------- */
function buildMocChoices() {
  const box = $('gw-mocs'), rows = [];
  for (const [key, name] of MOC_CHOICES) {
    const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
    label.className = 'gw-row'; input.type = 'checkbox'; input.dataset.moc = key; input.autocomplete = 'off'; text.textContent = name;
    input.addEventListener('change', () => { updateControls(); refreshTargets(); });
    label.append(input, text); rows.push(label);
  }
  const note = document.createElement('p'); note.className = 'gw-note'; note.id = 'gw-mocs-note';
  note.textContent = 'None, or up to three MOCs already loaded in the left panel (Additional MOC after its import). The GW probability inside an intersection is not renormalised.';
  box.replaceChildren(...rows, note);
}
function init() {
  const overlap = $('gw-overlap'), choices = window.ObservationalTiling ? window.ObservationalTiling.OVERLAP_CHOICES : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
  overlap.replaceChildren(...choices.map(v => Object.assign(document.createElement('option'), { value: String(v), textContent: v === 0 ? '0 % (edge or vertex contact)' : v + ' %', selected: v === 0 })));
  $('gw-max').max = String(MAX_FOVS);
  buildMocChoices();
  const a = client ? client.availability() : { ok: false, reason: 'scripts/gw-tiling-client.js is not loaded' };
  if (!a.ok) setUnavailable(a.reason);
  $('gw-level').addEventListener('change', refreshZones);
  $('gw-zones-all').addEventListener('click', () => { if (!ui.zones) return; ui.selected = new Set(ui.zones.map(z => z.id)); renderZones(); refreshTargets(); });
  $('gw-generate').addEventListener('click', generate);
  const shapeEl = $('cv-shape');   // GUI-CLEANUP-07B: the shared shape enables or disables GW Tiling at once
  if (shapeEl) for (const type of ['input', 'change']) shapeEl.addEventListener(type, updateControls);
  $('gw-cancel').addEventListener('click', () => { if (ui.running) hooks()?.cancel(); });
  window.addEventListener('vst-coverage-busy', e => { ui.busy = !!(e.detail && e.detail.busy); updateControls(); });
  window.addEventListener('vst-coverage-progress', e => { if (ui.running && e.detail) setWork(e.detail.value, e.detail.phase); });
  window.addEventListener('vst-coverage-cancelled', () => {
    if (!ui.running) return;
    client.cancel();     // terminates the Worker: its memory is released; the next request starts a new one
    ui.pool?.close();    // and the metrics Workers of this run
    feedback('GW Tiling interrupted: nothing was published; the plan and its probabilities are unchanged.');
  });
  window.addEventListener('vst-coverage-sequence-updated', () => {
    const note = $('gw-outdated'); if (!note || ui.resultSignature == null) return;
    note.hidden = lab().state.pointings.map(p => p.id).join('|') === ui.resultSignature;
  });
  window.addEventListener('vst-posterior-loaded', () => { if (!ui.unavailable) refreshZones(); });
  window.addEventListener('vst-moc-imported', e => { const key = e.detail && e.detail.key; updateControls(); if (key && selectedMocs().includes(key)) refreshTargets(); });
  updateControls();
  if (posterior() && !ui.unavailable) refreshZones();
  else if (!ui.unavailable) feedback('Waiting for the BAYESTAR sky map…');
}
init();
})();
