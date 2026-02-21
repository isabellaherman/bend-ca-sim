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

type DecodedState = {
  types: Uint8Array;
  energy10: Uint16Array;
  age: Uint16Array;
};

type UiRefs = {
  status: HTMLElement;
  info: HTMLElement;
  runInfo: HTMLElement;
  metrics: HTMLElement;
  inspector: HTMLElement;
  chart: HTMLCanvasElement;
  canvas: HTMLCanvasElement;
  start: HTMLButtonElement;
  pause: HTMLButtonElement;
  resume: HTMLButtonElement;
  step: HTMLButtonElement;
  reset: HTMLButtonElement;
  seedRandom: HTMLButtonElement;
  seedInput: HTMLInputElement;
  gridSize: HTMLSelectElement;
  initMode: HTMLSelectElement;
  tickRate: HTMLInputElement;
  tickRateOut: HTMLOutputElement;
  cellSize: HTMLInputElement;
  cellSizeOut: HTMLOutputElement;
  showEnergyLabels: HTMLInputElement;
  chunkTicks: HTMLInputElement;
  aliveRatio: HTMLInputElement;
  aliveRatioOut: HTMLOutputElement;
  repro: HTMLInputElement;
  maxEnergy: HTMLInputElement;
  startEnergy: HTMLInputElement;
  spawnEnergy: HTMLInputElement;
  threat: HTMLInputElement;
  ally: HTMLInputElement;
  prey: HTMLInputElement;
  aging: HTMLInputElement;
};

type History = {
  fire: number[];
  water: number[];
  grass: number[];
};

const HISTORY_LIMIT = 220;
const ENERGY_LABEL_MIN_CELL_PX = 14;
const STAGNATION_WARN_AFTER = 20;

const typeLabel: Record<number, string> = {
  0: "Empty",
  1: "Fire",
  2: "Water",
  3: "Grass"
};

