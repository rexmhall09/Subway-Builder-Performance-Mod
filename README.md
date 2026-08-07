# Subway Builder Performance

Subway Builder Performance improves map rendering with adaptive resolution, quality presets, optional level-of-detail controls, an FPS overlay, and diagnostics. It uses the public Subway Builder Mod API and keeps every tradeoff optional. By default it does not change simulation rules, routing, finances, or saves.

Version 0.3.0 supports Subway Builder 1.4.12 and newer, including the 1.5 and 1.6 releases.

![Performance settings](docs/images/performance-settings.png)

## Features

- Native / Safe, Balanced, Maximum Performance, Battery Saver, and Custom presets
- Fixed or automatic map render scale with selectable FPS targets and a minimum-quality floor
- Optional audited-allowlist LOD for distant 3D decoration and transit detail
- Inactive-window quality and monitoring reduction
- Live FPS counter with an optional detailed overlay (p95 frame time, scale, limitation hint)
- Benchmark snapshot capture with JSON export, including the stable game session ID, game clock, and train churn on Subway Builder 1.5+
- Diagnostic logging with layer-allowlist coverage and the active simulation cadence

## Experimental tuning (off by default)

On Subway Builder 1.5+ the game exposes moddable variables through `modifyConstants` and `modifyPathfindingRules`. The mod offers two clearly labeled opt-ins built on that official API:

- **High-speed update batching** batches game-state, train, and commuter updates at fast and ultra-fast speeds. Every simulation tick still runs; on-screen refreshes become chunkier at high speed.
- **Reduced pathfinding depth** lowers the maximum journey transfers by one. This cuts commute-simulation CPU cost on large networks but can change which journeys commuters pick, which changes ridership.

Both options are off unless you enable them, revert to game defaults when disabled, and are fully restored when the mod unloads. They are the only features in this mod that can affect gameplay, and the settings panel says so next to the controls.

## Version notes

- On Subway Builder 1.5+ settings persist through the game's scoped mod storage. On 1.4.x the mod falls back to a namespaced local mirror, as in v0.2.
- The LOD layer allowlists were audited against the 1.4.14 map style. The 1.5/1.6 style changes are fail-open: if an audited layer no longer exists, the toggle safely does nothing and diagnostics report the reduced coverage so it can be revalidated.
