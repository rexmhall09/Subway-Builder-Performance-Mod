# Changelog

All notable changes are documented here. Versions follow Semantic Versioning.

## 0.1.0

- Add fixed 100%, 85%, 70%, and 50% map render scales.
- Add an Automatic option to the render-scale menu that targets 30 FPS with hysteresis and cooldowns.
- Add an optional FPS overlay and diagnostic logging.
- Suspend the mod's monitoring loop while the game document is hidden.
- Stop monitoring and release the map reference when a game session ends.
- Restore native rendering when the mod is disabled or reloaded.
- Add fail-safe checks for unsupported game and MapLibre APIs.
