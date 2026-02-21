import test from "node:test";
import assert from "node:assert/strict";
import { startAutoplayLoop, tickIntervalMs } from "./loop.js";

test("tick interval uses tickRateUi and minimum 16ms", () => {
  assert.equal(tickIntervalMs(2), 500);
  assert.equal(tickIntervalMs(5), 200);
  assert.equal(tickIntervalMs(1000), 16);
  assert.equal(tickIntervalMs(0), 1000);
});

test("autoplay runs one tick per interval and respects pause", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let paused = false;
  let ticks = 0;
  const timer = startAutoplayLoop({
    tickRateUi: 2,
    isPaused: () => paused,
    onTick: () => {
      ticks += 1;
    }
  });

  t.mock.timers.tick(499);
  assert.equal(ticks, 0);

  t.mock.timers.tick(1);
  assert.equal(ticks, 1);

  paused = true;
  t.mock.timers.tick(1000);
  assert.equal(ticks, 1);

  paused = false;
  t.mock.timers.tick(500);
  assert.equal(ticks, 2);

  clearInterval(timer);
  t.mock.timers.reset();
});
