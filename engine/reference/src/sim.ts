import {
  DEFAULT_SIM_CONFIG,
  TYPE_EMPTY,
  TYPE_FIRE,
  TYPE_GRASS,
  TYPE_WATER,
  type FrameMessage,
  type FrameMetrics,
  type SimConfig,
  type TypeCode
} from "@ca-sim/contracts";
import { encodeUint16ToBase64, encodeUint8ToBase64 } from "./encode.js";
import { digestStateHex, hashChoice, hashU24Mod } from "./hash.js";
import { precomputeNeighbors } from "./neighbors.js";

export interface SimStateSoA {
  types: Uint8Array;
  energy10: Uint16Array;
  age: Uint16Array;
}

export interface RuntimeContext {
  neighbors: Uint32Array;
  size: number;
}

export interface TickResult {
  state: SimStateSoA;
  metrics: FrameMetrics;
  digest: string;
}

const FIXED_AGING_DRAIN10 = 1;

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isAlive(type: TypeCode): boolean {
  return type !== TYPE_EMPTY;
}

function beats(attacker: TypeCode, defender: TypeCode): boolean {
  return (
    (attacker === TYPE_WATER && defender === TYPE_FIRE) ||
    (attacker === TYPE_FIRE && defender === TYPE_GRASS) ||
    (attacker === TYPE_GRASS && defender === TYPE_WATER)
  );
}

function pickTypeFromCounts(
  c1: number,
  c2: number,
  c3: number,
  reproThreshold: number,
  seed: number,
  tick: number,
  idx: number
): TypeCode {
  const eligible: TypeCode[] = [];
  if (c1 >= reproThreshold) {
    eligible.push(TYPE_FIRE);
  }
  if (c2 >= reproThreshold) {
    eligible.push(TYPE_WATER);
  }
  if (c3 >= reproThreshold) {
    eligible.push(TYPE_GRASS);
  }
  if (eligible.length === 0) {
    return TYPE_EMPTY;
  }
  if (eligible.length === 1) {
    return eligible[0] ?? TYPE_EMPTY;
  }

  let maxCount = -1;
  const leaders: TypeCode[] = [];
  for (const type of eligible) {
    const count = type === TYPE_FIRE ? c1 : type === TYPE_WATER ? c2 : c3;
    if (count > maxCount) {
      maxCount = count;
      leaders.length = 0;
      leaders.push(type);
      continue;
    }
    if (count === maxCount) {
      leaders.push(type);
    }
  }
  if (leaders.length === 1) {
    return leaders[0] ?? TYPE_EMPTY;
  }
  const pick = hashChoice(seed, tick, idx, 17, leaders.length);
  return leaders[pick] ?? TYPE_EMPTY;
}

export function createRuntimeContext(config: SimConfig): RuntimeContext {
  const neighbors = precomputeNeighbors(config);
  return {
    neighbors,
    size: config.width * config.height
  };
}

function chooseClusterType(seed: number, clusterX: number, clusterY: number): TypeCode {
  const value = hashChoice(seed, clusterX, clusterY, 31337, 3) + 1;
  return value as TypeCode;
}

type TriadCenter = {
  x: number;
  y: number;
  type: TypeCode;
};

function centerWithJitter(
  seed: number,
  size: number,
  base10k: number,
  jitter: number,
  streamA: number,
  streamB: number
): number {
  const base = Math.floor(((size - 1) * base10k) / 10_000);
  if (jitter <= 0) {
    return base;
  }
  const spread = jitter * 2 + 1;
  const offset = hashU24Mod(seed, streamA, streamB, size, spread) - jitter;
  return clampInt(base + offset, 0, size - 1);
}

