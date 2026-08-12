/* Reference card for a single drug: what it is, who made it, how it works,
   what it is made of, and what else it treats.

   Provenance is shown per-block rather than in one blanket footnote, because
   the blocks have genuinely different standing:
     targets   — from the BeatAML release's own drug_gene table
     structure — fetched from PubChem, with a link to verify in one click
     write-up  — human-written reference text, not machine-verified
   Anything with no curated write-up says so instead of inventing one. */
import { db, ensureDrugInfo } from './data.js';
import { h, el, fmt } from './charts.js';

const STATUS_TONE = {
  Approved: 'var(--status-good)',
  Investigational: 'var(--status-warning)',
  'Tool compound': 'var(--text-muted)',
};

function sectionTitle(parent, text) {
  return h('div', {
    style: 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;'
      + 'color:var(--text-muted);font-weight:700;margin:14px 0 4px',
    text,
  }, parent);
}

function para(parent, text) {
  return h('p', {
    style: 'font-size:13px;line-height:1.65;color:var(--text-secondary);margin:0 0 8px',
    text,
  }, parent);
}

/** Provenance stamp — which source a block came from, and how far to trust it. */
function source(parent, text, tone = 'muted') {
  return h('div', {
    style: `font-size:11px;line-height:1.5;margin:2px 0 0;color:${
      tone === 'warn' ? 'var(--status-warning)' : 'var(--text-muted)'};`,
    text,
  }, parent);
}

/** Draw the molecule's formula as text with subscripted digits. */
function formula(parent, f) {
  const wrap = h('span', { style: 'font-size:15px;letter-spacing:.02em' }, parent);
  for (const part of f.match(/[A-Z][a-z]?|\d+/g) || [f]) {
    if (/^\d+$/.test(part)) {
      h('sub', { text: part, style: 'font-size:11px' }, wrap);
    } else {
      h('span', { text: part }, wrap);
    }
  }
  return wrap;
}

/**
 * Render the card into `parent` for `drugName`.
 * Loads druginfo.json on first use.
 */
