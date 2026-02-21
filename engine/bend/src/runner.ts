import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { EngineBackend, FrameMessage, SimConfig } from "@ca-sim/contracts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MASK_U24 = 0xffffff;

export interface BendRunOptions {
  backend: Extract<EngineBackend, "bend-rs" | "bend-c">;
  runId: string;
  config: SimConfig;
  ticks: number;
  includeState: boolean;
  bendEntryPath?: string;
}

function cliModeFromBackend(backend: BendRunOptions["backend"]): "run-rs" | "run-c" {
  return backend === "bend-rs" ? "run-rs" : "run-c";
}

function toInitModeFlag(mode: SimConfig["initMode"]): number {
  // Bend kernel currently supports random (0) and clustered (1) only.
  // Triad and single-block map to clustered as the closest deterministic layout.
  return mode === "clustered" || mode === "triad" || mode === "single-block" ? 1 : 0;
}

function toAliveRatio10k(ratio: number): number {
  const value = Math.floor(ratio * 10_000);
  return Math.max(0, Math.min(10_000, value));
}

function renderTemplate(template: string, options: BendRunOptions): string {
  const { config, ticks } = options;
  const size = config.width * config.height;
  const replacements: Record<string, number> = {
    __WIDTH__: config.width,
    __HEIGHT__: config.height,
    __SIZE__: size,
    __TICKS__: ticks,
    __SEED__: config.seed,
    __INIT_MODE__: toInitModeFlag(config.initMode),
    __ALIVE_RATIO_10K__: toAliveRatio10k(config.initialAliveRatio),
    __REPRO_THRESHOLD__: config.reproThreshold,
    __MAX_ENERGY__: config.constants.maxEnergy10,
    __START_ENERGY__: config.constants.startEnergy10,
    __SPAWN_ENERGY__: config.constants.spawnEnergy10,
    __THREAT_PENALTY__: config.constants.threatPenalty10,
    __ALLY_BONUS__: config.constants.allyBonus10,
    __PREY_BONUS__: config.constants.preyBonus10
  };

  let out = template;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.replace(new RegExp(token, "g"), String(value));
  }
  return out;
}

function parseDigestList(stdout: string, ticks: number): number[] {
  const listMatch = stdout.match(/\[[\s\S]*\]/m);
  const source = listMatch ? listMatch[0] : stdout;
  const numericTokens = Array.from(source.matchAll(/\d+/g))
    .map((match) => Number.parseInt(match[0] ?? "0", 10))
    .filter((value) => Number.isFinite(value));

  if (numericTokens.length < ticks) {
    throw new Error(
      `Unable to parse ${ticks} digests from Bend output (found ${numericTokens.length}). Raw output: ${stdout.slice(0, 500)}`
    );
  }

  return numericTokens.slice(-ticks).map((value) => value & MASK_U24);
}

function asHexDigest(value: number): string {
  return (value & MASK_U24).toString(16).padStart(6, "0");
}

export async function isBendInstalled(): Promise<boolean> {
  return new Promise((resolveInstalled) => {
    const proc = spawn(process.env.BEND_BIN ?? "bend", ["--version"], {
      stdio: "ignore"
    });
    proc.on("error", () => resolveInstalled(false));
    proc.on("exit", (code) => resolveInstalled(code === 0));
  });
}

export async function runBendBackend(options: BendRunOptions): Promise<FrameMessage[]> {
  if (options.includeState) {
    throw new Error("Bend backend currently supports digest-only mode (includeState=false).");
  }

  const bendEntry = options.bendEntryPath ?? resolve(__dirname, "sim.bend");
  await access(bendEntry, fsConstants.R_OK);
  const template = await readFile(bendEntry, "utf8");

  const tmp = await mkdtemp(join(tmpdir(), "ca-sim-bend-"));
  try {
    const generatedPath = join(tmp, "generated.bend");
    const rendered = renderTemplate(template, options);
    await writeFile(generatedPath, rendered, "utf8");

    const cliMode = cliModeFromBackend(options.backend);
    const bendBin = process.env.BEND_BIN ?? "bend";

    const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolveRun, rejectRun) => {
        const proc = spawn(bendBin, [cliMode, generatedPath], {
          stdio: ["ignore", "pipe", "pipe"]
        });
        let out = "";
        let err = "";
        proc.stdout.on("data", (chunk) => {
          out += String(chunk);
        });
        proc.stderr.on("data", (chunk) => {
          err += String(chunk);
        });
        proc.on("error", rejectRun);
        proc.on("close", (exitCode) => {
          resolveRun({
            code: exitCode ?? 1,
            stdout: out,
            stderr: err
          });
        });
      }
    );

    if (code !== 0) {
      throw new Error(`Bend run failed (backend=${options.backend}): ${stderr || "unknown error"}`);
    }

    const digests = parseDigestList(stdout, options.ticks);
    const frames: FrameMessage[] = [];
    for (let i = 0; i < digests.length; i += 1) {
      frames.push({
        runId: options.runId,
        backend: options.backend,
        tick: i + 1,
        digest: asHexDigest(digests[i] ?? 0),
        metrics: {
          popEmpty: 0,
          popFire: 0,
          popWater: 0,
          popGrass: 0,
          births: 0,
          deaths: 0,
          meanEnergy10: 0,
          meanAge: 0
        }
      });
    }

    return frames;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