function createTriadCenters(width: number, height: number, seed: number): TriadCenter[] {
  const jitterX = Math.max(1, Math.floor(width * 0.06));
  const jitterY = Math.max(1, Math.floor(height * 0.06));
  return [
    {
      type: TYPE_FIRE,
      x: centerWithJitter(seed, width, 2200, jitterX, 101, 211),
      y: centerWithJitter(seed, height, 2400, jitterY, 103, 223)
    },
    {
      type: TYPE_WATER,
      x: centerWithJitter(seed, width, 7800, jitterX, 107, 227),
      y: centerWithJitter(seed, height, 2400, jitterY, 109, 229)
    },
    {
      type: TYPE_GRASS,
      x: centerWithJitter(seed, width, 5000, jitterX, 113, 233),
      y: centerWithJitter(seed, height, 7600, jitterY, 127, 239)
    }
  ];
}

function createTriadInitialState(config: SimConfig): SimStateSoA {
  const size = config.width * config.height;
  const types = new Uint8Array(size);
  const energy10 = new Uint16Array(size);
  const age = new Uint16Array(size);
  const targetAlive = clampInt(Math.floor(config.initialAliveRatio * size), 0, size);
  if (targetAlive === 0) {
    return { types, energy10, age };
  }

  const targets = [
    Math.floor(targetAlive / 3),
    Math.floor(targetAlive / 3),
    Math.floor(targetAlive / 3)
  ];
  for (let i = 0; i < targetAlive % 3; i += 1) {
    targets[i] = (targets[i] ?? 0) + 1;
  }

  const centers = createTriadCenters(config.width, config.height, config.seed);
  for (let i = 0; i < centers.length; i += 1) {
    const center = centers[i];
    const type = center?.type ?? TYPE_EMPTY;
    const limit = targets[i] ?? 0;
    if (type === TYPE_EMPTY || limit <= 0) {
      continue;
    }

    const candidates: Array<{ idx: number; score: number }> = [];
    for (let idx = 0; idx < size; idx += 1) {
      const x = idx % config.width;
      const y = Math.floor(idx / config.width);
      const dx = x - center.x;
      const dy = y - center.y;
      const d2 = dx * dx + dy * dy;
      const tie = hashU24Mod(config.seed, idx, i + 1, 977, 1024);
      candidates.push({ idx, score: d2 * 1024 + tie });
    }
    candidates.sort((a, b) => a.score - b.score);

    let placed = 0;
    for (const candidate of candidates) {
      if (types[candidate.idx] !== TYPE_EMPTY) {
        continue;
      }
      types[candidate.idx] = type;
      energy10[candidate.idx] = config.constants.startEnergy10;
      placed += 1;
      if (placed >= limit) {
        break;
      }
    }
  }

  return { types, energy10, age };
}

