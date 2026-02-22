import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSimConfig,
  type BridgeServerMessage,
  type BridgeStateMessage,
  type ControlMessage,
  type EngineBackend,
  type FrameMessage,
  type RunPhase,
  type SimConfig
} from "@ca-sim/contracts";
import { ReferenceSimulator, buildFrame } from "@ca-sim/reference";
import { WebSocket, WebSocketServer } from "ws";
import { decideControl } from "./control_state.js";
import { startAutoplayLoop } from "./loop.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

type SessionState = {
  clientId: string;
  runId: string | null;
  backend: EngineBackend | null;
  config: SimConfig | null;
  simulator: ReferenceSimulator | null;
  phase: RunPhase;
  timer: NodeJS.Timeout | null;
  socket: WebSocket | null;
  lastFrame: FrameMessage | null;
  disconnectTimer: NodeJS.Timeout | null;
  lastActiveAt: number;
};

export type BridgeServerOptions = {
  host?: string;
  port?: number;
  sessionTtlMs?: number;
};

export type BridgeServerHandle = {
  host: string;
  port: number;
  wsUrl: string;
  server: HttpServer;
  wss: WebSocketServer;
  close: () => Promise<void>;
};

function coercePort(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(0, Math.floor(num));
}

function coerceSessionTtl(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(1000, Math.floor(num));
}