function template(): string {
  return `
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Bend + Canvas study</p>
          <h1>Cellular Pressure Arena</h1>
          <p class="subtitle">Fire / Water / Grass with deterministic seed runs</p>
        </div>
        <div class="status-pill" id="status">connecting...</div>
      </header>

      <section class="layout">
        <main class="panel stage">
          <div class="run-meta" id="run-info">No active run</div>
          <div class="sim-viewport">
            <canvas id="sim-canvas" width="896" height="896"></canvas>
          </div>
          <canvas id="chart-canvas" width="900" height="120"></canvas>
        </main>

        <aside class="sidebar">
          <section class="panel controls">
            <h2>Playback</h2>
            <p class="muted">Main flow stays simple. Adjust values in Advanced before Start/Reset.</p>

            <div class="buttons buttons-main">
              <button id="start" type="button">Start</button>
              <button id="pause" type="button">Pause</button>
              <button id="resume" type="button">Resume</button>
              <button id="step" type="button">Step</button>
              <button id="reset" type="button">Reset</button>
            </div>

            <details class="advanced">
              <summary>Advanced controls</summary>
              <div class="advanced-body">
                <div class="field-row">
                  <label for="seed">Seed</label>
                  <div class="seed-group">
                    <input id="seed" type="number" />
                    <button id="seed-random" type="button">Random</button>
                  </div>
                </div>

                <div class="field-row">
                  <label for="grid-size">Grid</label>
                  <select id="grid-size">
                    <option value="128">128 x 128</option>
                    <option value="256">256 x 256</option>
                  </select>
                </div>

                <div class="field-row">
                  <label for="init-mode">Init mode</label>
                  <select id="init-mode">
                    <option value="single-block">Debug seed (up to 9/type)</option>
                    <option value="triad">Triad (1 cluster/type)</option>
                    <option value="random">Random</option>
                    <option value="clustered">Clustered</option>
                  </select>
                </div>

                <div class="field-row">
                  <label for="tick-rate">Tick rate (1..5)</label>
                  <div class="range-row">
                    <input id="tick-rate" type="range" min="1" max="5" step="1" value="2" />
                    <output id="tick-rate-out">2</output>
                  </div>
                </div>

                <div class="field-row">
                  <label for="cell-size">Cell size (px, render/debug)</label>
                  <div class="range-row">
                    <input id="cell-size" type="range" min="4" max="24" step="1" value="7" />
                    <output id="cell-size-out">7</output>
                  </div>
                </div>

                <div class="field-row toggle-row">
                  <label for="show-energy-labels">Show energy text overlay</label>
                  <input id="show-energy-labels" type="checkbox" checked />
                </div>

                <div class="field-row">
                  <label for="chunk-ticks">Chunk ticks (manual step only)</label>
                  <input id="chunk-ticks" type="number" min="1" max="16" value="1" />
                </div>

                <div class="field-row">
                  <label for="alive-ratio">Alive ratio (random/clustered)</label>
                  <div class="range-row">
                    <input id="alive-ratio" type="range" min="0.01" max="1" step="0.01" value="0.20" />
                    <output id="alive-ratio-out">0.20</output>
                  </div>
                </div>

                <div class="field-row">
                  <label for="repro">Repro threshold</label>
                  <input id="repro" type="number" min="1" max="8" value="3" />
                </div>

                <div class="constants">
                  <p class="constants-title">Constants (fixed-point tenths)</p>
                  <div class="field-row"><label for="max-energy">Max energy</label><input id="max-energy" type="number" value="50" min="1" /></div>
                  <div class="field-row"><label for="start-energy">Start energy</label><input id="start-energy" type="number" value="50" min="0" /></div>
                  <div class="field-row"><label for="spawn-energy">Spawn energy</label><input id="spawn-energy" type="number" value="50" min="0" /></div>
                  <div class="field-row"><label for="threat">Threat penalty</label><input id="threat" type="number" value="10" min="0" /></div>
                  <div class="field-row"><label for="ally">Ally bonus</label><input id="ally" type="number" value="2" min="0" /></div>
                  <div class="field-row"><label for="prey">Prey bonus</label><input id="prey" type="number" value="0" min="0" /></div>
                  <div class="field-row"><label for="aging">Aging drain</label><input id="aging" type="number" value="1" min="0" /></div>
                </div>
              </div>
            </details>
          </section>

          <section class="panel telemetry">
            <h2>Telemetry</h2>
            <pre id="metrics"></pre>
            <h2>Inspector</h2>
            <pre id="inspector">Click a cell to inspect.</pre>
            <h2>Bridge</h2>
            <pre id="info">Waiting for server messages...</pre>
          </section>
        </aside>
      </section>
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

function beats(attacker: TypeCode, defender: TypeCode): boolean {
  return (
    (attacker === 2 && defender === 1) ||
    (attacker === 1 && defender === 3) ||
    (attacker === 3 && defender === 2)
  );
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
    status: parseRequired("#status"),
    info: parseRequired("#info"),
    runInfo: parseRequired("#run-info"),
    metrics: parseRequired("#metrics"),
    inspector: parseRequired("#inspector"),
    chart: parseRequired("#chart-canvas"),
    canvas: parseRequired("#sim-canvas"),
    start: parseRequired("#start"),
    pause: parseRequired("#pause"),
    resume: parseRequired("#resume"),
    step: parseRequired("#step"),
    reset: parseRequired("#reset"),
    seedRandom: parseRequired("#seed-random"),
    seedInput: parseRequired("#seed"),
    gridSize: parseRequired("#grid-size"),
    initMode: parseRequired("#init-mode"),
    tickRate: parseRequired("#tick-rate"),
    tickRateOut: parseRequired("#tick-rate-out"),
    cellSize: parseRequired("#cell-size"),
    cellSizeOut: parseRequired("#cell-size-out"),
    showEnergyLabels: parseRequired("#show-energy-labels"),
    chunkTicks: parseRequired("#chunk-ticks"),
    aliveRatio: parseRequired("#alive-ratio"),
    aliveRatioOut: parseRequired("#alive-ratio-out"),
    repro: parseRequired("#repro"),
    maxEnergy: parseRequired("#max-energy"),
    startEnergy: parseRequired("#start-energy"),
    spawnEnergy: parseRequired("#spawn-energy"),
    threat: parseRequired("#threat"),
    ally: parseRequired("#ally"),
    prey: parseRequired("#prey"),
    aging: parseRequired("#aging")
  };
}

function makeConfig(ui: UiRefs): SimConfig {
  const seed = clampInt(Number(ui.seedInput.value || randomSeed()), 1, 0x7fffffff);
  const initMode =
    ui.initMode.value === "clustered" || ui.initMode.value === "triad" || ui.initMode.value === "single-block"
      ? ui.initMode.value
      : "random";
  return normalizeSimConfig({
    width: Number(ui.gridSize.value),
    height: Number(ui.gridSize.value),
    seed,
    initMode,
    tickRateUi: Number(ui.tickRate.value),
    chunkTicks: Number(ui.chunkTicks.value),
    initialAliveRatio: Number(ui.aliveRatio.value),
    reproThreshold: Number(ui.repro.value),
    constants: {
      maxEnergy10: Number(ui.maxEnergy.value),
      startEnergy10: Number(ui.startEnergy.value),
      spawnEnergy10: Number(ui.spawnEnergy.value),
      threatPenalty10: Number(ui.threat.value),
      allyBonus10: Number(ui.ally.value),
      preyBonus10: Number(ui.prey.value),
      agingDrain10: Number(ui.aging.value)
    }
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
  ui.cellSizeOut.value = ui.cellSize.value;
  ui.aliveRatioOut.value = Number(ui.aliveRatio.value).toFixed(2);

  let ws: WebSocket | null = null;
  let latestConfig = makeConfig(ui);
  let latestFrame: FrameMessage | null = null;
  let decodedState: DecodedState | null = null;
  const history: History = { fire: [], water: [], grass: [] };
  let cellSizePx = clampInt(Number(ui.cellSize.value), 4, 24);
  let stagnantTicks = 0;

  const rawCtx = ui.canvas.getContext("2d");
  const rawChartCtx = ui.chart.getContext("2d");
  if (rawCtx === null || rawChartCtx === null) {
    throw new Error("Canvas context is unavailable.");
  }
  const ctx = rawCtx;
  const chartCtx = rawChartCtx;

  function updateStatus(text: string): void {
    ui.status.textContent = text;
  }

  function appendInfo(line: string): void {
    ui.info.textContent = `${line}\n${ui.info.textContent}`.slice(0, 3000);
  }

  function sendControl(message: ControlMessage): void {
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      appendInfo("Bridge socket is not open.");
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

  function updateMetrics(frame: FrameMessage): void {
    const m = frame.metrics;
    const stagnationLine =
      stagnantTicks >= STAGNATION_WARN_AFTER
        ? `stagnation: ${stagnantTicks} ticks (births=0 & deaths=0) WARNING`
        : `stagnation: ${stagnantTicks} ticks`;
    ui.metrics.textContent = [
      `runId: ${frame.runId}`,
      `backend: ${frame.backend}`,
      `tick: ${frame.tick}`,
      `digest: ${frame.digest}`,
      "",
      `empty: ${m.popEmpty}`,
      `fire:  ${m.popFire}`,
      `water: ${m.popWater}`,
      `grass: ${m.popGrass}`,
      "",
      `births: ${m.births}`,
      `deaths: ${m.deaths}`,
      `meanEnergy: ${(m.meanEnergy10 / 10).toFixed(1)}`,
      `meanAge: ${m.meanAge.toFixed(2)}`,
      stagnationLine
    ].join("\n");
  }

  function drawSparkline(): void {
    chartCtx.fillStyle = "rgba(12, 15, 22, 0.95)";
    chartCtx.fillRect(0, 0, ui.chart.width, ui.chart.height);

    const len = history.fire.length;
    if (len < 2) {
      return;
    }

    const maxPop = latestConfig.width * latestConfig.height;
    const drawLine = (series: number[], color: string): void => {
      chartCtx.strokeStyle = color;
      chartCtx.lineWidth = 2;
      chartCtx.beginPath();
      for (let i = 0; i < series.length; i += 1) {
        const x = (i / (series.length - 1)) * ui.chart.width;
        const value = series[i] ?? 0;
        const y = ui.chart.height - (value / maxPop) * ui.chart.height;
        if (i === 0) {
          chartCtx.moveTo(x, y);
        } else {
          chartCtx.lineTo(x, y);
        }
      }
      chartCtx.stroke();
    };

    drawLine(history.fire, "rgba(255, 121, 74, 0.95)");
    drawLine(history.water, "rgba(86, 173, 255, 0.95)");
    drawLine(history.grass, "rgba(109, 229, 118, 0.95)");
  }

  function renderFrame(): void {
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

    const showEnergy = ui.showEnergyLabels.checked && cellSizePx >= ENERGY_LABEL_MIN_CELL_PX;
    const maxEnergy = latestConfig.constants.maxEnergy10;

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
      if (showEnergy) {
        ctx.fillStyle = "rgba(244, 248, 255, 0.95)";
        ctx.font = `${Math.max(9, Math.floor(cellSizePx * 0.42))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText((energy10 / 10).toFixed(1), x + cellSizePx / 2, y + cellSizePx / 2);
      }
    }
  }

  function pushHistory(frame: FrameMessage): void {
    history.fire.push(frame.metrics.popFire);
    history.water.push(frame.metrics.popWater);
    history.grass.push(frame.metrics.popGrass);
    if (history.fire.length > HISTORY_LIMIT) history.fire.shift();
    if (history.water.length > HISTORY_LIMIT) history.water.shift();
    if (history.grass.length > HISTORY_LIMIT) history.grass.shift();
  }

  function handleFrame(frame: FrameMessage): void {
    latestFrame = frame;
    if (frame.tick === 0) {
      stagnantTicks = 0;
    } else if (frame.metrics.births === 0 && frame.metrics.deaths === 0) {
      stagnantTicks += 1;
    } else {
      stagnantTicks = 0;
    }
    if (stagnantTicks === STAGNATION_WARN_AFTER) {
      appendInfo(`WARNING: no births/deaths for ${STAGNATION_WARN_AFTER} ticks (possible stagnation).`);
    }
    const nextState = decodeState(frame);
    if (nextState !== null) {
      decodedState = nextState;
    }
    ui.runInfo.textContent = `run ${frame.runId} | tick ${frame.tick} | backend ${frame.backend}`;
    updateMetrics(frame);
    pushHistory(frame);
    renderFrame();
    drawSparkline();
  }

  function handleServerMessage(data: BridgeServerMessage): void {
    if (data.type === "frame") {
      handleFrame(data.frame);
      return;
    }
    if (data.type === "info") {
      appendInfo(data.message);
      return;
    }
    appendInfo(`ERROR: ${data.message}`);
  }

  function connectBridge(): void {
    updateStatus("connecting…");
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      updateStatus("connected");
      appendInfo(`Connected to ${WS_URL}`);
    };

    ws.onclose = () => {
      updateStatus("disconnected");
      appendInfo("Bridge disconnected. Reconnecting in 1.2s…");
      setTimeout(connectBridge, 1200);
    };

    ws.onerror = () => {
      updateStatus("error");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as BridgeServerMessage;
        handleServerMessage(data);
      } catch (err) {
        appendInfo(`Failed to parse server message: ${(err as Error).message}`);
      }
    };
  }

  function bindControls(): void {
    ui.tickRate.addEventListener("input", () => {
      ui.tickRateOut.value = ui.tickRate.value;
    });
    ui.cellSize.addEventListener("input", () => {
      cellSizePx = clampInt(Number(ui.cellSize.value), 4, 24);
      ui.cellSizeOut.value = String(cellSizePx);
      renderFrame();
    });
    ui.showEnergyLabels.addEventListener("change", () => {
      renderFrame();
    });
    ui.aliveRatio.addEventListener("input", () => {
      ui.aliveRatioOut.value = Number(ui.aliveRatio.value).toFixed(2);
    });

    ui.seedRandom.addEventListener("click", () => {
      ui.seedInput.value = String(randomSeed());
    });

    ui.start.addEventListener("click", () => {
      latestConfig = makeConfig(ui);
      stagnantTicks = 0;
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
      const ticks = clampInt(Number(ui.chunkTicks.value), 1, 16);
      sendControl({ type: "step", ticks });
    });

    ui.reset.addEventListener("click", () => {
      latestConfig = makeConfig(ui);
      stagnantTicks = 0;
      ui.seedInput.value = String(latestConfig.seed);
      sendControl({
        type: "reset",
        seed: latestConfig.seed,
        config: latestConfig
      });
      history.fire.length = 0;
      history.water.length = 0;
      history.grass.length = 0;
      drawSparkline();
    });

    ui.canvas.addEventListener("click", (event) => {
      if (decodedState === null) {
        return;
      }
      const rect = ui.canvas.getBoundingClientRect();
      const x = Math.floor(((event.clientX - rect.left) / rect.width) * latestConfig.width);
      const y = Math.floor(((event.clientY - rect.top) / rect.height) * latestConfig.height);
      const cx = clampInt(x, 0, latestConfig.width - 1);
      const cy = clampInt(y, 0, latestConfig.height - 1);
      const idx = cy * latestConfig.width + cx;
      const type = (decodedState.types[idx] ?? 0) as TypeCode;
      const energy = (decodedState.energy10[idx] ?? 0) / 10;
      const age = decodedState.age[idx] ?? 0;

      let allies = 0;
      let threats = 0;
      let prey = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          let nx = cx + ox;
          let ny = cy + oy;
          if (latestConfig.wrapWorld) {
            nx = (nx + latestConfig.width) % latestConfig.width;
            ny = (ny + latestConfig.height) % latestConfig.height;
          } else if (nx < 0 || ny < 0 || nx >= latestConfig.width || ny >= latestConfig.height) {
            continue;
          }
          const nType = (decodedState.types[ny * latestConfig.width + nx] ?? 0) as TypeCode;
          if (nType === 0 || type === 0) {
            continue;
          }
          if (nType === type) allies += 1;
          else if (beats(nType, type)) threats += 1;
          else if (beats(type, nType)) prey += 1;
        }
      }

      ui.inspector.textContent = [
        `coord: (${cx}, ${cy})`,
        `index: ${idx}`,
        `type: ${typeLabel[type]}`,
        `energy: ${energy.toFixed(1)}`,
        `age: ${age}`,
        "",
        `neighbors`,
        `allies: ${allies}`,
        `threats: ${threats}`,
        `prey: ${prey}`,
        "",
        `last tick: ${latestFrame?.tick ?? "-"}`
      ].join("\n");
    });
  }

  bindControls();
  connectBridge();
  drawSparkline();
  renderFrame();
}
