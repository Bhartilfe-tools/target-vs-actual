/*
 * Channel Leaderboard — shared calculation engine.
 * Used by:  target-vs-actual/leaderboard.html  and  the Persistency Times snapshot.
 * Reads the same live Google Sheet as the Target vs Actual dashboard, so every
 * month the leaderboard recalculates automatically as soon as new actuals are filled in.
 *
 * Rules
 *  - Accrual & Cash: YTD achievement = sum(actual Apr..latest) / sum(target Apr..latest)
 *  - Persistency 13M..61M: latest reported month (closing) actual vs target
 *  - Every parameter has equal weight; achievement is capped at 110% per parameter
 *  - Ranked channels exclude Company, Yodhha and Online
 */
(function () {
  'use strict';

  var SPREADSHEET_ID = '1d6EueHzDP36MMSy_4_5eHj0adAlg_xoL';
  var TABS = {
    Accrual: 'Accrual',
    Cash: 'Cash',
    '13M': 'Persistency_13M',
    '25M': 'Persistency_25M',
    '37M': 'Persistency_37M',
    '49M': 'Persistency_49M',
    '61M': 'Persistency_61M'
  };
  var PARAMS = ['Accrual', 'Cash', '13M', '25M', '37M', '49M', '61M'];
  var COHORTS = ['13M', '25M', '37M', '49M', '61M'];
  var RANKED = ['Agency', 'DD', 'PO', 'IM', 'CAB', 'Banca', 'UK'];
  var CAP = 110;

  // ---------- CSV ----------
  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
        } else { field += c; }
      } else if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else { field += c; }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
  }

  function num(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).replace(/[,₹%\s]/g, '');
    if (s === '' || /^n\/?a$/i.test(s)) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // Persistency cells -> percent number (81.3 means 81.3%). Same rule as pctVal() in index.html:
  // "81.3%" is already a percent; "0.813" (no % sign, up to 1.5) is a fraction; "81.3" is a percent.
  function pct(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim();
    if (s === '' || /^(na|n\/a|-)$/i.test(s)) return null;
    var hasPercentSign = s.indexOf('%') !== -1;
    var n = parseFloat(s.replace(/[%,\s]/g, ''));
    if (isNaN(n)) return null;
    var p = (hasPercentSign || Math.abs(n) > 1.5) ? n : n * 100;
    return Math.round(p * 1e6) / 1e6;
  }

  function fetchTab(tab) {
    var url = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID +
      '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(tab);
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Could not load tab "' + tab + '" (HTTP ' + res.status + ')');
      return res.text();
    });
  }

  // Wide tab -> { months:[...], data:{Channel:{month:{t,a}}} }
  function reshape(text, isPercent) {
    var rows = parseCSV(text);
    if (!rows.length) return { months: [], data: {} };
    var header = rows[0], months = [], colMap = {};
    for (var j = 1; j < header.length; j++) {
      var m = String(header[j]).trim().match(/^(.+?)\s+(Target|Actual)$/i);
      if (!m) continue;
      var mon = m[1].trim(), kind = m[2].toLowerCase() === 'target' ? 't' : 'a';
      if (months.indexOf(mon) === -1) months.push(mon);
      colMap[j] = { mon: mon, kind: kind };
    }
    var data = {};
    rows.slice(1).forEach(function (r) {
      var ch = String(r[0] || '').trim();
      if (!ch) return;
      var rec = {};
      Object.keys(colMap).forEach(function (j) {
        var cm = colMap[j], v = isPercent ? pct(r[j]) : num(r[j]);
        rec[cm.mon] = rec[cm.mon] || { t: null, a: null };
        rec[cm.mon][cm.kind] = v;
      });
      data[ch] = rec;
    });
    return { months: months, data: data };
  }

  // Latest month where at least one ranked channel has a non-zero actual
  function lastReported(tab) {
    for (var i = tab.months.length - 1; i >= 0; i--) {
      var m = tab.months[i];
      var hit = RANKED.some(function (ch) {
        var d = tab.data[ch] && tab.data[ch][m];
        return d && d.a !== null && d.a !== 0;
      });
      if (hit) return i;
    }
    return -1;
  }

  function ytd(tab, ch, upto) {
    var rec = tab.data[ch];
    if (!rec || upto < 0) return null;
    var t = 0, a = 0;
    for (var i = 0; i <= upto; i++) {
      var d = rec[tab.months[i]];
      if (!d) continue;
      t += d.t || 0; a += d.a || 0;
    }
    if (t <= 0) return null;
    return { t: t, a: a, ach: a / t * 100 };
  }

  function closing(tab, ch, idx) {
    var rec = tab.data[ch];
    if (!rec || idx < 0) return null;
    var d = rec[tab.months[idx]];
    if (!d || d.t === null || d.t <= 0 || d.a === null || d.a === 0) return null;
    return { t: d.t, a: d.a, ach: d.a / d.t * 100, gap: d.a - d.t };
  }

  function cap(v) { return Math.min(v, CAP); }

  function scoreChannel(ch, d) {
    var avail = PARAMS.filter(function (k) { return d[k]; });
    if (!avail.length) return null;
    var score = avail.reduce(function (s, k) { return s + cap(d[k].ach); }, 0) / avail.length;
    var pc = COHORTS.filter(function (k) { return d[k]; });
    var pers = pc.length === COHORTS.length
      ? pc.reduce(function (s, k) { return s + cap(d[k].ach); }, 0) / pc.length : null;
    return {
      ch: ch, d: d, score: score, pers: pers, n: avail.length,
      hits: avail.filter(function (k) { return d[k].ach >= 100; }).length
    };
  }

  function buildChannel(tabs, ch, accIdx, cashIdx, persIdx) {
    var d = { Accrual: ytd(tabs.Accrual, ch, accIdx), Cash: ytd(tabs.Cash, ch, cashIdx) };
    COHORTS.forEach(function (k) { d[k] = closing(tabs[k], ch, persIdx); });
    return d;
  }

  // Minimal changes (closest gaps first) for row r to overtake leader
  function pathTo1(r, leader) {
    var avail = PARAMS.filter(function (k) { return r.d[k]; });
    var n = avail.length, ach = {}, steps = {}, target = leader.score + 0.05, EPS = 1e-9;
    avail.forEach(function (k) { ach[k] = cap(r.d[k].ach); });
    function sc() { return avail.reduce(function (s, k) { return s + ach[k]; }, 0) / n; }
    function raise(list, ceiling) {
      for (var i = 0; i < list.length; i++) {
        if (sc() >= target - EPS) return;
        var k = list[i], to = Math.min(ceiling, ach[k] + (target - sc()) * n);
        if (to <= ach[k]) continue;
        steps[k] = { param: k, from: r.d[k], toAch: to };
        ach[k] = to;
      }
    }
    raise(avail.filter(function (k) { return ach[k] < 100; }).sort(function (a, b) { return ach[b] - ach[a]; }), 100);
    if (sc() < target - EPS) raise(avail.filter(function (k) { return ach[k] < CAP; }).sort(function (a, b) { return ach[b] - ach[a]; }), CAP);
    return { steps: Object.keys(steps).map(function (k) { return steps[k]; }), newScore: sc(), ok: sc() >= target - EPS };
  }

  function load() {
    var keys = Object.keys(TABS);
    return Promise.all(keys.map(function (k) { return fetchTab(TABS[k]); })).then(function (texts) {
      var tabs = {};
      keys.forEach(function (k, i) { tabs[k] = reshape(texts[i], COHORTS.indexOf(k) !== -1); });
      var accIdx = lastReported(tabs.Accrual), cashIdx = lastReported(tabs.Cash);
      var persIdx = Math.min.apply(null, COHORTS.map(function (k) { return lastReported(tabs[k]); }));
      if (accIdx < 0 || cashIdx < 0 || persIdx < 0) throw new Error('No reported actuals found in the sheet yet.');
      var rows = RANKED.map(function (ch) { return scoreChannel(ch, buildChannel(tabs, ch, accIdx, cashIdx, persIdx)); })
        .filter(Boolean).sort(function (a, b) { return b.score - a.score; });
      return {
        rows: rows,
        company: buildChannel(tabs, 'Company', accIdx, cashIdx, persIdx),
        params: PARAMS, cohorts: COHORTS, cap: CAP,
        accFrom: tabs.Accrual.months[0], accTo: tabs.Accrual.months[accIdx],
        cashTo: tabs.Cash.months[cashIdx], persMonth: tabs['13M'].months[persIdx],
        missing: rows.filter(function (r) { return r.n < PARAMS.length; }).map(function (r) {
          return { ch: r.ch, n: r.n, absent: PARAMS.filter(function (k) { return !r.d[k]; }) };
        })
      };
    });
  }

  window.TVALeaderboard = { load: load, pathTo1: pathTo1, PARAMS: PARAMS, COHORTS: COHORTS, CAP: CAP };
})();
