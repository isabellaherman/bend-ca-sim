import { performance } from "node:perf_hooks";
import { normalizeSimConfig } from "@ca-sim/contracts";
import { isBendInstalled, runBendBackend } from "@ca-sim/bend";
import { ReferenceSimulator } from "@ca-sim/reference";

type BenchRow = {
  backend: string;
  grid: string;
  ticks: number;
  ticksPerSec: number;
  nsPerCellTick: number;
};

const WARMUP = Number(process.env.BENCH_WARMUP ?? 100);
const TICKS = Number(process.env.BENCH_TICKS ?? 2000);
const GRIDS = (process.env.BENCH_GRIDS ?? "128,256,512")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function runJsBenchmark(size: number, repeats = 3): BenchRow {
  const samples: number[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const config = normalizeSimConfig({
      width: size,
      height: size,
      seed: 555 + i,
      initMode: "clustered",
      chunkTicks: 4,
      tickRateUi: 5
    });
    const sim = new ReferenceSimulator(config);
    for (let w = 0; w < WARMUP; w += 1) {
      sim.step();
    }
    const t0 = performance.now();
    for (let t = 0; t < TICKS; t += 1) {
      sim.step();
    }
    const elapsedMs = performance.now() - t0;
    samples.push(elapsedMs / 1000);
  }

  const seconds = median(samples);
  const ticksPerSec = TICKS / seconds;
  const nsPerCellTick = (seconds * 1e9) / (TICKS * size * size);
  return {
    backend: "js",
    grid: `${size}x${size}`,
    ticks: TICKS,
    ticksPerSec,
    nsPerCellTick
  };
}

async function runBendBenchmark(size: number, backend: "bend-rs" | "bend-c"): Promise<BenchRow> {
  const config = normalizeSimConfig({
    width: size,
    height: size,
    seed: 777,
    initMode: "clustered"
  });
  const t0 = performance.now();
  await runBendBackend({
    backend,
    config,
    ticks: TICKS,
    includeState: false,
    runId: `bench-${backend}-${size}-${Date.now()}`
  });
  const seconds = (performance.now() - t0) / 1000;
  const ticksPerSec = TICKS / seconds;
  const nsPerCellTick = (seconds * 1e9) / (TICKS * size * size);
  return {
    backend,
    grid: `${size}x${size}`,
    ticks: TICKS,
    ticksPerSec,
    nsPerCellTick
  };
}

function printTable(rows: BenchRow[]): void {
  process.stdout.write("\nbackend   grid      ticks   ticks/sec   ns/cell/tick\n");
  process.stdout.write("-----------------------------------------------------\n");
  for (const row of rows) {
    process.stdout.write(
      `${row.backend.padEnd(8)} ${row.grid.padEnd(8)} ${String(row.ticks).padEnd(7)} ${row.ticksPerSec
        .toFixed(2)
        .padEnd(10)} ${row.nsPerCellTick.toFixed(2)}\n`
    );
  }
}

async function main(): Promise<void> {
  process.stdout.write(`[bench] warmup=${WARMUP}, ticks=${TICKS}, grids=${GRIDS.join(",")}\n`);
  const rows: BenchRow[] = [];
  for (const size of GRIDS) {
    rows.push(runJsBenchmark(size));
  }

  const bendReady = await isBendInstalled();
  if (!bendReady) {
    process.stdout.write("[bench] bend not installed; skipping bend backends.\n");
    printTable(rows);
    return;
  }

  for (const size of GRIDS) {
    for (const backend of ["bend-rs", "bend-c"] as const) {
      try {
        rows.push(await runBendBenchmark(size, backend));
      } catch (error) {
        process.stderr.write(`[bench] ${backend} ${size}x${size} failed: ${(error as Error).message}\n`);
      }
    }
  }

  printTable(rows);
}

main().catch((error) => {
  process.stderr.write(`[bench] fatal error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
