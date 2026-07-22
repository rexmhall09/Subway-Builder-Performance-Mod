# Railyard submission

This repository is prepared for Railyard's GitHub Releases update flow. The Registry requires a public source repository, at least one GitHub release, and a `.zip` asset on the latest release.

## Prepared listing

- **Mod ID:** `subway-builder-performance`
- **Display name:** Subway Builder Performance
- **Author:** `rexmhall09`
- **Description:** Improves map rendering performance with fixed or automatic resolution scaling, plus an optional FPS counter and diagnostics. Simulation rules, routing, finances, and saves are never modified.
- **Tags:** `qol`, `ui`
- **Source URL:** `https://github.com/rexmhall09/Subway-Builder-Performance-Mod`
- **Update type:** GitHub Releases
- **GitHub repository:** `rexmhall09/Subway-Builder-Performance-Mod`
- **Gallery image:** `docs/images/performance-settings.webp`

The Registry ID was not present in the live Registry when checked on 2026-07-23.

## Publication checklist

1. Create the public GitHub repository at the source URL above and push `main`.
2. Confirm `npm run release:check` passes in a clean checkout.
3. Create and push the `v0.1.0` tag.
4. Confirm the release workflow creates:
   - `subway-builder-performance-v0.1.0.zip`
   - `manifest.json`
5. Download the release ZIP and confirm `manifest.json` and `index.js` are at its root.
6. Install that ZIP in a clean Railyard profile and complete the matrix in `BENCHMARKS.md`.
7. Open the Registry's **Publish New Mod** issue form and paste the prepared listing above.
8. Review and personally accept the Registry terms in the submission form.

Do not submit benchmark claims beyond the results recorded in `BENCHMARKS.md`.

