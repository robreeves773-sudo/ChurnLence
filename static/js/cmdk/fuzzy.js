/* fzf-inspired fuzzy scorer.  Returns -Infinity for no match, higher = better.
 *
 * Score tiers:
 *   1000+ : exact prefix match
 *    700+ : every query char hits the start of a word
 *    500+ : consecutive substring match
 *    100+ : scattered chars in order, with consecutive-streak bonus
 *
 * Recency boost is added flat into the score so a recently-touched item with
 * a slightly worse text match still floats above a stale exact-match.
 */
(function (root) {
  'use strict';

  function score(query, target, recencyBoost) {
    recencyBoost = recencyBoost || 0;
    if (!query) return recencyBoost;
    var q = String(query).toLowerCase();
    var t = String(target).toLowerCase();

    // Hard win: exact prefix
    if (t.indexOf(q) === 0) return 1000 + recencyBoost - (t.length - q.length);

    // Word-start match: every query char hits a word boundary
    var words = t.split(/[\s\-_./]+/);
    var wsIdx = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (wsIdx < q.length && w.length && w[0] === q[wsIdx]) wsIdx++;
    }
    if (wsIdx === q.length) return 700 + recencyBoost - words.length;

    // Consecutive substring anywhere
    var subIdx = t.indexOf(q);
    if (subIdx !== -1) return 500 + recencyBoost - subIdx;

    // Scattered chars in order with consecutive-streak bonus
    var ti = 0, qi = 0, s = 0, streak = 0;
    while (ti < t.length && qi < q.length) {
      if (t[ti] === q[qi]) {
        streak++;
        s += 10 + streak * 5;
        qi++;
      } else {
        streak = 0;
      }
      ti++;
    }
    if (qi < q.length) return -Infinity;
    return s + recencyBoost - t.length * 0.1;
  }

  function rank(query, items) {
    var scored = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var s = score(query, it.label, it.recency || 0);
      // Also try matching against keywords / id for better hits
      if (it.keywords) {
        var ks = score(query, it.keywords, it.recency || 0);
        if (ks > s) s = ks;
      }
      if (s > -Infinity) scored.push({ it: it, s: s });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, 50).map(function (x) { return x.it; });
  }

  root.CmdKFuzzy = { score: score, rank: rank };
})(window);
