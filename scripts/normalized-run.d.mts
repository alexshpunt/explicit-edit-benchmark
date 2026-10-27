export interface NormalizedToolEvent {
  ordinal: number;
  tool: string;
  category: string;
  outcome: "completed" | "error" | null;
  commandFeatures: string[];
}

/** Fixed maximal-team workload and safe per-profile wall-clock observations. */
export interface NormalizedTeamSuite {
  id: string;
  protocol: string;
  agents: 15;
  graphWidth: 15;
  workloadSha256: string;
  graphSha256: string;
  scheduleSha256: string;
  schedule: Array<{
    id: string;
    assignments: Array<{ task: string; agent: number; zone?: string; slot?: number }>;
  }>;
  observations: Array<{
    profileId: string;
    status:
      | "pass"
      | "blocked"
      | "provider_failure"
      | "driver_exit"
      | "infrastructure"
      | "cancelled"
      | "timeout";
    elapsedMs: number;
    terminalCategory: string | null;
  }>;
}

/** Restoring scores retain full planned round maxima, first and final evidence. */
export interface NormalizedRestoringTeamSuite extends Omit<
  NormalizedTeamSuite,
  "agents" | "graphWidth" | "observations"
> {
  agents: number;
  graphWidth: number;
  batchSize: number;
  policy: Record<string, unknown>;
  plannedAtoms: Array<{ round: string; totalAtoms: number }>;
  observations: Array<{
    profileId: string;
    result: {
      protocol: string;
      status: "complete" | "driver_exit" | "infrastructure" | "cancelled";
      identity: Record<string, string | null>;
      score: { first: { score: number }; final: { score: number } };
      [key: string]: unknown;
    };
  }>;
}
export interface NormalizedRunManifest {
  schemaVersion: 1 | 2 | 3 | 4;
  suite?: NormalizedTeamSuite | NormalizedRestoringTeamSuite;
  runId: string;
  contract: unknown;
  taskSetSha256: string;
  verifierSha256?: unknown;
  sourceRuns?: Array<{ runId: string }>;
  policy: {
    oracleRecoveries: unknown;
    retryFailures: unknown;
    concurrency: unknown;
    timeoutMs: unknown;
  };
  counts: {
    profiles: number;
    configurations: number;
    trials: number;
    rounds: number;
    toolCalls: number;
  };
  completeness: {
    eofClassification: "complete" | "partial";
    unknownDifferences: number;
    toolCallCoverage: "complete" | "partial";
    unobservedToolCallRounds: number;
  };
  files: Record<string, { bytes: number; sha256: string }>;
}

/** Reject adapters that cannot produce a canonical public identity. */
export function assertNormalizedIdentity(adapter: Record<string, unknown>, label?: string): void;

/** Convert one harness-native tool event into a safe fact without raw arguments. */
export function normalizeToolEvent(raw: unknown, ordinal: number): NormalizedToolEvent;

export interface NormalizedRunExportOptions {
  profileIdentity?: (
    profileId: string,
    adapter: Record<string, unknown>,
    manifest: Record<string, unknown>,
  ) => Record<string, unknown>;
  historicalMetrics?: boolean;
}

/** Export safe versioned identities and observed efficiency facts needed for analysis. */
export function exportNormalizedRun(
  rootDirectory: string,
  outputDirectory: string,
  options?: NormalizedRunExportOptions,
): Promise<NormalizedRunManifest>;
