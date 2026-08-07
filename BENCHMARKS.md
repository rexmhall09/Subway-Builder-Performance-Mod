# Benchmarks

## Reporting rules

Every comparison must use the same:

- game version and enabled-mod set
- save and save revision
- camera position, zoom, pitch, and visible layers
- simulation speed
- window size, display, and device pixel ratio
- warm-up and capture duration

Warm up for 15 seconds, capture for at least 30 seconds, and run three trials per configuration. Report the median of each metric's three trial outputs. Do not capture during autosave, city download, a panel transition, display switching, or DevTools recording.

Record:

- median FPS
- whole-capture p95 frame time and median one-second-window p95
- long frames over 33.4 ms
- JavaScript heap when available
- zoom and render scale
- paused, normal, or ultra-fast simulation
- fixed camera, active camera movement, or expensive UI panel
- correctness result

The in-game **Benchmark snapshot** control exports measured timing, scale and zoom ranges, public save/speed/pause metadata at capture start and stop, focus state, save-event markers, and optional heap data as JSON. Its capture window is independent of adaptive camera and resize stabilization resets. Record the save revision, scene category, exact camera path or open panel, and correctness result alongside each snapshot. Start a new capture for every trial.

## Baseline validity

All recorded results below were measured on Subway Builder 1.4.14. The 1.5.0 release improved large-map performance by roughly 35% on Windows and 15% on Mac and rewrote pathfinding, and 1.6.0 added roughly 15% and 5% more. Treat pre-1.5 numbers as historical: they justify the mod's design but are not valid baselines for new comparisons. Re-run benchmarks on the current game version before publishing any new claim.

## Development-machine reconnaissance

Date: 2026-07-22  
Game: Subway Builder 1.4.14  
Mod API: 1.0.0  
Platform: macOS, Retina device pixel ratio 2  
Viewport: 1155×1073 CSS pixels  
Native canvas: 2310×2146 pixels

These 10-second samples identified the initial bottleneck. Other installed mods were active, so they are not isolated release results.

| Save | Network | Simulation | Scale | FPS | p95 frame | Worst frame | Frames >33.4 ms | JS heap |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| NYC `save11` | 195 stations, 221 trains | Normal | 100% | 23.0 | 50.4 ms | 122.3 ms | 140 | 124.9 MB |
| NYC `save11` | 195 stations, 221 trains | Paused | 100% | 23.1 | 50.6 ms | 123.7 ms | 151 | 124.9 MB |

The unchanged paused result suggests that this fixed scene was renderer-limited. It justified testing canvas resolution before any simulation change.

## v0.1 integration smoke test

The v0.1 mod was linked into the live mods directory and exercised on the same large NYC scene. After an eight-second settle, the visible counter read:

| Save | Simulation | Scale | Observed FPS |
| --- | --- | ---: | ---: |
| NYC `save11` | Normal | 100% | 24 |
| NYC `save11` | Normal | 50% | 27 |

The 12.5% difference is a smoke result, not a release claim. The sample was short, other mods were active, and the save continued simulating between readings.

## v0.2 isolated baseline matrix

Status: **Pending in-game three-trial runs.**

No values are inferred from unit tests or the v0.1 smoke test. A row is completed only after all three trials and the correctness checks pass.

| Save | Speed | Scene | Native / Safe | Balanced | Maximum | Battery Saver | Correctness |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Small | Paused | Fixed camera | Pending | Pending | Pending | Pending | Pending |
| Small | Normal | Fixed camera | Pending | Pending | Pending | Pending | Pending |
| Small | Ultra fast | Fixed camera | Pending | Pending | Pending | Pending | Pending |
| Small | Normal | Active pan/zoom | Pending | Pending | Pending | Pending | Pending |
| Small | Normal | Expensive panel | Pending | Pending | Pending | Pending | Pending |
| Large | Paused | Fixed camera | Pending | Pending | Pending | Pending | Pending |
| Large | Normal | Fixed camera | Pending | Pending | Pending | Pending | Pending |
| Large | Ultra fast | Fixed camera | Pending | Pending | Pending | Pending | Pending |
| Large | Normal | Active pan/zoom | Pending | Pending | Pending | Pending | Pending |
| Large | Normal | Expensive panel | Pending | Pending | Pending | Pending | Pending |

