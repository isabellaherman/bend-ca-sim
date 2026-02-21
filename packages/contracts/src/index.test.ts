import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SIM_CONFIG, normalizeSimConfig } from "./index.js";

test("default sim config matches slow RTS baseline", () => {
  assert.equal(DEFAULT_SIM_CONFIG.tickRateUi, 2);
  assert.equal(DEFAULT_SIM_CONFIG.chunkTicks, 1);
  assert.equal(DEFAULT_SIM_CONFIG.initMode, "single-block");
  assert.equal(DEFAULT_SIM_CONFIG.initialAliveRatio, 0.2);
  assert.equal(DEFAULT_SIM_CONFIG.reproThreshold, 3);
});

test("tick rate normalization clamps to 1..5", () => {
  assert.equal(normalizeSimConfig({ tickRateUi: 0 }).tickRateUi, 1);
  assert.equal(normalizeSimConfig({ tickRateUi: -5 }).tickRateUi, 1);
  assert.equal(normalizeSimConfig({ tickRateUi: 3 }).tickRateUi, 3);
  assert.equal(normalizeSimConfig({ tickRateUi: 9 }).tickRateUi, 5);
});

test("init mode normalization accepts all modes and rejects unknown values", () => {
  assert.equal(normalizeSimConfig({ initMode: "triad" }).initMode, "triad");
  assert.equal(normalizeSimConfig({ initMode: "clustered" }).initMode, "clustered");
  assert.equal(normalizeSimConfig({ initMode: "random" }).initMode, "random");
  assert.equal(normalizeSimConfig({ initMode: "single-block" }).initMode, "single-block");
  assert.equal(
    normalizeSimConfig({ initMode: "invalid-mode" as unknown as "random" }).initMode,
    DEFAULT_SIM_CONFIG.initMode
  );
});
