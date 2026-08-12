/* One "what is this page" card per tab.

   Written to be readable with no biology background: what you are looking at,
   what you can do with it, and the handful of words that page uses which a
   general reader would not already know. Collapsible, and each tab remembers
   its own state so the card stops being in the way once it has been read. */
import { h } from './charts.js';

const INTRO = {
  overview: {
    title: 'Cohort — who is in this study',
    what: 'This study followed 805 people with acute myeloid leukemia (AML), a cancer of the '
      + 'blood-forming cells in bone marrow. For each person the researchers recorded their age, '
      + 'sex, how severe the disease looked, how they responded to treatment, how long they lived, '
      + 'and which genes were broken in their cancer.',
    does: 'This page is the summary of that group. Every chart answers "how many of the 805 are '
      + 'like this?" Click any bar — a risk level, a disease stage, a gene — and the whole website '
      + 'narrows to just those people, including every other tab.',
    terms: [
      ['AML', 'Acute myeloid leukemia. Immature blood cells multiply out of control and crowd out '
        + 'the healthy ones.'],
      ['ELN 2017 risk', 'A standard rating doctors give each patient — Favorable, Intermediate or '
        + 'Adverse — based on which genes and chromosomes are damaged. It predicts how well '
        + 'treatment is likely to go.'],
      ['Induction therapy', 'The first, most intense round of chemotherapy, aimed at wiping out the '
        + 'leukemia. "Complete response" means no cancer was detectable afterwards.'],
      ['Specimen', 'The actual sample of cells that was collected and tested — usually from bone '
        + 'marrow or from a normal blood draw.'],
    ],
  },

  genetics: {
    title: 'Genomics — which genes are broken',
    what: 'Cancer starts when the instructions inside a cell get damaged. Researchers read the DNA '
      + 'of each patient’s leukemia and listed every damaged gene. 756 of the 805 patients had '
      + 'this done.',
    does: 'The big grid at the top is an oncoprint. Each narrow column is one patient and each row '
      + 'is a gene; a coloured block means that gene was broken in that person. It is sorted so '
      + 'patients with the same damage stand next to each other, which is why it forms a staircase. '
      + 'Below it, the checkerboard shows which pairs of genes tend to break together — or never '
      + 'together, which usually means one is enough on its own.',
    terms: [
      ['Mutation', 'A change in the DNA sequence of a gene — a typo in the cell’s instructions.'],
      ['Missense', 'A typo that swaps one building block of the protein for another. The protein '
        + 'still gets made, but works differently.'],
      ['Truncating', 'A typo that cuts the protein short, so it usually stops working entirely.'],
      ['Co-occurring', 'Two genes that are damaged in the same patients more often than chance '
        + 'would explain.'],
      ['Mutually exclusive', 'Two genes almost never broken in the same patient — often because '
        + 'either one alone already does the job.'],
    ],
  },

  patient: {
    title: 'Patient — one person at a time',
    what: 'Everything the study recorded about a single patient, on one page: their clinical '
      + 'details, every damaged gene found in their leukemia, how their cells reacted to each drug '
      + 'that was tested, and which other patients most resemble them.',
    does: 'Pick someone from the dropdown, or arrive here by clicking a patient anywhere else on '
      + 'the site. The lollipop charts show where along each protein the damage landed. The '
      + 'dose–response curves are the raw laboratory measurements — the actual experiment, not a '
      + 'summary of it.',
    terms: [
      ['VAF', 'Variant allele fraction — what share of the cells carried that particular mutation. '
        + 'A high number means most of the cancer had it, so it probably happened early.'],
      ['Dose–response curve', 'Cells were exposed to increasing amounts of a drug. The curve '
        + 'shows how many survived at each dose. A curve that dives means the drug worked.'],
      ['Percentile', 'Where this patient falls among everyone tested. 10th percentile for a drug '
        + 'means only 10% of patients responded better.'],
      ['Karyotype', 'A description of the patient’s chromosomes — whole pieces of DNA that are '
        + 'missing, duplicated or swapped around.'],
    ],
  },

  drugs: {
    title: 'Drug response — which drugs killed the cancer cells',
    what: 'Researchers took each patient’s leukemia cells, kept them alive in a dish, and added '
      + '166 different cancer drugs one at a time at several strengths. After three days they '
      + 'counted how many cells survived.',
    does: 'This page ranks those drugs and asks what predicts them. The main chart shows how well '
      + 'each drug did on average. You can then split any drug by a broken gene to see whether '
      + 'patients with that damage responded differently — which is how a drug gets matched to a '
      + 'kind of patient rather than given to everyone.',
    terms: [
      ['AUC', 'The single number summarising a dose–response curve. Careful: it runs backwards. '
        + 'Low AUC means the drug worked well; the highest possible, 286, means the cells ignored it.'],
      ['Ex vivo', 'Latin for "out of the living". The test happened in a dish, not in a person — no '
        + 'liver, no immune system, no side effects.'],
      ['Median', 'The middle value. Half the patients scored above it, half below.'],
      ['q-value', 'How likely a result this strong would be a false alarm. Smaller is more '
        + 'trustworthy; below 0.05 is the usual bar.'],
    ],
  },

  omics: {
    title: 'Transcriptomics — which genes are switched on',
    what: 'A mutation is a typo in a recipe. This page is about something different: how loudly '
      + 'each recipe is being read out. Cells copy genes into RNA before building proteins, and '
      + 'counting that RNA shows which genes are running hot and which are switched off — even when '
      + 'the gene itself has no typo at all.',
    does: 'The map at the top places every patient as a dot, positioned so that people with similar '
      + 'gene activity sit near each other. Below, you can test whether a gene’s activity predicts '
      + 'how well a drug worked, or whether a broken gene changes the activity of another gene.',
    terms: [
      ['Gene expression', 'How much a gene is being used right now. Two people can have the same '
        + 'intact gene but run it at very different levels.'],
      ['RNA', 'The working copy a cell makes from a gene before building the protein. Counting it '
        + 'measures how active the gene is.'],
      ['log2', 'A compressed scale. Every step of 1 means double. It keeps genes that vary '
        + 'enormously on the same readable chart.'],
      ['PCA', 'A way of squashing thousands of measurements per person down to two numbers, so '
        + 'everyone can be drawn on one flat map. Close together means broadly similar.'],
      ['z-score', 'How far above or below the group average one value sits. 0 is exactly average, '
        + '+2 is unusually high, −2 unusually low.'],
    ],
  },

  survival: {
    title: 'Survival — how long people lived',
    what: 'For each patient the study recorded how long they were followed and whether they died '
      + 'during that time. This page turns that into a curve showing what fraction of a group was '
      + 'still alive as time went on.',
    does: 'Choose any way of splitting the patients — by risk rating, by a broken gene, by age — and '
      + 'the page draws one line per group. Lines that separate mean that split really does predict '
      + 'how long people live. The test underneath says whether the gap is bigger than luck.',
    terms: [
      ['Kaplan–Meier curve', 'The stepped line. It starts at 100% alive and drops a step at each '
        + 'death. Flat stretches are periods when nobody in that group died.'],
      ['Censored', 'A patient who was still alive when the study last checked on them. They count '
        + 'up to that point and then stop, rather than being treated as a death.'],
      ['Median survival', 'The time by which half of that group had died. "Not reached" means more '
        + 'than half were still alive at the end.'],
      ['Log-rank test', 'Checks whether two curves are genuinely different or just look different '
        + 'by chance.'],
    ],
  },
};