### v0.2 release validation snapshots

Date: 2026-07-25

Game: Subway Builder 1.4.14 via Railyard 0.2.8

Mod API: 1.0.0
Platform: macOS, DPR 2, 1710×1042 CSS pixels

The v0.2 mod was enabled through the in-game Mod Manager, reloaded successfully (12 public hooks), and its Performance settings were exercised on NYC `save11` (195 stations, 221 trains). These are single, fixed-camera, paused captures with the Settings panel open. The panel limited both captures to approximately 30 FPS, so they validate installation, capture output, pixel-ratio application, and state stability only; they are not a performance comparison or release claim.

| Save | Scene | Scale | Duration | Median FPS | p95 frame | Worst frame | Long frames | Heap | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| NYC `save11` | Paused, fixed camera, Settings panel | 100% | 38.4 s | 30.0 | 34.3 ms | 728.0 ms | 426 | 124.9 MB | v0.2 loaded; stable state |
| NYC `save11` | Paused, fixed camera, Settings panel | 50% | 43.0 s | 30.0 | 34.2 ms | 728.4 ms | 461 | 124.9 MB | map pixel ratio changed from 2 to 1; stable state |

## Feature isolation matrix

Each optional optimization must also be tested by changing only that feature from a matching baseline.

| Feature | Required comparison | Result |
| --- | --- | --- |
| 30/45/60 FPS targets | Same fixed scene and quality floor | Pending |
| 85/70/50% minimum | Same target and fixed scene | Pending |
| Decorative LOD | Same distant zoom with audited allowlist layers present | Pending |
| Transit-detail LOD | Same distant zoom with audited arrows/signals present | Pending |
| Inactive-window mode | Focused versus unfocused renderer and mod timers | Pending |
| Pixel-ratio write avoidance | Repeated unchanged resize/style events | Mock coverage added; live trace pending |

An optional feature is removed or revised if it lacks a repeatable benefit, changes simulation behavior, fails to restore map state, or conflicts with a supported game version.

## Correctness checklist

For every release candidate:

- Load small and large saves at native quality.
- Run paused, normal, and ultra-fast simulation.
- Compare fixed camera, active movement, and expensive UI panels.
- Change each setting independently, then disable it and verify exact effective restoration.
- Move the game between displays with different scaling.
- Change map style with each LOD option enabled and disabled.
- Confirm passenger routing completes.
- Confirm trains move, stop, and route normally.
- Confirm money, revenue, and expenses change normally.
- Save to a new slot, return to the menu, and reload it.
- Confirm the mod never writes to save data.
- Hot reload twice and verify one settings panel, one overlay, and one listener set.
- Return to the main menu and confirm sampling and logging stop.
- Disable the mod and confirm the original pixel ratio and effective layer visibility return.

## Automated coverage

The mock integration suite covers:

- v0.1-to-v0.2 migration
- every preset's stored controls
- selectable targets and minimum quality
- sustained adaptive downshift, p95-only pressure, stabilization exclusion, and recovery
- movement-event handling that never changes pixel ratio during an active gesture
- audited LOD allowlists, thresholds, style replacement, and retryable effective visibility restoration
- inactive-window sampling behavior
- display device-pixel-ratio changes
- redundant pixel-ratio write and direct-resize avoidance
- independent benchmark windows, frozen start/stop metadata, and JSON export
- partial-startup, game-end, and hot-reload cleanup
- unsupported-map failure safety

Automated tests validate controller behavior and cleanup. They do not substitute for the pending in-game performance and correctness matrix.
