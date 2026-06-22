# CTG Digitizer

A browser tool that converts cardiotocography (CTG) strips — PDF or image — into
CSV time series (US-FHR, 2nd-FHR, TOCO). **Everything runs in your browser; your
strips are never uploaded** (only this page's code is downloaded). Drop one or
many files, each is digitized automatically, and you can download all CSVs as a
ZIP.

- **Live tool:** https://justinklchan.github.io/ctg-digitizer/
- Traces are separated by panel and clustered by color (no fixed-color
  assumption). The axis scale is read off the printed numbers (OCR), falling
  back to the standard clinical scale (240/30 bpm, 0–100 TOCO) per-axis when a
  strip's labels can't be read reliably.

Self-contained static site (pdf.js, JSZip, Tesseract.js bundled same-origin).
Source/algorithm and validation harness live in the project's `browser_tool/`.
