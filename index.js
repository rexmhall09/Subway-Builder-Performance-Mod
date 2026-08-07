// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rexmhall09

(function subwayBuilderPerformanceMod() {
  "use strict";

  const MOD_ID = "subway-builder-performance";
  const MOD_NAME = "Performance";
  const MOD_VERSION = "0.3.0";
  const SETTINGS_VERSION = 3;
  const GLOBAL_KEY = "__SUBWAY_BUILDER_PERFORMANCE_MOD__";
  const OVERLAY_ID = "subway-builder-performance-fps";
  const SETTINGS_KEY = "settings";
  const LOCAL_SETTINGS_KEY = `${MOD_ID}:settings`;
  const LOG_INTERVAL_MS = 10_000;
  const SAMPLE_WINDOW_MS = 1_000;
  const DISPLAY_FPS_WINDOW_MS = 500;
  const OVERLAY_REFRESH_MS = 250;
  const BENCHMARK_FRAME_LIMIT = 250_000;
  const MAX_RECORDED_FRAME_MS = 60_000;
  const ADAPTIVE_COOLDOWN_MS = 10_000;
  const ADAPTIVE_DOWN_SAMPLES = 3;
  const ADAPTIVE_UP_SAMPLES = 8;
  const INITIAL_SETTLE_MS = 4_000;
  const EVENT_SETTLE_MS = 2_000;
  const DECORATIVE_LOD_MAX_ZOOM = 13;
  const TRANSIT_LOD_MAX_ZOOM = 11;
  const AUTOMATIC_RENDER_SCALE_VALUE = "automatic";
  const DECORATIVE_LAYER_IDS = Object.freeze([
    "building-foundations",
    "buildings-3d"
  ]);
  const TRANSIT_DETAIL_LAYER_IDS = Object.freeze([
    "signal-lines",
    "signal-lines-under",
    "signal-points",
    "signal-points-under",
    "track-arrows-path",
    "route-arrows-path"
  ]);

  const TUNING_BATCHING_OPTIONS = Object.freeze(["off", "conservative", "aggressive"]);
  const TUNING_BATCHING_MULTIPLIERS = Object.freeze({
    conservative: { ultrafast: 2 },
    aggressive: { fast: 2, ultrafast: 4 }
  });
  const DEFAULT_MAX_TICKS_PER_UPDATE = 1000;

  const RENDER_SCALE_OPTIONS = Object.freeze([
    { value: 1, label: "100% - Native quality" },
    { value: 0.85, label: "85% - High quality" },
    { value: 0.7, label: "70% - Balanced" },
    { value: 0.5, label: "50% - Maximum performance" }
  ]);
  const TARGET_FPS_OPTIONS = Object.freeze([30, 45, 60]);
  const MINIMUM_SCALE_OPTIONS = Object.freeze([0.85, 0.7, 0.5]);

  const DEFAULT_SETTINGS = Object.freeze({
    settingsVersion: SETTINGS_VERSION,
    preset: "native",
    renderScale: 1,
    adaptiveRenderScale: false,
    adaptiveTargetFps: 30,
    minimumRenderScale: 0.5,
    decorativeLod: false,
    transitLod: false,
    inactiveWindowMode: false,
    showFps: false,
    detailedOverlay: false,
    diagnosticLogging: false,
    simTickBatching: "off",
    pathfindingLite: false
  });

  const PRESETS = Object.freeze({
    native: {
      label: "Native / Safe",
      description: "Native visuals with only zero-tradeoff housekeeping.",
      values: {
        renderScale: 1,
        adaptiveRenderScale: false,
        adaptiveTargetFps: 30,
        minimumRenderScale: 0.5,
        decorativeLod: false,
        transitLod: false,
        inactiveWindowMode: false
      }
    },
    balanced: {
      label: "Balanced",
      description: "Targets 45 FPS down to 70% and hides distant 3D decoration.",
      values: {
        renderScale: 1,
        adaptiveRenderScale: true,
        adaptiveTargetFps: 45,
        minimumRenderScale: 0.7,
        decorativeLod: true,
        transitLod: false,
        inactiveWindowMode: false
      }
    },
    maximum: {
      label: "Maximum Performance",
      description: "Allows 50% quality plus decorative and transit LOD.",
      values: {
        renderScale: 1,
        adaptiveRenderScale: true,
        adaptiveTargetFps: 60,
        minimumRenderScale: 0.5,
        decorativeLod: true,
        transitLod: true,
        inactiveWindowMode: true
      }
    },
    battery: {
      label: "Battery Saver",
      description: "Targets 30 FPS and reduces map work while unfocused.",
      values: {
        renderScale: 1,
        adaptiveRenderScale: true,
        adaptiveTargetFps: 30,
        minimumRenderScale: 0.7,
        decorativeLod: true,
        transitLod: false,
        inactiveWindowMode: true
      }
    }
  });

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
    settingsRevision: 0,
    gameActive: false,
    map: null,
    mapSupported: true,
    disposed: false,
    applyingRenderScale: false,
    adaptiveScale: 1,
    activeRenderScale: 1,
    originalMapPixelRatio: null,
    originalMapPixelRatioImplicit: false,
    renderScaleWasWritten: false,
    lastDevicePixelRatio: nativePixelRatio(),
    dprMediaQuery: null,
    dprMediaQueryListener: null,
    adaptiveLowSamples: 0,
    adaptiveHighSamples: 0,
    adaptiveBlockedUntil: Number.NEGATIVE_INFINITY,
    lastAdaptiveChangeAt: Number.NEGATIVE_INFINITY,
    smoothedFrameMs: null,
    animationFrameId: null,
    diagnosticTimerId: null,
    sampleStartedAt: 0,
    lastFrameAt: 0,
    frameTimes: [],
    currentFps: null,
    displayFps: null,
    displayFrameTimes: [],
    lastOverlayUpdateAt: 0,
    p95FrameMs: null,
    longFrames: 0,
    overlay: null,
    windowFocused: isWindowFocused(),
    mapMoving: false,
    paused: false,
    simulationSpeed: "unknown",
    saveName: null,
    gameSessionId: null,
    gameDay: null,
    gameHour: null,
    scopedStorage: null,
    hookUnsubscribers: [],
    tuningBaseline: null,
    tuningWritten: { batching: false, pathfinding: false },
    lodCoverageWarned: { decorative: false, transit: false },
    mapListeners: [],
    layerSnapshots: {
      decorative: new Map(),
      transit: new Map()
    },
    applyingLod: false,
    limitationHint: "collecting",
    scaleProbe: null,
    benchmarkSamples: [],
    benchmarkFrameTimes: [],
    benchmarkWindowFrameTimes: [],
    benchmarkWindowStartedAt: null,
    benchmarkLastFrameAt: null,
    benchmarkStartedAt: null,
    benchmarkEndedAt: null,
    benchmarkConfiguration: null,
    benchmarkEnvironment: null,
    benchmarkInitialState: null,
    benchmarkFinalState: null,
    benchmarkEvents: [],
    benchmarkTrainCounts: { spawned: 0, deleted: 0 },
    benchmarkCapturing: false,
    dispose
  };

  window[GLOBAL_KEY] = runtime;

  try {
    initialize();
  } catch (error) {
    failInitialization(error);
  }

  function failInitialization(error) {
    console.error(`[${MOD_NAME}] Initialization failed safely.`, error);
    try {
      dispose();
    } catch (cleanupError) {
      console.error(`[${MOD_NAME}] Initialization cleanup also failed.`, cleanupError);
    }
  }

  function initialize() {
    // Capture the mod's storage identity synchronously (Subway Builder 1.5+).
    // On 1.4.x this is unavailable and the localStorage mirror remains the fallback.
    runtime.scopedStorage = captureScopedStorage();

    const mirroredSettings = readSettingsMirror();
    if (mirroredSettings) runtime.settings = sanitizeSettings(mirroredSettings);

    // Start the documented API read while the game still has this mod's context.
    const storedSettingsPromise = storageGet(SETTINGS_KEY, null).catch((error) => {
      console.warn(`[${MOD_NAME}] Settings could not be read; defaults will be used.`, error);
      return null;
    });

    resetAdaptiveScale();
    readCurrentGameState();

    // Register every callback before the first await so Subway Builder 1.4.14
    // captures the manifest mod ID for context-preserving lifecycle hooks.
    registerHook("onMapReady", handleMapReady);
    if (typeof api.utils.getMap === "function") {
      try {
        const currentMap = api.utils.getMap();
        if (currentMap && currentMap !== runtime.map) handleMapReady(currentMap);
      } catch (error) {
        console.warn(`[${MOD_NAME}] The current map could not be read; onMapReady will be used instead.`, error);
      }
    }
    registerHook("onGameLoaded", () => {
      if (runtime.disposed) return;
      flushSettingsToApi();
      runtime.gameActive = true;
      readCurrentGameState();
      resetAdaptiveScale();
      applyRenderScale();
      applyTuning();
      syncMonitoring();
    });
    registerHook("onGameEnd", handleGameEnd);
    registerHook("onPauseChanged", (paused) => {
      if (runtime.disposed) return;
      runtime.paused = paused === true;
    });
    registerHook("onSpeedChanged", (speed) => {
      if (runtime.disposed) return;
      runtime.simulationSpeed = String(speed || "unknown");
    });
    registerHook("onGameSaved", () => {
      if (runtime.disposed) return;
      flushSettingsToApi();
      readCurrentGameState();
      recordBenchmarkEvent("game-saved");
      suspendAdaptive(INITIAL_SETTLE_MS);
    });
    registerHook("onDayChange", (day) => {
      if (runtime.disposed) return;
      if (Number.isFinite(Number(day))) runtime.gameDay = Number(day);
      recordBenchmarkEvent("day-changed");
    });
    registerHook("onHourChange", (hour, day) => {
      if (runtime.disposed) return;
      if (Number.isFinite(Number(hour))) runtime.gameHour = Number(hour);
      if (Number.isFinite(Number(day))) runtime.gameDay = Number(day);
    });
    registerHook("onWarning", () => {
      if (runtime.disposed) return;
      recordBenchmarkEvent("game-warning");
    });
    registerHook("onError", () => {
      if (runtime.disposed) return;
      recordBenchmarkEvent("game-error");
    });
    registerHook("onTrainSpawned", () => {
      if (runtime.disposed || !runtime.benchmarkCapturing) return;
      runtime.benchmarkTrainCounts.spawned += 1;
    });
    registerHook("onTrainDeleted", () => {
      if (runtime.disposed || !runtime.benchmarkCapturing) return;
      runtime.benchmarkTrainCounts.deleted += 1;
    });

    addDocumentListener("visibilitychange", handleVisibilityChange);
    addWindowListener("focus", handleWindowFocus);
    addWindowListener("blur", handleWindowBlur);
    addWindowListener("resize", handleWindowResize);
    watchDevicePixelRatio();

    registerSettingsPanel();
    syncMonitoring();
    void finishSettingsInitialization(storedSettingsPromise, mirroredSettings).catch(failInitialization);
    console.info(`[${MOD_NAME}] v${MOD_VERSION} ready (Mod API ${api.version || "unknown"}).`);
  }

  async function finishSettingsInitialization(storedSettingsPromise, mirroredSettings) {
    const storedSettings = await storedSettingsPromise;
    if (runtime.disposed) return;

    if (runtime.settingsRevision === 0) {
      // The mirror was the authoritative store in v0.2.x, so it wins when present;
      // afterwards persistSettings migrates it into Mod API storage and retires it.
      runtime.settings = sanitizeSettings(mirroredSettings || storedSettings || DEFAULT_SETTINGS);
    }
    persistSettings(runtime.settings);
    resetAdaptiveScale();
    applyLayerLod();
    applyRenderScale();
    applyTuning();
    syncMonitoring();
    updateOverlay();
  }

  function registerHook(hookName, callback) {
    const register = api.hooks[hookName];
    if (typeof register !== "function") return;
    // Registration errors for required hooks must propagate to failInitialization.
    const unsubscribe = register(callback);
    if (typeof unsubscribe === "function") runtime.hookUnsubscribers.push(unsubscribe);
  }

  function unsubscribeHooks() {
    for (const unsubscribe of runtime.hookUnsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        console.warn(`[${MOD_NAME}] A lifecycle hook could not be unsubscribed.`, error);
      }
    }
    runtime.hookUnsubscribers = [];
  }

  function captureScopedStorage() {
    if (typeof api.storage.scoped !== "function") return null;
    try {
      const scoped = api.storage.scoped();
      return scoped && typeof scoped.get === "function" && typeof scoped.set === "function"
        ? scoped
        : null;
    } catch (error) {
      console.warn(`[${MOD_NAME}] Scoped storage could not be captured; the local mirror will be used.`, error);
      return null;
    }
  }

  function storageGet(key, fallback) {
    if (runtime.scopedStorage) return Promise.resolve(runtime.scopedStorage.get(key, fallback));
    // The trailing manifest ID is honored by Subway Builder 1.5+ and ignored by 1.4.x.
    return Promise.resolve(api.storage.get(key, fallback, MOD_ID));
  }

  function storageSet(key, value) {
    if (runtime.scopedStorage) return Promise.resolve(runtime.scopedStorage.set(key, value));
    return Promise.resolve(api.storage.set(key, value, MOD_ID));
  }

  function persistSettings(settings) {
    if (runtime.scopedStorage) {
      flushSettingsToApi();
      removeSettingsMirror();
      return;
    }
    writeSettingsMirror(settings);
  }

  function readSettingsMirror() {
    try {
      const localStorage = window.localStorage;
      if (!localStorage || typeof localStorage.getItem !== "function") return null;
      const value = localStorage.getItem(LOCAL_SETTINGS_KEY);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.warn(`[${MOD_NAME}] The local settings mirror could not be read.`, error);
      return null;
    }
  }

  function writeSettingsMirror(settings) {
    try {
      const localStorage = window.localStorage;
      if (!localStorage || typeof localStorage.setItem !== "function") return false;
      localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(settings));
      return true;
    } catch (error) {
      console.warn(`[${MOD_NAME}] Settings changed for this session but the local mirror could not be saved.`, error);
      return false;
    }
  }

  function removeSettingsMirror() {
    try {
      const localStorage = window.localStorage;
      if (!localStorage || typeof localStorage.removeItem !== "function") return;
      localStorage.removeItem(LOCAL_SETTINGS_KEY);
    } catch {
      // The retired mirror key is harmless if it cannot be removed.
    }
  }

  function flushSettingsToApi() {
    try {
      const pendingWrite = storageSet(SETTINGS_KEY, { ...runtime.settings });
      if (pendingWrite && typeof pendingWrite.catch === "function") {
        void pendingWrite.catch((error) => {
          console.warn(`[${MOD_NAME}] Settings could not be copied to Mod API storage.`, error);
        });
      }
    } catch (error) {
      console.warn(`[${MOD_NAME}] Settings could not be copied to Mod API storage.`, error);
    }
  }

  function sanitizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const requestedScale = Number(source.renderScale);
    const renderScale = validScale(requestedScale) ? requestedScale : DEFAULT_SETTINGS.renderScale;
    const adaptiveRenderScale = source.adaptiveRenderScale === true;
    const requestedTarget = Number(source.adaptiveTargetFps);
    const adaptiveTargetFps = TARGET_FPS_OPTIONS.includes(requestedTarget)
      ? requestedTarget
      : DEFAULT_SETTINGS.adaptiveTargetFps;
    const requestedMinimum = Number(source.minimumRenderScale);
    const minimumRenderScale = MINIMUM_SCALE_OPTIONS.includes(requestedMinimum)
      ? requestedMinimum
      : DEFAULT_SETTINGS.minimumRenderScale;
    const isVersionTwo = Number(source.settingsVersion) >= 2;
    const preset = isVersionTwo && (
      source.preset === "custom"
      || Object.prototype.hasOwnProperty.call(PRESETS, source.preset)
    )
      ? source.preset
      : source.adaptiveRenderScale === true || renderScale !== 1
        ? "custom"
        : DEFAULT_SETTINGS.preset;

    const visualSettings = {
      renderScale: adaptiveRenderScale ? 1 : renderScale,
      adaptiveRenderScale,
      adaptiveTargetFps,
      minimumRenderScale,
      decorativeLod: source.decorativeLod === true,
      transitLod: source.transitLod === true,
      inactiveWindowMode: source.inactiveWindowMode === true
    };

    return {
      settingsVersion: SETTINGS_VERSION,
      preset,
      ...(preset !== "custom" && PRESETS[preset] ? PRESETS[preset].values : visualSettings),
      showFps: source.showFps === true,
      detailedOverlay: source.detailedOverlay === true,
      diagnosticLogging: source.diagnosticLogging === true,
      simTickBatching: TUNING_BATCHING_OPTIONS.includes(source.simTickBatching)
        ? source.simTickBatching
        : DEFAULT_SETTINGS.simTickBatching,
      pathfindingLite: source.pathfindingLite === true
    };
  }

  function validScale(value) {
    return RENDER_SCALE_OPTIONS.some((option) => option.value === value);
  }

  async function setSettings(nextValue) {
    if (runtime.disposed) return;
    const previous = runtime.settings;
    runtime.settings = sanitizeSettings(nextValue);
    runtime.settingsRevision += 1;

    if (
      previous.adaptiveRenderScale !== runtime.settings.adaptiveRenderScale
      || previous.renderScale !== runtime.settings.renderScale
      || previous.minimumRenderScale !== runtime.settings.minimumRenderScale
      || previous.adaptiveTargetFps !== runtime.settings.adaptiveTargetFps
    ) {
      resetAdaptiveScale();
    }

    if (!runtime.settings.decorativeLod && previous.decorativeLod) restoreLayerGroup("decorative");
    if (!runtime.settings.transitLod && previous.transitLod) restoreLayerGroup("transit");
    applyLayerLod();
    applyRenderScale();
    if (
      previous.simTickBatching !== runtime.settings.simTickBatching
      || previous.pathfindingLite !== runtime.settings.pathfindingLite
    ) {
      applyTuning();
    }
    syncMonitoring();
    updateOverlay();
    persistSettings(runtime.settings);
  }

  function updateSetting(key, value) {
    return setSettings({ ...runtime.settings, preset: "custom", [key]: value });
  }

  function updateRenderScaleMode(value) {
    const automatic = value === AUTOMATIC_RENDER_SCALE_VALUE;
    return setSettings({
      ...runtime.settings,
      preset: "custom",
      renderScale: automatic ? 1 : Number(value),
      adaptiveRenderScale: automatic
    });
  }

  function applyPreset(preset) {
    const definition = PRESETS[preset];
    if (!definition) return Promise.resolve();
    return setSettings({ ...runtime.settings, ...definition.values, preset });
  }

  function handleMapReady(map) {
    if (runtime.disposed) return;
    runtime.gameActive = true;
    readCurrentGameState();

    if (map && map === runtime.map) {
      resetFrameMeasurements(true);
      suspendAdaptive(INITIAL_SETTLE_MS);
      applyRenderScale();
      applyLayerLod();
      syncMonitoring();
      return;
    }

    detachMapListeners();
    restoreAllLayerStatesBeforeRelease();
    restoreOriginalRenderScale();
    runtime.map = null;
    runtime.originalMapPixelRatio = null;
    runtime.originalMapPixelRatioImplicit = false;
    runtime.renderScaleWasWritten = false;
    runtime.activeRenderScale = 1;

    if (!map || typeof map !== "object") {
      runtime.mapSupported = false;
      console.warn(`[${MOD_NAME}] This game build did not provide a usable MapLibre map.`);
      syncMonitoring();
      return;
    }

    runtime.map = map;
    runtime.mapMoving = false;
    runtime.lodCoverageWarned = { decorative: false, transit: false };
    runtime.lastDevicePixelRatio = nativePixelRatio();
    const originalRatio = readMapPixelRatio(map);
    runtime.mapSupported = typeof map.setPixelRatio === "function" && originalRatio !== null;
    runtime.originalMapPixelRatio = runtime.mapSupported ? originalRatio : null;
    runtime.originalMapPixelRatioImplicit = runtime.mapSupported
      && Math.abs(originalRatio - runtime.lastDevicePixelRatio) <= 0.001;
    resetAdaptiveScale();
    attachMapListeners(map);
    if (runtime.mapSupported) {
      applyRenderScale();
    } else {
      console.warn(
        `[${MOD_NAME}] This game build does not expose reliable MapLibre render scaling; native quality is unchanged.`
      );
    }
    applyLayerLod();
    syncMonitoring();
  }

  function handleGameEnd() {
    if (runtime.disposed) return;

    flushSettingsToApi();
    finishBenchmarkCapture();
    detachMapListeners();
    restoreAllLayerStatesBeforeRelease();
    restoreOriginalRenderScale();
    restoreTuning();
    runtime.gameActive = false;
    runtime.map = null;
    runtime.mapSupported = true;
    runtime.originalMapPixelRatio = null;
    runtime.originalMapPixelRatioImplicit = false;
    runtime.renderScaleWasWritten = false;
    runtime.mapMoving = false;
    runtime.adaptiveScale = 1;
    runtime.activeRenderScale = 1;
    runtime.paused = false;
    runtime.simulationSpeed = "unknown";
    runtime.saveName = null;
    runtime.gameSessionId = null;
    runtime.gameDay = null;
    runtime.gameHour = null;
    runtime.lodCoverageWarned = { decorative: false, transit: false };
    resetAdaptiveScale();
    syncMonitoring();
  }

  function attachMapListeners(map) {
    addMapListener(map, "movestart", handleMapMoveStart);
    addMapListener(map, "moveend", handleMapMoveEnd);
    addMapListener(map, "zoomend", handleMapZoomEnd);
    addMapListener(map, "resize", handleMapResize);
    addMapListener(map, "styledataloading", handleStyleLoading);
    addMapListener(map, "styledata", handleStyleData);
  }

  function addMapListener(map, eventName, callback) {
    if (typeof map.on !== "function") return;
    try {
      map.on(eventName, callback);
      runtime.mapListeners.push({ map, eventName, callback });
    } catch (error) {
      console.warn(`[${MOD_NAME}] Map event "${eventName}" is unavailable.`, error);
    }
  }

  function detachMapListeners() {
    for (const listener of runtime.mapListeners) {
      if (typeof listener.map.off !== "function") continue;
      try {
        listener.map.off(listener.eventName, listener.callback);
      } catch (error) {
        console.warn(`[${MOD_NAME}] A map event listener could not be removed.`, error);
      }
    }
    runtime.mapListeners = [];
  }

  function handleMapMoveStart() {
    if (runtime.disposed || runtime.applyingRenderScale) return;
    if (runtime.map && typeof runtime.map.isMoving === "function") {
      try {
        if (!runtime.map.isMoving()) return;
      } catch {
        // Fall back to the documented movement event when state inspection fails.
      }
    }
    runtime.mapMoving = true;
    resetAdaptiveCounters();
  }

  function handleMapMoveEnd() {
    if (runtime.disposed || runtime.applyingRenderScale) return;
    if (!runtime.mapMoving) return;
    runtime.mapMoving = false;
    resetFrameMeasurements(true);
    suspendAdaptive(EVENT_SETTLE_MS);
    applyRenderScale();
  }

  function handleMapZoomEnd() {
    if (runtime.disposed || runtime.applyingRenderScale) return;
    suspendAdaptive(EVENT_SETTLE_MS);
    applyLayerLod();
  }

  function handleMapResize() {
    if (runtime.disposed || runtime.applyingRenderScale) return;
    resetFrameMeasurements(true);
    suspendAdaptive(EVENT_SETTLE_MS);
  }

  function handleStyleLoading() {
    if (runtime.disposed || runtime.applyingLod) return;
    restoreAllLayerStatesBeforeRelease();
    runtime.lodCoverageWarned = { decorative: false, transit: false };
    resetFrameMeasurements(true);
    suspendAdaptive(INITIAL_SETTLE_MS);
  }

  function handleStyleData() {
    if (runtime.disposed || runtime.applyingLod) return;
    suspendAdaptive(EVENT_SETTLE_MS);
    applyLayerLod();
  }

  function nativePixelRatio() {
    const ratio = Number(window.devicePixelRatio);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  function isWindowFocused() {
    if (document.hidden === true) return false;
    if (typeof document.hasFocus !== "function") return true;
    try {
      return document.hasFocus();
    } catch {
      return true;
    }
  }

  function readMapPixelRatio(map) {
    if (!map || typeof map.getPixelRatio !== "function") return null;
    try {
      const ratio = Number(map.getPixelRatio());
      return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
    } catch {
      return null;
    }
  }

  function observedRenderScale() {
    if (!Number.isFinite(runtime.originalMapPixelRatio) || runtime.originalMapPixelRatio <= 0) {
      return runtime.activeRenderScale;
    }
    const currentRatio = readMapPixelRatio(runtime.map);
    return currentRatio === null
      ? runtime.activeRenderScale
      : currentRatio / runtime.originalMapPixelRatio;
  }

  function allowedScales() {
    return RENDER_SCALE_OPTIONS
      .map((option) => option.value)
      .filter((value) => value + 0.001 >= runtime.settings.minimumRenderScale);
  }

  function desiredRenderScale() {
    let scale = runtime.settings.adaptiveRenderScale
      ? runtime.adaptiveScale
      : runtime.settings.renderScale;
    if (runtime.settings.inactiveWindowMode && !runtime.windowFocused) {
      const scales = allowedScales();
      scale = Math.min(scale, scales[scales.length - 1] || scale);
    }
    return scale;
  }

  function applyRenderScale() {
    const map = runtime.map;
    if (!map || typeof map.setPixelRatio !== "function" || typeof map.getPixelRatio !== "function") return false;

    const scale = desiredRenderScale();
    if (!Number.isFinite(runtime.originalMapPixelRatio)) {
      runtime.mapSupported = false;
      return false;
    }

    if (Math.abs(scale - 1) <= 0.001 && !runtime.renderScaleWasWritten) {
      runtime.activeRenderScale = 1;
      runtime.mapSupported = true;
      return false;
    }

    const baselineRatio = runtime.originalMapPixelRatio;
    const targetRatio = baselineRatio * scale;
    const currentRatio = readMapPixelRatio(map);
    if (currentRatio === null) {
      runtime.mapSupported = false;
      console.warn(`[${MOD_NAME}] MapLibre stopped reporting its pixel ratio; render scaling was left unchanged.`);
      return false;
    }
    if (Math.abs(scale - 1) > 0.001 && Math.abs(currentRatio - targetRatio) <= 0.001) {
      runtime.activeRenderScale = scale;
      runtime.mapSupported = true;
      return false;
    }

    runtime.applyingRenderScale = true;
    try {
      if (Math.abs(scale - 1) <= 0.001) {
        map.setPixelRatio(runtime.originalMapPixelRatioImplicit ? null : runtime.originalMapPixelRatio);
        runtime.renderScaleWasWritten = false;
      } else {
        map.setPixelRatio(targetRatio);
        runtime.renderScaleWasWritten = true;
      }
      runtime.activeRenderScale = scale;
      runtime.mapSupported = true;
      resetFrameMeasurements(false);
      return true;
    } catch (error) {
      runtime.mapSupported = false;
      console.warn(`[${MOD_NAME}] Render scaling was rejected; the previous map quality remains active.`, error);
      return false;
    } finally {
      runtime.applyingRenderScale = false;
    }
  }

  function restoreOriginalRenderScale() {
    const map = runtime.map;
    if (
      !runtime.renderScaleWasWritten
      || !map
      || typeof map.setPixelRatio !== "function"
      || !Number.isFinite(runtime.originalMapPixelRatio)
    ) return;

    runtime.applyingRenderScale = true;
    try {
      map.setPixelRatio(runtime.originalMapPixelRatioImplicit ? null : runtime.originalMapPixelRatio);
      runtime.renderScaleWasWritten = false;
    } catch (error) {
      console.warn(`[${MOD_NAME}] The original render scale could not be restored during cleanup.`, error);
    } finally {
      runtime.applyingRenderScale = false;
    }
  }

  function handleWindowResize() {
    if (runtime.disposed) return;
    const previousRatio = runtime.lastDevicePixelRatio;
    const nextRatio = nativePixelRatio();
    runtime.lastDevicePixelRatio = nextRatio;
    if (runtime.originalMapPixelRatioImplicit && Number.isFinite(runtime.originalMapPixelRatio)) {
      runtime.originalMapPixelRatio = nextRatio;
    }
    resetFrameMeasurements(true);
    suspendAdaptive(EVENT_SETTLE_MS);
    applyRenderScale();
    if (Math.abs(previousRatio - nextRatio) > 0.001) watchDevicePixelRatio();
  }

  function handleDevicePixelRatioChange() {
    if (runtime.disposed) return;
    handleWindowResize();
  }

  function watchDevicePixelRatio() {
    removeDevicePixelRatioWatcher();
    if (runtime.disposed || typeof window.matchMedia !== "function") return;

    try {
      const mediaQuery = window.matchMedia(`(resolution: ${nativePixelRatio()}dppx)`);
      if (!mediaQuery) return;
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleDevicePixelRatioChange);
      } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(handleDevicePixelRatioChange);
      } else {
        return;
      }
      runtime.dprMediaQuery = mediaQuery;
      runtime.dprMediaQueryListener = handleDevicePixelRatioChange;
    } catch {
      runtime.dprMediaQuery = null;
      runtime.dprMediaQueryListener = null;
    }
  }

  function removeDevicePixelRatioWatcher() {
    const mediaQuery = runtime.dprMediaQuery;
    const listener = runtime.dprMediaQueryListener;
    if (mediaQuery && listener) {
      try {
        if (typeof mediaQuery.removeEventListener === "function") {
          mediaQuery.removeEventListener("change", listener);
        } else if (typeof mediaQuery.removeListener === "function") {
          mediaQuery.removeListener(listener);
        }
      } catch {
        // The window may already be tearing down.
      }
    }
    runtime.dprMediaQuery = null;
    runtime.dprMediaQueryListener = null;
  }

  function handleWindowFocus() {
    if (runtime.disposed) return;
    runtime.windowFocused = isWindowFocused();
    resetFrameMeasurements(true);
    if (runtime.windowFocused) suspendAdaptive(INITIAL_SETTLE_MS);
    else resetAdaptiveCounters();
    applyRenderScale();
    syncMonitoring();
  }

  function handleWindowBlur() {
    if (runtime.disposed) return;
    runtime.windowFocused = false;
    resetFrameMeasurements(true);
    resetAdaptiveCounters();
    applyRenderScale();
    syncMonitoring();
  }

  function handleVisibilityChange() {
    if (runtime.disposed) return;
    runtime.windowFocused = isWindowFocused();
    resetFrameMeasurements(true);
    if (runtime.windowFocused) suspendAdaptive(INITIAL_SETTLE_MS);
    else resetAdaptiveCounters();
    applyRenderScale();
    syncMonitoring();
  }

  function syncMonitoring() {
    if (runtime.disposed) return;

    const diagnosticsActive = !runtime.settings.inactiveWindowMode || runtime.windowFocused;
    if (runtime.gameActive && diagnosticsActive && runtime.settings.showFps) ensureOverlay();
    else removeOverlay();

    const shouldSample = shouldSampleNow();
    if (shouldSample && runtime.animationFrameId === null) startSampler();
    if (!shouldSample && runtime.animationFrameId !== null) stopSampler();

    const shouldLog = runtime.gameActive
      && document.hidden !== true
      && diagnosticsActive
      && runtime.settings.diagnosticLogging;
    if (shouldLog && runtime.diagnosticTimerId === null) {
      runtime.diagnosticTimerId = window.setInterval(logDiagnostics, LOG_INTERVAL_MS);
    } else if (!shouldLog && runtime.diagnosticTimerId !== null) {
      window.clearInterval(runtime.diagnosticTimerId);
      runtime.diagnosticTimerId = null;
    }
  }

  function shouldSampleNow() {
    if (!runtime.gameActive || document.hidden === true) return false;
    if (runtime.settings.inactiveWindowMode && !runtime.windowFocused) return false;
    return Boolean(
      (runtime.settings.adaptiveRenderScale && runtime.mapSupported && runtime.map)
      || runtime.settings.showFps
      || runtime.settings.diagnosticLogging
      || runtime.benchmarkCapturing
    );
  }

  function startSampler() {
    resetFrameMeasurements(true);
    if (runtime.benchmarkCapturing) {
      const now = performance.now();
      resetBenchmarkWindow(now);
      runtime.benchmarkLastFrameAt = now;
    }
    runtime.animationFrameId = shouldSampleNow()
      ? window.requestAnimationFrame(sampleFrame)
      : null;
  }

  function stopSampler() {
    if (runtime.animationFrameId !== null) {
      window.cancelAnimationFrame(runtime.animationFrameId);
      runtime.animationFrameId = null;
    }
    if (runtime.benchmarkCapturing) {
      resetBenchmarkWindow(null);
      runtime.benchmarkLastFrameAt = null;
    }
    resetFrameMeasurements(true);
  }

  function resetFrameMeasurements(resetProbe) {
    const now = performance.now();
    runtime.sampleStartedAt = now;
    runtime.lastFrameAt = now;
    runtime.frameTimes = [];
    runtime.currentFps = null;
    runtime.displayFps = null;
    runtime.displayFrameTimes = [];
    runtime.lastOverlayUpdateAt = 0;
    runtime.p95FrameMs = null;
    runtime.longFrames = 0;
    runtime.smoothedFrameMs = null;
    if (resetProbe) {
      runtime.scaleProbe = null;
      runtime.limitationHint = "collecting";
    }
  }

  function sampleFrame(now) {
    if (runtime.disposed) return;

    const duration = now - runtime.lastFrameAt;
    if (duration > 0 && duration <= MAX_RECORDED_FRAME_MS) {
      runtime.frameTimes.push(duration);
      runtime.displayFrameTimes.push({ at: now, duration });
      updateDisplayFps(now);
    } else if (duration > MAX_RECORDED_FRAME_MS) {
      runtime.sampleStartedAt = now;
      runtime.frameTimes = [];
      runtime.displayFps = null;
      runtime.displayFrameTimes = [];
      runtime.lastOverlayUpdateAt = now;
      runtime.smoothedFrameMs = null;
      resetAdaptiveCounters();
    }
    runtime.lastFrameAt = now;

    if (runtime.benchmarkCapturing && runtime.benchmarkLastFrameAt !== null) {
      const benchmarkDuration = now - runtime.benchmarkLastFrameAt;
      if (benchmarkDuration > 0 && benchmarkDuration <= MAX_RECORDED_FRAME_MS) {
        runtime.benchmarkFrameTimes.push(benchmarkDuration);
        runtime.benchmarkWindowFrameTimes.push(benchmarkDuration);
        if (runtime.benchmarkFrameTimes.length > BENCHMARK_FRAME_LIMIT) {
          runtime.benchmarkFrameTimes.splice(0, 10_000);
        }
      } else if (benchmarkDuration > MAX_RECORDED_FRAME_MS) {
        resetBenchmarkWindow(now);
      }
      runtime.benchmarkLastFrameAt = now;
    }

    if (
      runtime.benchmarkCapturing
      && runtime.benchmarkWindowStartedAt !== null
      && now - runtime.benchmarkWindowStartedAt >= SAMPLE_WINDOW_MS
      && runtime.benchmarkWindowFrameTimes.length > 1
    ) {
      recordBenchmarkSample(
        now,
        runtime.benchmarkWindowFrameTimes,
        now - runtime.benchmarkWindowStartedAt
      );
      resetBenchmarkWindow(now);
    }

    const elapsed = now - runtime.sampleStartedAt;
    if (elapsed >= SAMPLE_WINDOW_MS && runtime.frameTimes.length > 1) {
      const measurementWindowStartedAt = runtime.sampleStartedAt;
      const sorted = runtime.frameTimes.slice().sort((a, b) => a - b);
      runtime.currentFps = (runtime.frameTimes.length * 1000) / elapsed;
      runtime.p95FrameMs = percentile(sorted, 0.95);
      runtime.longFrames = runtime.frameTimes.filter((frameMs) => frameMs > 33.4).length;
      const averageFrameMs = elapsed / runtime.frameTimes.length;
      const cleanAdaptiveWindow = measurementWindowStartedAt >= runtime.adaptiveBlockedUntil
        && !runtime.mapMoving
        && runtime.windowFocused;
      runtime.smoothedFrameMs = cleanAdaptiveWindow
        ? runtime.smoothedFrameMs === null
          ? averageFrameMs
          : runtime.smoothedFrameMs * 0.75 + averageFrameMs * 0.25
        : null;
      runtime.sampleStartedAt = now;
      runtime.frameTimes = [];
      updateScaleProbe();
      updateOverlay();
      updateAdaptiveScale(now);
    }

    runtime.animationFrameId = shouldSampleNow()
      ? window.requestAnimationFrame(sampleFrame)
      : null;
  }

  function updateDisplayFps(now) {
    const cutoff = now - DISPLAY_FPS_WINDOW_MS;
    while (
      runtime.displayFrameTimes.length > 0
      && runtime.displayFrameTimes[0].at < cutoff
    ) {
      runtime.displayFrameTimes.shift();
    }
    if (now - runtime.lastOverlayUpdateAt < OVERLAY_REFRESH_MS) return;

    const elapsed = runtime.displayFrameTimes.reduce(
      (total, frame) => total + frame.duration,
      0
    );
    runtime.displayFps = elapsed > 0 && runtime.displayFrameTimes.length > 1
      ? (runtime.displayFrameTimes.length * 1000) / elapsed
      : null;
    runtime.lastOverlayUpdateAt = now;
    updateOverlay();
  }

  function percentile(sorted, fraction) {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return sorted[index];
  }

  function median(values) {
    if (values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  }

  function resetAdaptiveScale() {
    runtime.adaptiveScale = 1;
    runtime.lastAdaptiveChangeAt = performance.now();
    resetFrameMeasurements(true);
    resetAdaptiveCounters();
    suspendAdaptive(INITIAL_SETTLE_MS);
  }

  function resetAdaptiveCounters() {
    runtime.adaptiveLowSamples = 0;
    runtime.adaptiveHighSamples = 0;
  }

  function suspendAdaptive(milliseconds) {
    const now = performance.now();
    runtime.adaptiveBlockedUntil = Math.max(runtime.adaptiveBlockedUntil, now + milliseconds);
    runtime.scaleProbe = null;
    runtime.limitationHint = "collecting";
    resetAdaptiveCounters();
  }

  function updateAdaptiveScale(now) {
    if (!runtime.settings.adaptiveRenderScale || !runtime.mapSupported || !runtime.map) return;
    if (runtime.currentFps === null || runtime.p95FrameMs === null || runtime.smoothedFrameMs === null) return;
    if (runtime.mapMoving || !runtime.windowFocused || now < runtime.adaptiveBlockedUntil) return;
    if (now - runtime.lastAdaptiveChangeAt < ADAPTIVE_COOLDOWN_MS) return;

    const target = runtime.settings.adaptiveTargetFps;
    const smoothedFps = 1000 / runtime.smoothedFrameMs;
    const targetFrameMs = 1000 / target;
    const tooSlow = smoothedFps < target * 0.92 || runtime.p95FrameMs > targetFrameMs * 1.35;
    const recoveryThreshold = target === 60 ? target * 0.98 : target * 1.08;
    const hasHeadroom = smoothedFps >= recoveryThreshold && runtime.p95FrameMs <= targetFrameMs * 1.1;

    if (tooSlow) {
      runtime.adaptiveLowSamples += 1;
      runtime.adaptiveHighSamples = 0;
    } else if (hasHeadroom) {
      runtime.adaptiveHighSamples += 1;
      runtime.adaptiveLowSamples = 0;
    } else {
      resetAdaptiveCounters();
    }

    const scales = allowedScales();
    const currentIndex = scales.findIndex((value) => Math.abs(value - runtime.adaptiveScale) < 0.001);
    if (currentIndex < 0) return;

    let nextScale = runtime.adaptiveScale;
    if (runtime.adaptiveLowSamples >= ADAPTIVE_DOWN_SAMPLES && currentIndex < scales.length - 1) {
      nextScale = scales[currentIndex + 1];
    } else if (runtime.adaptiveHighSamples >= ADAPTIVE_UP_SAMPLES && currentIndex > 0) {
      nextScale = scales[currentIndex - 1];
    }
    if (nextScale === runtime.adaptiveScale) return;

    const previousScale = runtime.adaptiveScale;
    const direction = nextScale < previousScale ? "down" : "up";
    runtime.adaptiveScale = nextScale;
    resetAdaptiveCounters();
    applyRenderScale();
    if (!runtime.mapSupported || Math.abs(runtime.activeRenderScale - nextScale) > 0.001) {
      runtime.adaptiveScale = previousScale;
      runtime.scaleProbe = null;
      return;
    }
    runtime.scaleProbe = {
      beforeFps: smoothedFps,
      direction,
      samplesRemaining: 3,
      afterFpsSamples: []
    };
    runtime.limitationHint = "measuring";
    runtime.lastAdaptiveChangeAt = now;
    updateOverlay();
    if (runtime.settings.diagnosticLogging) {
      console.info(`[${MOD_NAME}:adaptive] Map render scale changed to ${Math.round(nextScale * 100)}%.`);
    }
  }

  function updateScaleProbe() {
    const probe = runtime.scaleProbe;
    if (
      !probe
      || runtime.currentFps === null
      || runtime.mapMoving
      || !runtime.windowFocused
      || performance.now() < runtime.adaptiveBlockedUntil
    ) return;
    probe.afterFpsSamples.push(runtime.currentFps);
    probe.samplesRemaining -= 1;
    if (probe.samplesRemaining > 0) return;

    const afterFps = median(probe.afterFpsSamples);
    const improvement = probe.direction === "down"
      ? (afterFps - probe.beforeFps) / Math.max(1, probe.beforeFps)
      : (probe.beforeFps - afterFps) / Math.max(1, probe.beforeFps);
    runtime.limitationHint = improvement >= 0.08
      ? "likely GPU/render"
      : improvement <= 0.03
        ? "likely CPU/other"
        : "mixed";
    runtime.scaleProbe = null;
  }

  function currentZoom() {
    const map = runtime.map;
    if (!map || typeof map.getZoom !== "function") return null;
    try {
      const zoom = Number(map.getZoom());
      return Number.isFinite(zoom) ? zoom : null;
    } catch {
      return null;
    }
  }

  function applyLayerLod() {
    const map = runtime.map;
    if (!map || runtime.applyingLod || typeof map.getStyle !== "function" || typeof map.setLayoutProperty !== "function") return;
    const zoom = currentZoom();
    if (zoom === null) return;

    let layers;
    try {
      const style = map.getStyle();
      layers = style && Array.isArray(style.layers) ? style.layers : [];
    } catch (error) {
      console.warn(`[${MOD_NAME}] Map layers could not be audited; LOD remains unchanged.`, error);
      return;
    }

    warnOnStaleAllowlist(layers);

    runtime.applyingLod = true;
    try {
      if (runtime.settings.decorativeLod && zoom <= DECORATIVE_LOD_MAX_ZOOM) {
        hideMatchingLayers("decorative", layers, isDecorativeLayer);
      } else {
        restoreLayerGroup("decorative");
      }
      if (runtime.settings.transitLod && zoom <= TRANSIT_LOD_MAX_ZOOM) {
        hideMatchingLayers("transit", layers, isTransitDetailLayer);
      } else {
        restoreLayerGroup("transit");
      }
    } finally {
      runtime.applyingLod = false;
    }
  }

  function lodCoverage(layers) {
    return {
      decorative: `${layers.filter(isDecorativeLayer).length}/${DECORATIVE_LAYER_IDS.length}`,
      transit: `${layers.filter(isTransitDetailLayer).length}/${TRANSIT_DETAIL_LAYER_IDS.length}`
    };
  }

  function currentLodCoverage() {
    const map = runtime.map;
    if (!map || typeof map.getStyle !== "function") return null;
    try {
      const style = map.getStyle();
      return style && Array.isArray(style.layers) ? lodCoverage(style.layers) : null;
    } catch {
      return null;
    }
  }

  function warnOnStaleAllowlist(layers) {
    if (layers.length === 0) return;
    const groups = [
      ["decorative", runtime.settings.decorativeLod, isDecorativeLayer, "Decorative"],
      ["transit", runtime.settings.transitLod, isTransitDetailLayer, "Transit-detail"]
    ];
    for (const [group, enabled, predicate, label] of groups) {
      if (!enabled || runtime.lodCoverageWarned[group]) continue;
      if (layers.some(predicate)) continue;
      runtime.lodCoverageWarned[group] = true;
      console.warn(
        `[${MOD_NAME}] ${label} LOD found none of its audited layers in this game build's map style; `
        + "the toggle is safely inactive. The allowlist may need revalidation for this Subway Builder version."
      );
    }
  }

  function isDecorativeLayer(layer) {
    if (!layer || typeof layer.id !== "string") return false;
    return layer.type === "fill-extrusion" && DECORATIVE_LAYER_IDS.includes(layer.id);
  }

  function isTransitDetailLayer(layer) {
    if (!layer || typeof layer.id !== "string") return false;
    return TRANSIT_DETAIL_LAYER_IDS.includes(layer.id);
  }

  function hideMatchingLayers(group, layers, predicate) {
    const map = runtime.map;
    const snapshots = runtime.layerSnapshots[group];
    for (const layer of layers) {
      if (!predicate(layer)) continue;
      try {
        const current = typeof map.getLayoutProperty === "function"
          ? map.getLayoutProperty(layer.id, "visibility")
          : layer.layout && layer.layout.visibility;
        if (!snapshots.has(layer.id)) {
          snapshots.set(layer.id, {
            visibility: current === "none" ? "none" : "visible"
          });
        }
        if (current !== "none") map.setLayoutProperty(layer.id, "visibility", "none");
      } catch (error) {
        console.warn(`[${MOD_NAME}] Layer "${layer.id}" could not be hidden safely.`, error);
      }
    }
  }

  function restoreLayerGroup(group, retainFailures = true) {
    const map = runtime.map;
    const snapshots = runtime.layerSnapshots[group];
    if (!map || typeof map.setLayoutProperty !== "function") {
      snapshots.clear();
      return;
    }

    const failedSnapshots = [];
    for (const [layerId, snapshot] of snapshots) {
      try {
        if (typeof map.getLayer === "function" && !map.getLayer(layerId)) continue;
        map.setLayoutProperty(
          layerId,
          "visibility",
          snapshot.visibility
        );
      } catch (error) {
        if (retainFailures) failedSnapshots.push([layerId, snapshot]);
        console.warn(`[${MOD_NAME}] Layer "${layerId}" could not be restored during cleanup.`, error);
      }
    }
    snapshots.clear();
    for (const [layerId, snapshot] of failedSnapshots) snapshots.set(layerId, snapshot);
  }

  function restoreAllLayerStates(retainFailures = true) {
    if (runtime.applyingLod) return;
    runtime.applyingLod = true;
    try {
      restoreLayerGroup("decorative", retainFailures);
      restoreLayerGroup("transit", retainFailures);
    } finally {
      runtime.applyingLod = false;
    }
  }

  function restoreAllLayerStatesBeforeRelease() {
    restoreAllLayerStates(true);
    if (
      runtime.layerSnapshots.decorative.size > 0
      || runtime.layerSnapshots.transit.size > 0
    ) {
      restoreAllLayerStates(false);
    }
  }

  function ensureOverlay() {
    if (runtime.overlay && runtime.overlay.isConnected) return;

    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-label", "Performance diagnostics");
    overlay.setAttribute("aria-live", "off");
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
      font: "600 12px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace",
      fontVariantNumeric: "tabular-nums",
      pointerEvents: "none",
      userSelect: "none",
      whiteSpace: "pre"
    });
    overlay.textContent = "… FPS";
    document.body.appendChild(overlay);
    runtime.overlay = overlay;
  }

  function updateOverlay() {
    if (!runtime.overlay || !runtime.overlay.isConnected) return;
    const fps = runtime.displayFps ?? runtime.currentFps;
    if (fps === null) return;
    let text;
    if (!runtime.settings.detailedOverlay) {
      text = `${Math.round(fps)} FPS`;
    } else {
      const p95 = runtime.p95FrameMs === null ? "…" : runtime.p95FrameMs.toFixed(1);
      text = `${Math.round(fps)} FPS · p95 ${p95} ms\n${Math.round(observedRenderScale() * 100)}% · ${runtime.limitationHint}`;
    }
    if (runtime.overlay.textContent !== text) runtime.overlay.textContent = text;
  }

  function removeOverlay() {
    if (runtime.overlay) runtime.overlay.remove();
    runtime.overlay = null;
    const staleOverlay = document.getElementById(OVERLAY_ID);
    if (staleOverlay) staleOverlay.remove();
  }

  function recordBenchmarkSample(now, frameTimes, elapsed) {
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    runtime.benchmarkSamples.push({
      at: now,
      fps: (frameTimes.length * 1000) / elapsed,
      p95FrameMs: percentile(sorted, 0.95),
      longFrames: frameTimes.filter((frameMs) => frameMs > 33.4).length,
      jsHeapMB: currentJsHeapMB(),
      scale: observedRenderScale(),
      zoom: currentZoom(),
      paused: runtime.paused,
      speed: runtime.simulationSpeed,
      moving: runtime.mapMoving,
      focused: runtime.windowFocused
    });
    if (runtime.benchmarkSamples.length > 3_600) runtime.benchmarkSamples.shift();
  }

  function resetBenchmarkWindow(startedAt) {
    runtime.benchmarkWindowFrameTimes = [];
    runtime.benchmarkWindowStartedAt = startedAt;
  }

  function recordBenchmarkEvent(type) {
    if (!runtime.benchmarkCapturing || runtime.benchmarkStartedAt === null) return;
    runtime.benchmarkEvents.push({
      type,
      atSeconds: roundOrNull((performance.now() - runtime.benchmarkStartedAt) / 1000)
    });
  }

  function currentJsHeapMB() {
    const memory = performance.memory;
    return memory && Number.isFinite(memory.usedJSHeapSize)
      ? Number((memory.usedJSHeapSize / 1_048_576).toFixed(1))
      : null;
  }

  function readCurrentGameState() {
    const gameState = api.gameState;
    if (!gameState || typeof gameState !== "object") return;

    if (typeof gameState.getGameSpeed === "function") {
      try {
        const speed = gameState.getGameSpeed();
        runtime.simulationSpeed = speed ? String(speed) : "unknown";
      } catch (error) {
        console.warn(`[${MOD_NAME}] Current simulation speed could not be read.`, error);
      }
    }

    if (typeof gameState.isPaused === "function") {
      try {
        runtime.paused = gameState.isPaused() === true;
      } catch (error) {
        console.warn(`[${MOD_NAME}] Current pause state could not be read.`, error);
      }
    }

    if (typeof gameState.getSaveName === "function") {
      try {
        const saveName = gameState.getSaveName();
        runtime.saveName = typeof saveName === "string" && saveName.trim()
          ? saveName.trim()
          : null;
      } catch (error) {
        console.warn(`[${MOD_NAME}] Current save name could not be read.`, error);
      }
    }

    if (typeof gameState.getGameSessionId === "function") {
      try {
        const sessionId = gameState.getGameSessionId();
        runtime.gameSessionId = typeof sessionId === "string" && sessionId.trim()
          ? sessionId.trim()
          : null;
      } catch {
        runtime.gameSessionId = null;
      }
    }

    if (typeof gameState.getCurrentDay === "function") {
      try {
        const day = Number(gameState.getCurrentDay());
        runtime.gameDay = Number.isFinite(day) ? day : null;
      } catch {
        runtime.gameDay = null;
      }
    }

    if (typeof gameState.getCurrentHour === "function") {
      try {
        const hour = Number(gameState.getCurrentHour());
        runtime.gameHour = Number.isFinite(hour) ? hour : null;
      } catch {
        runtime.gameHour = null;
      }
    }
  }

  function tuningSupport() {
    return {
      batching: typeof api.modifyConstants === "function"
        && typeof api.utils.getConstants === "function",
      pathfinding: typeof api.modifyPathfindingRules === "function"
        && typeof api.utils.getPathfindingRules === "function"
    };
  }

  function ensureTuningBaseline(support) {
    const cached = runtime.tuningBaseline;
    if (
      cached
      && (!support.batching || cached.ticksPerUpdate)
      && (!support.pathfinding || cached.maxTransfers !== null)
    ) return cached;
    const baseline = cached || { ticksPerUpdate: null, maxTicksPerUpdate: null, maxTransfers: null };
    if (support.batching && !baseline.ticksPerUpdate) {
      try {
        const constants = api.utils.getConstants();
        if (constants && typeof constants === "object") {
          if (constants.TICKS_PER_UPDATE && typeof constants.TICKS_PER_UPDATE === "object") {
            baseline.ticksPerUpdate = JSON.parse(JSON.stringify(constants.TICKS_PER_UPDATE));
          }
          const ceiling = Number(constants.MAX_TICKS_PER_UPDATE);
          baseline.maxTicksPerUpdate = Number.isFinite(ceiling) && ceiling > 0
            ? ceiling
            : DEFAULT_MAX_TICKS_PER_UPDATE;
        }
      } catch (error) {
        console.warn(`[${MOD_NAME}] Game constants could not be read; update batching stays off.`, error);
      }
    }
    if (support.pathfinding && baseline.maxTransfers === null) {
      try {
        const rules = api.utils.getPathfindingRules();
        const maxTransfers = rules && Number(rules.MAX_TRANSFERS);
        if (Number.isFinite(maxTransfers) && maxTransfers > 1) baseline.maxTransfers = maxTransfers;
      } catch (error) {
        console.warn(`[${MOD_NAME}] Pathfinding rules could not be read; reduced depth stays off.`, error);
      }
    }
    runtime.tuningBaseline = baseline;
    return baseline;
  }

  function batchedTicksPatch(baseline, level) {
    const multipliers = TUNING_BATCHING_MULTIPLIERS[level];
    if (!multipliers || !baseline.ticksPerUpdate) return null;
    const patch = {};
    for (const [tier, factor] of Object.entries(multipliers)) {
      const original = baseline.ticksPerUpdate[tier];
      if (!original || typeof original !== "object") continue;
      const tierPatch = {};
      for (const [key, value] of Object.entries(original)) {
        if (!Number.isFinite(Number(value))) continue;
        tierPatch[key] = Math.min(
          baseline.maxTicksPerUpdate || DEFAULT_MAX_TICKS_PER_UPDATE,
          Math.max(1, Math.round(Number(value) * factor))
        );
      }
      if (Object.keys(tierPatch).length > 0) patch[tier] = tierPatch;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  function applyTuning() {
    const support = tuningSupport();
    const wantsBatching = runtime.settings.simTickBatching !== "off";
    const wantsPathfinding = runtime.settings.pathfindingLite === true;
    if (
      !wantsBatching && !runtime.tuningWritten.batching
      && !wantsPathfinding && !runtime.tuningWritten.pathfinding
    ) return;

    const baseline = ensureTuningBaseline(support);

    if (support.batching && baseline.ticksPerUpdate) {
      try {
        if (wantsBatching) {
          const patch = batchedTicksPatch(baseline, runtime.settings.simTickBatching);
          if (patch) {
            api.modifyConstants({ TICKS_PER_UPDATE: patch });
            runtime.tuningWritten.batching = true;
          }
        } else if (runtime.tuningWritten.batching) {
          api.modifyConstants({
            TICKS_PER_UPDATE: JSON.parse(JSON.stringify(baseline.ticksPerUpdate))
          });
          runtime.tuningWritten.batching = false;
        }
      } catch (error) {
        console.warn(`[${MOD_NAME}] Update batching could not be applied; game defaults remain active.`, error);
      }
    }

    if (support.pathfinding && baseline.maxTransfers !== null) {
      try {
        if (wantsPathfinding) {
          api.modifyPathfindingRules({ MAX_TRANSFERS: baseline.maxTransfers - 1 });
          runtime.tuningWritten.pathfinding = true;
        } else if (runtime.tuningWritten.pathfinding) {
          api.modifyPathfindingRules({ MAX_TRANSFERS: baseline.maxTransfers });
          runtime.tuningWritten.pathfinding = false;
        }
      } catch (error) {
        console.warn(`[${MOD_NAME}] Reduced pathfinding depth could not be applied; game defaults remain active.`, error);
      }
    }
  }

  function restoreTuning() {
    const baseline = runtime.tuningBaseline;
    if (!baseline) return;
    if (runtime.tuningWritten.batching && baseline.ticksPerUpdate) {
      try {
        api.modifyConstants({
          TICKS_PER_UPDATE: JSON.parse(JSON.stringify(baseline.ticksPerUpdate))
        });
        runtime.tuningWritten.batching = false;
      } catch (error) {
        console.warn(`[${MOD_NAME}] Update batching could not be restored during cleanup.`, error);
      }
    }
    if (runtime.tuningWritten.pathfinding && baseline.maxTransfers !== null) {
      try {
        api.modifyPathfindingRules({ MAX_TRANSFERS: baseline.maxTransfers });
        runtime.tuningWritten.pathfinding = false;
      } catch (error) {
        console.warn(`[${MOD_NAME}] Pathfinding depth could not be restored during cleanup.`, error);
      }
    }
  }

  function captureBenchmarkState() {
    return {
      zoom: roundOrNull(currentZoom()),
      renderScalePercent: Math.round(observedRenderScale() * 100),
      saveName: runtime.saveName,
      sessionId: runtime.gameSessionId,
      day: runtime.gameDay,
      hour: runtime.gameHour,
      paused: runtime.paused,
      simulationSpeed: runtime.simulationSpeed,
      focused: runtime.windowFocused,
      jsHeapMB: currentJsHeapMB()
    };
  }

  function benchmarkSummary() {
    const samples = runtime.benchmarkSamples;
    const rawFrames = runtime.benchmarkFrameTimes;
    const sortedRawFrames = rawFrames.slice().sort((a, b) => a - b);
    const heapSamples = samples
      .map((sample) => sample.jsHeapMB)
      .filter((value) => Number.isFinite(value));
    const zoomSamples = samples
      .map((sample) => sample.zoom)
      .filter((value) => Number.isFinite(value));
    const captureEnd = runtime.benchmarkCapturing
      ? performance.now()
      : runtime.benchmarkEndedAt;
    const captureDurationSeconds = runtime.benchmarkStartedAt !== null && captureEnd !== null
      ? Math.max(0, (captureEnd - runtime.benchmarkStartedAt) / 1000)
      : null;
    const capturedState = runtime.benchmarkStartedAt === null
      ? captureBenchmarkState()
      : runtime.benchmarkCapturing
        ? captureBenchmarkState()
        : runtime.benchmarkFinalState || runtime.benchmarkInitialState || captureBenchmarkState();
    return {
      modVersion: MOD_VERSION,
      configuration: runtime.benchmarkConfiguration,
      environment: runtime.benchmarkEnvironment,
      initialState: runtime.benchmarkInitialState,
      finalState: capturedState,
      durationSeconds: roundOrNull(captureDurationSeconds),
      samples: samples.length,
      frameCount: rawFrames.length,
      medianFps: roundOrNull(median(samples.map((sample) => sample.fps))),
      p95FrameMs: sortedRawFrames.length === 0
        ? null
        : roundOrNull(percentile(sortedRawFrames, 0.95)),
      worstFrameMs: sortedRawFrames.length === 0
        ? null
        : roundOrNull(sortedRawFrames[sortedRawFrames.length - 1]),
      medianP95FrameMs: roundOrNull(median(samples.map((sample) => sample.p95FrameMs))),
      totalLongFrames: rawFrames.length === 0
        ? samples.reduce((total, sample) => total + sample.longFrames, 0)
        : rawFrames.filter((frameMs) => frameMs > 33.4).length,
      scaleRangePercent: samples.length === 0
        ? null
        : [
            Math.round(Math.min(...samples.map((sample) => sample.scale)) * 100),
            Math.round(Math.max(...samples.map((sample) => sample.scale)) * 100)
      ],
      zoomRange: zoomSamples.length === 0
        ? null
        : [
            roundOrNull(Math.min(...zoomSamples)),
            roundOrNull(Math.max(...zoomSamples))
        ],
      zoom: capturedState.zoom,
      saveName: capturedState.saveName,
      sessionId: capturedState.sessionId,
      paused: capturedState.paused,
      simulationSpeed: capturedState.simulationSpeed,
      focused: capturedState.focused,
      jsHeapMB: capturedState.jsHeapMB,
      medianJsHeapMB: roundOrNull(median(heapSamples)),
      peakJsHeapMB: heapSamples.length === 0 ? null : roundOrNull(Math.max(...heapSamples)),
      trainsSpawned: runtime.benchmarkTrainCounts.spawned,
      trainsDeleted: runtime.benchmarkTrainCounts.deleted,
      events: runtime.benchmarkEvents.slice()
    };
  }

  function roundOrNull(value) {
    return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(1));
  }

  async function copyBenchmarkSummary() {
    const text = JSON.stringify(benchmarkSummary(), null, 2);
    try {
      if (window.navigator && window.navigator.clipboard && typeof window.navigator.clipboard.writeText === "function") {
        await window.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      console.warn(`[${MOD_NAME}] Clipboard access was denied; the benchmark snapshot was logged instead.`, error);
    }
    console.info(`[${MOD_NAME}:benchmark]\n${text}`);
    return false;
  }

  function clearBenchmarkSamples() {
    runtime.benchmarkSamples = [];
    runtime.benchmarkFrameTimes = [];
    runtime.benchmarkWindowFrameTimes = [];
    runtime.benchmarkEvents = [];
    runtime.benchmarkTrainCounts = { spawned: 0, deleted: 0 };
    runtime.benchmarkEndedAt = null;
    runtime.benchmarkFinalState = null;
    if (runtime.benchmarkCapturing) {
      runtime.benchmarkStartedAt = performance.now();
      runtime.benchmarkWindowStartedAt = runtime.benchmarkStartedAt;
      runtime.benchmarkLastFrameAt = runtime.benchmarkStartedAt;
      runtime.benchmarkConfiguration = { ...runtime.settings };
      runtime.benchmarkEnvironment = {
        apiVersion: api.version || "unknown",
        devicePixelRatio: nativePixelRatio(),
        mapPixelRatio: readMapPixelRatio(runtime.map),
        windowWidth: Number.isFinite(Number(window.innerWidth)) ? Number(window.innerWidth) : null,
        windowHeight: Number.isFinite(Number(window.innerHeight)) ? Number(window.innerHeight) : null
      };
      runtime.benchmarkInitialState = captureBenchmarkState();
    } else {
      runtime.benchmarkWindowStartedAt = null;
      runtime.benchmarkLastFrameAt = null;
      runtime.benchmarkStartedAt = null;
      runtime.benchmarkConfiguration = null;
      runtime.benchmarkEnvironment = null;
      runtime.benchmarkInitialState = null;
    }
  }

  function startBenchmarkCapture() {
    readCurrentGameState();
    runtime.benchmarkCapturing = true;
    clearBenchmarkSamples();
    resetFrameMeasurements(true);
    syncMonitoring();
  }

  function stopBenchmarkCapture() {
    finishBenchmarkCapture();
    syncMonitoring();
  }

  function finishBenchmarkCapture() {
    if (!runtime.benchmarkCapturing) return;
    runtime.benchmarkEndedAt = performance.now();
    runtime.benchmarkFinalState = captureBenchmarkState();
    runtime.benchmarkCapturing = false;
    resetBenchmarkWindow(null);
    runtime.benchmarkLastFrameAt = null;
  }

  function simulationCadenceSnapshot() {
    if (typeof api.utils.getConstants !== "function") return null;
    try {
      const constants = api.utils.getConstants();
      if (!constants || typeof constants !== "object") return null;
      const tiers = constants.TICKS_PER_UPDATE;
      const speed = runtime.simulationSpeed;
      return {
        maxTicksPerUpdate: Number.isFinite(Number(constants.MAX_TICKS_PER_UPDATE))
          ? Number(constants.MAX_TICKS_PER_UPDATE)
          : null,
        currentSpeedTicks: tiers && typeof tiers === "object" && tiers[speed] && typeof tiers[speed] === "object"
          ? { ...tiers[speed] }
          : null
      };
    } catch {
      return null;
    }
  }

  function logDiagnostics() {
    if (runtime.currentFps === null) return;

    const canvas = document.querySelector("canvas.maplibregl-canvas");
    const details = {
      ...benchmarkSummary(),
      currentFps: Number(runtime.currentFps.toFixed(1)),
      currentP95FrameMs: runtime.p95FrameMs === null ? null : Number(runtime.p95FrameMs.toFixed(1)),
      currentLongFrames: runtime.longFrames,
      renderScalePercent: Math.round(observedRenderScale() * 100),
      targetFps: runtime.settings.adaptiveRenderScale ? runtime.settings.adaptiveTargetFps : null,
      limitationHint: runtime.limitationHint,
      mapMoving: runtime.mapMoving,
      canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
      lodCoverage: currentLodCoverage(),
      simulationCadence: simulationCadenceSnapshot()
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

    function SelectRow({ id, label, description, value, onChange, options }) {
      return h("div", { className: "space-y-2 py-1" }, [
        h("label", { key: "label", htmlFor: id, className: "text-sm font-medium" }, label),
        h(
          "select",
          {
            key: "select",
            id,
            value: String(value),
            className: "w-full rounded border border-input bg-background px-3 py-2 text-sm",
            onChange: (event) => onChange(event.target.value)
          },
          options.map((option) => h("option", { key: option.value, value: String(option.value) }, option.label))
        ),
        h("p", { key: "description", className: "text-xs text-muted-foreground" }, description)
      ]);
    }

    function PerformanceSettings() {
      const [settings, setLocalSettings] = React.useState(runtime.settings);
      const [copyStatus, setCopyStatus] = React.useState("");
      const [capturing, setCapturing] = React.useState(runtime.benchmarkCapturing);

      const change = (key, value, customizePreset = true) => {
        const next = sanitizeSettings({
          ...settings,
          preset: customizePreset ? "custom" : settings.preset,
          [key]: value
        });
        setLocalSettings(next);
        void setSettings(next);
      };

      const changePreset = (preset) => {
        if (preset === "custom") {
          const next = sanitizeSettings({ ...settings, preset: "custom" });
          setLocalSettings(next);
          void setSettings(next);
          return;
        }
        const definition = PRESETS[preset];
        if (!definition) return;
        const next = sanitizeSettings({ ...settings, ...definition.values, preset });
        setLocalSettings(next);
        void applyPreset(preset);
      };

      const changeRenderScaleMode = (value) => {
        const automatic = value === AUTOMATIC_RENDER_SCALE_VALUE;
        const next = sanitizeSettings({
          ...settings,
          preset: "custom",
          renderScale: automatic ? 1 : Number(value),
          adaptiveRenderScale: automatic
        });
        setLocalSettings(next);
        void updateRenderScaleMode(value);
      };

      return h("section", { className: "space-y-4 p-1", "data-performance-settings": "true" }, [
        h("div", { key: "heading", className: "space-y-1" }, [
          h("h3", { key: "title", className: "text-base font-semibold" }, "Performance"),
          h(
            "p",
            { key: "intro", className: "text-xs text-muted-foreground" },
            "All simulation rules, routing, finances, and saves remain unchanged. Visual tradeoffs are optional."
          )
        ]),
        h(SelectRow, {
          key: "preset",
          id: `${MOD_ID}-preset`,
          label: "Performance preset",
          description: settings.preset === "custom"
            ? "Custom keeps the individual controls below."
            : PRESETS[settings.preset].description,
          value: settings.preset,
          onChange: changePreset,
          options: [
            ...Object.entries(PRESETS).map(([value, definition]) => ({ value, label: definition.label })),
            { value: "custom", label: "Custom" }
          ]
        }),
        h(SelectRow, {
          key: "scale",
          id: `${MOD_ID}-render-scale`,
          label: "Map render scale",
          description: "Automatic changes only the map canvas resolution. Lower fixed values make the map softer.",
          value: settings.adaptiveRenderScale ? AUTOMATIC_RENDER_SCALE_VALUE : settings.renderScale,
          onChange: changeRenderScaleMode,
          options: [
            { value: AUTOMATIC_RENDER_SCALE_VALUE, label: `Automatic - Target ${settings.adaptiveTargetFps} FPS` },
            ...RENDER_SCALE_OPTIONS
          ]
        }),
        h("details", { key: "advanced", open: settings.preset === "custom", className: "space-y-3 rounded border border-input p-3" }, [
          h("summary", { key: "summary", className: "cursor-pointer text-sm font-medium" }, "Advanced controls"),
          h("div", { key: "content", className: "mt-3 space-y-3" }, [
            h(SelectRow, {
              key: "target",
              id: `${MOD_ID}-target-fps`,
              label: "Automatic FPS target",
              description: "A higher target may reduce map sharpness more often.",
              value: settings.adaptiveTargetFps,
              onChange: (value) => change("adaptiveTargetFps", Number(value)),
              options: TARGET_FPS_OPTIONS.map((value) => ({ value, label: `${value} FPS` }))
            }),
            h(SelectRow, {
              key: "minimum",
              id: `${MOD_ID}-minimum-scale`,
              label: "Minimum automatic quality",
              description: "Automatic and inactive-window scaling never go below this value.",
              value: settings.minimumRenderScale,
              onChange: (value) => change("minimumRenderScale", Number(value)),
              options: MINIMUM_SCALE_OPTIONS.map((value) => ({ value, label: `${Math.round(value * 100)}%` }))
            }),
            h(ToggleRow, {
              key: "decorative",
              id: `${MOD_ID}-decorative-lod`,
              label: "Decorative map detail",
              description: `Hides audited 3D building and foundation layers at zoom ${DECORATIVE_LOD_MAX_ZOOM} or below. Routes and stations stay visible.`,
              checked: settings.decorativeLod,
              onChange: (value) => change("decorativeLod", value)
            }),
            h(ToggleRow, {
              key: "transit",
              id: `${MOD_ID}-transit-lod`,
              label: "Transit-detail LOD",
              description: `Hides audited arrow and signal layers at zoom ${TRANSIT_LOD_MAX_ZOOM} or below. Trains, routes, and stations stay visible.`,
              checked: settings.transitLod,
              onChange: (value) => change("transitLod", value)
            }),
            h(ToggleRow, {
              key: "inactive",
              id: `${MOD_ID}-inactive-window`,
              label: "Inactive-window mode",
              description: "Uses the allowed minimum map quality and pauses this mod's monitoring while the game is unfocused.",
              checked: settings.inactiveWindowMode,
              onChange: (value) => change("inactiveWindowMode", value)
            })
          ])
        ]),
        !runtime.mapSupported
          ? h("p", { key: "unsupported", className: "text-xs text-destructive" }, "Render scaling is unsupported by this game build; native quality remains active.")
          : null,
        (() => {
          const support = tuningSupport();
          if (!support.batching && !support.pathfinding) return null;
          return h("details", { key: "tuning", className: "space-y-3 rounded border border-input p-3" }, [
            h("summary", { key: "summary", className: "cursor-pointer text-sm font-medium" }, "Experimental tuning (affects gameplay)"),
            h("div", { key: "content", className: "mt-3 space-y-3" }, [
              h(
                "p",
                { key: "warning", className: "text-xs text-destructive" },
                "Unlike everything above, these options change simulation update cadence or commuter pathfinding through the official game-variable API. They can change gameplay results and stay off unless you enable them. Both revert to game defaults when disabled."
              ),
              support.batching
                ? h(SelectRow, {
                    key: "batching",
                    id: `${MOD_ID}-sim-batching`,
                    label: "High-speed update batching",
                    description: "Batches game-state, train, and commuter updates at fast and ultra-fast speeds so large networks stay responsive. Every simulation tick still runs; on-screen numbers and trains refresh less often at high speed.",
                    value: settings.simTickBatching,
                    onChange: (value) => change("simTickBatching", value, false),
                    options: [
                      { value: "off", label: "Off - Game defaults" },
                      { value: "conservative", label: "Conservative - 2x batching at ultra-fast" },
                      { value: "aggressive", label: "Aggressive - 2x at fast, 4x at ultra-fast" }
                    ]
                  })
                : null,
              support.pathfinding
                ? h(ToggleRow, {
                    key: "pathfinding",
                    id: `${MOD_ID}-pathfinding-lite`,
                    label: "Reduced pathfinding depth",
                    description: "Lowers the maximum journey transfers by one. Cuts commute-simulation CPU cost on large networks, but commuters may pick different journeys, which changes ridership.",
                    checked: settings.pathfindingLite,
                    onChange: (value) => change("pathfindingLite", value, false)
                  })
                : null
            ])
          ]);
        })(),
        h(ToggleRow, {
          key: "fps",
          id: `${MOD_ID}-show-fps`,
          label: "Show FPS",
          description: "Shows a lightweight live FPS counter in the upper-right corner.",
          checked: settings.showFps,
          onChange: (value) => change("showFps", value, false)
        }),
        h(ToggleRow, {
          key: "details",
          id: `${MOD_ID}-detailed-overlay`,
          label: "Detailed performance overlay",
          description: "Adds p95 frame time, current scale, and a measured renderer-versus-CPU hint. Requires Show FPS.",
          checked: settings.detailedOverlay,
          onChange: (value) => change("detailedOverlay", value, false)
        }),
        h(ToggleRow, {
          key: "logging",
          id: `${MOD_ID}-diagnostic-logging`,
          label: "Diagnostic logging",
          description: "Logs benchmark-ready FPS, p95 frame-time, scale, zoom, speed, canvas, and heap data every 10 seconds.",
          checked: settings.diagnosticLogging,
          onChange: (value) => change("diagnosticLogging", value, false)
        }),
        h("div", { key: "benchmark", className: "space-y-2 rounded border border-input p-3" }, [
          h("p", { key: "title", className: "text-sm font-medium" }, "Benchmark snapshot"),
          h(
            "p",
            { key: "description", className: "text-xs text-muted-foreground" },
            "Capture at least 30 seconds after a 15-second warm-up, then copy a compact JSON snapshot."
          ),
          h("div", { key: "buttons", className: "flex gap-2" }, [
            h(
              "button",
              {
                key: "capture",
                type: "button",
                className: "rounded border border-input px-3 py-1.5 text-xs",
                onClick: () => {
                  if (capturing) {
                    stopBenchmarkCapture();
                    setCapturing(false);
                    setCopyStatus("Capture stopped.");
                  } else {
                    startBenchmarkCapture();
                    setCapturing(true);
                    setCopyStatus("Capturing…");
                  }
                }
              },
              capturing ? "Stop capture" : "Start capture"
            ),
            h(
              "button",
              {
                key: "copy",
                type: "button",
                className: "rounded border border-input px-3 py-1.5 text-xs",
                onClick: async () => {
                  const copied = await copyBenchmarkSummary();
                  setCopyStatus(copied ? "Copied." : "Logged to DevTools.");
                }
              },
              "Copy snapshot"
            ),
            h(
              "button",
              {
                key: "clear",
                type: "button",
                className: "rounded border border-input px-3 py-1.5 text-xs",
                onClick: () => {
                  clearBenchmarkSamples();
                  setCopyStatus("Cleared.");
                }
              },
              "Clear samples"
            )
          ]),
          copyStatus ? h("p", { key: "status", className: "text-xs text-muted-foreground" }, copyStatus) : null
        ]),
        h(
          "p",
          { key: "version", className: "pt-1 text-xs text-muted-foreground" },
          `v${MOD_VERSION}`
        )
      ]);
    }

    api.ui.registerComponent("settings-menu", {
      id: `${MOD_ID}-settings`,
      component: PerformanceSettings
    });
  }

  function addDocumentListener(eventName, callback) {
    if (typeof document.addEventListener === "function") document.addEventListener(eventName, callback);
  }

  function removeDocumentListener(eventName, callback) {
    if (typeof document.removeEventListener === "function") document.removeEventListener(eventName, callback);
  }

  function addWindowListener(eventName, callback) {
    if (typeof window.addEventListener === "function") window.addEventListener(eventName, callback);
  }

  function removeWindowListener(eventName, callback) {
    if (typeof window.removeEventListener === "function") window.removeEventListener(eventName, callback);
  }

  function dispose() {
    if (runtime.disposed) return;
    runtime.disposed = true;
    finishBenchmarkCapture();
    stopSampler();
    if (runtime.diagnosticTimerId !== null) {
      window.clearInterval(runtime.diagnosticTimerId);
      runtime.diagnosticTimerId = null;
    }
    removeOverlay();
    detachMapListeners();
    restoreAllLayerStatesBeforeRelease();
    restoreOriginalRenderScale();
    restoreTuning();
    unsubscribeHooks();
    removeDevicePixelRatioWatcher();
    removeDocumentListener("visibilitychange", handleVisibilityChange);
    removeWindowListener("focus", handleWindowFocus);
    removeWindowListener("blur", handleWindowBlur);
    removeWindowListener("resize", handleWindowResize);
    runtime.map = null;
  }
})();
