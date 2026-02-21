import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SIM_CONFIG,
  normalizeSimConfig,
  randomSeed,
  type BridgeServerMessage,
  type ControlMessage,
  type EngineBackend,
  type PartialSimConfig,
  type SimConfig
} from "@ca-sim/contracts";
import { ReferenceSimulator, buildFrame } from "@ca-sim/reference";
import { WebSocket, WebSocketServer } from "ws";
import { startAutoplayLoop } from "./loop.js";

const port = Number(process.env.BRIDGE_PORT ?? 8787);
const host = process.env.BRIDGE_HOST ?? "0.0.0.0";

type ClientState = {
  runId: string;
  backend: EngineBackend;
  config: SimConfig;
  simulator: ReferenceSimulator;
  paused: boolean;
  timer: NodeJS.Timeout | null;
};

function send(ws: WebSocket, message: BridgeServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function sendInfo(ws: WebSocket, message: string): void {
  send(ws, { type: "info", message });
}

function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: "error", message });
}

function emitInitialFrame(ws: WebSocket, state: ClientState): void {
  const snapshot = state.simulator.getState();
  const frame = buildFrame(
    state.runId,
    state.backend,
    state.simulator.getTick(),
    state.simulator.getDigest(),
    state.simulator.getMetrics(),
    snapshot,
    true
  );
  send(ws, { type: "frame", frame });
}

function emitSteps(ws: WebSocket, state: ClientState, ticks: number): void {
  const maxTicks = Math.max(1, Math.floor(ticks));
  for (let i = 0; i < maxTicks; i += 1) {
    const result = state.simulator.step();
    const frame = buildFrame(
      state.runId,
      state.backend,
      state.simulator.getTick(),
      result.digest,
      result.metrics,
      result.state,
      true
    );
    send(ws, { type: "frame", frame });
  }
}

function clearTimer(state: ClientState): void {
  if (state.timer === null) {
    return;
  }
  clearInterval(state.timer);
  state.timer = null;
}

function startLoop(ws: WebSocket, state: ClientState): void {
  clearTimer(state);
  state.timer = startAutoplayLoop({
    tickRateUi: state.config.tickRateUi,
    isPaused: () => state.paused,
    onTick: () => emitSteps(ws, state, 1)
  });
}

function makeClientState(config: SimConfig, backend: EngineBackend): ClientState {
  return {
    runId: randomUUID(),
    backend,
    config,
    simulator: new ReferenceSimulator(config),
    paused: false,
    timer: null
  };
}

function applyStart(
  ws: WebSocket,
  current: ClientState | null,
  config: SimConfig,
  requestedBackend: EngineBackend | undefined
): ClientState {
  if (current !== null) {
    clearTimer(current);
  }
  const backend: EngineBackend = requestedBackend ?? "js";
  if (backend !== "js") {
    sendInfo(ws, `Backend "${backend}" requested. Live bridge currently runs JS reference engine.`);
  }
  const state = makeClientState(config, "js");
  emitInitialFrame(ws, state);
  startLoop(ws, state);
  return state;
}

function applyReset(
  ws: WebSocket,
  current: ClientState,
  seed: number | undefined,
  partialConfig: PartialSimConfig | undefined
): ClientState {
  const merged = normalizeSimConfig({
    ...current.config,
    ...(partialConfig ?? {}),
    seed: seed ?? partialConfig?.seed ?? current.config.seed
  });
  const next = makeClientState(merged, current.backend);
  next.paused = current.paused;
  emitInitialFrame(ws, next);
  startLoop(ws, next);
  return next;
}

function parseControlMessage(raw: string): ControlMessage | null {
  try {
    const data = JSON.parse(raw) as ControlMessage;
    if (!data || typeof data !== "object" || !("type" in data)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      service: "ca-sim-bridge",
      ws: `ws://${host}:${port}`,
      health: "/health"
    })
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let state: ClientState | null = null;
  sendInfo(ws, "Connected. Send ControlMessage JSON payloads.");

  ws.on("message", (payload) => {
    const message = parseControlMessage(payload.toString());
    if (message === null) {
      sendError(ws, "Invalid control message JSON.");
      return;
    }

    switch (message.type) {
      case "start": {
        const normalized = normalizeSimConfig(message.config);
        state = applyStart(ws, state, normalized, message.backend);
        sendInfo(ws, `Run started: ${state.runId} (seed=${normalized.seed}, backend=${state.backend})`);
        return;
      }
      case "pause": {
        if (state === null) {
          sendError(ws, "No active run. Send start first.");
          return;
        }
        state.paused = true;
        sendInfo(ws, "Paused.");
        return;
      }
      case "resume": {
        if (state === null) {
          sendError(ws, "No active run. Send start first.");
          return;
        }
        state.paused = false;
        sendInfo(ws, "Resumed.");
        return;
      }
      case "step": {
        if (state === null) {
          sendError(ws, "No active run. Send start first.");
          return;
        }
        emitSteps(ws, state, message.ticks ?? 1);
        sendInfo(ws, `Stepped ${Math.max(1, Math.floor(message.ticks ?? 1))} tick(s).`);
        return;
      }
      case "reset": {
        if (state === null) {
          const seed = message.seed ?? randomSeed();
          const config = normalizeSimConfig({
            ...DEFAULT_SIM_CONFIG,
            ...(message.config ?? {}),
            seed
          });
          state = applyStart(ws, state, config, "js");
          sendInfo(ws, `No active run found. Started new run with seed ${seed}.`);
          return;
        }
        state = applyReset(ws, state, message.seed, message.config);
        sendInfo(ws, `Run reset: ${state.runId} (seed=${state.config.seed})`);
        return;
      }
      case "stop": {
        if (state !== null) {
          clearTimer(state);
          state = null;
        }
        sendInfo(ws, "Stopped.");
        return;
      }
      default:
        sendError(ws, "Unsupported control message.");
    }
  });

  ws.on("close", () => {
    if (state !== null) {
      clearTimer(state);
    }
  });
});

server.listen(port, host, () => {
  process.stdout.write(`[bridge] listening on ws://${host}:${port}\n`);
});
