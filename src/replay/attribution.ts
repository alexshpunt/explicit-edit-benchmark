import type { Cause } from "./trace/types.ts";

/** A mutating call and the time it could have written: from its start to its result. */
export interface CallWindow {
  agent: string;
  call: string;
  start: number;
  end: number;
  args: unknown;
  /** The enclosing script call, when this call ran inside one. */
  parent?: string;
  /** The result the call returned, when known. */
  output?: string;
}

export interface AttributionOptions {
  /** How long before a call's start event a write may be observed (clock skew). */
  leadMs?: number;
  /** How long after a call's result a write may still be observed (recorder latency). */
  lagMs?: number;
  /** Each agent's start and end, on the same clock as the call windows. */
  lifetimes?: Map<string, { start: number; end: number }>;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

const tokens = (text: string) => new Set(text.match(IDENTIFIER) ?? []);

/**
 * Binds file changes to the calls that made them. Every hunk is attributed on its own,
 * because one recorded version can merge writes of several agents.
 */
export class Attributor {
  private readonly calls: CallWindow[];
  private readonly lead: number;
  private readonly lag: number;
  private readonly argTokens = new Map<string, { args: Set<string>; output: Set<string> }>();

  private readonly lifetimes: Map<string, { start: number; end: number }>;

  /** `lifetimes` (agent start and end) lets a write that no running call explains go to
   * an earlier writing call of a live agent: a command can leave a background process
   * that writes after the call returned. */
  constructor(
    calls: CallWindow[],
    { leadMs = 25, lagMs = 300, lifetimes = new Map() }: AttributionOptions = {},
  ) {
    this.calls = [...calls].sort((a, b) => a.start - b.start);
    this.lead = leadMs;
    this.lag = lagMs;
    this.lifetimes = lifetimes;
  }

  /** Earlier writing calls of agents alive at t; used only when no call is running. */
  private lingering(t: number) {
    return this.calls.filter((call) => {
      const life = this.lifetimes.get(call.agent);
      return life !== undefined && call.end < t && life.start <= t && t <= life.end + this.lag;
    });
  }

  /** Calls running at t. A script whose nested edit call is also running gives way to it. */
  candidates(t: number) {
    const running = this.calls.filter(
      (call) => call.start - this.lead <= t && t <= call.end + this.lag,
    );
    const parents = new Set(running.map((call) => call.parent).filter(Boolean));
    return running.filter((call) => !parents.has(call.call));
  }

  /** Identifiers of the call's arguments, and those only its result has, which edit tools
   * often echo but which also hold unrelated surrounding text. */
  private tokensOf(call: CallWindow) {
    let entry = this.argTokens.get(call.call);
    if (!entry) {
      const args = tokens(stringsOf(call.args).join("\n"));
      const output = new Set([...tokens(call.output ?? "")].filter((token) => !args.has(token)));
      entry = { args, output };
      this.argTokens.set(call.call, entry);
    }
    return entry;
  }

  attribute(t: number, hunk: { removed: string[]; insert: string[] }): Cause {
    const candidates = this.candidates(t);
    if (candidates.length === 0) {
      // Only text evidence can tie a write to a call that already returned.
      const late = this.lingering(t);
      if (!late.length || this.evidence(late, hunk) === 0) return { confidence: "external" };
      const cause = this.score(late, hunk);
      return cause.confidence === "matched" ? cause : { confidence: "external" };
    }
    const [first] = candidates;
    const running: Cause =
      candidates.length === 1 && first
        ? { confidence: "exact", agent: first.agent, call: first.call }
        : this.score(candidates, hunk);
    // A background process of a returned call can write while other calls run. Its call
    // wins only when the hunk's text names it and none of the running calls.
    if (this.fresh(hunk).size > 0 && this.evidence(candidates, hunk) === 0) {
      const late = this.lingering(t);
      if (late.length && this.evidence(late, hunk) > 0) {
        const cause = this.score(late, hunk);
        if (cause.confidence === "matched") return cause;
      }
    }
    return running;
  }

