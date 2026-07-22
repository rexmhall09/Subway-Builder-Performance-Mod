# Investigation notes

## Scope inspected

- Installed Subway Builder 1.4.14 Electron application
- Live `window.SubwayBuilderAPI` 1.0.0 object
- Official Subway Builder Mod API documentation
- Current Railyard Registry schema, submission form, security rules, and accepted mod releases
- Installed Railyard mods and registry manifests
- Shipped renderer and worker bundle structure
- Live large-save renderer behavior

No proprietary game bundle or extracted source is included in this repository.

## Architecture findings

The application uses React, Zustand, MapLibre GL, Deck.gl, and Recharts. It ships dedicated worker bundles for:

- simulation engine worker
- commuter/pathfinding worker
- interlined-route worker
- arrow-computation worker

The 1.4.14 renderer contains a worker wrapper for the main simulation tick, but the active path currently uses its main-thread fallback. The wrapper sends the full synchronized simulation state when invoked, so privately forcing it on could replace main-thread work with large structured-clone costs. A real architecture improvement would require a persistent game-side worker with incremental state patches and profiling across save sizes; the Mod API does not expose that boundary.

The UI distinguishes frequent from infrequent state updates. Completed commute data is filtered on an interval, and simulation performance metrics are already tracked internally. Those findings make broad timer interception or store replacement both redundant and risky.

The public API provides lifecycle hooks, read-only game-state getters, actions, map registration, storage, and UI extension points. It does not provide stable controls for:

- changing passenger pathfinding internals
- changing base-game statistics or graph refresh intervals
- suspending closed base-game panels
- changing train render culling
- replacing save serialization
- overriding worker tick scheduling

## Measured bottleneck

The NYC `save11` network contains 195 stations and 221 trains. In a fixed scene it measured approximately 23 FPS both at normal speed and while paused. The nearly identical results indicate renderer/GPU cost rather than simulation tick cost.

On the Retina test display, a 1155×1073 map occupied a 2310×2146 backing canvas. Reducing MapLibre's public pixel ratio directly reduces the number of rendered pixels without changing route geometry, map data, or simulation state. This is therefore exposed as an explicit visual tradeoff with a native-quality default.

The same measured control supports an optional adaptive mode. It uses conservative hysteresis to step among the fixed, tested scale values toward 30 FPS. It never changes simulation speed and is disabled by default.

## Existing behavior observed

- The game includes a built-in 10-second frame logger.
- MapLibre, Deck.gl, and the frame logger each maintain animation-frame work while a game map is open.
- Custom map layers are checked after style updates so they survive style reloads.
- A large-save autosave produced a visible slow-operation warning during profiling, but the Mod API does not expose a safe save-serialization replacement.
- The game already has a 2D/3D map control, including its own building-extrusion handling. Duplicating it in this mod would add settings without adding capability.
- Subway Builder 1.4.14 ships Electron 38.4.0 and already exposes GPU rasterization, high-performance GPU selection, automatic V8 heap sizing, and advanced Chromium flags through its own settings. Both GPU options were enabled on the tested installation.

## Rejected changes

### Global animation-frame throttling

Rejected because it would affect unrelated UI animation, MapLibre, Deck.gl, audio scheduling, and other mods. It would be version-fragile and could change interaction behavior.

### Internal worker patching

Rejected because workers are bundled implementation details and the public API exposes no stable replacement hook. Modifying `app.asar` would bypass Railyard, conflict with application integrity and updates, and could silently corrupt routing or simulation behavior after a game update.

### Statistics and graph throttling

Not implemented. Panels already mount conditionally and the public API does not expose their base-game refresh cadence. No repeatable bottleneck was demonstrated.

### Separate 3D-building toggle

Not implemented because Subway Builder already exposes 2D/3D rendering in the main map controls. Reaching into private style-layer IDs would be less compatible than the built-in control.

### Custom-layer recovery suppression

Rejected for the first release. Although recovery checks were visible during frame profiling, suppressing the game's private listener could cause mod layers to disappear after a style reload. The measured cost has not yet justified that compatibility risk.

### Cache clearing or forced garbage collection

Rejected. Clearing Electron caches does not improve steady-state game code and can increase subsequent loading time. Forced garbage collection is not a stable renderer API and often creates larger frame stalls.

### Automatic memory-limit edits

Rejected. Memory limits are startup configuration, vary by machine, and are not safely writable through Mod API 1.0.0 in the tested build. Troubleshooting should direct users to official game guidance rather than changing files silently.

## Version safety

The mod uses only official lifecycle hooks, public MapLibre pixel-ratio methods, and the standard Page Visibility API. It checks each method before use, catches runtime failures, and defaults to native rendering. The manifest restricts the initial release to Subway Builder 1.4.x from 1.4.12 onward; later versions require revalidation.
