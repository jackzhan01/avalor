/**
 * Shared measurements over a table's stances.
 *
 * Lives apart from any one harness because the same numbers are wanted before
 * and after the aggregation fix, and two copies would drift exactly when the
 * comparison mattered most.
 */

/** Below this a stance is an accusation; above its negation, support. */
export const EDGE = 0.15;

export interface Stance {
  speaker: string;
  target: string;
  valence: number;
  speakerEvil: boolean;
  targetEvil: boolean;
}

export interface RoundLog {
  key: string;
  round: number;
  stances: Stance[];
}

export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let out = 0;
  for (let i = 0; i < k; i += 1) out += Math.log(n - i) - Math.log(i + 1);
  return out;
}

/** Concentration of good speakers' accusations that land on innocent seats. */
export function falseConsensus(logs: readonly RoundLog[]): {
  entropy: number;
  topShare: number;
} {
  let entropy = 0;
  let topShare = 0;
  let cells = 0;

  for (const log of logs) {
    const counts = new Map<string, number>();
    let total = 0;
    for (const s of log.stances) {
      if (s.speakerEvil || s.targetEvil || s.valence >= -EDGE) continue;
      counts.set(s.target, (counts.get(s.target) ?? 0) + 1);
      total += 1;
    }
    if (total < 3 || counts.size === 0) continue;
    let h = 0;
    let top = 0;
    for (const c of counts.values()) {
      const p = c / total;
      h -= p * Math.log(p);
      if (c > top) top = c;
    }
    const available = new Set(
      log.stances.filter((s) => !s.speakerEvil && !s.targetEvil).map((s) => s.target),
    ).size;
    entropy += available > 1 ? h / Math.log(available) : 0;
    topShare += top / total;
    cells += 1;
  }

  return {
    entropy: cells ? entropy / cells : NaN,
    topShare: cells ? topShare / cells : NaN,
  };
}

/**
 * How often a whole table lands on one innocent, against independent chance.
 *
 * The baseline uses the arm's OWN accusation rate, so a table that simply
 * accuses more is not scored as more conspiratorial.
 */
export function pileOn(logs: readonly RoundLog[]): number {
  let accusations = 0;
  let opportunities = 0;
  for (const log of logs) {
    for (const s of log.stances) {
      if (s.speakerEvil || s.targetEvil) continue;
      opportunities += 1;
      if (s.valence < -EDGE) accusations += 1;
    }
  }
  const p = opportunities ? accusations / opportunities : 0;

  let observed = 0;
  let independent = 0;
  for (const log of logs) {
    const byTarget = new Map<string, { hit: number; seen: number }>();
    for (const s of log.stances) {
      if (s.speakerEvil || s.targetEvil) continue;
      if (!byTarget.has(s.target)) byTarget.set(s.target, { hit: 0, seen: 0 });
      const cell = byTarget.get(s.target)!;
      cell.seen += 1;
      if (s.valence < -EDGE) cell.hit += 1;
    }
    for (const { hit, seen } of byTarget.values()) {
      if (seen < 3) continue;
      if (hit >= 3) observed += 1;
      let tail = 0;
      for (let k = 3; k <= seen; k += 1) {
        tail += Math.exp(
          logChoose(seen, k) +
            k * Math.log(Math.max(p, 1e-9)) +
            (seen - k) * Math.log(Math.max(1 - p, 1e-9)),
        );
      }
      independent += tail;
    }
  }
  return independent > 0 ? observed / independent : NaN;
}

