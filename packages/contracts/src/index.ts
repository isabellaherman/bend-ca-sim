export type TypeCode = 0 | 1 | 2 | 3;
export type InitMode = "random" | "clustered" | "triad" | "single-block";
export type EngineBackend = "js" | "bend-rs" | "bend-c";
export type RunPhase = "idle" | "running" | "paused";

export interface SimConstants {
  maxEnergy10: number;
  startEnergy10: number;
  spawnEnergy10: number;
  threatPenalty10: number;
  allyBonus10: number;
  preyBonus10: number;
  agingDrain10: number;
}

export interface SimConfig {
  width: number;
  height: number;
  wrapWorld: boolean;
  tickRateUi: number;
  chunkTicks: number;
  seed: number;
  initMode: InitMode;
  initialAliveRatio: number;
  reproThreshold: number;
  constants: SimConstants;
}

export type PartialSimConfig = Partial<Omit<SimConfig, "constants">> & {
  constants?: Partial<SimConstants>;
};

export interface FrameMetrics {
  popEmpty: number;
  popFire: number;
  popWater: number;
  popGrass: number;
  births: number;
  deaths: number;
  meanEnergy10: number;
  meanAge: number;
}

export interface FrameStatePayload {
  types: string;
  energy10: string;
  age: string;
}

export interface FrameMessage {
  runId: string;
  tick: number;
  digest: string;
  backend: EngineBackend;
  metrics: FrameMetrics;
  state?: FrameStatePayload;
}

export type ControlMessage =
  | { type: "start"; config: SimConfig; backend?: EngineBackend }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "step"; ticks?: number }
  | { type: "reset"; seed?: number; config?: PartialSimConfig }
  | { type: "stop" };

export interface BridgeInfoMessage {
  type: "info";
  message: string;
}

export interface BridgeErrorMessage {
  type: "error";
  message: string;
}

export interface BridgeStateMessage {
  type: "state";
  phase: RunPhase;
  hasRun: boolean;
  runId: string | null;
  tick: number;
  backend: EngineBackend | null;
  seed: number | null;
}

export type BridgeServerMessage =
  | { type: "frame"; frame: FrameMessage }
  | BridgeStateMessage
  | BridgeInfoMessage
  | BridgeErrorMessage;

export const TYPE_EMPTY: TypeCode = 0;
export const TYPE_FIRE: TypeCode = 1;
export const TYPE_WATER: TypeCode = 2;
export const TYPE_GRASS: TypeCode = 3;

export const DEFAULT_CONSTANTS: SimConstants = {
  maxEnergy10: 50,
  startEnergy10: 50,
  spawnEnergy10: 50,
  threatPenalty10: 10,
  allyBonus10: 0,
  preyBonus10: 0,
  agingDrain10: 1
};

export const DEFAULT_SIM_CONFIG: SimConfig = {
  width: 128,
  height: 128,
  wrapWorld: true,
  tickRateUi: 2,
  chunkTicks: 1,
  seed: 42,
  initMode: "single-block",
  initialAliveRatio: 0.2,
  reproThreshold: 3,
  constants: DEFAULT_CONSTANTS
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positiveInt(value: number, fallback: number): number {
  const next = Number.isFinite(value) ? Math.floor(value) : fallback;
  return next > 0 ? next : fallback;
}

function boundedInt(value: number, min: number, max: number, fallback: number): number {
  return Math.floor(clampNumber(Number.isFinite(value) ? value : fallback, min, max));
}

function normalizeInitMode(value: unknown, fallback: InitMode): InitMode {
  return value === "random" || value === "clustered" || value === "triad" || value === "single-block"
    ? value
    : fallback;
}

export function normalizeSimConfig(input?: PartialSimConfig): SimConfig {
  const source = input ?? {};
  const constantsSource = source.constants ?? {};
  const fixedAgingDrain10 = DEFAULT_CONSTANTS.agingDrain10;

  const constants: SimConstants = {
    maxEnergy10: boundedInt(
      constantsSource.maxEnergy10 ?? DEFAULT_CONSTANTS.maxEnergy10,
      1,
      10_000,
      DEFAULT_CONSTANTS.maxEnergy10
    ),
    startEnergy10: boundedInt(
      constantsSource.startEnergy10 ?? DEFAULT_CONSTANTS.startEnergy10,
      0,
      10_000,
      DEFAULT_CONSTANTS.startEnergy10
    ),
    spawnEnergy10: boundedInt(
      constantsSource.spawnEnergy10 ?? DEFAULT_CONSTANTS.spawnEnergy10,
      0,
      10_000,
      DEFAULT_CONSTANTS.spawnEnergy10
    ),
    threatPenalty10: boundedInt(
      constantsSource.threatPenalty10 ?? DEFAULT_CONSTANTS.threatPenalty10,
      0,
      10_000,
      DEFAULT_CONSTANTS.threatPenalty10
    ),
    allyBonus10: boundedInt(
      constantsSource.allyBonus10 ?? DEFAULT_CONSTANTS.allyBonus10,
      0,
      10_000,
      DEFAULT_CONSTANTS.allyBonus10
    ),
    preyBonus10: boundedInt(
      constantsSource.preyBonus10 ?? DEFAULT_CONSTANTS.preyBonus10,
      0,
      10_000,
      DEFAULT_CONSTANTS.preyBonus10
    ),
    // Aging drain is a fixed simulation rule (0.1 energy per alive tick).
    agingDrain10: fixedAgingDrain10
  };

  const maxEnergy10 = constants.maxEnergy10;
  constants.startEnergy10 = clampNumber(constants.startEnergy10, 0, maxEnergy10);
  constants.spawnEnergy10 = clampNumber(constants.spawnEnergy10, 0, maxEnergy10);

  return {
    width: positiveInt(source.width ?? DEFAULT_SIM_CONFIG.width, DEFAULT_SIM_CONFIG.width),
    height: positiveInt(source.height ?? DEFAULT_SIM_CONFIG.height, DEFAULT_SIM_CONFIG.height),
    wrapWorld: source.wrapWorld ?? DEFAULT_SIM_CONFIG.wrapWorld,
    tickRateUi: clampNumber(source.tickRateUi ?? DEFAULT_SIM_CONFIG.tickRateUi, 1, 5),
    chunkTicks: boundedInt(source.chunkTicks ?? DEFAULT_SIM_CONFIG.chunkTicks, 1, 16, DEFAULT_SIM_CONFIG.chunkTicks),
    seed: positiveInt(source.seed ?? DEFAULT_SIM_CONFIG.seed, DEFAULT_SIM_CONFIG.seed),
    initMode: normalizeInitMode(source.initMode, DEFAULT_SIM_CONFIG.initMode),
    initialAliveRatio: clampNumber(source.initialAliveRatio ?? DEFAULT_SIM_CONFIG.initialAliveRatio, 0, 1),
    reproThreshold: boundedInt(source.reproThreshold ?? DEFAULT_SIM_CONFIG.reproThreshold, 1, 8, DEFAULT_SIM_CONFIG.reproThreshold),
    constants
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}
