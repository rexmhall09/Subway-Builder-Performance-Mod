# Benchmarks

## Rules

Every reported comparison must use the same:

- game version and enabled-mod set
- save
- camera position, zoom, pitch, and visible layers
- simulation speed
- window size and display scaling
- warm-up period

Each configuration should run for at least 30 seconds after a 15-second warm-up. Record FPS, p95 frame time, frames over 33.4 ms, canvas size, and available JavaScript heap. Run at least three trials and report the median. Do not compare while an autosave, city download, panel transition, or DevTools recording is active.

## Development-machine baseline

Date: 2026-07-22  
Game: Subway Builder 1.4.14  
Mod API: 1.0.0  
Platform: macOS, Retina device pixel ratio 2  
Viewport: 1155×1073 CSS pixels  
Native canvas: 2310×2146 pixels

The following 10-second reconnaissance samples identified the bottleneck before implementation. Other user-installed mods were active, so these are not release-grade isolated A/B results.

| Save | Network | Simulation | Scale | FPS | p95 frame | Worst frame | Frames >33.4 ms | JS heap |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| NYC `save11` | 195 stations, 221 trains | Normal | 100% | 23.0 | 50.4 ms | 122.3 ms | 140 | 124.9 MB |
| NYC `save11` | 195 stations, 221 trains | Paused | 100% | 23.1 | 50.6 ms | 123.7 ms | 151 | 124.9 MB |

The unchanged paused result is the key finding: renderer cost dominated this scene. It justified testing canvas render scale and ruled out changing simulation behavior as the first intervention.

## Live integration smoke test

The mod was linked into the live mods directory, enabled through the in-game Mod Manager, and exercised on the same large NYC scene. The Performance panel, persistence, render-scale changes, FPS overlay, and restoration to native quality all worked. After an eight-second settle, the visible one-second counter read:

| Save | Simulation | Scale | Observed FPS |
| --- | --- | ---: | ---: |
| NYC `save11` | Normal | 100% | 24 |
| NYC `save11` | Normal | 50% | 27 |

That is a 12.5% same-session uplift, but it is a smoke result rather than a release claim. The development hot reload duplicated callbacks from other installed mods, the save continued simulating between readings, and the sample was shorter than the release protocol. The game was left at 100% native quality with the FPS overlay and diagnostic logging disabled.

## Main-menu lifecycle check

The monitoring lifecycle is deterministic and covered by the release test harness. With **Show FPS** enabled, ending a game session now cancels the pending animation-frame sampler, removes the overlay, releases the map reference, and restores native pixel ratio before the map is released.

| State after returning to main menu | Before | After |
| --- | ---: | ---: |
| Pending mod animation-frame callback | 1, continuously rescheduled | 0 |
| Retained MapLibre map reference | 1 | 0 |
| FPS overlay | Present | Removed |

This reduces background work and retained memory outside gameplay; it is not presented as an in-game FPS increase.

## Release matrix

Release claims remain pending until the mod is enabled in an isolated test profile and the matrix below is completed with three-trial medians.

Automatic render scale uses these same four scale levels. Its controller is unit-tested for sustained-low-FPS downshifts, cooldown behavior, disabled-state inactivity, and hidden-document suspension. A release claim for automatic mode still requires the live matrix below; controller tests do not substitute for an in-game benchmark.

| Save class | Simulation | 100% FPS | 85% FPS | 70% FPS | 50% FPS | Correctness checks |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Small | Paused | Pending | Pending | Pending | Pending | Pending |
| Small | Normal | Pending | Pending | Pending | Pending | Pending |
| Small | Ultra fast | Pending | Pending | Pending | Pending | Pending |
| Large | Paused | Pending | Pending | Pending | Pending | Pending |
| Large | Normal | Pending | Pending | Pending | Pending | Pending |
| Large | Ultra fast | Pending | Pending | Pending | Pending | Pending |

## Correctness checklist

For each release candidate:

- Load small and large saves at native scale.
- Change each setting independently and restore it.
- Select automatic scale long enough to observe a downshift, then select 100% and confirm native quality is restored.
- Run paused, normal, and ultra-fast simulation.
- Confirm passenger routing continues to complete.
- Confirm trains move, stop, and route normally.
- Confirm money, revenue, and expenses continue changing normally.
- Save to a new slot, return to the menu, and reload it.
- Confirm the mod never writes to save data.
- Hot reload the mod twice and verify there is one FPS overlay and one settings panel.
- Return to the main menu and confirm the overlay and monitoring loop stop.
- Disable the mod and confirm native device-pixel-ratio rendering is restored.

An optimization is removed if the median benefit is not repeatable or if any correctness check fails.
