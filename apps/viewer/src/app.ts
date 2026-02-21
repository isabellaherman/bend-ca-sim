import {
  normalizeSimConfig,
  randomSeed,
  type BridgeServerMessage,
  type ControlMessage,
  type FrameMessage,
  type SimConfig,
  type TypeCode
} from "@ca-sim/contracts";

const WS_URL = (import.meta.env.VITE_BRIDGE_WS as string | undefined) ?? "ws://localhost:8787";
const GRID_SIZE = 64;
const MIN_CELL_SIZE_PX = 13;
const MAX_CELL_SIZE_PX = 18;

type DecodedState = {
  types: Uint8Array;
  energy10: Uint16Array;
  age: Uint16Array;
};

type UiRefs = {
  viewport: HTMLElement;
  canvas: HTMLCanvasElement;
  start: HTMLButtonElement;
  pause: HTMLButtonElement;
  resume: HTMLButtonElement;
  step: HTMLButtonElement;
  reset: HTMLButtonElement;
  seedRandom: HTMLButtonElement;
  seedInput: HTMLInputElement;
};

function template(): string {
  return `
    <div class="shell">
      <main class="stage">
        <div class="sim-viewport" id="sim-viewport">
          <canvas id="sim-canvas" width="896" height="896"></canvas>
        </div>
      </main>

      <footer class="control-bar">
        <label for="seed">Seed</label>
        <input id="seed" type="number" />
        <button id="seed-random" type="button">Random</button>
        <button id="start" type="button" class="playback-first">Start</button>
        <button id="pause" type="button">Pause</button>
        <button id="resume" type="button">Resume</button>
        <button id="step" type="button">Step</button>
        <button id="reset" type="button">Reset</button>
      </footer>
    </div>
  `;
}

function decodeBase64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function decodeBase64ToUint16(encoded: string): Uint16Array {
  const bytes = decodeBase64ToBytes(encoded);
  const out = new Uint16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (bytes[i * 2] ?? 0) | ((bytes[i * 2 + 1] ?? 0) << 8);
  }
  return out;
}

