# Changelog

All notable changes are documented here. Versions follow Semantic Versioning.

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
