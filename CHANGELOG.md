# Changelog

All notable changes are documented here. Versions follow Semantic Versioning.

## 0.3.0

Compatibility with Subway Builder 1.5 and 1.6.

- Widen the supported game range to `>=1.4.12 <2.0.0` so the mod installs on Subway Builder 1.5.x and 1.6.x.
- Persist settings through the game's scoped mod storage on 1.5+, migrate the v0.2 local mirror into it once, and retire the mirror. The 1.4.x mirror fallback remains.
- Unsubscribe every lifecycle hook on unload using the 1.6 unsubscribe support, so reloads no longer leave listeners behind.
- Warn once, safely, when an audited LOD allowlist matches no layer in the running game build, and report allowlist coverage in diagnostics so the 1.5/1.6 map styles can be revalidated.

New features on Subway Builder 1.5+.

- Add opt-in experimental tuning built on the official game-variable API: high-speed update batching (`TICKS_PER_UPDATE` at fast and ultra-fast, capped by `MAX_TICKS_PER_UPDATE`) and reduced pathfinding depth (`MAX_TRANSFERS` lowered by one). Both are off by default, labeled as gameplay-affecting, revert when disabled, and restore game defaults on unload and at game end.
- Record the stable game session ID, current game day and hour, and per-capture train spawn/removal counts in benchmark snapshots, plus day-change, game-warning, and game-error event markers.
- Log the active simulation cadence and LOD allowlist coverage in diagnostics.
- Migrate settings to version 3; existing presets and choices are preserved and the new tuning options default to off.

## 0.2.2

- Persist every Performance setting immediately across app restarts.
- Keep the documented Mod API storage path as a lifecycle-backed copy.
- Register lifecycle hooks before asynchronous initialization so the game preserves the mod context.

## 0.2.1

- Refresh the FPS counter four times per second using a separate half-second rolling sample.
- Keep adaptive scaling and stable p95 diagnostics on their existing one-second measurement window.
- Avoid unnecessary overlay text updates.

## 0.2.0

- Add Native / Safe, Balanced, Maximum Performance, Battery Saver, and Custom presets.
- Add selectable 30, 45, and 60 FPS automatic targets.
- Add 85%, 70%, and 50% minimum automatic quality.
- Use smoothed frame time and p95 frame time with conservative hysteresis and cooldowns.
- Delay adaptive decisions after load, save, resize, refocus, movement, zoom, and style changes.
- Avoid redundant pixel-ratio writes and direct `map.resize()` calls, and handle display device-pixel-ratio changes.
- Add optional audited-allowlist LOD for distant 3D buildings and foundations.
- Add optional audited-allowlist LOD for distant arrows and signals.
- Add optional inactive-window quality and monitoring reduction.
- Add a detailed overlay with p95 frame time, scale, and a measured limitation hint.
- Add independent benchmark capture and JSON export with whole-capture timing, environment, event markers, and start/stop state.
- Add versioned migration from v0.1 settings.
- Restore the inferred implicit DPR mode for equal-DPR baselines or the captured numeric pixel ratio, recorded effective layer visibility, and event listeners on cleanup.
- Keep map pixel ratio unchanged during pan, zoom, and rotate gestures so camera input remains uninterrupted.
- Simplify the in-game Performance footer to the release version only.
- Make the release workflow safe to rerun when a release tag already exists.

## 0.1.0

- Add fixed 100%, 85%, 70%, and 50% map render scales.
- Add an Automatic option that targets 30 FPS with hysteresis and cooldowns.
- Add an optional FPS overlay and diagnostic logging.
- Suspend monitoring while the game document is hidden.
- Stop monitoring and release the map reference when a game session ends.
- Restore native rendering when the mod is disabled or reloaded.
- Add fail-safe checks for unsupported game and MapLibre APIs.