function energyToColor(type: TypeCode, energy10: number, age: number, maxEnergy10: number): string {
  const ratio = Math.min(1, Math.max(0, maxEnergy10 === 0 ? 0 : energy10 / maxEnergy10));
  const ageFade = Math.min(0.35, age / 450);

  let hue = 0;
  let sat = 70;
  let light = 50;
  if (type === 1) {
    hue = 16;
    sat = 92;
    light = 24 + ratio * 42;
  } else if (type === 2) {
    hue = 204;
    sat = 84;
    light = 24 + ratio * 36;
  } else if (type === 3) {
    hue = 108;
    sat = 68;
    light = 22 + ratio * 40;
  }

  sat = sat - ageFade * 30;
  const alpha = 0.42 + ratio * 0.58;
  return `hsl(${hue} ${sat}% ${light}% / ${alpha})`;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseRequired<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Missing element: ${selector}`);
  }
  return el as T;
}

function getUiRefs(): UiRefs {
  return {
    viewport: parseRequired("#sim-viewport"),
    canvas: parseRequired("#sim-canvas"),
    start: parseRequired("#start"),
    pause: parseRequired("#pause"),
    resume: parseRequired("#resume"),
    step: parseRequired("#step"),
    reset: parseRequired("#reset"),
    seedRandom: parseRequired("#seed-random"),
    seedInput: parseRequired("#seed")
  };
}

function makeConfig(ui: UiRefs, previous?: SimConfig): SimConfig {
  const seed = clampInt(Number(ui.seedInput.value || randomSeed()), 1, 0x7fffffff);
  if (previous === undefined) {
    return normalizeSimConfig({
      seed,
      width: GRID_SIZE,
      height: GRID_SIZE
    });
  }

  const initMode =
    previous.initMode === "clustered" || previous.initMode === "triad" || previous.initMode === "single-block"
      ? previous.initMode
      : "random";

  return normalizeSimConfig({
    width: GRID_SIZE,
    height: GRID_SIZE,
    wrapWorld: previous.wrapWorld,
    tickRateUi: previous.tickRateUi,
    chunkTicks: previous.chunkTicks,
    initialAliveRatio: previous.initialAliveRatio,
    reproThreshold: previous.reproThreshold,
    constants: previous.constants,
    seed,
    initMode
  });
}

export function bootApp(): void {
  const root = document.getElementById("app");
  if (root === null) {
    throw new Error("Missing #app container.");
  }
  root.innerHTML = template();

  const ui = getUiRefs();
  ui.seedInput.value = String(randomSeed());

  let ws: WebSocket | null = null;
  let latestConfig = makeConfig(ui);
  let decodedState: DecodedState | null = null;
  let cellSizePx = MIN_CELL_SIZE_PX;

  const rawCtx = ui.canvas.getContext("2d");
  if (rawCtx === null) {
    throw new Error("Canvas context is unavailable.");
  }
  const ctx = rawCtx;

  function sendControl(message: ControlMessage): void {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify(message));
  }

  function decodeState(frame: FrameMessage): DecodedState | null {
    if (frame.state === undefined) {
      return null;
    }
    return {
      types: decodeBase64ToBytes(frame.state.types),
      energy10: decodeBase64ToUint16(frame.state.energy10),
      age: decodeBase64ToUint16(frame.state.age)
    };
  }

  function fitCellSizePx(): number {
    const widthFit = Math.floor(ui.viewport.clientWidth / latestConfig.width);
    const heightFit = Math.floor(ui.viewport.clientHeight / latestConfig.height);
    const fit = Math.max(1, Math.min(widthFit, heightFit));
    return clampInt(fit, MIN_CELL_SIZE_PX, MAX_CELL_SIZE_PX);
  }

  function renderFrame(): void {
    cellSizePx = fitCellSizePx();
    const targetW = Math.max(1, latestConfig.width * cellSizePx);
    const targetH = Math.max(1, latestConfig.height * cellSizePx);
    if (ui.canvas.width !== targetW || ui.canvas.height !== targetH) {
      ui.canvas.width = targetW;
      ui.canvas.height = targetH;
    }
    ctx.fillStyle = "rgb(19, 21, 28)";
    ctx.fillRect(0, 0, targetW, targetH);
    if (decodedState === null) {
      return;
    }

    const maxEnergy = latestConfig.constants.maxEnergy10;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.max(9, Math.floor(cellSizePx * 0.45))}px ui-monospace, SFMono-Regular, Menlo, monospace`;

    for (let idx = 0; idx < decodedState.types.length; idx += 1) {
      const type = (decodedState.types[idx] ?? 0) as TypeCode;
      if (type === 0) {
        continue;
      }
      const x = (idx % latestConfig.width) * cellSizePx;
      const y = Math.floor(idx / latestConfig.width) * cellSizePx;
      const energy10 = decodedState.energy10[idx] ?? 0;
      const age = decodedState.age[idx] ?? 0;
      ctx.fillStyle = energyToColor(type, energy10, age, maxEnergy);
      ctx.fillRect(x, y, cellSizePx, cellSizePx);
      ctx.strokeStyle = "rgba(6, 10, 16, 0.72)";
      ctx.lineWidth = Math.max(1, Math.floor(cellSizePx * 0.12));
      ctx.fillStyle = "rgba(251, 246, 237, 0.9)";
      const energyText = (energy10 / 10).toFixed(1);
      ctx.strokeText(energyText, x + cellSizePx / 2, y + cellSizePx / 2);
      ctx.fillText(energyText, x + cellSizePx / 2, y + cellSizePx / 2);
    }
  }

  function handleFrame(frame: FrameMessage): void {
    const nextState = decodeState(frame);
    if (nextState !== null) {
      decodedState = nextState;
    }
    renderFrame();
  }

  function handleServerMessage(data: BridgeServerMessage): void {
    if (data.type === "frame") {
      handleFrame(data.frame);
      return;
    }
  }

  function connectBridge(): void {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => undefined;

    ws.onclose = () => {
      setTimeout(connectBridge, 1200);
    };

    ws.onerror = () => undefined;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as BridgeServerMessage;
        handleServerMessage(data);
      } catch (err) {
        console.error(`Failed to parse server message: ${(err as Error).message}`);
      }
    };
  }

  function bindControls(): void {
    ui.seedRandom.addEventListener("click", () => {
      ui.seedInput.value = String(randomSeed());
    });

    ui.start.addEventListener("click", () => {
      latestConfig = makeConfig(ui, latestConfig);
      ui.seedInput.value = String(latestConfig.seed);
      sendControl({ type: "start", backend: "js", config: latestConfig });
    });

    ui.pause.addEventListener("click", () => {
      sendControl({ type: "pause" });
    });

    ui.resume.addEventListener("click", () => {
      sendControl({ type: "resume" });
    });

    ui.step.addEventListener("click", () => {
      sendControl({ type: "step", ticks: latestConfig.chunkTicks });
    });

    ui.reset.addEventListener("click", () => {
      latestConfig = makeConfig(ui, latestConfig);
      ui.seedInput.value = String(latestConfig.seed);
      sendControl({
        type: "reset",
        seed: latestConfig.seed,
        config: latestConfig
      });
    });
  }

  bindControls();
  window.addEventListener("resize", () => {
    renderFrame();
  });
  connectBridge();
  renderFrame();
}
