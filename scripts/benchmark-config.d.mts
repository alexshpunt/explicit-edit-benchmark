export interface BenchmarkModel {
  thinking: string;
  family: string;
  version: string;
  provider?: string;
  selectors?: Record<string, string>;
  [key: string]: unknown;
}

export interface BenchmarkAdapter {
  kind: string;
  command: string;
  args: string[];
  version: string;
  model: string;
  thinking: string;
  ready: boolean;
  agentFamily: string;
  agentVersion: string;
  modelFamily: string;
  modelVersion: string;
  provider: string | null;
  harnessFamily: string;
  adapterVersion: string;
  configurationLabels: string[];
  configurationId?: string;
  configuration: {
    tools: string[];
    extensions: string[];
    rules: string[];
    runtimeFlags: string[];
    environment: string[];
  };
  [key: string]: unknown;
}

export interface HarnessContext<Model extends BenchmarkModel = BenchmarkModel> {
  model: Model;
  modelId: string;
  harnessId: string;
  profileId: string;
  overrides: Record<string, unknown>;
}

export interface HarnessMetrics {
  calls: unknown[] | null;
  toolCalls: number | null;
  modelRounds: number | null;
  errors: unknown[];
  eventCount?: number;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalTokens?: number | null;
  failedToolCalls?: number | null;
  invalidToolCalls?: number | null;
}

export interface HarnessDefinition<Model extends BenchmarkModel = BenchmarkModel> {
  createAdapter(context: HarnessContext<Model>): BenchmarkAdapter | Promise<BenchmarkAdapter>;
  inspectOutput?(file: string): HarnessMetrics | Promise<HarnessMetrics>;
  continueSession?(adapter: ResolvedBenchmarkAdapter, context?: unknown): BenchmarkAdapter;
}

export interface MatrixBlock {
  models: string[];
  harnesses: string[];
}

export interface BenchmarkPair {
  model: string;
  harness: string;
  profile?: string;
  overrides?: Record<string, unknown>;
}

export interface BenchmarkConfig {
  models: Record<string, BenchmarkModel>;
  harnesses: Record<string, HarnessDefinition>;
  selection: {
    matrix?: MatrixBlock[];
    pairs?: BenchmarkPair[];
  };
}

export interface ResolvedBenchmarkAdapter extends BenchmarkAdapter {
  profileId: string;
  modelId: string;
  harnessId: string;
  inspectOutput?: HarnessDefinition["inspectOutput"];
  continueSession?: HarnessDefinition["continueSession"];
}

export interface BuiltInHarnessOptions {
  harness: string;
  selector?: string;
  command: string;
  version: string;
  agentFamily: string;
  agentVersion: string;
  harnessFamily: string;
  adapterVersion: string;
  configurationLabels: string[];
  [key: string]: unknown;
}

export function builtInHarness(options: BuiltInHarnessOptions): HarnessDefinition;
export function defineBenchmarkConfig<Config extends BenchmarkConfig>(config: Config): Config;
export function defineHarness<Model extends BenchmarkModel>(
  definition: HarnessDefinition<Model>,
): HarnessDefinition<Model>;
export function resolveBenchmarkProfiles(
  config: BenchmarkConfig,
): Promise<Record<string, ResolvedBenchmarkAdapter>>;
export function loadBenchmarkProfiles(
  file: string,
): Promise<
  Record<
    string,
    BenchmarkAdapter &
      Partial<Pick<ResolvedBenchmarkAdapter, "profileId" | "modelId" | "harnessId">> &
      Pick<ResolvedBenchmarkAdapter, "inspectOutput" | "continueSession">
  >
>;
