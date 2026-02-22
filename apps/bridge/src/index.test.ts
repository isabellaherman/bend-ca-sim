import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  normalizeSimConfig,
  type BridgeErrorMessage,
  type BridgeServerMessage,
  type BridgeStateMessage
} from "@ca-sim/contracts";
import { WebSocket } from "ws";
import { createBridgeServer, type BridgeServerHandle } from "./index.js";

type MessagePredicate<T extends BridgeServerMessage = BridgeServerMessage> = (
  message: BridgeServerMessage
) => message is T;

type PendingWaiter<T extends BridgeServerMessage = BridgeServerMessage> = {
  predicate: MessagePredicate<T>;
  resolve: (message: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function isState(message: BridgeServerMessage): message is BridgeStateMessage {
  return message.type === "state";
}

function isError(message: BridgeServerMessage): message is BridgeErrorMessage {
  return message.type === "error";
}

async function connectWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await once(ws, "open");
  return ws;
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  ws.close();
  await once(ws, "close");
}

function createInbox(ws: WebSocket): {
  next: <T extends BridgeServerMessage>(predicate: MessagePredicate<T>, timeoutMs?: number) => Promise<T>;
} {
  const buffer: BridgeServerMessage[] = [];
  const waiters: PendingWaiter[] = [];

  ws.on("message", (payload) => {
    const parsed = JSON.parse(payload.toString()) as BridgeServerMessage;
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      if (waiter === undefined || !waiter.predicate(parsed)) {
        continue;
      }
      waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }
    buffer.push(parsed);
  });

  ws.on("close", () => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.reject(new Error("WebSocket closed while waiting for message."));
    }
  });

  return {
    next: <T extends BridgeServerMessage>(
      predicate: MessagePredicate<T>,
      timeoutMs = 2_000
    ): Promise<T> => {
      for (let i = 0; i < buffer.length; i += 1) {
        const current = buffer[i];
        if (current === undefined || !predicate(current)) {
          continue;
        }
        buffer.splice(i, 1);
        return Promise.resolve(current);
      }

      return new Promise<T>((resolveWait, rejectWait) => {
        const waiter: PendingWaiter<T> = {
          predicate,
          resolve: resolveWait,
          reject: rejectWait,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            rejectWait(new Error(`Timed out after ${timeoutMs}ms waiting for message.`));
          }, timeoutMs)
        };
        waiters.push(waiter);
      });
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function createBridgeOrSkip(t: TestContext): Promise<BridgeServerHandle | null> {
  try {
    return await createBridgeServer({
      host: "127.0.0.1",
      port: 0,
      sessionTtlMs: 5_000
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("EPERM")) {
      t.skip("Sandbox blocks listen() in this environment; websocket integration test skipped.");
      return null;
    }
    throw error;
  }
}

test("start contract: create once, pause, start resumes, running start is no-op", async (t) => {
  const bridge = await createBridgeOrSkip(t);
  if (bridge === null) {
    return;
  }
  t.after(async () => {
    await bridge.close();
  });

  const ws = await connectWs(`${bridge.wsUrl}?clientId=start-contract`);
  t.after(async () => {
    await closeWs(ws);
  });
  const inbox = createInbox(ws);

  await inbox.next((message): message is BridgeStateMessage => isState(message) && message.phase === "idle");

  const config = normalizeSimConfig({
    width: 32,
    height: 32,
    seed: 123,
    tickRateUi: 1
  });
  ws.send(JSON.stringify({ type: "start", backend: "js", config }));
  const started = await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "running" && message.hasRun
  );
  assert.equal(started.runId !== null, true);
  const runId = started.runId;
  assert.equal(started.seed, config.seed);

  ws.send(JSON.stringify({ type: "pause" }));
  const paused = await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "paused"
  );
  assert.equal(paused.runId, runId);

  ws.send(
    JSON.stringify({
      type: "start",
      backend: "js",
      config: normalizeSimConfig({
        ...config,
        seed: 999
      })
    })
  );
  const resumed = await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "running"
  );
  assert.equal(resumed.runId, runId);
  assert.equal(resumed.seed, config.seed);

  ws.send(
    JSON.stringify({
      type: "start",
      backend: "js",
      config: normalizeSimConfig({
        ...config,
        seed: 777
      })
    })
  );
  const runningNoOp = await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "running"
  );
  assert.equal(runningNoOp.runId, runId);
  assert.equal(runningNoOp.seed, config.seed);
});

