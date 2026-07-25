# Performance API requests

These are public hooks that would enable additional measured optimizations without patching private game code. None is required for the current v0.2 features.

## UI panel activity

Requested:

- stable panel-open and panel-close events
- per-panel refresh policy or documented refresh intervals
- an opt-in way for mods to suspend their own registered panel work while closed

Why: route manager, statistics, charts, and other expensive panels can be profiled separately, but the current API cannot attribute or adjust base-game panel work.

Safety requirement: the game must retain ownership of state updates, and hiding a panel must not change simulation or recorded statistics.

## Save profiling

Requested:

- save-start and save-end events with duration
- read-only serialization timing and serialized-size metrics
- an official way to schedule non-urgent autosaves around interaction

Why: a large-save stall was observed, but replacing save serialization or timers privately would risk data loss.

Safety requirement: mods must not receive raw private save data or bypass atomic game-owned writes.

## Simulation and worker metrics

Requested:

- read-only main-thread simulation time per tick
- read-only worker queue and task-duration metrics
- public indication of whether the simulation worker path is active

Why: pause, normal, and ultra-fast comparisons can identify pressure, but current hooks expose speed changes rather than execution cost.

Safety requirement: measurement first. Scheduling or worker control should remain game-owned unless a versioned, validated extension point is designed.

## Rendering detail

Requested:

- stable semantic layer metadata such as `decorative`, `gameplay-critical`, `arrow`, and `signal`
- public train and passenger animation-detail controls
- an official idle-render or dirty-render mode with correctness guarantees

Why: MapLibre layer visibility supports a narrow, fail-open allowlist today, but the audited IDs are an implementation assumption rather than an official stable contract. Semantic metadata would avoid relying on layer IDs. Train/passenger animation detail and continuous idle rendering cannot be changed safely through the current API.

Safety requirement: every setting must be reversible, style-reload-safe, and unable to hide route, station, alert, or construction information accidentally.

## Performance telemetry

Requested:

- frame CPU time and renderer/GPU time when available
- long-task notifications attributed to simulation, UI, save, map, or mods
- documented memory metrics beyond optional Chromium heap exposure

Why: FPS response to resolution changes is a useful hint, but direct attribution would make benchmark conclusions more reliable.
