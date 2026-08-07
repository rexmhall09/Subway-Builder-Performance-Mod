# Railyard submission

The published releases use Railyard's GitHub Releases update flow.

## Prepared listing

- **Mod ID:** `subway-builder-performance`
- **Display name:** Subway Builder Performance
- **Author:** `rexmhall09`
- **Description:** Adds adaptive map scaling, optional level of detail, presets, an FPS counter, and diagnostics. Default settings never change simulation rules, routing, finances, or saves; optional experimental tuning on Subway Builder 1.5+ is clearly labeled as gameplay-affecting.
- **Tags:** `qol`, `ui`
- **Source URL:** `https://github.com/rexmhall09/Subway-Builder-Performance-Mod`
- **Update type:** GitHub Releases
- **GitHub repository:** `rexmhall09/Subway-Builder-Performance-Mod`
- **Gallery image:** `docs/images/performance-settings.png`

## Release checklist

1. Confirm every gameplay-affecting option is off by default and clearly labeled.
2. Confirm `npm run release:check` passes in a clean checkout.
3. Confirm `manifest.json`, `package.json`, `index.js`, README, and changelog all identify the release version.
4. Confirm the release workflow creates the versioned ZIP plus `manifest.json`.
5. Download the release ZIP and confirm `manifest.json` and `index.js` are at its root.
6. Install the ZIP on the current game version and verify: map movement stays uninterrupted, settings persist across an app restart, LOD coverage warnings in diagnostics, and tuning options apply and restore.

Do not submit benchmark claims beyond the results recorded in `BENCHMARKS.md`.