test("reset contract: idle reset errors, active reset preserves run identity and phase", async (t) => {
  const bridge = await createBridgeOrSkip(t);
  if (bridge === null) {
    return;
  }
  t.after(async () => {
    await bridge.close();
  });

  const ws = await connectWs(`${bridge.wsUrl}?clientId=reset-contract`);
  t.after(async () => {
    await closeWs(ws);
  });
  const inbox = createInbox(ws);

  await inbox.next((message): message is BridgeStateMessage => isState(message) && message.phase === "idle");

  ws.send(JSON.stringify({ type: "reset" }));
  const resetError = await inbox.next(
    (message): message is BridgeErrorMessage => isError(message) && message.message.includes("No active run")
  );
  assert.equal(resetError.type, "error");
  const stillIdle = await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "idle" && !message.hasRun
  );
  assert.equal(stillIdle.hasRun, false);

  const config = normalizeSimConfig({
    width: 24,
    height: 24,
    seed: 456,
    tickRateUi: 1
  });
  ws.send(JSON.stringify({ type: "start", backend: "js", config }));
  const running = await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "running" && message.hasRun
  );
  assert.equal(running.runId !== null, true);
  const runId = running.runId;

  ws.send(JSON.stringify({ type: "step", ticks: 3 }));
  const afterStep = await inbox.next(
    (message): message is BridgeStateMessage =>
      isState(message) && message.phase === "running" && message.runId === runId && message.tick >= 3
  );
  assert.equal(afterStep.seed, config.seed);

  ws.send(JSON.stringify({ type: "pause" }));
  const paused = await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "paused" && message.runId === runId
  );
  assert.equal(paused.tick >= 3, true);

  ws.send(JSON.stringify({ type: "reset", seed: 999, config: { seed: 999 } }));
  const pausedReset = await inbox.next(
    (message): message is BridgeStateMessage =>
      isState(message) && message.phase === "paused" && message.runId === runId && message.tick === 0
  );
  assert.equal(pausedReset.seed, config.seed);

  ws.send(JSON.stringify({ type: "resume" }));
  await inbox.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "running" && message.runId === runId
  );

  ws.send(JSON.stringify({ type: "reset", seed: 222, config: { seed: 222 } }));
  const runningReset = await inbox.next(
    (message): message is BridgeStateMessage =>
      isState(message) && message.phase === "running" && message.runId === runId && message.tick === 0
  );
  assert.equal(runningReset.seed, config.seed);
});

test("reconnect with same clientId restores same run and does not advance while disconnected", async (t) => {
  const bridge = await createBridgeOrSkip(t);
  if (bridge === null) {
    return;
  }
  t.after(async () => {
    await bridge.close();
  });

  const clientId = "reconnect-contract";
  const ws1 = await connectWs(`${bridge.wsUrl}?clientId=${clientId}`);
  const inbox1 = createInbox(ws1);
  await inbox1.next((message): message is BridgeStateMessage => isState(message) && message.phase === "idle");

  const config = normalizeSimConfig({
    width: 16,
    height: 16,
    seed: 777,
    tickRateUi: 1
  });
  ws1.send(JSON.stringify({ type: "start", backend: "js", config }));
  const started = await inbox1.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "running" && message.hasRun
  );
  assert.equal(started.runId !== null, true);
  const runId = started.runId;
  const tickBeforeDisconnect = started.tick;

  await closeWs(ws1);
  await delay(1_250);

  const ws2 = await connectWs(`${bridge.wsUrl}?clientId=${clientId}`);
  t.after(async () => {
    await closeWs(ws2);
  });
  const inbox2 = createInbox(ws2);

  const reconnectedState = await inbox2.next(
    (message): message is BridgeStateMessage => isState(message) && message.phase === "running" && message.hasRun
  );
  assert.equal(reconnectedState.runId, runId);
  assert.equal(reconnectedState.tick, tickBeforeDisconnect);

  const replayedFrame = await inbox2.next(
    (message): message is Extract<BridgeServerMessage, { type: "frame" }> =>
      message.type === "frame" && message.frame.runId === runId && message.frame.tick === tickBeforeDisconnect
  );
  assert.equal(replayedFrame.type, "frame");

  const advancedFrame = await inbox2.next(
    (message): message is Extract<BridgeServerMessage, { type: "frame" }> =>
      message.type === "frame" && message.frame.runId === runId && message.frame.tick > tickBeforeDisconnect,
    2_000
  );
  assert.equal(advancedFrame.type, "frame");
});