/** Does a suspicion of an innocent survive into the next round, over chance? */
export function persistence(logs: readonly RoundLog[]): number {
  const byGame = new Map<string, Map<number, Map<string, number>>>();
  for (const log of logs) {
    if (!byGame.has(log.key)) byGame.set(log.key, new Map());
    const mean = new Map<string, { sum: number; n: number }>();
    for (const s of log.stances) {
      if (s.speakerEvil || s.targetEvil) continue;
      if (!mean.has(s.target)) mean.set(s.target, { sum: 0, n: 0 });
      const cell = mean.get(s.target)!;
      cell.sum += s.valence;
      cell.n += 1;
    }
    const out = new Map<string, number>();
    for (const [t, cell] of mean) out.set(t, cell.sum / cell.n);
    byGame.get(log.key)!.set(log.round, out);
  }

  let givenHit = 0;
  let givenN = 0;
  let withoutHit = 0;
  let withoutN = 0;
  for (const rounds of byGame.values()) {
    const ordered = [...rounds.keys()].sort((a, b) => a - b);
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const now = rounds.get(ordered[i])!;
      const next = rounds.get(ordered[i + 1])!;
      for (const [target, value] of now) {
        const later = next.get(target);
        if (later === undefined) continue;
        if (value < -EDGE) {
          givenN += 1;
          if (later < -EDGE) givenHit += 1;
        } else {
          withoutN += 1;
          if (later < -EDGE) withoutHit += 1;
        }
      }
    }
  }
  const given = givenN ? givenHit / givenN : NaN;
  const without = withoutN ? withoutHit / withoutN : NaN;
  return without > 0 ? given / without : NaN;
}

/**
 * Intraclass correlation over (round, target) clusters, and what it implies.
 *
 * `voices` is the effective number of independent speakers a cluster is worth
 * — the number the aggregator should be using and, before the fix, was not.
 */
export function designEffect(logs: readonly RoundLog[]): {
  rho: number;
  meanSize: number;
  design: number;
  voices: number;
} {
  const clusters: { values: number[]; targetEvil: boolean }[] = [];
  for (const log of logs) {
    const byTarget = new Map<string, { values: number[]; targetEvil: boolean }>();
    for (const s of log.stances) {
      if (s.speakerEvil) continue;
      if (!byTarget.has(s.target)) {
        byTarget.set(s.target, { values: [], targetEvil: s.targetEvil });
      }
      byTarget.get(s.target)!.values.push(s.valence);
    }
    clusters.push(...byTarget.values());
  }

  const usable = clusters.filter((c) => c.values.length >= 2);
  if (usable.length < 2) return { rho: NaN, meanSize: NaN, design: NaN, voices: NaN };

  // Centre on the mean stance for targets of that true side, so a genuinely
  // evil seat drawing agreement is not scored as agreement for no reason.
  const mean = { evil: 0, evilN: 0, good: 0, goodN: 0 };
  for (const c of usable) {
    for (const v of c.values) {
      if (c.targetEvil) {
        mean.evil += v;
        mean.evilN += 1;
      } else {
        mean.good += v;
        mean.goodN += 1;
      }
    }
  }
  const centre = (c: { targetEvil: boolean }) =>
    c.targetEvil
      ? mean.evil / Math.max(mean.evilN, 1)
      : mean.good / Math.max(mean.goodN, 1);

  let n = 0;
  let total = 0;
  for (const c of usable) {
    for (const v of c.values) {
      total += v - centre(c);
      n += 1;
    }
  }
  const grand = total / n;

  let ssB = 0;
  let ssW = 0;
  let sumSq = 0;
  for (const c of usable) {
    const k = c.values.length;
    const m = c.values.reduce((a, v) => a + (v - centre(c)), 0) / k;
    ssB += k * (m - grand) ** 2;
    for (const v of c.values) ssW += (v - centre(c) - m) ** 2;
    sumSq += k * k;
  }
  const groups = usable.length;
  const msB = ssB / Math.max(groups - 1, 1);
  const msW = ssW / Math.max(n - groups, 1);
  const n0 = (n - sumSq / n) / Math.max(groups - 1, 1);
  const rho = Math.max(0, (msB - msW) / Math.max(msB + (n0 - 1) * msW, 1e-12));
  const meanSize = n / groups;
  const design = 1 + (meanSize - 1) * rho;
  return { rho, meanSize, design, voices: meanSize / design };
}
