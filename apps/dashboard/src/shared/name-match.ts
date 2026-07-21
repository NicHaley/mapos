/**
 * Shared fuzzy name matching for the user's places, used by the renderer search panel
 * and the main-process agent tools so both agree on what a query matches.
 *
 * `scoreNameMatch` returns 0 for "no match" or a comparable score in (0, 1] — callers
 * filter on > 0 and sort descending. Tiers, best first: exact > prefix > substring >
 * whole-string typo > per-token match (each query token an exact/prefix/typo match of
 * some name token). Typo tolerance is edit distance (OSA, so transpositions count as
 * one edit): 1 edit for tokens of 4+ chars, 2 for 8+.
 */

export function normalizePlaceName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]?s(?=$|[^a-z0-9])/g, "")
    .replace(/['’]/g, "");
}

/** A place's name is its file basename, extension stripped. */
export function placeNameFromPath(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  return base.replace(/\.[^.]+$/, "");
}

function editsAllowed(len: number): number {
  if (len >= 8) return 2;
  if (len >= 4) return 1;
  return 0;
}

/** Optimal-string-alignment distance, capped: returns cap + 1 as soon as it can't be <= cap. */
function osaDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prevPrev: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      let d = Math.min(sub, prev[j] + 1, row[j - 1] + 1);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prevPrev[j - 2] + 1);
      }
      row.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > cap) return cap + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

function tokenize(normalized: string): string[] {
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

function bestTokenScore(qt: string, nameTokens: string[]): number {
  let best = 0;
  const allowed = editsAllowed(qt.length);
  for (const nt of nameTokens) {
    if (nt === qt) return 1;
    if (nt.startsWith(qt)) {
      if (best < 0.85) best = 0.85;
      continue;
    }
    if (allowed > 0) {
      const d = osaDistance(qt, nt, allowed);
      if (d <= allowed) {
        const s = 1 - d * 0.35;
        if (s > best) best = s;
      }
    }
  }
  return best;
}

const MIN_SCORE = 0.3;

export function scoreNameMatch(query: string, name: string): number {
  const nq = normalizePlaceName(query).trim();
  const nn = normalizePlaceName(name).trim();
  if (!nq || !nn) return 0;

  let score = 0;
  if (nq === nn) score = 1;
  else if (nn.startsWith(nq)) score = 0.9;
  else if (nn.includes(nq)) score = 0.8;

  if (score < 0.85) {
    const allowed = editsAllowed(nq.length);
    if (allowed > 0) {
      const d = osaDistance(nq, nn, allowed);
      if (d <= allowed) score = Math.max(score, 0.85 - d * 0.15);
    }
  }

  if (score < 0.75) {
    const qTokens = tokenize(nq);
    const nTokens = tokenize(nn);
    if (qTokens.length && nTokens.length) {
      let sum = 0;
      for (const qt of qTokens) {
        const s = bestTokenScore(qt, nTokens);
        if (s === 0) {
          sum = 0;
          break;
        }
        sum += s;
      }
      if (sum > 0) score = Math.max(score, 0.75 * (sum / qTokens.length));
    }
  }

  if (score === 0) return 0;
  // Shorter names win ties (an exact-ish hit on "Adrian" beats one on "Adrian's spare keys").
  score -= Math.min(nn.length, 40) * 0.002;
  return score >= MIN_SCORE ? score : 0;
}