export function drugCard(parent, drugName, { header = true } = {}) {
  const box = h('div', {}, parent);
  h('div', { class: 'hint', text: 'Loading drug reference…' }, box);

  ensureDrugInfo().then(() => {
    box.textContent = '';
    const info = db.drugInfo?.[drugName];
    if (!info) {
      h('div', { class: 'empty', text: `No reference entry for ${drugName}.` }, box);
      return;
    }
    const cur = info.curated;
    const chem = info.chem;

    // ---- header: name + status. Suppressed when the caller already titled the
    // block (the recommendation panel does), so the name is not printed twice.
    // The release's `family` value is a kinase-group taxonomy name — accurate
    // but unreadable ("STE: Homologs of yeast Sterile 7…"), and the target
    // chips below say the same thing better, so it is not shown here.
    if (header) {
      const head = h('div', {
        style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap',
      }, box);
      h('span', {
        style: 'font-size:17px;font-weight:650;letter-spacing:-0.01em',
        text: drugName,
      }, head);
      if (cur?.status) {
        const pill = h('span', { class: 'pill', text: cur.status }, head);
        pill.style.borderColor = STATUS_TONE[cur.status] || 'var(--border)';
        pill.style.color = STATUS_TONE[cur.status] || 'var(--text-secondary)';
      }
    }

    const cols = h('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:20px;margin-top:6px',
    }, box);
    const left = h('div', {}, cols);
    const right = h('div', {}, cols);

    // ---- how it works
    sectionTitle(left, 'How it works');
    if (cur?.mechanism) {
      para(left, cur.mechanism);
    } else {
      para(left, 'No written summary for this compound. The targets below come straight from the '
        + 'dataset and are the most reliable clue to what it does.');
    }

    if (info.targets?.length) {
      sectionTitle(left, 'What it binds');
      const list = h('div', { style: 'display:flex;gap:5px;flex-wrap:wrap' }, left);
      for (const t of info.targets) {
        const chip = h('span', { class: 'pill', text: t }, list);
        const d = info.targetDesc?.[t];
        if (d) chip.title = d;
      }
      source(left, 'Target list from the BeatAML 2.0 release. Hover a gene for its full name.');
    }

    // ---- who made it
    if (cur?.developer) {
      sectionTitle(left, 'Who developed it');
      para(left, cur.developer);
    }

    // ---- other uses
    sectionTitle(left, 'What else it is used for');
    if (cur?.otherUses) {
      para(left, cur.otherUses);
    } else {
      para(left, 'Not recorded here. Most compounds in this panel are research tools rather than '
        + 'approved medicines.');
    }

    if (cur) {
      source(left,
        'The three sections above are written reference text, not part of the BeatAML data and not '
        + 'automatically verified. Check the PubChem link before relying on any of it.', 'warn');
    }

    // ---- what it is made of
    sectionTitle(right, 'What it is made of');
    const ingredient = cur?.activeIngredient
      || chem?.matchedName
      || drugName.replace(/\s*\([^)]*\)\s*$/, '');
    h('div', {
      style: 'font-size:13px;line-height:1.6;margin:0 0 10px',
    }, right).append(
      Object.assign(document.createElement('span'), {
        textContent: 'Active ingredient: ',
        style: 'color:var(--text-muted)',
      }),
      Object.assign(document.createElement('b'), { textContent: ingredient }),
    );
    if (chem) {
      const rows = h('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:13px' }, right);
      h('span', { style: 'color:var(--text-muted)', text: 'Formula' }, rows);
      const fcell = h('span', {}, rows);
      formula(fcell, chem.formula || '—');
      h('span', { style: 'color:var(--text-muted)', text: 'Molecular weight' }, rows);
      h('span', { text: chem.weight ? `${chem.weight} g/mol` : '—' }, rows);
      if (cur?.chemClass) {
        h('span', { style: 'color:var(--text-muted)', text: 'Chemical class' }, rows);
        h('span', { text: cur.chemClass }, rows);
      }
      h('span', { style: 'color:var(--text-muted)', text: 'PubChem CID' }, rows);
      h('span', { text: String(chem.cid ?? '—') }, rows);

      if (chem.smiles) {
        h('div', {
          style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;'
            + 'color:var(--text-muted);font-weight:600;margin:12px 0 3px',
          text: 'Structure (SMILES)',
        }, right);
        h('div', {
          style: 'font-family:var(--mono);font-size:11px;line-height:1.5;word-break:break-all;'
            + 'background:var(--wash);border-radius:7px;padding:8px 10px;color:var(--text-secondary)',
          text: chem.smiles,
        }, right);
        h('div', {
          class: 'hint', style: 'margin:4px 0 0',
          text: 'SMILES is the molecule written as a line of text — letters are atoms, brackets are '
            + 'branches, numbers close rings.',
        }, right);
      }
      if (chem.cid) {
        const a = h('a', {
          href: `https://pubchem.ncbi.nlm.nih.gov/compound/${chem.cid}`,
          target: '_blank', rel: 'noopener',
          style: 'display:inline-block;margin-top:10px;font-size:12.5px;color:var(--series-1)',
          text: 'Open the full PubChem entry (structure diagram, safety, references) →',
        }, right);
        a.title = 'Opens pubchem.ncbi.nlm.nih.gov in a new tab';
      }
      source(right, `Molecular data fetched from PubChem${
        chem.matchedName && chem.matchedName !== drugName ? ` (matched as "${chem.matchedName}")` : ''}.`);
    } else {
      para(right, 'No PubChem match for this name — it is likely an internal code rather than a '
        + 'registered compound name.');
    }
    return undefined;
  }).catch((e) => {
    box.textContent = '';
    h('div', { class: 'empty', text: `Could not load drug reference: ${e.message}` }, box);
  });

  return box;
}
