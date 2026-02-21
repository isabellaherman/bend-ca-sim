import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSimConfig } from "@ca-sim/contracts";
import { ReferenceSimulator, createRuntimeContext, stepState, type SimStateSoA } from "./sim.js";

function emptyState(size: number): SimStateSoA {
  return {
    types: new Uint8Array(size),
    energy10: new Uint16Array(size),
    age: new Uint16Array(size)
  };
}

function countConnectedComponentsByType(state: SimStateSoA, neighbors: Uint32Array): Record<1 | 2 | 3, number> {
  const seen = new Uint8Array(state.types.length);
  const out: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  const stack: number[] = [];

  for (let idx = 0; idx < state.types.length; idx += 1) {
    const type = state.types[idx];
    if (type < 1 || type > 3 || seen[idx] === 1) {
      continue;
    }
    seen[idx] = 1;
    out[type as 1 | 2 | 3] += 1;
    stack.push(idx);

    while (stack.length > 0) {
      const current = stack.pop() ?? 0;
      const base = current * 8;
      for (let k = 0; k < 8; k += 1) {
        const next = neighbors[base + k] ?? current;
        if (seen[next] === 1 || state.types[next] !== type) {
          continue;
        }
        seen[next] = 1;
        stack.push(next);
      }
    }
  }

  return out;
}

function aliveFootprintSignature(state: SimStateSoA): string {
  let out = "";
  for (let i = 0; i < state.types.length; i += 1) {
    out += state.types[i] === 0 ? "0" : "1";
  }
  return out;
}

test("threat reduces energy and can kill", () => {
  const config = normalizeSimConfig({
    width: 3,
    height: 3,
    wrapWorld: false,
    reproThreshold: 8,
    constants: {
      maxEnergy10: 50,
      startEnergy10: 50,
      spawnEnergy10: 50,
      threatPenalty10: 10,
      allyBonus10: 0,
      preyBonus10: 0,
      agingDrain10: 1
    }
  });
  const size = config.width * config.height;
  const state = emptyState(size);
  const center = 4;
  state.types[center] = 1; // fire
  state.energy10[center] = 11;

  // 8 water neighbors around center (water beats fire).
  for (let i = 0; i < size; i += 1) {
    if (i === center) continue;
    state.types[i] = 2;
    state.energy10[i] = 50;
  }

  const runtime = createRuntimeContext(config);
  const next = stepState(state, config, runtime, 1);
  assert.equal(next.state.types[center], 0);
  assert.equal(next.state.energy10[center], 0);
  assert.equal(next.metrics.deaths >= 1, true);
});

test("birth in empty cell when threshold met", () => {
  const config = normalizeSimConfig({
    width: 3,
    height: 3,
    wrapWorld: false,
    reproThreshold: 2,
    constants: {
      spawnEnergy10: 50
    }
  });
  const size = config.width * config.height;
  const state = emptyState(size);
  const center = 4;
  state.types[1] = 1;
  state.types[3] = 1;
  state.types[5] = 1;

  const runtime = createRuntimeContext(config);
  const next = stepState(state, config, runtime, 1);
  assert.equal(next.state.types[center], 1);
  assert.equal(next.state.energy10[center], 50);
  assert.equal(next.state.age[center], 0);
});

test("alive cell ages and loses fixed 0.1 energy per tick", () => {
  const config = normalizeSimConfig({
    width: 3,
    height: 3,
    wrapWorld: false,
    reproThreshold: 8,
    constants: {
      maxEnergy10: 50,
      startEnergy10: 50,
      spawnEnergy10: 50,
      threatPenalty10: 0,
      allyBonus10: 0,
      preyBonus10: 0,
      agingDrain10: 99
    }
  });
  const size = config.width * config.height;
  const state = emptyState(size);
  const center = 4;
  state.types[center] = 1;
  state.energy10[center] = 5;
  state.age[center] = 7;

  const runtime = createRuntimeContext(config);
  const next = stepState(state, config, runtime, 1);
  assert.equal(next.state.types[center], 1);
  assert.equal(next.state.energy10[center], 4);
  assert.equal(next.state.age[center], 8);
});

