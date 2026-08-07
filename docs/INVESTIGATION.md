# Investigation notes

## Scope inspected

- Installed Subway Builder 1.4.14 Electron application
- Live `window.SubwayBuilderAPI` 1.0.0 object
- Official Subway Builder Mod API map and lifecycle documentation
- Existing Railyard mods and manifests
- Shipped renderer and worker bundle structure
- Large-save fixed-camera behavior
- Public MapLibre pixel-ratio, event, style, and layer-visibility methods

No proprietary game bundle or extracted source is included in this repository.

## Architecture findings

The application uses React, Zustand, MapLibre GL, Deck.gl, and Recharts. It ships workers for simulation, commuter/pathfinding, interlined routes, and arrow computation.

The 1.4.14 renderer includes a worker wrapper for the main simulation tick, but the observed active path uses a main-thread fallback. Privately forcing the wrapper could add large state-cloning costs and would depend on bundled implementation details. A safe architecture change would require a game-owned persistent worker with incremental state transfer and public lifecycle control.

The public API exposes:

- `onMapReady` with the raw MapLibre instance
- game load, save, end, pause, and speed hooks
- read-only save name, pause state, and simulation speed
- storage and UI registration
- public map events and style methods through MapLibre

It does not expose panel refresh rates, autosave serialization, pathfinding scheduling, simulation-worker control, train/passenger render detail, or idle-render scheduling.

v0.2 uses the read-only game-state values in benchmark snapshots. It never changes simulation state through that API.

## Measured initial bottleneck

The NYC `save11` network contains 195 stations and 221 trains. In one fixed scene it measured approximately 23 FPS both at normal speed and while paused. That result suggests renderer cost dominated that scene.

On the Retina test display, a 1155×1073 map used a 2310×2146 backing canvas. Public MapLibre pixel-ratio control directly reduces that backing resolution without changing geometry, routing, simulation state, or saves.

## v0.2 implementation decisions

### Adaptive scaling

Automatic mode now combines an exponential moving frame-time average with p95 frame time. It retains asymmetric sustained-sample thresholds and a 10-second cooldown. Decisions pause after operations that can create temporary frame spikes: load, save, resize, focus, movement, zoom, and style changes. Measurement windows that overlap those stabilization periods do not enter the adaptive average.

The controller supports 30, 45, and 60 FPS targets and 85%, 70%, and 50% quality floors. It never changes simulation speed.

### Render-scale housekeeping

The mod captures the map's existing pixel ratio as its 100% baseline and compares the active ratio with the requested value before writing. It does not call `map.resize()` directly because MapLibre owns the effects of `setPixelRatio()`. The public getter exposes the ratio but not whether it came from implicit device DPR or an explicit override, so a value equal to the current device DPR is treated as implicit and rebased between displays; any other captured numeric ratio is preserved.

### Camera movement safety

Changing MapLibre's pixel ratio from `movestart` interrupts active camera gestures in the live game. v0.2 therefore never changes pixel ratio while panning, zooming, or rotating. Movement events only pause adaptive decisions and exclude unstable measurement windows; any pending scale is applied after movement ends.

### Audited allowlist level of detail

The raw map style provides layer IDs, types, and layout visibility. v0.2 deliberately uses a fail-open allowlist recovered from the inspected Subway Builder 1.4.14 style:

- decorative LOD: `building-foundations` and `buildings-3d`
- transit LOD: `signal-lines`, `signal-lines-under`, `signal-points`, `signal-points-under`, `track-arrows-path`, and `route-arrows-path`

These IDs are an audited implementation assumption, not an official stable API contract. Routes, stations, trains, labels, and any unknown or newly introduced IDs are ignored until audited. Before hiding an allowed layer, the mod records its effective visibility. Disable, zoom restoration, game exit, and hot reload restore the same effective state. Style reloads restore the outgoing style before auditing the replacement.

Minor-label LOD was not implemented because reliably distinguishing decorative labels from gameplay-relevant labels across styles needs stronger metadata than layer names alone.

Train and passenger animation LOD was not implemented because the Mod API does not expose stable animation-detail controls.

### Inactive-window mode

Standard focus and visibility events can safely lower map resolution and stop only this mod's sampler and diagnostic timer. The mod does not pause the game or intercept MapLibre, Deck.gl, or global animation frames.

### Diagnostics

The overlay reports direct measurements. Its GPU/render-versus-CPU hint is based on the observed FPS response after an automatic scale change, not browser hardware counters. It is intentionally labeled as a likely limitation rather than a definitive profiler result.

## Non-rendering investigation

### UI panels and charts

The game separates frequent and infrequent state updates, and panels mount conditionally. No public API controls base-game refresh cadence or exposes closed-panel work. No patch was implemented.

### Autosave

A large-save autosave produced a visible long operation during reconnaissance. The public hook can identify save timing but cannot replace or schedule serialization. v0.2 ignores short post-save spikes for adaptive decisions but does not change saving.

### Memory and garbage collection

Chromium may expose used JavaScript heap for diagnostics. Forced garbage collection and cache clearing remain rejected because they are not stable performance controls and can increase stalls or later load time.

### Simulation and workers

Pause-versus-normal results did not identify simulation as the first bottleneck in the tested fixed scene. The public API provides speed notifications but no main-thread timing, worker scheduling, or incremental state boundary. Private patching remains rejected.

### Continuous idle rendering

MapLibre and Deck.gl can continue animation work while a map is open. There is no supported game-level idle renderer control, and intercepting global animation frames would affect UI, audio, other mods, and map correctness. No limiter was implemented.

## Rejected changes

- global animation-frame or timer throttling
- private store or React component replacement
- worker bundle patching
- save serialization replacement
- pathfinding or route-cache patches
- forced garbage collection
- automatic Electron or V8 flag edits
- broad label hiding based only on layer names
- direct train/passenger animation mutation

## Version safety

The mod uses documented lifecycle hooks, public MapLibre methods, and standard browser focus and visibility events. Every optional map change is feature-checked and wrapped in failure isolation.

v0.3.0 widens the manifest range to `>=1.4.12 <2.0.0` after auditing the mod's full API surface against the Subway Builder 1.5.0 and 1.6.0 modding documentation: every hook, storage method, gameState getter, and MapLibre call the mod uses remains documented and unchanged. Two items still deserve in-game revalidation on 1.5/1.6 builds:

- The LOD layer allowlists were recovered from the 1.4.14 style, and 1.5/1.6 changed map colors and road rendering. The design is fail-open, and v0.3.0 additionally warns once and reports allowlist coverage in diagnostics when audited layers are missing, so a stale allowlist is visible instead of silent.
- The experimental tuning options rely on the documented `TICKS_PER_UPDATE`, `MAX_TICKS_PER_UPDATE`, and `MAX_TRANSFERS` variables. They are validated by the game, applied through deep merge, and restored from a baseline captured before the first write.