function send(ws: WebSocket | null, message: BridgeServerMessage): void {
  if (ws === null || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function sendInfo(ws: WebSocket | null, message: string): void {
  send(ws, { type: "info", message });
}

function sendError(ws: WebSocket | null, message: string): void {
  send(ws, { type: "error", message });
}

function createEmptySession(clientId: string): SessionState {
  return {
    clientId,
    runId: null,
    backend: null,
    config: null,
    simulator: null,
    phase: "idle",
    timer: null,
    socket: null,
    lastFrame: null,
    disconnectTimer: null,
    lastActiveAt: Date.now()
  };
}

function hasRun(
  session: SessionState
): session is SessionState & {
  runId: string;
  backend: EngineBackend;
  config: SimConfig;
  simulator: ReferenceSimulator;
} {
  return session.runId !== null && session.backend !== null && session.config !== null && session.simulator !== null;
}

function asStateMessage(session: SessionState): BridgeStateMessage {
  const tick = hasRun(session) ? session.simulator.getTick() : 0;
  return {
    type: "state",
    phase: session.phase,
    hasRun: hasRun(session),
    runId: session.runId,
    tick,
    backend: session.backend,
    seed: session.config?.seed ?? null
  };
}

function emitState(session: SessionState): void {
  send(session.socket, asStateMessage(session));
}

function emitFrame(session: SessionState, frame: FrameMessage): void {
  session.lastFrame = frame;
  send(session.socket, { type: "frame", frame });
}

function emitInitialFrame(session: SessionState): void {
  if (!hasRun(session)) {
    return;
  }
  const snapshot = session.simulator.getState();
  const frame = buildFrame(
    session.runId,
    session.backend,
    session.simulator.getTick(),
    session.simulator.getDigest(),
    session.simulator.getMetrics(),
    snapshot,
    true
  );
  emitFrame(session, frame);
}

function emitSteps(session: SessionState, ticks: number): void {
  if (!hasRun(session)) {
    return;
  }
  const safeTicks = Math.max(1, Math.floor(ticks));
  for (let i = 0; i < safeTicks; i += 1) {
    const result = session.simulator.step();
    const frame = buildFrame(
      session.runId,
      session.backend,
      session.simulator.getTick(),
      result.digest,
      result.metrics,
      result.state,
      true
    );
    emitFrame(session, frame);
  }
}

function clearTimer(session: SessionState): void {
  if (session.timer === null) {
    return;
  }
  clearInterval(session.timer);
  session.timer = null;
}

function startLoop(session: SessionState): void {
  clearTimer(session);
  if (!hasRun(session) || session.phase !== "running") {
    return;
  }
  if (session.socket === null || session.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  session.timer = startAutoplayLoop({
    tickRateUi: session.config.tickRateUi,
    isPaused: () =>
      session.phase !== "running" ||
      session.socket === null ||
      session.socket.readyState !== WebSocket.OPEN,
    onTick: () => {
      if (session.socket === null || session.socket.readyState !== WebSocket.OPEN) {
        clearTimer(session);
        return;
      }
      emitSteps(session, 1);
    }
  });
}

function ensureSession(sessions: Map<string, SessionState>, clientId: string): SessionState {
  const existing = sessions.get(clientId);
  if (existing !== undefined) {
    return existing;
  }
  const next = createEmptySession(clientId);
  sessions.set(clientId, next);
  return next;
}

function dropSession(sessions: Map<string, SessionState>, session: SessionState): void {
  clearTimer(session);
  if (session.disconnectTimer !== null) {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
  }
  sessions.delete(session.clientId);
}

function scheduleSessionDrop(
  sessions: Map<string, SessionState>,
  session: SessionState,
  sessionTtlMs: number
): void {
  if (session.disconnectTimer !== null) {
    clearTimeout(session.disconnectTimer);
  }
  session.lastActiveAt = Date.now();
  session.disconnectTimer = setTimeout(() => {
    if (session.socket !== null) {
      return;
    }
    dropSession(sessions, session);
  }, sessionTtlMs);
}

function parseClientId(request: IncomingMessage): string {
  const requestUrl = request.url ?? "/";
  const host = request.headers.host ?? "localhost";
  try {
    const parsed = new URL(requestUrl, `http://${host}`);
    const raw = parsed.searchParams.get("clientId")?.trim() ?? "";
    if (raw.length > 0) {
      return raw.slice(0, 128);
    }
  } catch {
    // no-op
  }
  return randomUUID();
}

function parseControlMessage(raw: string): ControlMessage | null {
  try {
    const data = JSON.parse(raw) as { type?: unknown; config?: unknown };
    if (typeof data !== "object" || data === null || typeof data.type !== "string") {
      return null;
    }
    if (data.type === "start") {
      if (typeof data.config !== "object" || data.config === null) {
        return null;
      }
      return data as ControlMessage;
    }
    if (
      data.type === "pause" ||
      data.type === "resume" ||
      data.type === "step" ||
      data.type === "reset" ||
      data.type === "stop"
    ) {
      return data as ControlMessage;
    }
    return null;
  } catch {
    return null;
  }
}

function startNewRun(
  session: SessionState,
  config: SimConfig,
  requestedBackend: EngineBackend | undefined
): void {
  if (requestedBackend !== undefined && requestedBackend !== "js") {
    sendInfo(session.socket, `Backend "${requestedBackend}" requested. Live bridge currently runs JS reference engine.`);
  }
  session.runId = randomUUID();
  session.backend = "js";
  session.config = config;
  session.simulator = new ReferenceSimulator(config);
  session.phase = "running";
  emitInitialFrame(session);
  startLoop(session);
}

function resetRun(session: SessionState): void {
  if (!hasRun(session)) {
    return;
  }
  session.simulator = new ReferenceSimulator(session.config);
  emitInitialFrame(session);
  if (session.phase === "running") {
    startLoop(session);
    return;
  }
  clearTimer(session);
}

function stopRun(session: SessionState): void {
  clearTimer(session);
  session.runId = null;
  session.backend = null;
  session.config = null;
  session.simulator = null;
  session.phase = "idle";
  session.lastFrame = null;
}

function attachConnection(session: SessionState, ws: WebSocket): void {
  if (session.disconnectTimer !== null) {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
  }
  if (session.socket !== null && session.socket !== ws && session.socket.readyState === WebSocket.OPEN) {
    session.socket.close(1000, "Replaced by newer connection.");
  }
  session.socket = ws;
  session.lastActiveAt = Date.now();
  sendInfo(ws, `Connected as client "${session.clientId}".`);
  emitState(session);
  if (session.lastFrame !== null) {
    send(ws, { type: "frame", frame: session.lastFrame });
  }
  if (session.phase === "running") {
    startLoop(session);
  }
}

function disconnectConnection(session: SessionState, ws: WebSocket): void {
  if (session.socket !== ws) {
    return;
  }
  session.socket = null;
  clearTimer(session);
}

function handleControlMessage(session: SessionState, message: ControlMessage): void {
  const decision = decideControl(
    {
      hasRun: hasRun(session),
      phase: session.phase
    },
    message
  );

  switch (decision.kind) {
    case "start_new": {
      if (message.type !== "start") {
        sendError(session.socket, "Invalid start payload.");
        break;
      }
      const normalized = normalizeSimConfig(message.config);
      startNewRun(session, normalized, message.backend);
      sendInfo(session.socket, `Run started: ${session.runId} (seed=${normalized.seed}, backend=${session.backend})`);
      break;
    }
    case "resume": {
      session.phase = "running";
      startLoop(session);
      sendInfo(session.socket, "Resumed.");
      break;
    }
    case "pause": {
      session.phase = "paused";
      clearTimer(session);
      sendInfo(session.socket, "Paused.");
      break;
    }
    case "reset": {
      resetRun(session);
      if (session.config !== null) {
        sendInfo(session.socket, `Run reset (seed=${session.config.seed}).`);
      }
      break;
    }
    case "step": {
      emitSteps(session, decision.ticks);
      sendInfo(session.socket, `Stepped ${decision.ticks} tick(s).`);
      break;
    }
    case "stop": {
      stopRun(session);
      sendInfo(session.socket, "Stopped.");
      break;
    }
    case "noop": {
      sendInfo(session.socket, decision.reason);
      break;
    }
    case "error": {
      sendError(session.socket, decision.message);
      break;
    }
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }

  emitState(session);
}

export async function createBridgeServer(options: BridgeServerOptions = {}): Promise<BridgeServerHandle> {
  const host = options.host ?? process.env.BRIDGE_HOST ?? DEFAULT_HOST;
  const port = coercePort(options.port ?? process.env.BRIDGE_PORT, DEFAULT_PORT);
  const sessionTtlMs = coerceSessionTtl(
    options.sessionTtlMs ?? process.env.BRIDGE_SESSION_TTL_MS,
    DEFAULT_SESSION_TTL_MS
  );
  const sessions = new Map<string, SessionState>();

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
        controls: ["start", "pause", "resume", "reset", "step", "stop"],
        sessionTtlMs,
        health: "/health"
      })
    );
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws, request) => {
    const clientId = parseClientId(request);
    const session = ensureSession(sessions, clientId);
    attachConnection(session, ws);

    ws.on("message", (payload) => {
      session.lastActiveAt = Date.now();
      const raw = typeof payload === "string" ? payload : payload.toString();
      const message = parseControlMessage(raw);
      if (message === null) {
        sendError(session.socket, "Invalid control message JSON.");
        emitState(session);
        return;
      }
      handleControlMessage(session, message);
    });

    ws.on("close", () => {
      disconnectConnection(session, ws);
      scheduleSessionDrop(sessions, session, sessionTtlMs);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      wss.off("error", onError);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      wss.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    wss.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  wss.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[bridge] websocket error: ${message}\n`);
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null && "port" in address ? Number(address.port) : port;
  const wsUrl = `ws://${host}:${boundPort}`;

  const close = async (): Promise<void> => {
    for (const session of sessions.values()) {
      clearTimer(session);
      if (session.disconnectTimer !== null) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
      }
      if (session.socket !== null && session.socket.readyState === WebSocket.OPEN) {
        session.socket.close(1001, "Server shutting down.");
      }
    }
    sessions.clear();

    await new Promise<void>((resolveWss) => {
      wss.close(() => resolveWss());
    });
    await new Promise<void>((resolveServer, rejectServer) => {
      server.close((err) => {
        if (err !== undefined) {
          rejectServer(err);
          return;
        }
        resolveServer();
      });
    });
  };

  return {
    host,
    port: boundPort,
    wsUrl,
    server,
    wss,
    close
  };
}

function isMainModule(metaUrl: string): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  return resolve(fileURLToPath(metaUrl)) === resolve(process.argv[1]);
}

if (isMainModule(import.meta.url)) {
  createBridgeServer()
    .then((bridge) => {
      process.stdout.write(`[bridge] listening on ${bridge.wsUrl}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[bridge] failed to start: ${message}\n`);
      process.exitCode = 1;
    });
}