/** Insert the intro card for `tab` as the first thing inside `root`. */
export function tabIntro(root, tab) {
  const cfg = INTRO[tab];
  if (!cfg) return null;
  const storeKey = `beataml-intro-${tab}`;
  const open = localStorage.getItem(storeKey) !== 'no';

  const card = h('div', { class: 'card', style: 'margin-bottom:14px' }, root);
  card.style.borderLeft = '3px solid var(--series-1)';

  const head = h('div', {
    style: 'display:flex;gap:10px;align-items:center;cursor:pointer',
  }, card);
  h('h3', { text: cfg.title, style: 'margin:0' }, head);
  h('span', { style: 'flex:1' }, head);
  const toggle = h('span', { class: 'hint', style: 'margin:0', text: open ? 'hide' : 'show' }, head);

  const body = h('div', {}, card);
  body.hidden = !open;
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? 'show' : 'hide';
    localStorage.setItem(storeKey, body.hidden ? 'no' : 'yes');
  });

  const cols = h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-top:10px',
  }, body);

  const block = (parent, label, text) => {
    const b = h('div', {}, parent);
    h('div', {
      style: 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;'
        + 'color:var(--text-muted);font-weight:700;margin-bottom:4px',
      text: label,
    }, b);
    h('p', {
      style: 'font-size:13px;line-height:1.65;color:var(--text-secondary);margin:0',
      text,
    }, b);
    return b;
  };
  block(cols, 'What you are looking at', cfg.what);
  block(cols, 'What you can do here', cfg.does);

  if (cfg.terms?.length) {
    const t = h('div', {}, cols);
    h('div', {
      style: 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;'
        + 'color:var(--text-muted);font-weight:700;margin-bottom:4px',
      text: 'Words used on this page',
    }, t);
    const dl = h('dl', {
      style: 'margin:0;font-size:12.5px;line-height:1.6;display:grid;gap:6px',
    }, t);
    for (const [term, def] of cfg.terms) {
      const row = h('div', {}, dl);
      h('b', { text: `${term} — `, style: 'color:var(--text-primary)' }, row);
      h('span', { text: def, style: 'color:var(--text-secondary)' }, row);
    }
  }
  return card;
}