test("alive cell dies when fixed 0.1 age drain reaches zero", () => {
  const config = normalizeSimConfig({
    width: 3,
    height: 3,
    wrapWorld: false,
    reproThreshold: 8,
    constants: {
      maxEnergy10: 50,
      startEnergy10: 50,
      spawnEnergy10: 50,
      threatPenalty10: 0,
      allyBonus10: 0,
      preyBonus10: 0,
      agingDrain10: 0
    }
  });
  const size = config.width * config.height;
  const state = emptyState(size);
  const center = 4;
  state.types[center] = 1;
  state.energy10[center] = 1;
  state.age[center] = 3;

  const runtime = createRuntimeContext(config);
  const next = stepState(state, config, runtime, 1);
  assert.equal(next.state.types[center], 0);
  assert.equal(next.state.energy10[center], 0);
  assert.equal(next.state.age[center], 0);
  assert.equal(next.metrics.deaths >= 1, true);
});

test("step result is identical even when config agingDrain10 differs", () => {
  const normalized = normalizeSimConfig({
    width: 5,
    height: 5,
    wrapWorld: false,
    reproThreshold: 8,
    constants: {
      maxEnergy10: 50,
      startEnergy10: 50,
      spawnEnergy10: 50,
      threatPenalty10: 0,
      allyBonus10: 0,
      preyBonus10: 0,
      agingDrain10: 1
    }
  });
  const configA = {
    ...normalized,
    constants: {
      ...normalized.constants,
      agingDrain10: 0
    }
  };
  const configB = {
    ...normalized,
    constants: {
      ...normalized.constants,
      agingDrain10: 9
    }
  };

  const size = normalized.width * normalized.height;
  const state = emptyState(size);
  const center = Math.floor(size / 2);
  state.types[center] = 1;
  state.energy10[center] = 5;

  const runtimeA = createRuntimeContext(configA);
  const runtimeB = createRuntimeContext(configB);
  const nextA = stepState(state, configA, runtimeA, 1);
  const nextB = stepState(state, configB, runtimeB, 1);

  assert.equal(nextA.digest, nextB.digest);
  assert.deepEqual(Array.from(nextA.state.types), Array.from(nextB.state.types));
  assert.deepEqual(Array.from(nextA.state.energy10), Array.from(nextB.state.energy10));
  assert.deepEqual(Array.from(nextA.state.age), Array.from(nextB.state.age));
});

test("same seed and config produce deterministic digest sequence", () => {
  const config = normalizeSimConfig({
    width: 32,
    height: 32,
    seed: 98765,
    initMode: "clustered"
  });
  const simA = new ReferenceSimulator(config);
  const simB = new ReferenceSimulator(config);

  for (let i = 0; i < 200; i += 1) {
    const a = simA.step();
    const b = simB.step();
    assert.equal(a.digest, b.digest);
  }
});

test("triad init mode starts with one connected group per type and mostly empty map", () => {
  const config = normalizeSimConfig({
    width: 128,
    height: 128,
    seed: 4242,
    initMode: "triad",
    initialAliveRatio: 0.02,
    reproThreshold: 4
  });
  const sim = new ReferenceSimulator(config);
  const state = sim.getState();
  const runtime = createRuntimeContext(config);
  const components = countConnectedComponentsByType(state, runtime.neighbors);
  const metrics = sim.getMetrics();

  assert.equal(components[1], 1);
  assert.equal(components[2], 1);
  assert.equal(components[3], 1);
  assert.equal(metrics.popEmpty > metrics.popFire + metrics.popWater + metrics.popGrass, true);
});

test("single-block init mode starts with up to 9 cells per type and all 3 types", () => {
  const config = normalizeSimConfig({
    width: 11,
    height: 11,
    seed: 12345,
    initMode: "single-block",
    constants: {
      startEnergy10: 50
    }
  });
  const sim = new ReferenceSimulator(config);
  const state = sim.getState();

  let aliveCount = 0;
  let fire = 0;
  let water = 0;
  let grass = 0;
  const bounds: Record<1 | 2 | 3, { minX: number; maxX: number; minY: number; maxY: number }> = {
    1: { minX: config.width, maxX: -1, minY: config.height, maxY: -1 },
    2: { minX: config.width, maxX: -1, minY: config.height, maxY: -1 },
    3: { minX: config.width, maxX: -1, minY: config.height, maxY: -1 }
  };
  for (let i = 0; i < state.types.length; i += 1) {
    if (state.types[i] !== 0) {
      aliveCount += 1;
      assert.equal(state.age[i], 0);
      assert.equal(state.energy10[i], config.constants.startEnergy10);
      const x = i % config.width;
      const y = Math.floor(i / config.width);
      if (state.types[i] === 1) fire += 1;
      if (state.types[i] === 2) water += 1;
      if (state.types[i] === 3) grass += 1;
      const type = state.types[i] as 1 | 2 | 3;
      const b = bounds[type];
      b.minX = Math.min(b.minX, x);
      b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y);
      b.maxY = Math.max(b.maxY, y);
    }
  }
  assert.equal(aliveCount, 27);
  assert.equal(fire, 9);
  assert.equal(water, 9);
  assert.equal(grass, 9);
  assert.equal(bounds[1].maxX - bounds[1].minX + 1, 3);
  assert.equal(bounds[1].maxY - bounds[1].minY + 1, 3);
  assert.equal(bounds[2].maxX - bounds[2].minX + 1, 3);
  assert.equal(bounds[2].maxY - bounds[2].minY + 1, 3);
  assert.equal(bounds[3].maxX - bounds[3].minX + 1, 3);
  assert.equal(bounds[3].maxY - bounds[3].minY + 1, 3);
});