function createSingleBlockInitialState(config: SimConfig): SimStateSoA {
  const size = config.width * config.height;
  const types = new Uint8Array(size);
  const energy10 = new Uint16Array(size);
  const age = new Uint16Array(size);
  const typeCycle: readonly TypeCode[] = [TYPE_FIRE, TYPE_WATER, TYPE_GRASS];
  const rotation = hashChoice(config.seed, config.width, config.height, 911, 3);
  const rotated: TypeCode[] = [
    typeCycle[rotation % 3] ?? TYPE_FIRE,
    typeCycle[(rotation + 1) % 3] ?? TYPE_WATER,
    typeCycle[(rotation + 2) % 3] ?? TYPE_GRASS
  ];
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };

  const paintBlock = (cx: number, cy: number, type: TypeCode): void => {
    for (let y = cy - 1; y <= cy + 1; y += 1) {
      if (y < 0 || y >= config.height) {
        continue;
      }
      for (let x = cx - 1; x <= cx + 1; x += 1) {
        if (x < 0 || x >= config.width) {
          continue;
        }
        const idx = y * config.width + x;
        if (types[idx] !== TYPE_EMPTY) {
          continue;
        }
        types[idx] = type;
        energy10[idx] = config.constants.startEnergy10;
        age[idx] = 0;
        counts[type] = (counts[type] ?? 0) + 1;
      }
    }
  };

  const minCenterX = 1;
  const maxCenterX = config.width - 2;
  const minCenterY = 1;
  const maxCenterY = config.height - 2;
  if (minCenterX <= maxCenterX && minCenterY <= maxCenterY) {
    const rangeX = maxCenterX - minCenterX + 1;
    const rangeY = maxCenterY - minCenterY + 1;
    const area = rangeX * rangeY;
    const minDimension = Math.min(config.width, config.height);
    const desiredMinDistance = Math.max(6, Math.floor(minDimension / 4));
    const separationCandidates = [
      desiredMinDistance,
      Math.floor(desiredMinDistance * 0.75),
      Math.floor(desiredMinDistance * 0.5),
      3,
      0
    ].filter((value, index, arr) => value >= 0 && arr.indexOf(value) === index);
    const centers: Array<{ x: number; y: number; type: TypeCode }> = [];
    let placedAllBlocks = false;

    for (const minDistance of separationCandidates) {
      centers.length = 0;
      let failed = false;
      for (let i = 0; i < rotated.length; i += 1) {
        const type = rotated[i] ?? TYPE_EMPTY;
        if (type === TYPE_EMPTY) {
          continue;
        }
        let placed = false;
        for (let attempt = 0; attempt < 512; attempt += 1) {
          const stream = i * 1009 + attempt + 1;
          const centerX = minCenterX + hashU24Mod(config.seed, type, stream, 947, rangeX);
          const centerY = minCenterY + hashU24Mod(config.seed, type, stream, 953, rangeY);
          const overlaps = centers.some((center) => Math.abs(center.x - centerX) <= 2 && Math.abs(center.y - centerY) <= 2);
          if (overlaps) {
            continue;
          }
          const tooClose = centers.some((center) => {
            const dx = center.x - centerX;
            const dy = center.y - centerY;
            return Math.hypot(dx, dy) < minDistance;
          });
          if (tooClose) {
            continue;
          }
          centers.push({ x: centerX, y: centerY, type });
          placed = true;
          break;
        }

        if (placed) {
          continue;
        }

        const start = hashU24Mod(config.seed, type, i + 1, 971, area);
        for (let offset = 0; offset < area; offset += 1) {
          const flat = (start + offset) % area;
          const x = minCenterX + (flat % rangeX);
          const y = minCenterY + Math.floor(flat / rangeX);
          const overlaps = centers.some((center) => Math.abs(center.x - x) <= 2 && Math.abs(center.y - y) <= 2);
          if (overlaps) {
            continue;
          }
          const tooClose = centers.some((center) => {
            const dx = center.x - x;
            const dy = center.y - y;
            return Math.hypot(dx, dy) < minDistance;
          });
          if (tooClose) {
            continue;
          }
          centers.push({ x, y, type });
          placed = true;
          break;
        }

        if (!placed) {
          failed = true;
          break;
        }
      }

      if (failed) {
        continue;
      }
      placedAllBlocks = true;
      break;
    }

    if (placedAllBlocks) {
      for (const center of centers) {
        paintBlock(center.x, center.y, center.type);
      }
    }
  }

  // Tiny-grid fallback: guarantee at least one cell per type when possible.
  for (const type of rotated) {
    if ((counts[type] ?? 0) > 0) {
      continue;
    }
    const start = hashU24Mod(config.seed, type, size, 977, size);
    for (let offset = 0; offset < size; offset += 1) {
      const idx = (start + offset) % size;
      if (types[idx] !== TYPE_EMPTY) {
        continue;
      }
      types[idx] = type;
      energy10[idx] = config.constants.startEnergy10;
      age[idx] = 0;
      counts[type] = 1;
      break;
    }
  }

  return { types, energy10, age };
}

