/* digitizer_core.js -- DOM-free CTG strip -> series extractor.
 *
 * Color-agnostic: the color SCHEME is auto-detected -- either gray gridlines with
 * colored traces (the common case) or a colored gridline lattice with dark/achromatic
 * traces -- and traces are separated by PANEL (top = FHR, bottom = TOCO) and by VERTICAL
 * POSITION within a panel (the widest interior ink-free valley), never by hue. The two
 * FHR-panel traces are labelled by mean value (higher = us_fhr_bpm, the primary FHR;
 * lower = fhr2_bpm = maternal), matching the usual FHR-above-maternal layout; the maternal
 * trace is emitted only when actually present.
 *
 * Calibration is either taken from explicit overrides (opts.fhr_cal /
 * opts.toco_cal / opts.start_min / opts.end_min, e.g. from OCR of the printed
 * axis numbers) or falls back to the standard clinical scale (FHR top 240 /
 * step 30, TOCO 0 / step 20, time auto from gridline spacing).
 *
 *   const res = digitize(rgba, width, height, opts);
 *   res.csv / res.calibration / res.overlay / res.present / res.log
 *
 * Runs identically in the browser (canvas pixels) and in Node (test harness).
 */
(function (root) {
  "use strict";

  function linmap(p, p0, v0, p1, v1) { return v0 + (v1 - v0) * (p - p0) / (p1 - p0); }
  function num(x, d) { return x == null || x === "" ? d : Number(x); }
  function pad(s, n) { while (s.length < n) s += " "; return s; }
  function p2(n) { return n < 10 ? "0" + n : "" + n; }

  function groupLines(idx, gap) {
    gap = gap == null ? 3 : gap;
    const out = [];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], last = out[out.length - 1];
      if (out.length && i - last[last.length - 1] <= gap) last.push(i);
      else out.push([i]);
    }
    return out.map(function (g) { let s = 0; for (let j = 0; j < g.length; j++) s += g[j]; return Math.round(s / g.length); });
  }

  function median(arr) {
    const a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    const n = a.length; if (!n) return 0;
    return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }

  function hueOf(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
    if (dl === 0) return -1;
    let h;
    if (mx === r) h = ((g - b) / dl) % 6;
    else if (mx === g) h = (b - r) / dl + 2;
    else h = (r - g) / dl + 4;
    h *= 60; if (h < 0) h += 360;
    return h;
  }
  function circDist(a, b) { const d = Math.abs(a - b); return Math.min(d, 360 - d); }

  // --- gridlines: low-saturation, not-white rows/cols covering >50% ---
  function detectGridlines(d, W, H) {
    const rowCount = new Int32Array(H), colCount = new Int32Array(W);
    for (let y = 0; y < H; y++) {
      let off = y * W * 4;
      for (let x = 0; x < W; x++, off += 4) {
        const r = d[off], g = d[off + 1], b = d[off + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx - mn < 25 && mx < 210) { rowCount[y]++; colCount[x]++; }
      }
    }
    const rowIdx = [], colIdx = [];
    for (let y = 0; y < H; y++) if (rowCount[y] / W > 0.5) rowIdx.push(y);
    for (let x = 0; x < W; x++) if (colCount[x] / H > 0.5) colIdx.push(x);
    return { rows: groupLines(rowIdx, 3), cols: groupLines(colIdx, 3) };
  }

  // --- gridlines when the lattice is COLORED (and traces are dark/achromatic): saturated,
  //     not-white rows/cols covering most of the span. Inverse of the gray-gridline case. ---
  function detectGridlinesColored(d, W, H, gsat) {
    const rowCount = new Int32Array(H), colCount = new Int32Array(W);
    for (let y = 0; y < H; y++) {
      let off = y * W * 4;
      for (let x = 0; x < W; x++, off += 4) {
        const r = d[off], g = d[off + 1], b = d[off + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx - mn >= gsat && mx < 195) { rowCount[y]++; colCount[x]++; }   // bold/dark colored line (major, not faint minor)
      }
    }
    const rowIdx = [], colIdx = [];
    for (let y = 0; y < H; y++) if (rowCount[y] / W > 0.4) rowIdx.push(y);
    for (let x = 0; x < W; x++) if (colCount[x] / H > 0.4) colIdx.push(x);
    return { rows: groupLines(rowIdx, 3), cols: groupLines(colIdx, 3) };
  }

  // split horizontal gridlines into FHR (top) and TOCO (bottom) at the biggest gap
  function splitPanels(hrows) {
    let gi = 1, gmax = -1;
    for (let i = 1; i < hrows.length; i++) { const g = hrows[i] - hrows[i - 1]; if (g > gmax) { gmax = g; gi = i; } }
    return { fhrRows: hrows.slice(0, gi), tocoRows: hrows.slice(gi), boundary: (hrows[gi - 1] + hrows[gi]) / 2 };
  }

  // printed y-axis number columns (dark text stacked at gridline levels)
  function detectNumberBands(d, W, H, rowLo, rowHi) {
    const cc = new Int32Array(W);
    for (let y = rowLo; y < rowHi; y++) {
      let off = y * W * 4;
      for (let x = 0; x < W; x++, off += 4) {
        const r = d[off], g = d[off + 1], b = d[off + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx - mn < 25 && mx < 150) cc[x]++;
      }
    }
    const thr = median(cc) + Math.max(10.0, 0.02 * (rowHi - rowLo));
    const hot = new Uint8Array(W), flagged = [];
    for (let x = 0; x < W; x++) if (cc[x] > thr) { hot[x] = 1; flagged.push(x); }
    const centers = groupLines(flagged, 6), runs = [];
    for (let k = 0; k < centers.length; k++) {
      let lo = centers[k], hi = centers[k];
      while (lo > 0 && hot[lo - 1]) lo--;
      while (hi < W - 1 && hot[hi + 1]) hi++;
      runs.push([lo, hi]);
    }
    return runs;
  }

  function dominantRunCenter(ys) {
    if (ys.length === 1) return ys[0];
    const starts = [0], ends = [];
    for (let k = 1; k < ys.length; k++) if (ys[k] - ys[k - 1] > 2) { ends.push(k - 1); starts.push(k); }
    ends.push(ys.length - 1);
    let best = 0, bestLen = -1;
    for (let k = 0; k < starts.length; k++) { const len = ends[k] - starts[k]; if (len > bestLen) { bestLen = len; best = k; } }
    let s = 0; for (let j = starts[best]; j <= ends[best]; j++) s += ys[j];
    return s / (ends[best] - starts[best] + 1);
  }

  function traceFromMask(mask, W, H, colLo, colHi) {
    const cols = [], rows = [], ys = [];
    for (let c = colLo; c < colHi; c++) {
      ys.length = 0;
      for (let y = 0; y < H; y++) if (mask[y * W + c]) ys.push(y);
      if (ys.length) { cols.push(c); rows.push(dominantRunCenter(ys)); }
    }
    return { cols: cols, rows: rows };
  }

  // --- per-row "ink" (saturated = colored trace) count over [lo,hi], lightly smoothed ---
  function rowInkProfile(d, W, H, ink, lo, hi) {
    const prof = new Float64Array(H);
    for (let y = lo; y <= hi; y++) {
      let off = y * W * 4, c = 0;
      for (let x = 0; x < W; x++, off += 4) {
        if (ink(d[off], d[off + 1], d[off + 2])) c++;
      }
      prof[y] = c;
    }
    const sm = new Float64Array(H), win = 3;
    for (let y = lo; y <= hi; y++) {
      let s = 0, n = 0;
      for (let k = -win; k <= win; k++) { const yy = y + k; if (yy >= lo && yy <= hi) { s += prof[yy]; n++; } }
      sm[y] = s / n;
    }
    return sm;
  }

  // Center of the widest *interior* low-ink band in [lo,hi] -- a gap that has trace ink both
  // above and below it. This separates stacked traces / panels by POSITION, not color, and
  // (being ink-free) never cuts through a trace. Returns null when there is only one ink
  // band (e.g. a single FHR trace with no maternal, or a single panel).
  function widestInteriorGap(sm, lo, hi) {
    let mx = 0; for (let y = lo; y <= hi; y++) if (sm[y] > mx) mx = sm[y];
    if (mx <= 0) return null;
    const low = 0.10 * mx;
    const runs = []; let s = -1;
    for (let y = lo; y <= hi; y++) {
      if (sm[y] < low) { if (s < 0) s = y; }
      else if (s >= 0) { runs.push([s, y - 1]); s = -1; }
    }
    if (s >= 0) runs.push([s, hi]);
    let best = null, bestW = -1;
    for (let i = 0; i < runs.length; i++) {
      const a = runs[i][0], b = runs[i][1];
      if (a <= lo || b >= hi) continue;            // touches an edge -> outer margin, not interior
      const w = b - a; if (w > bestW) { bestW = w; best = runs[i]; }
    }
    return best ? Math.round((best[0] + best[1]) / 2) : null;
  }

  // ink mask (trace pixels per the ink predicate) within a row band
  function inkMaskBand(d, W, H, ink, rTop, rBot) {
    const y0 = Math.max(0, Math.floor(rTop)), y1 = Math.min(H, Math.ceil(rBot));
    const m = new Uint8Array(W * H);
    for (let y = y0; y < y1; y++) {
      let off = y * W * 4;
      for (let x = 0; x < W; x++, off += 4) {
        if (ink(d[off], d[off + 1], d[off + 2])) m[y * W + x] = 1;
      }
    }
    return m;
  }

  // mean hue over a mask's set pixels -- for display/logging only, never to classify a trace
  function meanHue(d, mask) {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const off = i * 4, h = hueOf(d[off], d[off + 1], d[off + 2]);
      if (h < 0) continue;
      const a = h * Math.PI / 180; sx += Math.cos(a); sy += Math.sin(a); n++;
    }
    if (!n) return 0;
    let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360;
    return Math.round(h);
  }

  // mean hue sampled along a trace's points (display only)
  function meanHueAlong(d, W, tr) {
    let sx = 0, sy = 0, n = 0;
    for (let j = 0; j < tr.cols.length; j++) {
      const off = (Math.round(tr.rows[j]) * W + tr.cols[j]) * 4;
      const h = hueOf(d[off], d[off + 1], d[off + 2]); if (h < 0) continue;
      const a = h * Math.PI / 180; sx += Math.cos(a); sy += Math.sin(a); n++;
    }
    if (!n) return 0;
    let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360;
    return Math.round(h);
  }

  // Separate two stacked traces (upper = fetal, lower = maternal) by per-column ORDER:
  // where a column has two ink runs the topmost is fetal and the bottommost is maternal
  // (holds unless the traces truly cross), so a fetal deceleration that dips toward the
  // maternal line is still kept as fetal. A column with a single run is assigned by which
  // side of splitRow it falls on, and the other trace simply gets no point there -- so a
  // missing or absent maternal trace is preserved rather than fabricated.
  function extractStacked(d, W, H, ink, rTop, rBot, scan_left, scan_right, splitRow) {
    const y0 = Math.max(0, Math.floor(rTop)), y1 = Math.min(H, Math.ceil(rBot));
    // pass 1: raw vertical ink runs per column (split at any gap > 2 px) + thickness stats
    const colRaw = [], allTh = [];
    for (let c = scan_left; c < scan_right; c++) {
      const tops = [], bots = [];
      let s = -1, last = -10;
      for (let y = y0; y < y1; y++) {
        const off = (y * W + c) * 4;
        if (ink(d[off], d[off + 1], d[off + 2])) {
          if (s < 0) s = y;
          else if (y - last > 2) { tops.push(s); bots.push(last); allTh.push(last - s + 1); s = y; }
          last = y;
        }
      }
      if (s >= 0) { tops.push(s); bots.push(last); allTh.push(last - s + 1); }
      colRaw.push({ tops: tops, bots: bots });
    }
    const lineTh = median(allTh) || 3;
    const closeGap = Math.max(4, Math.round(1.4 * lineTh));   // bridge a gridline-sized gap, but not real trace separation
    const mergeTh = Math.max(7, Math.round(2.4 * lineTh));    // a single run this tall = two traces overlapping
    const hi = { cols: [], rows: [] }, lo = { cols: [], rows: [] };
    for (let i = 0; i < colRaw.length; i++) {
      const c = scan_left + i, tops = colRaw[i].tops, bots = colRaw[i].bots;
      if (!tops.length) continue;
      // group raw runs separated by < closeGap (a trace split by a gridline -> one group)
      const gT = [tops[0]], gB = [bots[0]];
      for (let j = 1; j < tops.length; j++) {
        if (tops[j] - gB[gB.length - 1] < closeGap) gB[gB.length - 1] = bots[j];
        else { gT.push(tops[j]); gB.push(bots[j]); }
      }
      const k = gT.length, cen = function (j) { return (gT[j] + gB[j]) / 2; };
      if (k >= 2) {                                 // two distinct traces: topmost = fetal, bottommost = maternal
        hi.cols.push(c); hi.rows.push(cen(0));
        lo.cols.push(c); lo.rows.push(cen(k - 1));
      } else if (gB[0] - gT[0] + 1 >= mergeTh) {    // one run too tall to be a single line = traces overlapping
        hi.cols.push(c); hi.rows.push(gT[0] + 2);
        lo.cols.push(c); lo.rows.push(gB[0] - 2);
      } else if (cen(0) < splitRow) { hi.cols.push(c); hi.rows.push(cen(0)); }   // lone thin trace: assign by value
      else { lo.cols.push(c); lo.rows.push(cen(0)); }
    }
    return { hi: hi, lo: lo };
  }

  function digitize(d, W, H, opts) {
    opts = opts || {};
    const o = {
      fhr_top: num(opts.fhr_top, 240), fhr_step: num(opts.fhr_step, 30),
      toco_bot: num(opts.toco_bot, 0), toco_step: num(opts.toco_step, 20),
      start_min: num(opts.start_min, 0),
      end_min: opts.end_min == null || opts.end_min === "" ? null : Number(opts.end_min),
      sat: num(opts.sat, 35), autocrop: opts.autocrop !== false,
      crop_left: opts.crop_left == null ? null : Number(opts.crop_left),
      crop_right: opts.crop_right == null ? null : Number(opts.crop_right),
      grid_s: opts.grid_s == null || opts.grid_s === "" ? null : Number(opts.grid_s),
      max_gap_px: num(opts.max_gap_px, 4), start_clock: opts.start_clock || null,
      fhr_cal: opts.fhr_cal || null,    // [rT,vT,rB,vB]
      toco_cal: opts.toco_cal || null,
    };
    const log = [];
    log.push("loaded image (" + W + "x" + H + " px)");

    // Detect gridlines and pick a color scheme. Default: gray gridlines + colored traces.
    // If no gray lattice is found, the gridlines are colored (e.g. brown/pink) and the traces
    // are dark/achromatic (e.g. black) -- detect the colored lattice and flip the ink test.
    let grid = detectGridlines(d, W, H), colored = false;
    if (grid.rows.length < 4 || grid.cols.length < 2) {
      const gc = detectGridlinesColored(d, W, H, Math.max(20, o.sat - 5));
      if (gc.rows.length >= 4 && gc.cols.length >= 2) { grid = gc; colored = true; }
    }
    const hrows = grid.rows, vcols = grid.cols;
    if (hrows.length < 4 || vcols.length < 2)
      throw new Error("could not detect enough gridlines (" + hrows.length + " horizontal, " +
        vcols.length + " vertical). Needs a strip with clear gridlines.");
    // ink(r,g,b) = "is a trace pixel". Colored-grid strips: dark/achromatic ink. Gray-grid
    // strips (the common case): saturated/colored ink, matching the original behavior.
    const ink = colored
      ? function (r, g, b) { const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b); return mx - mn < o.sat && mx < 160; }
      : function (r, g, b) { const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b); return mx - mn >= o.sat; };
    log.push("color scheme: " + (colored ? "colored gridlines / dark traces" : "gray gridlines / colored traces"));

    // Panel split by trace-ink position: the FHR/TOCO boundary is the widest interior
    // ink-free band, which is robust even when the inter-panel gap is narrower than the
    // gridline spacing (the gridline-gap heuristic fails there). Calibration below still
    // uses the extreme gridlines, so the exact split index does not affect the scale.
    const fullProf = rowInkProfile(d, W, H, ink, hrows[0], hrows[hrows.length - 1]);
    let boundary = widestInteriorGap(fullProf, hrows[0], hrows[hrows.length - 1]);
    if (boundary == null) boundary = splitPanels(hrows).boundary;          // fallback: gridline gap
    let fhrRows = hrows.filter(function (r) { return r <= boundary; });
    let tocoRows = hrows.filter(function (r) { return r > boundary; });
    if (fhrRows.length < 2 || tocoRows.length < 2) {                       // safety: revert to gap split
      const p = splitPanels(hrows); fhrRows = p.fhrRows; tocoRows = p.tocoRows; boundary = p.boundary;
    }

    // --- Y calibration (override or standard fallback) ---
    let frT, fvT, frB, fvB;
    if (o.fhr_cal) { frT = o.fhr_cal[0]; fvT = o.fhr_cal[1]; frB = o.fhr_cal[2]; fvB = o.fhr_cal[3]; }
    else { frT = fhrRows[0]; fvT = o.fhr_top; frB = fhrRows[1]; fvB = o.fhr_top - o.fhr_step; }
    let trT, tvT, trB, tvB;
    if (o.toco_cal) { trT = o.toco_cal[0]; tvT = o.toco_cal[1]; trB = o.toco_cal[2]; tvB = o.toco_cal[3]; }
    else { trB = tocoRows[tocoRows.length - 1]; tvB = o.toco_bot; trT = tocoRows[tocoRows.length - 2]; tvT = o.toco_bot + o.toco_step; }

    // --- X (time) calibration ---
    const x_left = vcols[0], x_right = vcols[vcols.length - 1];
    let end_min;
    if (o.end_min != null) end_min = o.end_min;
    else {
      const gaps = [];
      for (let k = 1; k < vcols.length; k++) gaps.push(vcols[k] - vcols[k - 1]);
      const gmax = Math.max.apply(null, gaps);
      const big = gaps.filter(function (g) { return g > 0.6 * gmax; });
      const minute_px = big.length ? median(big) : median(gaps);
      end_min = o.start_min + Math.max(1, Math.round((x_right - x_left) / minute_px));
    }

    // --- horizontal crop (drop printed number columns) ---
    let scan_left = x_left, scan_right = x_right;
    if (o.crop_left != null) scan_left = o.crop_left;
    if (o.crop_right != null) scan_right = o.crop_right;
    if (o.autocrop && o.crop_left == null && o.crop_right == null) {
      const pad32 = 32, bands = detectNumberBands(d, W, H, hrows[0], Math.floor(0.60 * H));
      const left = bands.filter(function (r) { return r[1] < 0.15 * W; });
      const right = bands.filter(function (r) { return r[0] > 0.85 * W; });
      if (left.length) scan_left = Math.max(scan_left, Math.max.apply(null, left.map(function (r) { return r[1]; })) + pad32);
      if (right.length) scan_right = Math.min(scan_right, Math.min.apply(null, right.map(function (r) { return r[0]; })) - pad32);
    }

    log.push("panels    : FHR rows " + fhrRows.join(",") + "  |  TOCO rows " + tocoRows.join(","));
    log.push("FHR scale : row " + Math.round(frT) + "->" + fvT + ", row " + Math.round(frB) + "->" + fvB + " bpm" + (o.fhr_cal ? " (OCR)" : " (standard)"));
    log.push("TOCO scale: row " + Math.round(trT) + "->" + tvT + ", row " + Math.round(trB) + "->" + tvB + (o.toco_cal ? " (OCR)" : " (standard)"));
    log.push("time axis : cols " + x_left + ".." + x_right + " -> " + o.start_min + ".." + end_min + " min");
    if (scan_left !== x_left || scan_right !== x_right) log.push("cropped   : cols " + scan_left + ".." + scan_right);

    const to_time = function (c) { return linmap(c, x_left, o.start_min, x_right, end_min) * 60.0; };
    const to_fhr = function (rw) { return linmap(rw, frT, fvT, frB, fvB); };
    const to_toco = function (rw) { return linmap(rw, trT, tvT, trB, tvB); };

    // --- trace extraction: separate by PANEL and by VERTICAL POSITION (value), not color ---
    // FHR panel: take one ink mask, then split it at the interior ink valley into an upper
    // (higher bpm = fetal) and lower (adult range = maternal) trace. No valley => a single
    // FHR trace, i.e. the maternal trace is simply absent (data missingness is expected).
    const fhrTop = fhrRows[0] - 4, fhrBot = boundary;
    const ftLo = Math.max(0, Math.floor(fhrTop)), ftHi = Math.min(H - 1, Math.ceil(fhrBot));
    const fhrProf = rowInkProfile(d, W, H, ink, ftLo, ftHi);
    const fhrSplit = widestInteriorGap(fhrProf, ftLo, ftHi);
    const scanW = Math.max(1, scan_right - scan_left);
    const cand = [];
    const consider = function (tr) {
      if (!tr.cols.length) return;
      let s = 0; for (let j = 0; j < tr.rows.length; j++) s += to_fhr(tr.rows[j]);
      cand.push({ tr: tr, mean: s / tr.rows.length, hue: meanHueAlong(d, W, tr), cov: tr.cols.length / scanW });
    };
    if (fhrSplit == null) {                               // one band -> single FHR trace (no maternal)
      consider(traceFromMask(inkMaskBand(d, W, H, ink, fhrTop, fhrBot), W, H, scan_left, scan_right));
    } else {                                              // two bands -> fetal (upper) + maternal (lower)
      const tk = extractStacked(d, W, H, ink, fhrTop, fhrBot, scan_left, scan_right, fhrSplit);
      consider(tk.hi); consider(tk.lo);
    }
    // A real FHR/maternal trace spans most of the strip; drop sparse components that are
    // really text/arrow annotations (e.g. "80 BPM" labels), not a heart-rate trace.
    let fhrOut = cand.filter(function (c) { return c.cov >= 0.5; });
    if (!fhrOut.length && cand.length) { cand.sort(function (a, b) { return b.cov - a.cov; }); fhrOut = [cand[0]]; }
    fhrOut.sort(function (a, b) { return b.mean - a.mean; });   // higher bpm first = fetal

    // TOCO panel is its own subplot: a single trace, lower ink band
    const tocoInk = inkMaskBand(d, W, H, ink, boundary, tocoRows[tocoRows.length - 1] + 4);
    const tocoTrace = traceFromMask(tocoInk, W, H, scan_left, scan_right);

    const overlay = {}, present = [];
    function addSeries(name, tr, conv) {
      overlay[name] = { cols: tr.cols, rows: tr.rows, conv: conv };
      present.push(name);
      let vmin = Infinity, vmax = -Infinity;
      for (let j = 0; j < tr.rows.length; j++) { const v = conv(tr.rows[j]); if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
      log.push(pad(name, 11) + ": " + tr.cols.length + " pts, range " + vmin.toFixed(1) + ".." + vmax.toFixed(1) + " (hue " + Math.round(arguments[3] || 0) + ")");
    }
    if (fhrOut[0]) addSeries("us_fhr_bpm", fhrOut[0].tr, to_fhr, fhrOut[0].hue);
    if (fhrOut[1]) addSeries("fhr2_bpm", fhrOut[1].tr, to_fhr, fhrOut[1].hue);
    if (tocoTrace.cols.length) addSeries("toco", tocoTrace, to_toco, meanHue(d, tocoInk));
    if (!present.length) throw new Error("no colored traces detected. Try a lower color sensitivity.");

    const sec_per_px = (end_min - o.start_min) * 60.0 / (x_right - x_left);

    // --- output columns ---
    let timeGrid, colsOut;
    if (o.grid_s == null) {
      const n = scan_right - scan_left;
      timeGrid = new Float64Array(n);
      for (let i = 0; i < n; i++) timeGrid[i] = to_time(scan_left + i);
      colsOut = {};
      for (let pi = 0; pi < present.length; pi++) {
        const nm = present[pi], ov = overlay[nm], y = new Float64Array(n); y.fill(NaN);
        for (let j = 0; j < ov.cols.length; j++) y[ov.cols[j] - scan_left] = ov.conv(ov.rows[j]);
        colsOut[nm] = y;
      }
      log.push("grid step : " + sec_per_px.toFixed(4) + " s (" + (1 / sec_per_px).toFixed(2) + " Hz, raw per-pixel, " + n + " cols)");
    } else {
      const max_gap_s = o.max_gap_px * sec_per_px, series = {};
      let t_lo = Infinity, t_hi = -Infinity;
      for (let pi = 0; pi < present.length; pi++) {
        const nm = present[pi], ov = overlay[nm];
        const t = ov.cols.map(to_time), v = ov.rows.map(ov.conv);
        series[nm] = { t: t, v: v };
        if (t[0] < t_lo) t_lo = t[0]; if (t[t.length - 1] > t_hi) t_hi = t[t.length - 1];
      }
      const g0 = Math.floor(t_lo), g1 = Math.ceil(t_hi), n = Math.floor((g1 - g0) / o.grid_s) + 1;
      timeGrid = new Float64Array(n);
      for (let i = 0; i < n; i++) timeGrid[i] = g0 + i * o.grid_s;
      colsOut = {};
      for (let pi = 0; pi < present.length; pi++) {
        const nm = present[pi], s = series[nm], y = new Float64Array(n);
        for (let i = 0; i < n; i++) y[i] = interpWithGap(s.t, s.v, timeGrid[i], max_gap_s);
        colsOut[nm] = y;
      }
      log.push("grid step : " + o.grid_s.toFixed(4) + " s (" + (1 / o.grid_s).toFixed(2) + " Hz, user-set)");
    }

    // --- CSV ---
    let clock = null, base = 0;
    if (o.start_clock) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(o.start_clock.trim());
      if (!m) throw new Error("start clock must look like HH:MM");
      base = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
      clock = function (sec) { const s = Math.round(base + sec); return p2(Math.floor(s / 3600) % 24) + ":" + p2(Math.floor(s / 60) % 60) + ":" + p2(s % 60); };
    }
    const header = (clock ? ["clock"] : []).concat(["time_s"]).concat(present);
    const lines = [header.join(",")];
    for (let i = 0; i < timeGrid.length; i++) {
      const row = [];
      if (clock) row.push(clock(timeGrid[i]));
      row.push(timeGrid[i].toFixed(3));
      for (let pi = 0; pi < present.length; pi++) { const v = colsOut[present[pi]][i]; row.push(isNaN(v) ? "nan" : v.toFixed(3)); }
      lines.push(row.join(","));
    }

    return {
      csv: lines.join("\n") + "\n",
      calibration: {
        fhr: { frT: frT, fvT: fvT, frB: frB, fvB: fvB, source: o.fhr_cal ? "ocr" : "standard" },
        toco: { trT: trT, tvT: tvT, trB: trB, tvB: tvB, source: o.toco_cal ? "ocr" : "standard" },
        time: { x_left: x_left, x_right: x_right, start_min: o.start_min, end_min: end_min },
        scan: { left: scan_left, right: scan_right }, hrows: hrows, vcols: vcols,
      },
      overlay: overlay, present: present, nrows: timeGrid.length, log: log,
    };
  }

  function interpWithGap(t, v, gt, max_gap_s) {
    if (gt < t[0] || gt > t[t.length - 1]) return NaN;
    let lo = 0, hi = t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= gt) lo = m; else hi = m; }
    const span = t[hi] - t[lo];
    if (span > max_gap_s) return NaN;
    if (span === 0) return v[lo];
    return v[lo] + (v[hi] - v[lo]) * (gt - t[lo]) / span;
  }

  const api = {
    digitize: digitize,
    _internal: { detectGridlines: detectGridlines, splitPanels: splitPanels, detectNumberBands: detectNumberBands, groupLines: groupLines, median: median, linmap: linmap, hueOf: hueOf },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CTGDigitizer = api;
})(typeof self !== "undefined" ? self : this);
