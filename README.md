# CA-Sim v0

Deterministic cellular automata sandbox with:

- Bend-oriented simulation architecture
- JS reference engine for parity and tooling
- Local bridge for real-time canvas rendering

## Workspace layout

- `packages/contracts`: shared types and defaults
- `engine/reference`: deterministic SoA fixed-point reference engine
- `engine/bend`: Bend runtime wrapper and Bend kernel template
- `apps/bridge`: WebSocket control + frame streaming service
- `apps/viewer`: Vite + TypeScript Canvas client
- `scripts`: parity and benchmark orchestrators

## Getting started

```bash
npm install
npm run dev:bridge
npm run dev:viewer
```

Bridge default: `ws://localhost:8787`  
Viewer default: `http://localhost:5173`

## Verification commands

```bash
npm run test
npm run parity
npm run bench
```

`parity` and `bench` always run JS reference checks. Bend comparisons (`run-rs`, `run-c`) are attempted when `bend` is installed.
