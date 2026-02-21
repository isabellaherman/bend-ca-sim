export function tickIntervalMs(tickRateUi: number): number {
  return Math.max(16, Math.round(1000 / Math.max(1, tickRateUi)));
}

type AutoplayLoopInput = {
  tickRateUi: number;
  isPaused: () => boolean;
  onTick: () => void;
};

export function startAutoplayLoop(input: AutoplayLoopInput): NodeJS.Timeout {
  return setInterval(() => {
    if (input.isPaused()) {
      return;
    }
    input.onTick();
  }, tickIntervalMs(input.tickRateUi));
}