export function createInitialState(config: SimConfig): SimStateSoA {
  if (config.initMode === "single-block") {
    return createSingleBlockInitialState(config);
  }
  if (config.initMode === "triad") {
    return createTriadInitialState(config);
  }
  const size = config.width * config.height;
  const types = new Uint8Array(size);
  const energy10 = new Uint16Array(size);
  const age = new Uint16Array(size);
  const {
    width,
    seed,
    initMode,
    initialAliveRatio,
    constants: { startEnergy10 }
  } = config;

  const clusterSize = 8;
  const aliveRatio10k = clampInt(Math.floor(initialAliveRatio * 10_000), 0, 10_000);
  for (let idx = 0; idx < size; idx += 1) {
    const x = idx % width;
    const y = Math.floor(idx / width);
    let aliveChance10k = aliveRatio10k;
    let cellType: TypeCode = TYPE_EMPTY;

    if (initMode === "clustered") {
      const clusterX = Math.floor(x / clusterSize);
      const clusterY = Math.floor(y / clusterSize);
      cellType = chooseClusterType(seed, clusterX, clusterY);
      const clusterBias10k = 6_000 + hashU24Mod(seed, clusterX, clusterY, 91, 8_001); // [6000..14000]
      aliveChance10k = clampInt((aliveRatio10k * clusterBias10k) / 10_000, 0, 10_000);
    } else {
      const nextType = (hashChoice(seed, idx, 73, 11, 3) + 1) as TypeCode;
      cellType = nextType;
    }

    const roll10k = hashU24Mod(seed, idx, 19, 7, 10_000);
    if (roll10k < aliveChance10k) {
      types[idx] = cellType;
      energy10[idx] = startEnergy10;
      age[idx] = 0;
      continue;
    }

    types[idx] = TYPE_EMPTY;
    energy10[idx] = 0;
    age[idx] = 0;
  }

  return { types, energy10, age };
}

export function cloneState(state: SimStateSoA): SimStateSoA {
  return {
    types: new Uint8Array(state.types),
    energy10: new Uint16Array(state.energy10),
    age: new Uint16Array(state.age)
  };
}

export function computeMetrics(state: SimStateSoA, births = 0, deaths = 0): FrameMetrics {
  let popEmpty = 0;
  let popFire = 0;
  let popWater = 0;
  let popGrass = 0;
  let totalEnergy = 0;
  let totalAge = 0;
  let alive = 0;

  for (let i = 0; i < state.types.length; i += 1) {
    const type = state.types[i] as TypeCode;
    if (type === TYPE_EMPTY) {
      popEmpty += 1;
      continue;
    }
    alive += 1;
    totalEnergy += state.energy10[i] ?? 0;
    totalAge += state.age[i] ?? 0;
    if (type === TYPE_FIRE) {
      popFire += 1;
    } else if (type === TYPE_WATER) {
      popWater += 1;
    } else {
      popGrass += 1;
    }
  }

  return {
    popEmpty,
    popFire,
    popWater,
    popGrass,
    births,
    deaths,
    meanEnergy10: alive === 0 ? 0 : Math.round(totalEnergy / alive),
    meanAge: alive === 0 ? 0 : Number((totalAge / alive).toFixed(2))
  };
}

export function digestState(state: SimStateSoA): string {
  return digestStateHex(state.types, state.energy10, state.age);
}

