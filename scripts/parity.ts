import { performance } from "node:perf_hooks";
import { normalizeSimConfig } from "@ca-sim/contracts";
import { isBendInstalled, runBendBackend } from "@ca-sim/bend";
import { ReferenceSimulator } from "@ca-sim/reference";

const TICKS = Number(process.env.PARITY_TICKS ?? 500);

function runJsDigests(config: ReturnType<typeof normalizeSimConfig>, ticks: number): string[] {
  const sim = new ReferenceSimulator(config);
  const out: string[] = [];
  for (let i = 0; i < ticks; i += 1) {
    out.push(sim.step().digest);
  }
  return out;
}

function assertDigestEqual(label: string, left: string[], right: string[]): void {
  if (left.length !== right.length) {
    throw new Error(`${label}: digest length mismatch (${left.length} vs ${right.length})`);
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      throw new Error(`${label}: mismatch at tick ${i + 1} (${left[i]} != ${right[i]})`);
    }
  }
}

async function main(): Promise<void> {
  const config = normalizeSimConfig({
    width: Number(process.env.PARITY_WIDTH ?? 128),
    height: Number(process.env.PARITY_HEIGHT ?? 128),
    seed: Number(process.env.PARITY_SEED ?? 424242),
    initMode:
      (process.env.PARITY_INIT_MODE as "random" | "clustered" | "triad" | "single-block" | undefined) ??
      "clustered"
  });

  process.stdout.write(`[parity] config=${config.width}x${config.height}, ticks=${TICKS}, seed=${config.seed}\n`);

  const t0 = performance.now();
  const jsA = runJsDigests(config, TICKS);
  const jsB = runJsDigests(config, TICKS);
  const t1 = performance.now();

  assertDigestEqual("js-determinism", jsA, jsB);
  process.stdout.write(`[parity] js deterministic check passed in ${(t1 - t0).toFixed(1)}ms\n`);

  const bendReady = await isBendInstalled();
  if (!bendReady) {
    process.stdout.write("[parity] bend not installed; skipping bend-rs / bend-c parity.\n");
    return;
  }

  const runId = `parity-${Date.now()}`;
  try {
    const rsFrames = await runBendBackend({
      backend: "bend-rs",
      config,
      ticks: TICKS,
      includeState: false,
      runId
    });
    const cFrames = await runBendBackend({
      backend: "bend-c",
      config,
      ticks: TICKS,
      includeState: false,
      runId
    });

    const rsDigests = rsFrames.map((frame) => frame.digest);
    const cDigests = cFrames.map((frame) => frame.digest);
    assertDigestEqual("js-vs-bend-rs", jsA, rsDigests);
    assertDigestEqual("js-vs-bend-c", jsA, cDigests);
    assertDigestEqual("bend-rs-vs-bend-c", rsDigests, cDigests);
    process.stdout.write("[parity] full parity passed (js, bend-rs, bend-c)\n");
  } catch (error) {
    process.stderr.write(`[parity] bend parity failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[parity] fatal error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
