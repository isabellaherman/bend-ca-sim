# Bend Engine Integration

`runner.ts` defines the runtime contract between orchestration scripts and a Bend kernel.

## Runtime contract

- `src/sim.bend` is a template kernel.
- The Node runner injects config/tick constants by replacing `__TOKENS__`.
- The rendered temporary Bend file is executed with:

```bash
bend run-rs <generated.bend>
bend run-c  <generated.bend>
```

The Bend program returns a list of u24 digests (one per tick) on stdout.
The runner parses that list and builds `FrameMessage[]`.

Current limitation: bend runner is digest-only (`includeState=false`).

## Current status

- Bridge runtime is fully functional with the JS reference engine.
- Bend kernel in `src/sim.bend` implements init + tick update + digest emission.
- Parity scripts compare `bend-rs` and `bend-c` digest streams against JS reference.
