import type { ControlMessage, RunPhase } from "@ca-sim/contracts";

export interface ControlSnapshot {
  hasRun: boolean;
  phase: RunPhase;
}

export type ControlDecision =
  | { kind: "start_new" }
  | { kind: "resume" }
  | { kind: "pause" }
  | { kind: "reset" }
  | { kind: "step"; ticks: number }
  | { kind: "stop" }
  | { kind: "noop"; reason: string }
  | { kind: "error"; message: string };

function normalizeStepTicks(ticks: number | undefined): number {
  return Math.max(1, Math.floor(ticks ?? 1));
}

export function decideControl(snapshot: ControlSnapshot, message: ControlMessage): ControlDecision {
  switch (message.type) {
    case "start": {
      if (!snapshot.hasRun) {
        return { kind: "start_new" };
      }
      if (snapshot.phase === "paused") {
        return { kind: "resume" };
      }
      return { kind: "noop", reason: "Start ignored: run is already active." };
    }
    case "pause": {
      if (snapshot.phase === "running") {
        return { kind: "pause" };
      }
      return { kind: "noop", reason: "Pause ignored: run is not running." };
    }
    case "resume": {
      if (snapshot.phase === "paused") {
        return { kind: "resume" };
      }
      return { kind: "noop", reason: "Resume ignored: run is not paused." };
    }
    case "reset": {
      if (!snapshot.hasRun) {
        return { kind: "error", message: "No active run. Start a run before reset." };
      }
      return { kind: "reset" };
    }
    case "step": {
      if (!snapshot.hasRun) {
        return { kind: "error", message: "No active run. Start a run before stepping." };
      }
      return { kind: "step", ticks: normalizeStepTicks(message.ticks) };
    }
    case "stop": {
      if (!snapshot.hasRun) {
        return { kind: "noop", reason: "Stop ignored: no active run." };
      }
      return { kind: "stop" };
    }
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}