  /** Names the hunk introduces: on its inserted side only. */
  private fresh(hunk: { removed: string[]; insert: string[] }) {
    const removed = tokens(hunk.removed.join("\n"));
    return new Set([...tokens(hunk.insert.join("\n"))].filter((token) => !removed.has(token)));
  }

  /** The best text evidence any of the calls has for the hunk. */
  private evidence(calls: CallWindow[], hunk: { removed: string[]; insert: string[] }) {
    const fresh = this.fresh(hunk);
    let best = 0;
    for (const call of calls) {
      const { args } = this.tokensOf(call);
      let score = 0;
      for (const token of args) if (fresh.has(token)) score++;
      best = Math.max(best, score);
    }
    return best;
  }

  private score(candidates: CallWindow[], hunk: { removed: string[]; insert: string[] }): Cause {
    // Tokens of the hunk; names that appear only on the inserted side (new names,
    // moved text at its destination) are the strongest evidence.
    const inserted = tokens(hunk.insert.join("\n"));
    const removed = tokens(hunk.removed.join("\n"));
    const sets = candidates.map((call) => this.tokensOf(call));
    const spread = new Map<string, number>();
    for (const { args, output } of sets)
      for (const token of [...args, ...output]) spread.set(token, (spread.get(token) ?? 0) + 1);
    // Result text weighs little: an edit result echoes the edit but also its surroundings,
    // which other agents may be editing. Measured on two recorded runs against the task
    // that names each hunk's new identifiers: 0.1 settles the most hunks without errors.
    const scores = sets.map(({ args, output }) => {
      let score = 0;
      for (const [set, factor] of [
        [args, 1],
        [output, 0.1],
      ] as const)
        for (const token of set) {
          const weight = factor / (spread.get(token) ?? 1);
          if (inserted.has(token) && !removed.has(token)) score += 3 * weight;
          else if (inserted.has(token) || removed.has(token)) score += weight;
        }
      return score;
    });
    let bestIndex = -1;
    let bestScore = 0;
    let secondScore = 0;
    for (const [index, score] of scores.entries()) {
      if (bestIndex < 0 || score > bestScore) {
        if (bestIndex >= 0) secondScore = bestScore;
        bestIndex = index;
        bestScore = score;
      } else secondScore = Math.max(secondScore, score);
    }
    const list = candidates.map(({ agent, call }) => ({ agent, call }));
    const winner = candidates[bestIndex];
    if (winner && bestScore > 0 && bestScore >= 2 * secondScore)
      return { confidence: "matched", agent: winner.agent, call: winner.call, candidates: list };
    if (winner && bestScore > secondScore)
      return { confidence: "ambiguous", agent: winner.agent, call: winner.call, candidates: list };
    return { confidence: "ambiguous", candidates: list };
  }
}

/**
 * Settles ambiguous hunks with the other hunks of the same recorded version: the removed
 * half of a block move goes with the hunk that inserted the same text, and a hunk whose
 * candidates include the one call that made every settled hunk of the version goes to it.
 */
export function refineChange(hunks: Array<{ removed: string[]; insert: string[]; cause: Cause }>) {
  const settled = hunks.filter((hunk) => hunk.cause.confidence !== "ambiguous" && hunk.cause.call);
  if (!settled.length) return;
  const key = (lines: string[]) =>
    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  for (const hunk of hunks) {
    if (hunk.cause.confidence !== "ambiguous") continue;
    const candidates = hunk.cause.candidates ?? [];
    const removed = key(hunk.removed);
    const inserted = key(hunk.insert);
    const partner = settled.find((other) => {
      if (!candidates.some((candidate) => candidate.call === other.cause.call)) return false;
      if (removed.length > 20 && key(other.insert).includes(removed)) return true;
      return inserted.length > 20 && key(other.removed).includes(inserted);
    });
    const calls = new Set(settled.map((other) => other.cause.call));
    const only = calls.size === 1 ? settled[0]?.cause : undefined;
    const source =
      partner?.cause ??
      (only && candidates.some((candidate) => candidate.call === only.call) ? only : undefined);
    if (source)
      hunk.cause = { confidence: "matched", agent: source.agent, call: source.call, candidates };
  }
}
