#!/bin/zsh
# Sets up what ARES's work-mode workers use to make real files (all free and open source):
#   - LibreOffice (headless conversions and previews) and poppler (pdftoppm) via Homebrew
#   - a Python venv with the document libraries, and node's docx + pptxgenjs, in the support folder
#   - Chromium for the Playwright browser
# Safe to run again. Usage: zsh scripts/setup-worker-runtime.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RT="$HOME/Library/Application Support/ARES/work/.runtime"
mkdir -p "$RT"

command -v soffice >/dev/null || brew install --cask libreoffice
command -v pdftoppm >/dev/null || brew install poppler

echo "› Python libraries"
[[ -x "$RT/venv/bin/python3" ]] || python3 -m venv "$RT/venv"
"$RT/venv/bin/pip" install -q --upgrade openpyxl pandas "markitdown[docx,pptx,xlsx,pdf]" pypdf pdfplumber reportlab python-docx python-pptx matplotlib pdf2image

echo "› Node libraries"
[[ -f "$RT/package.json" ]] || echo '{"name":"ares-worker-runtime","private":true}' > "$RT/package.json"
(cd "$RT" && npm install -q docx pptxgenjs)

echo "› Browser for Playwright"
node node_modules/playwright/cli.js install chromium chromium-headless-shell

echo "✓ Worker runtime ready in $RT (ARES copies the document skills in at launch)"
