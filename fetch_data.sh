#!/usr/bin/env bash
# Download the BeatAML 2.0 release files that the ETL scripts read.
#
# These are not committed: the set is ~338 MB and the expression matrix alone is
# 268 MB, past GitHub's 100 MB per-file limit. The derived JSON the website
# loads IS committed under web/data/, so you only need this if you want to
# re-run or modify the pipeline.
#
# Source: https://biodev.github.io/BeatAML2/  (CC-BY-4.0)
set -euo pipefail

BASE="https://github.com/biodev/beataml2.0_data/raw/main"
DEST="$(dirname "$0")/data/raw"
mkdir -p "$DEST"

FILES=(
  beataml_wv1to4_clinical.xlsx
  beataml_wes_wv1to4_mutations_dbgap.txt
  beataml_probit_curve_fits_v4_dbgap.txt
  beataml_wv1to4_raw_inhibitor_v4_dbgap.txt
  beataml_drug_families.xlsx
  beataml_waves1to4_sample_mapping.xlsx
  beataml_waves1to4_norm_exp_dbgap.txt
)

for f in "${FILES[@]}"; do
  if [ -s "$DEST/$f" ]; then
    echo "have    $f"
    continue
  fi
  echo "fetching $f …"
  curl -sSL --fail -o "$DEST/$f" "$BASE/$f"
done

echo
echo "Done. Files in $DEST:"
ls -lh "$DEST" | awk 'NR>1 {print "  " $5 "\t" $9}'
echo
echo "Now rebuild the site payloads:"
echo "  .venv/bin/python etl.py"
echo "  .venv/bin/python etl_omics.py"
echo "  .venv/bin/python etl_drugs.py   # needs network (PubChem)"
