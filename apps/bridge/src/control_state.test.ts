import assert from "node:assert/strict";
import test from "node:test";
import { decideControl, type ControlSnapshot } from "./control_state.js";

const idle: ControlSnapshot = { hasRun: false, phase: "idle" };
const running: ControlSnapshot = { hasRun: true, phase: "running" };
const paused: ControlSnapshot = { hasRun: true, phase: "paused" };

test("idle start creates a new run", () => {
  const decision = decideControl(idle, {
    type: "start",
    backend: "js",
    config: {
      width: 8,
      height: 8,
      wrapWorld: true,
      tickRateUi: 2,
      chunkTicks: 1,
      seed: 42,
      initMode: "single-block",
      initialAliveRatio: 0.2,
      reproThreshold: 3,
      constants: {
        maxEnergy10: 50,
        startEnergy10: 50,
        spawnEnergy10: 50,
        threatPenalty10: 10,
        allyBonus10: 0,
        preyBonus10: 0,
        agingDrain10: 1
      }
    }
  });
  assert.deepEqual(decision, { kind: "start_new" });
});

test("start while running is no-op", () => {
  const decision = decideControl(running, {
    type: "start",
    backend: "js",
    config: {
      width: 8,
      height: 8,
      wrapWorld: true,
      tickRateUi: 2,
      chunkTicks: 1,
      seed: 42,
      initMode: "single-block",
      initialAliveRatio: 0.2,
      reproThreshold: 3,
      constants: {
        maxEnergy10: 50,
        startEnergy10: 50,
        spawnEnergy10: 50,
        threatPenalty10: 10,
        allyBonus10: 0,
        preyBonus10: 0,
        agingDrain10: 1
      }
    }
  });
  assert.equal(decision.kind, "noop");
});

test("start while paused resumes", () => {
  const decision = decideControl(paused, {
    type: "start",
    backend: "js",
    config: {
      width: 8,
      height: 8,
      wrapWorld: true,
      tickRateUi: 2,
      chunkTicks: 1,
      seed: 42,
      initMode: "single-block",
      initialAliveRatio: 0.2,
      reproThreshold: 3,
      constants: {
        maxEnergy10: 50,
        startEnergy10: 50,
        spawnEnergy10: 50,
        threatPenalty10: 10,
        allyBonus10: 0,
        preyBonus10: 0,
        agingDrain10: 1
      }
    }
  });
  assert.deepEqual(decision, { kind: "resume" });
});

test("idle reset returns explicit error", () => {
  const decision = decideControl(idle, { type: "reset" });
  assert.equal(decision.kind, "error");
});

test("running reset is allowed", () => {
  const decision = decideControl(running, { type: "reset" });
  assert.deepEqual(decision, { kind: "reset" });
});

test("paused reset is allowed", () => {
  const decision = decideControl(paused, { type: "reset" });
  assert.deepEqual(decision, { kind: "reset" });
});

test("step requires run and normalizes ticks", () => {
  const noRun = decideControl(idle, { type: "step", ticks: 4 });
  assert.equal(noRun.kind, "error");

  const runningStep = decideControl(running, { type: "step", ticks: 0 });
  assert.deepEqual(runningStep, { kind: "step", ticks: 1 });
});
