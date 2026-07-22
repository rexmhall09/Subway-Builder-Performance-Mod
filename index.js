// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rexmhall09

(function subwayBuilderPerformanceMod() {
  "use strict";

  const MOD_ID = "subway-builder-performance";
  const MOD_NAME = "Performance";
  const MOD_VERSION = "0.1.0";
  const GLOBAL_KEY = "__SUBWAY_BUILDER_PERFORMANCE_MOD__";
  const OVERLAY_ID = "subway-builder-performance-fps";
  const SETTINGS_KEY = "settings";
  const LOG_INTERVAL_MS = 10_000;
  const SAMPLE_WINDOW_MS = 1_000;
  const ADAPTIVE_TARGET_FPS = 30;
  const ADAPTIVE_COOLDOWN_MS = 10_000;
  const ADAPTIVE_DOWN_SAMPLES = 3;
  const ADAPTIVE_UP_SAMPLES = 8;

  const DEFAULT_SETTINGS = Object.freeze({
    renderScale: 1,
    adaptiveRenderScale: false,
    showFps: false,
    diagnosticLogging: false
  });

  const RENDER_SCALE_OPTIONS = Object.freeze([
    { value: 1, label: "100% - Native quality" },
    { value: 0.85, label: "85% - Minor softness" },
    { value: 0.7, label: "70% - Balanced" },
    { value: 0.5, label: "50% - Maximum FPS" }
  ]);
  const AUTOMATIC_RENDER_SCALE_VALUE = "automatic";

  const previousInstance = window[GLOBAL_KEY];
  if (previousInstance && typeof previousInstance.dispose === "function") {
    try {
      previousInstance.dispose();
    } catch (error) {
      console.warn(`[${MOD_NAME}] Could not clean up the previous instance.`, error);
    }
  }

  const api = window.SubwayBuilderAPI;
  if (!api || !api.hooks || !api.ui || !api.storage || !api.utils) {
    console.error(`[${MOD_NAME}] SubwayBuilderAPI is unavailable. The mod was not started.`);
    return;
  }

  const runtime = {
    settings: { ...DEFAULT_SETTINGS },
    gameActive: false,
    map: null,
    mapSupported: true,
    disposed: false,
    activeRenderScale: DEFAULT_SETTINGS.renderScale,
    adaptiveLowSamples: 0,
    adaptiveHighSamples: 0,
    lastAdaptiveChangeAt: Number.NEGATIVE_INFINITY,
    animationFrameId: null,
    diagnosticTimerId: null,
    sampleStartedAt: 0,
    lastFrameAt: 0,
    frameTimes: [],
    currentFps: null,
    p95FrameMs: null,
    longFrames: 0,
    overlay: null,
    dispose
  };

  window[GLOBAL_KEY] = runtime;

  initialize().catch((error) => {
    console.error(`[${MOD_NAME}] Initialization failed safely.`, error);
  });

  async function initialize() {
    runtime.settings = sanitizeSettings(
      await api.storage.get(SETTINGS_KEY, DEFAULT_SETTINGS).catch((error) => {
        console.warn(`[${MOD_NAME}] Settings could not be read; defaults will be used.`, error);
        return DEFAULT_SETTINGS;
      })
    );
    if (runtime.disposed) return;
    runtime.activeRenderScale = runtime.settings.renderScale;

    registerSettingsPanel();
    api.hooks.onMapReady(handleMapReady);
    api.hooks.onGameLoaded(() => {
      if (runtime.disposed) return;
      runtime.gameActive = true;
      applyRenderScale();
      syncMonitoring();
    });
    if (typeof api.hooks.onGameEnd === "function") {
      api.hooks.onGameEnd(handleGameEnd);
    }
    if (typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    syncMonitoring();
    console.info(`[${MOD_NAME}] v${MOD_VERSION} ready (Mod API ${api.version || "unknown"}).`);
  }

  function sanitizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const requestedScale = Number(source.renderScale);
    const renderScale = RENDER_SCALE_OPTIONS.some((option) => option.value === requestedScale)
      ? requestedScale
      : DEFAULT_SETTINGS.renderScale;
    const adaptiveRenderScale = source.adaptiveRenderScale === true;

    return {
      renderScale: adaptiveRenderScale ? 1 : renderScale,
      adaptiveRenderScale,
      showFps: source.showFps === true,
      diagnosticLogging: source.diagnosticLogging === true
    };
  }

  async function updateSetting(key, value) {
    if (runtime.disposed) return;

    runtime.settings = sanitizeSettings({ ...runtime.settings, [key]: value });
    if (key === "renderScale" || key === "adaptiveRenderScale") {
      resetAdaptiveScale();
      applyRenderScale();
    }
    if (key === "adaptiveRenderScale" || key === "showFps" || key === "diagnosticLogging") syncMonitoring();

    try {
      await api.storage.set(SETTINGS_KEY, runtime.settings);
    } catch (error) {
      console.warn(`[${MOD_NAME}] The setting changed for this session but could not be saved.`, error);
    }
  }

  async function updateRenderScaleMode(value) {
    if (runtime.disposed) return;

    const automatic = value === AUTOMATIC_RENDER_SCALE_VALUE;
    runtime.settings = sanitizeSettings({
      ...runtime.settings,
      renderScale: automatic ? 1 : Number(value),
      adaptiveRenderScale: automatic
    });
    resetAdaptiveScale();
    applyRenderScale();
    syncMonitoring();

    try {
      await api.storage.set(SETTINGS_KEY, runtime.settings);
    } catch (error) {
      console.warn(`[${MOD_NAME}] The setting changed for this session but could not be saved.`, error);
    }
  }

  function handleMapReady(map) {
    if (runtime.disposed) return;
    runtime.gameActive = true;

    if (!map || typeof map.setPixelRatio !== "function") {
      runtime.map = null;
      runtime.mapSupported = false;
      console.warn(`[${MOD_NAME}] This game build does not expose MapLibre render scaling; native quality is unchanged.`);
      syncMonitoring();
      return;
    }

    runtime.map = map;
    runtime.mapSupported = true;
    applyRenderScale();
    syncMonitoring();
  }

  function handleGameEnd() {
    if (runtime.disposed) return;

    restoreNativeRenderScale();
    runtime.gameActive = false;
    runtime.map = null;
    runtime.mapSupported = true;
    runtime.activeRenderScale = runtime.settings.renderScale;
    runtime.adaptiveLowSamples = 0;
    runtime.adaptiveHighSamples = 0;
    syncMonitoring();
  }

  function nativePixelRatio() {
    const ratio = Number(window.devicePixelRatio);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  function applyRenderScale() {
    const map = runtime.map;
    if (!map || typeof map.setPixelRatio !== "function") return;

    const targetRatio = nativePixelRatio() * runtime.activeRenderScale;
    try {
      if (typeof map.getPixelRatio !== "function" || Math.abs(map.getPixelRatio() - targetRatio) > 0.001) {
        map.setPixelRatio(targetRatio);
      }
      if (typeof map.resize === "function") map.resize();
    } catch (error) {
      runtime.mapSupported = false;
      console.warn(`[${MOD_NAME}] Render scaling was rejected; native quality remains active.`, error);
    }
  }

  function restoreNativeRenderScale() {
    const map = runtime.map;
    if (!map || typeof map.setPixelRatio !== "function") return;

    try {
      map.setPixelRatio(nativePixelRatio());
      if (typeof map.resize === "function") map.resize();
    } catch (error) {
      console.warn(`[${MOD_NAME}] Native render scale could not be restored during cleanup.`, error);
    }
  }

  function syncMonitoring() {
    if (runtime.disposed) return;

    if (runtime.gameActive && runtime.settings.showFps) ensureOverlay();
    else removeOverlay();

    const pageVisible = document.hidden !== true;
    const shouldSample = shouldSampleNow();
    if (shouldSample && runtime.animationFrameId === null) startSampler();
    if (!shouldSample && runtime.animationFrameId !== null) stopSampler();

    if (runtime.gameActive && pageVisible && runtime.settings.diagnosticLogging && runtime.diagnosticTimerId === null) {
      runtime.diagnosticTimerId = window.setInterval(logDiagnostics, LOG_INTERVAL_MS);
    } else if ((!runtime.gameActive || !pageVisible || !runtime.settings.diagnosticLogging) && runtime.diagnosticTimerId !== null) {
      window.clearInterval(runtime.diagnosticTimerId);
      runtime.diagnosticTimerId = null;
    }
  }

  function shouldSampleNow() {
    return runtime.gameActive && document.hidden !== true && (
      (runtime.settings.adaptiveRenderScale && runtime.mapSupported && runtime.map)
      || runtime.settings.showFps
      || runtime.settings.diagnosticLogging
    );
  }

  function startSampler() {
    runtime.sampleStartedAt = performance.now();
    runtime.lastFrameAt = runtime.sampleStartedAt;
    runtime.frameTimes = [];
    runtime.animationFrameId = shouldSampleNow()
      ? window.requestAnimationFrame(sampleFrame)
      : null;
  }

  function stopSampler() {
    if (runtime.animationFrameId !== null) {
      window.cancelAnimationFrame(runtime.animationFrameId);
      runtime.animationFrameId = null;
    }
    runtime.frameTimes = [];
    runtime.currentFps = null;
    runtime.p95FrameMs = null;
    runtime.longFrames = 0;
  }

  function sampleFrame(now) {
    if (runtime.disposed) return;

    runtime.frameTimes.push(now - runtime.lastFrameAt);
    runtime.lastFrameAt = now;

    const elapsed = now - runtime.sampleStartedAt;
    if (elapsed >= SAMPLE_WINDOW_MS && runtime.frameTimes.length > 1) {
      const sorted = runtime.frameTimes.slice().sort((a, b) => a - b);
      runtime.currentFps = (runtime.frameTimes.length * 1000) / elapsed;
      runtime.p95FrameMs = percentile(sorted, 0.95);
      runtime.longFrames = runtime.frameTimes.filter((duration) => duration > 33.4).length;
      runtime.sampleStartedAt = now;
      runtime.frameTimes = [];
      updateOverlay();
      updateAdaptiveScale(now);
    }

    runtime.animationFrameId = shouldSampleNow()
      ? window.requestAnimationFrame(sampleFrame)
      : null;
  }

  function percentile(sorted, fraction) {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
    return sorted[index];
  }

  function resetAdaptiveScale() {
    runtime.activeRenderScale = runtime.settings.renderScale;
    runtime.adaptiveLowSamples = 0;
    runtime.adaptiveHighSamples = 0;
    runtime.lastAdaptiveChangeAt = performance.now();
  }

  function updateAdaptiveScale(now) {
    if (!runtime.settings.adaptiveRenderScale || !runtime.mapSupported || !runtime.map || runtime.currentFps === null) return;
    if (now - runtime.lastAdaptiveChangeAt < ADAPTIVE_COOLDOWN_MS) return;

    const allowedScales = RENDER_SCALE_OPTIONS
      .map((option) => option.value)
      .filter((value) => value <= runtime.settings.renderScale);
    const currentIndex = allowedScales.indexOf(runtime.activeRenderScale);
    if (currentIndex < 0) return;

    if (runtime.currentFps < ADAPTIVE_TARGET_FPS * 0.92) {
      runtime.adaptiveLowSamples += 1;
      runtime.adaptiveHighSamples = 0;
    } else if (runtime.currentFps > ADAPTIVE_TARGET_FPS * 1.15) {
      runtime.adaptiveHighSamples += 1;
      runtime.adaptiveLowSamples = 0;
    } else {
      runtime.adaptiveLowSamples = 0;
      runtime.adaptiveHighSamples = 0;
    }

    let nextScale = runtime.activeRenderScale;
    if (runtime.adaptiveLowSamples >= ADAPTIVE_DOWN_SAMPLES && currentIndex < allowedScales.length - 1) {
      nextScale = allowedScales[currentIndex + 1];
    } else if (runtime.adaptiveHighSamples >= ADAPTIVE_UP_SAMPLES && currentIndex > 0) {
      nextScale = allowedScales[currentIndex - 1];
    }

    if (nextScale === runtime.activeRenderScale) return;

    runtime.activeRenderScale = nextScale;
    runtime.adaptiveLowSamples = 0;
    runtime.adaptiveHighSamples = 0;
    runtime.lastAdaptiveChangeAt = now;
    applyRenderScale();
    updateOverlay();
    if (runtime.settings.diagnosticLogging) {
      console.info(`[${MOD_NAME}:adaptive] Map render scale changed to ${Math.round(nextScale * 100)}%.`);
    }
  }

  function handleVisibilityChange() {
    if (runtime.disposed) return;
    runtime.adaptiveLowSamples = 0;
    runtime.adaptiveHighSamples = 0;
    syncMonitoring();
  }

  function ensureOverlay() {
    if (runtime.overlay && runtime.overlay.isConnected) return;

    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-label", "Frames per second");
    Object.assign(overlay.style, {
      position: "fixed",
      top: "64px",
      right: "12px",
      zIndex: "2147483000",
      padding: "4px 8px",
      border: "1px solid rgba(255, 255, 255, 0.45)",
      borderRadius: "4px",
      background: "rgba(0, 0, 0, 0.72)",
      color: "#ffffff",
      font: "600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace",
      fontVariantNumeric: "tabular-nums",
      pointerEvents: "none",
      userSelect: "none"
    });
    overlay.textContent = "… FPS";
    document.body.appendChild(overlay);
    runtime.overlay = overlay;
  }

  function updateOverlay() {
    if (!runtime.overlay || !runtime.overlay.isConnected || runtime.currentFps === null) return;
    const scale = runtime.settings.adaptiveRenderScale
      ? ` · ${Math.round(runtime.activeRenderScale * 100)}%`
      : "";
    runtime.overlay.textContent = `${Math.round(runtime.currentFps)} FPS${scale}`;
  }

  function removeOverlay() {
    if (runtime.overlay) runtime.overlay.remove();
    runtime.overlay = null;
    const staleOverlay = document.getElementById(OVERLAY_ID);
    if (staleOverlay) staleOverlay.remove();
  }

  function logDiagnostics() {
    if (runtime.currentFps === null) return;

    const canvas = document.querySelector("canvas.maplibregl-canvas");
    const memory = performance.memory;
    const details = {
      fps: Number(runtime.currentFps.toFixed(1)),
      p95FrameMs: runtime.p95FrameMs === null ? null : Number(runtime.p95FrameMs.toFixed(1)),
      framesOver33ms: runtime.longFrames,
      renderScalePercent: Math.round(runtime.activeRenderScale * 100),
      adaptiveRenderScale: runtime.settings.adaptiveRenderScale,
      canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
      jsHeapMB: memory && Number.isFinite(memory.usedJSHeapSize)
        ? Number((memory.usedJSHeapSize / 1_048_576).toFixed(1))
        : null
    };
    console.info(`[${MOD_NAME}:diagnostics]`, details);
  }

  function registerSettingsPanel() {
    const React = api.utils.React;
    const components = api.utils.components || {};
    const Switch = components.Switch;
    const Label = components.Label;
    const h = React.createElement;

    function ToggleRow({ id, label, description, checked, onChange }) {
      return h("div", { className: "flex items-start justify-between gap-4 py-2" }, [
        h("div", { key: "copy", className: "space-y-1" }, [
          Label
            ? h(Label, { key: "label", htmlFor: id, className: "text-sm font-medium" }, label)
            : h("label", { key: "label", htmlFor: id, className: "text-sm font-medium" }, label),
          h("p", { key: "description", className: "text-xs text-muted-foreground" }, description)
        ]),
        Switch
          ? h(Switch, { key: "control", id, checked, onCheckedChange: onChange })
          : h("input", { key: "control", id, type: "checkbox", checked, onChange: (event) => onChange(event.target.checked) })
      ]);
    }

    function PerformanceSettings() {
      const [settings, setSettings] = React.useState(runtime.settings);

      const change = (key, value) => {
        const next = sanitizeSettings({ ...settings, [key]: value });
        setSettings(next);
        void updateSetting(key, next[key]);
      };

      const changeRenderScaleMode = (value) => {
        const automatic = value === AUTOMATIC_RENDER_SCALE_VALUE;
        const next = sanitizeSettings({
          ...settings,
          renderScale: automatic ? 1 : Number(value),
          adaptiveRenderScale: automatic
        });
        setSettings(next);
        void updateRenderScaleMode(value);
      };

      return h("section", { className: "space-y-4 p-1", "data-performance-settings": "true" }, [
        h("div", { key: "heading", className: "space-y-1" }, [
          h("h3", { key: "title", className: "text-base font-semibold" }, "Performance"),
          h(
            "p",
            { key: "intro", className: "text-xs text-muted-foreground" },
            "Renderer controls are independent and never change simulation rules, routing, finances, or saves."
          )
        ]),
        h("div", { key: "scale", className: "space-y-2" }, [
          h("label", { key: "label", htmlFor: `${MOD_ID}-render-scale`, className: "text-sm font-medium" }, "Map render scale"),
          h(
            "select",
            {
              key: "select",
              id: `${MOD_ID}-render-scale`,
              value: settings.adaptiveRenderScale
                ? AUTOMATIC_RENDER_SCALE_VALUE
                : String(settings.renderScale),
              className: "w-full rounded border border-input bg-background px-3 py-2 text-sm",
              onChange: (event) => changeRenderScaleMode(event.target.value)
            },
            [
              h(
                "option",
                { key: AUTOMATIC_RENDER_SCALE_VALUE, value: AUTOMATIC_RENDER_SCALE_VALUE },
                "Automatic - Target 30 FPS"
              ),
              ...RENDER_SCALE_OPTIONS.map((option) => h("option", { key: option.value, value: String(option.value) }, option.label))
            ]
          ),
          h(
            "p",
            { key: "description", className: "text-xs text-muted-foreground" },
            "Automatic steps between 100% and 50% to target 30 FPS. Fixed lower values can improve FPS on Retina/HiDPI displays, but make the map softer. 100% native quality is the default."
          ),
          !runtime.mapSupported
            ? h("p", { key: "unsupported", className: "text-xs text-destructive" }, "Render scaling is unsupported by this game build; native quality remains active.")
            : null
        ]),
        h(ToggleRow, {
          key: "fps",
          id: `${MOD_ID}-show-fps`,
          label: "Show FPS",
          description: "Shows a lightweight one-second rolling FPS counter in the upper-right corner.",
          checked: settings.showFps,
          onChange: (value) => change("showFps", value)
        }),
        h(ToggleRow, {
          key: "logging",
          id: `${MOD_ID}-diagnostic-logging`,
          label: "Diagnostic logging",
          description: "Logs FPS, frame-time, render-scale, canvas-size, and available heap measurements every 10 seconds. Off by default.",
          checked: settings.diagnosticLogging,
          onChange: (value) => change("diagnosticLogging", value)
        }),
        h(
          "p",
          { key: "version", className: "pt-1 text-xs text-muted-foreground" },
          `${MOD_NAME} v${MOD_VERSION} · Mod API ${api.version || "unknown"}`
        )
      ]);
    }

    api.ui.registerComponent("settings-menu", {
      id: `${MOD_ID}-settings`,
      component: PerformanceSettings
    });
  }

  function dispose() {
    if (runtime.disposed) return;
    runtime.disposed = true;
    stopSampler();
    if (runtime.diagnosticTimerId !== null) {
      window.clearInterval(runtime.diagnosticTimerId);
      runtime.diagnosticTimerId = null;
    }
    removeOverlay();
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    restoreNativeRenderScale();
    runtime.map = null;
  }
})();
