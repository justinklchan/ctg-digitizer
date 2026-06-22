/* autocal.js -- derive CTG axis calibration from OCR'd axis numbers.
 *
 * Pure / DOM-free: takes detected gridlines + recognized number tokens and
 * returns calibration overrides for digitizer_core (fhr_cal, toco_cal,
 * start_min, end_min). Uses a robust (Theil-Sen) value~row fit per panel and
 * FALLS BACK to the standard clinical scale whenever the OCR is too sparse,
 * non-monotonic, or inconsistent -- so a bad read degrades to "standard" rather
 * than producing a wrong number silently.
 *
 *   const cal = buildCalibration({ hrows, vcols, W, H, yTokens, timeTokens, defaults });
 *   // cal.fhr_cal / cal.toco_cal may be null (=> core uses standard scale)
 *   // cal.fhrSource / tocoSource / timeSource in {"ocr","standard"}
 *   // cal.warnings: string[]
 *
 * Token shapes:  yTokens: [{ val:Number, y:Number }]   (left+right margins merged)
 *                timeTokens: [{ text:String, x:Number }]
 */
(function (root) {
  "use strict";

  function median(a) {
    const s = a.slice().sort(function (x, y) { return x - y; }), n = s.length;
    if (!n) return NaN;
    return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  }
  function medianSpacing(rows) {
    const g = []; for (let i = 1; i < rows.length; i++) g.push(rows[i] - rows[i - 1]);
    return g.length ? median(g) : 0;
  }
  function splitPanels(hrows) {
    let gi = 1, gmax = -1;
    for (let i = 1; i < hrows.length; i++) { const g = hrows[i] - hrows[i - 1]; if (g > gmax) { gmax = g; gi = i; } }
    return { fhrRows: hrows.slice(0, gi), tocoRows: hrows.slice(gi), boundary: (hrows[gi - 1] + hrows[gi]) / 2 };
  }

  // robust line val = a*pos + b via Theil-Sen
  function theilSen(pts) {
    const slopes = [];
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const dp = pts[j].p - pts[i].p;
        if (Math.abs(dp) > 1e-9) slopes.push((pts[j].v - pts[i].v) / dp);
      }
    if (!slopes.length) return null;
    const a = median(slopes);
    const b = median(pts.map(function (q) { return q.v - a * q.p; }));
    return { a: a, b: b };
  }

  // match number tokens to gridline rows, fit, validate -> {cal,[rT,vT,rB,vB], source}
  function fitPanel(tokens, rows, wantNeg, warnings, label) {
    if (rows.length < 2) return { cal: null, source: "standard" };
    const sp = medianSpacing(rows), tol = Math.max(6, 0.4 * sp);
    // assign each token to nearest gridline row
    const byRow = {};
    tokens.forEach(function (t) {
      let best = null, bd = 1e9;
      rows.forEach(function (r) { const dd = Math.abs(t.y - r); if (dd < bd) { bd = dd; best = r; } });
      if (bd <= tol) { (byRow[best] = byRow[best] || []).push(t.val); }
    });
    const pts = [];
    Object.keys(byRow).forEach(function (r) { pts.push({ p: Number(r), v: median(byRow[r]) }); });
    if (pts.length < 3) { warnings.push(label + ": only " + pts.length + " axis labels read -> standard scale"); return { cal: null, source: "standard" }; }

    const fit = theilSen(pts);
    if (!fit) return { cal: null, source: "standard" };
    if (wantNeg && fit.a >= 0) { warnings.push(label + ": axis numbers not decreasing with row -> standard scale"); return { cal: null, source: "standard" }; }

    // Accept only if the robust line is supported by inliers that SPAN the panel
    // (a few correct labels at both ends beat many clustered/garbage ones). This
    // accepts a sparse-but-clean read and a mostly-right dense read, while a
    // marginal/garbled read falls back to the standard scale instead of a
    // slightly-wrong one.
    const tolV = Math.max(1.5, 0.3 * Math.abs(fit.a) * sp);
    let inl = 0, inMin = Infinity, inMax = -Infinity;
    pts.forEach(function (q) {
      if (Math.abs(q.v - (fit.a * q.p + fit.b)) <= tolV) { inl++; if (q.p < inMin) inMin = q.p; if (q.p > inMax) inMax = q.p; }
    });
    const panelSpan = rows[rows.length - 1] - rows[0];
    const inlierSpan = inl ? inMax - inMin : 0;
    if (inl < 3 || inl < 0.5 * pts.length || inlierSpan < 0.55 * panelSpan) {
      warnings.push(label + ": axis labels not reliable (" + inl + "/" + pts.length + " inliers, span " +
        Math.round(100 * inlierSpan / (panelSpan || 1)) + "%) -> standard scale");
      return { cal: null, source: "standard" };
    }

    const rT = rows[0], rB = rows[rows.length - 1];
    return { cal: [rT, fit.a * rT + fit.b, rB, fit.a * rB + fit.b], source: "ocr" };
  }

  // parse "12" -> 12 (minutes) or "10:17" -> absolute minutes
  function parseTime(text) {
    const t = text.trim();
    let m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
    return null;
  }

  function fitTime(timeTokens, x_left, x_right, warnings) {
    const pts = [];
    (timeTokens || []).forEach(function (t) {
      const v = parseTime(t.text);
      if (v != null) pts.push({ p: t.x, v: v });
    });
    if (pts.length < 2) { warnings.push("time: <2 readable time labels -> 1-min/gridline assumption"); return { start_min: 0, end_min: null, source: "standard" }; }
    const fit = theilSen(pts);
    if (!fit || Math.abs(fit.a) < 1e-9) { warnings.push("time: degenerate time fit -> 1-min/gridline assumption"); return { start_min: 0, end_min: null, source: "standard" }; }
    // express as minutes from the left edge (start at 0)
    const span = fit.a * (x_right - x_left);
    if (span <= 0) { warnings.push("time: non-increasing time -> 1-min/gridline assumption"); return { start_min: 0, end_min: null, source: "standard" }; }
    return { start_min: 0, end_min: span, source: "ocr" };
  }

  function buildCalibration(input) {
    const warnings = [];
    const panels = splitPanels(input.hrows);
    const yT = input.yTokens || [];
    const fhrTok = yT.filter(function (t) { return t.y < panels.boundary; });
    const tocoTok = yT.filter(function (t) { return t.y >= panels.boundary; });

    const fhr = fitPanel(fhrTok, panels.fhrRows, true, warnings, "FHR");
    const toco = fitPanel(tocoTok, panels.tocoRows, true, warnings, "TOCO");
    const x_left = input.vcols[0], x_right = input.vcols[input.vcols.length - 1];
    const time = fitTime(input.timeTokens, x_left, x_right, warnings);

    return {
      fhr_cal: fhr.cal, toco_cal: toco.cal,
      start_min: time.start_min, end_min: time.end_min,
      fhrSource: fhr.source, tocoSource: toco.source, timeSource: time.source,
      warnings: warnings, panels: panels,
    };
  }

  const api = { buildCalibration: buildCalibration, _internal: { theilSen: theilSen, fitPanel: fitPanel, parseTime: parseTime, splitPanels: splitPanels } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CTGAutoCal = api;
})(typeof self !== "undefined" ? self : this);
