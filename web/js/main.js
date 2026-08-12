/* App shell: data load, the single global filter row, tab routing. */
import {
  db, loadAll, filters, resetFilters, onFilterChange, emitFilterChange,
  selection, activeChips,
} from './data.js';
import { h } from './charts.js';
import * as overview from './views/overview.js';
import * as genetics from './views/genetics.js';
import * as patient from './views/patient.js';
import * as drugs from './views/drugs.js';
import * as omics from './views/omics.js';
import * as match from './views/match.js';
import * as survival from './views/survival.js';

const VIEWS = {
  overview: { mod: overview, el: null },
  genetics: { mod: genetics, el: null },
  patient: { mod: patient, el: null },
  drugs: { mod: drugs, el: null },
  omics: { mod: omics, el: null },
  match: { mod: match, el: null },
  survival: { mod: survival, el: null },
};
let currentView = 'overview';

/* ------------------------------------------------------------------ theme */
function initTheme() {
  const btn = document.getElementById('theme-toggle');
  const modes = ['auto', 'light', 'dark'];
  let i = modes.indexOf(localStorage.getItem('beataml-theme') || 'auto');
  if (i < 0) i = 0;
  const apply = () => {
    const m = modes[i];
    if (m === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', m);
    btn.textContent = `Theme: ${m}`;
    localStorage.setItem('beataml-theme', m);
  };
  btn.addEventListener('click', () => {
    i = (i + 1) % modes.length;
    apply();
    renderCurrent();   // scales read CSS custom properties at draw time
  });
  apply();
}

/* ---------------------------------------------------------------- filters */
function fillSelect(sel, values, { multi = false } = {}) {
  const keep = multi
    ? new Set([...sel.selectedOptions].map((o) => o.value))
    : sel.value;
  if (!multi) {
    while (sel.options.length > 1) sel.remove(1);
  } else {
    sel.textContent = '';
  }
  for (const v of values) {
    const o = h('option', { value: v, text: v }, sel);
    if (multi ? keep.has(v) : keep === v) o.selected = true;
  }
}

function initFilters() {
  const uniq = (key) => [...new Set(db.patients.map((p) => p[key]).filter(Boolean))].sort();

  const eln = document.getElementById('f-eln');
  const stage = document.getElementById('f-stage');
  const sex = document.getElementById('f-sex');
  const specimen = document.getElementById('f-specimen');
  const gene = document.getElementById('f-gene');
  const fusion = document.getElementById('f-fusion');
  const ageMin = document.getElementById('f-agemin');
  const ageMax = document.getElementById('f-agemax');

  fillSelect(eln, uniq('eln'), { multi: true });
  fillSelect(stage, uniq('stage'), { multi: true });
  fillSelect(sex, uniq('sex'));
  fillSelect(specimen, uniq('specimenType'));
  fillSelect(gene, db.geneFreq.map((d) => `${d.gene}`));
  fillSelect(fusion, db.fusions);

  // label gene options with their cohort frequency
  for (const o of gene.options) {
    if (!o.value) continue;
    const rec = db.geneFreq.find((d) => d.gene === o.value);
    if (rec) o.textContent = `${rec.gene} (${rec.n})`;
  }

  const syncMulti = (el, set) => {
    el.addEventListener('change', () => {
      set.clear();
      for (const o of el.selectedOptions) set.add(o.value);
      emitFilterChange();
    });
  };
  syncMulti(eln, filters.eln);
  syncMulti(stage, filters.stage);

  sex.addEventListener('change', () => { filters.sex = sex.value; emitFilterChange(); });
  specimen.addEventListener('change', () => { filters.specimen = specimen.value; emitFilterChange(); });
  gene.addEventListener('change', () => { filters.gene = gene.value; emitFilterChange(); });
  fusion.addEventListener('change', () => { filters.fusion = fusion.value; emitFilterChange(); });
  ageMin.addEventListener('change', () => {
    filters.ageMin = ageMin.value === '' ? null : +ageMin.value; emitFilterChange();
  });
  ageMax.addEventListener('change', () => {
    filters.ageMax = ageMax.value === '' ? null : +ageMax.value; emitFilterChange();
  });

  document.getElementById('f-reset').addEventListener('click', () => {
    resetFilters();
    syncControls();
    emitFilterChange();
  });
}

/** Push the filter store back into the controls (after chip removal / reset /
 *  a click-to-filter on a chart). */
function syncControls() {
  const eln = document.getElementById('f-eln');
  const stage = document.getElementById('f-stage');
  for (const o of eln.options) o.selected = filters.eln.has(o.value);
  for (const o of stage.options) o.selected = filters.stage.has(o.value);
  document.getElementById('f-sex').value = filters.sex;
  document.getElementById('f-specimen').value = filters.specimen;
  document.getElementById('f-gene').value = filters.gene;
  document.getElementById('f-fusion').value = filters.fusion;
  document.getElementById('f-agemin').value = filters.ageMin ?? '';
  document.getElementById('f-agemax').value = filters.ageMax ?? '';
}

function renderChips() {
  const wrap = document.getElementById('chips');
  wrap.textContent = '';
  const chips = activeChips();
  for (const c of chips) {
    const chip = h('div', { class: 'chip' }, wrap);
    h('span', { text: c.label }, chip);
    const x = h('button', { type: 'button', text: '×', 'aria-label': `Remove ${c.label}` }, chip);
    x.addEventListener('click', () => {
      if (c.key === 'eln') filters.eln.delete(c.value);
      else if (c.key === 'stage') filters.stage.delete(c.value);
      else if (c.key === 'ageMin') filters.ageMin = null;
      else if (c.key === 'ageMax') filters.ageMax = null;
      else filters[c.key] = '';
      syncControls();
      emitFilterChange();
    });
  }
  if (chips.length > 1) {
    const clear = h('button', { class: 'btn', type: 'button', text: 'Clear all' }, wrap);
    clear.addEventListener('click', () => {
      resetFilters(); syncControls(); emitFilterChange();
    });
  }
}

function renderCount() {
  const sel = selection();
  const node = document.getElementById('f-count');
  node.textContent = '';
  h('b', { text: sel.length.toLocaleString() }, node);
  h('span', { text: sel.length === 1 ? ' patient' : ' patients' }, node);
  if (sel.length !== db.patients.length) {
    h('span', { text: ` of ${db.patients.length.toLocaleString()}` }, node);
  }
}

/* ------------------------------------------------------------------ views */
function renderCurrent() {
  const v = VIEWS[currentView];
  v.el.classList.add('stale');           // hold the previous frame, no skeleton flash
  requestAnimationFrame(() => {
    v.mod.render(v.el);
    v.el.classList.remove('stale');
  });
}

function showView(name, { updateHash = true } = {}) {
  if (!VIEWS[name]) name = 'overview';
  currentView = name;
  for (const [k, v] of Object.entries(VIEWS)) v.el.hidden = k !== name;
  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === name));
  }
  if (updateHash && location.hash.slice(1) !== name) {
    history.replaceState(null, '', `#${name}`);
  }
  // Profile match has its own patient form and ignores the cohort slice, so the
  // global filter row would be two sets of controls with only one of them live.
  const usesGlobalFilters = name !== 'match';
  document.getElementById('filterbar').hidden = !usesGlobalFilters;
  document.getElementById('chips').hidden = !usesGlobalFilters;
  renderCurrent();
}

function initTabs() {
  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.addEventListener('click', () => showView(b.dataset.view));
  }
  window.addEventListener('hashchange', () => {
    showView(location.hash.slice(1) || 'overview', { updateHash: false });
  });
  window.addEventListener('goto-patient', (e) => {
    patient.setPatient(e.detail);
    showView('patient');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/* ------------------------------------------------------------------- boot */
(async function boot() {
  for (const k of Object.keys(VIEWS)) VIEWS[k].el = document.getElementById(`view-${k}`);
  try {
    await loadAll();
  } catch (err) {
    document.getElementById('loading').textContent =
      `Could not load the data files (${err.message}). Serve this directory over HTTP — opening index.html from the filesystem is blocked by the browser.`;
    return;
  }
  document.getElementById('loading').remove();
  initTheme();
  initFilters();
  initTabs();
  onFilterChange(() => {
    syncControls();
    renderChips();
    renderCount();
    renderCurrent();
  });
  renderChips();
  renderCount();
  showView(location.hash.slice(1) || 'overview', { updateHash: false });
})();