test("single-block init mode footprint is deterministic per seed and changes across seeds", () => {
  const base = {
    width: 64,
    height: 64,
    initMode: "single-block" as const
  };
  const stateA = new ReferenceSimulator(
    normalizeSimConfig({
      ...base,
      seed: 12345
    })
  ).getState();
  const stateB = new ReferenceSimulator(
    normalizeSimConfig({
      ...base,
      seed: 12345
    })
  ).getState();
  const sameSeedFootprintA = aliveFootprintSignature(stateA);
  const sameSeedFootprintB = aliveFootprintSignature(stateB);
  assert.equal(sameSeedFootprintA, sameSeedFootprintB);

  const varied = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const state = new ReferenceSimulator(
      normalizeSimConfig({
        ...base,
        seed
      })
    ).getState();
    varied.add(aliveFootprintSignature(state));
  }
  assert.equal(varied.size > 1, true);
});

test("single-block init mode keeps type blocks separated on large grids", () => {
  const config = normalizeSimConfig({
    width: 128,
    height: 128,
    seed: 20260221,
    initMode: "single-block"
  });
  const state = new ReferenceSimulator(config).getState();
  const bounds: Record<1 | 2 | 3, { minX: number; maxX: number; minY: number; maxY: number }> = {
    1: { minX: config.width, maxX: -1, minY: config.height, maxY: -1 },
    2: { minX: config.width, maxX: -1, minY: config.height, maxY: -1 },
    3: { minX: config.width, maxX: -1, minY: config.height, maxY: -1 }
  };

  for (let i = 0; i < state.types.length; i += 1) {
    const type = state.types[i] as 1 | 2 | 3 | 0;
    if (type === 0) {
      continue;
    }
    const x = i % config.width;
    const y = Math.floor(i / config.width);
    const b = bounds[type];
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y);
    b.maxY = Math.max(b.maxY, y);
  }

  const centers = (Object.values(bounds) as Array<{ minX: number; maxX: number; minY: number; maxY: number }>).map((b) => ({
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2
  }));
  const minDistance = Math.max(8, Math.floor(Math.min(config.width, config.height) / 8));

  for (let i = 0; i < centers.length; i += 1) {
    for (let j = i + 1; j < centers.length; j += 1) {
      const dx = (centers[i]?.x ?? 0) - (centers[j]?.x ?? 0);
      const dy = (centers[i]?.y ?? 0) - (centers[j]?.y ?? 0);
      assert.equal(Math.hypot(dx, dy) >= minDistance, true);
    }
  }
});

test("single-block grows with repro threshold 3", () => {
  const config = normalizeSimConfig({
    width: 64,
    height: 64,
    seed: 999,
    initMode: "single-block",
    reproThreshold: 3
  });
  const sim = new ReferenceSimulator(config);

  let births = 0;
  for (let i = 0; i < 5; i += 1) {
    births += sim.step().metrics.births;
  }
  assert.equal(births > 0, true);
});

test("single-block does not grow with repro threshold 4 in early ticks", () => {
  const config = normalizeSimConfig({
    width: 64,
    height: 64,
    seed: 999,
    initMode: "single-block",
    reproThreshold: 4
  });
  const sim = new ReferenceSimulator(config);

  let births = 0;
  for (let i = 0; i < 5; i += 1) {
    births += sim.step().metrics.births;
  }
  assert.equal(births, 0);
});

test("single-block mode is deterministic for same seed and config", () => {
  const config = normalizeSimConfig({
    width: 64,
    height: 64,
    seed: 777,
    initMode: "single-block",
    reproThreshold: 3
  });
  const simA = new ReferenceSimulator(config);
  const simB = new ReferenceSimulator(config);

  for (let i = 0; i < 120; i += 1) {
    assert.equal(simA.step().digest, simB.step().digest);
  }
});