export function stepState(
  current: SimStateSoA,
  config: SimConfig,
  context: RuntimeContext,
  tick: number
): TickResult {
  const { size, neighbors } = context;
  const nextTypes = new Uint8Array(size);
  const nextEnergy10 = new Uint16Array(size);
  const nextAge = new Uint16Array(size);

  let births = 0;
  let deaths = 0;

  const maxEnergy10 = config.constants.maxEnergy10;

  for (let idx = 0; idx < size; idx += 1) {
    const type = current.types[idx] as TypeCode;
    const base = idx * 8;

    if (!isAlive(type)) {
      let c1 = 0;
      let c2 = 0;
      let c3 = 0;

      for (let k = 0; k < 8; k += 1) {
        const neighborIdx = neighbors[base + k] ?? idx;
        const neighborType = current.types[neighborIdx] as TypeCode;
        if (neighborType === TYPE_FIRE) {
          c1 += 1;
        } else if (neighborType === TYPE_WATER) {
          c2 += 1;
        } else if (neighborType === TYPE_GRASS) {
          c3 += 1;
        }
      }

      const spawnType = pickTypeFromCounts(c1, c2, c3, config.reproThreshold, config.seed, tick, idx);
      if (spawnType === TYPE_EMPTY) {
        nextTypes[idx] = TYPE_EMPTY;
        nextEnergy10[idx] = 0;
        nextAge[idx] = 0;
        continue;
      }

      nextTypes[idx] = spawnType;
      nextEnergy10[idx] = clampInt(config.constants.spawnEnergy10, 0, maxEnergy10);
      nextAge[idx] = 0;
      births += 1;
      continue;
    }

    let threats = 0;
    let allies = 0;
    let prey = 0;
    for (let k = 0; k < 8; k += 1) {
      const neighborIdx = neighbors[base + k] ?? idx;
      const neighborType = current.types[neighborIdx] as TypeCode;
      if (!isAlive(neighborType)) {
        continue;
      }
      if (neighborType === type) {
        allies += 1;
        continue;
      }
      if (beats(neighborType, type)) {
        threats += 1;
        continue;
      }
      if (beats(type, neighborType)) {
        prey += 1;
      }
    }

    const delta10 =
      threats * -config.constants.threatPenalty10 +
      allies * config.constants.allyBonus10 +
      prey * config.constants.preyBonus10 -
      FIXED_AGING_DRAIN10;

    const currentEnergy = current.energy10[idx] ?? 0;
    const nextEnergy = clampInt(currentEnergy + delta10, 0, maxEnergy10);
    if (nextEnergy <= 0) {
      nextTypes[idx] = TYPE_EMPTY;
      nextEnergy10[idx] = 0;
      nextAge[idx] = 0;
      deaths += 1;
      continue;
    }

    nextTypes[idx] = type;
    nextEnergy10[idx] = nextEnergy;
    nextAge[idx] = (current.age[idx] ?? 0) + 1;
  }

  const state: SimStateSoA = {
    types: nextTypes,
    energy10: nextEnergy10,
    age: nextAge
  };
  return {
    state,
    metrics: computeMetrics(state, births, deaths),
    digest: digestState(state)
  };
}

export function buildFrame(
  runId: string,
  backend: "js" | "bend-rs" | "bend-c",
  tick: number,
  digest: string,
  metrics: FrameMetrics,
  state: SimStateSoA,
  includeState: boolean
): FrameMessage {
  const frame: FrameMessage = {
    runId,
    backend,
    tick,
    digest,
    metrics
  };
  if (includeState) {
    frame.state = {
      types: encodeUint8ToBase64(state.types),
      energy10: encodeUint16ToBase64(state.energy10),
      age: encodeUint16ToBase64(state.age)
    };
  }
  return frame;
}

export class ReferenceSimulator {
  private readonly config: SimConfig;
  private readonly context: RuntimeContext;
  private state: SimStateSoA;
  private tick = 0;

  constructor(config: SimConfig = DEFAULT_SIM_CONFIG) {
    this.config = config;
    this.context = createRuntimeContext(config);
    this.state = createInitialState(config);
  }

  getConfig(): SimConfig {
    return this.config;
  }

  getTick(): number {
    return this.tick;
  }

  getState(): SimStateSoA {
    return cloneState(this.state);
  }

  getDigest(): string {
    return digestState(this.state);
  }

  getMetrics(): FrameMetrics {
    return computeMetrics(this.state, 0, 0);
  }

  step(): TickResult {
    const nextTick = this.tick + 1;
    const result = stepState(this.state, this.config, this.context, nextTick);
    this.state = result.state;
    this.tick = nextTick;
    return result;
  }

  stepMany(count: number): TickResult[] {
    const safeCount = clampInt(count, 1, 1_000_000);
    const out: TickResult[] = [];
    for (let i = 0; i < safeCount; i += 1) {
      out.push(this.step());
    }
    return out;
  }
}
