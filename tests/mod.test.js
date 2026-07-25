"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const LOCAL_SETTINGS_KEY = "subway-builder-performance:settings";

test("keeps runtime and release metadata aligned with the supported game range", () => {
  assert.equal(manifest.id, "subway-builder-performance");
  assert.equal(manifest.version, "0.2.2");
  assert.equal(packageMetadata.version, manifest.version);
  assert.equal(manifest.dependencies["subway-builder"], ">=1.4.12 <1.5.0");
  assert.match(source, /const MOD_ID = "subway-builder-performance";/);
  assert.match(source, /const MOD_VERSION = "0.2.2";/);
});

function createMap(options = {}) {
  const listeners = new Map();
  const layers = (options.layers || []).map((layer) => ({
    ...layer,
    layout: layer.layout ? { ...layer.layout } : undefined
  }));
  const calls = [];
  let pixelRatioWriteDepth = 0;

  return {
    ratio: options.ratio || 2,
    zoom: options.zoom ?? 12,
    layers,
    calls,
    resized: 0,
    maxPixelRatioWriteDepth: 0,
    getPixelRatio() { return this.ratio; },
    isMoving() { return options.isMoving !== false; },
    setPixelRatio(value) {
      pixelRatioWriteDepth += 1;
      this.maxPixelRatioWriteDepth = Math.max(this.maxPixelRatioWriteDepth, pixelRatioWriteDepth);
      try {
        const implicitRatio = typeof options.getNativePixelRatio === "function"
          ? options.getNativePixelRatio()
          : options.nativePixelRatio ?? 2;
        this.ratio = value === null ? implicitRatio : value;
        calls.push(["setPixelRatio", value]);
        for (const eventName of options.pixelRatioEvents || []) this.emit(eventName);
      } finally {
        pixelRatioWriteDepth -= 1;
      }
    },
    resize() {
      this.resized += 1;
      calls.push(["resize"]);
      if (options.throwOnResize) throw new Error("map.resize() must not be called directly");
    },
    getZoom() { return this.zoom; },
    getStyle() { return { layers: this.layers }; },
    getLayer(id) { return this.layers.find((layer) => layer.id === id) || null; },
    getLayoutProperty(id, property) {
      const layer = this.getLayer(id);
      return layer && layer.layout ? layer.layout[property] : undefined;
    },
    setLayoutProperty(id, property, value) {
      const layer = this.getLayer(id);
      if (!layer) throw new Error(`missing layer ${id}`);
      if (
        typeof options.shouldThrowOnLayout === "function"
        && options.shouldThrowOnLayout(id, property, value)
      ) {
        throw new Error(`rejected layout update for ${id}`);
      }
      if (!layer.layout) layer.layout = {};
      if (value === null) delete layer.layout[property];
      else layer.layout[property] = value;
      calls.push(["setLayoutProperty", id, property, value]);
    },
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    off(name, callback) {
      if (listeners.has(name)) listeners.get(name).delete(callback);
    },
    emit(name) {
      for (const callback of listeners.get(name) || []) callback();
    },
    listenerCount() {
      return [...listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0);
    }
  };
}

function createHarness(options = {}) {
  const elements = new Map();
  const bodyChildren = [];
  const storage = { value: options.savedSettings };
  const localStorageData = options.localStorageData || new Map();
  const hooks = {};
  const registrations = [];
  const logs = [];
  const frames = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervals = new Map();
  const mediaQueries = [];
  let nextFrameId = 1;
  let nextIntervalId = 1;
  let now = 0;
  let clipboardText = null;

  function makeElement(tagName) {
    return {
      tagName,
      id: "",
      style: {},
      attributes: {},
      isConnected: false,
      textContent: "",
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      remove() {
        this.isConnected = false;
        if (this.id) elements.delete(this.id);
        const index = bodyChildren.indexOf(this);
        if (index >= 0) bodyChildren.splice(index, 1);
      }
    };
  }

  const document = {
    hidden: false,
    body: {
      appendChild(element) {
        element.isConnected = true;
        bodyChildren.push(element);
        if (element.id) elements.set(element.id, element);
      }
    },
    createElement: makeElement,
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector() {
      return options.canvas || null;
    },
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (documentListeners.get(name) === callback) documentListeners.delete(name);
    }
  };

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } };
    },
    useState(initial) {
      let value = initial;
      return [value, (next) => { value = next; }];
    }
  };

  const api = {
    version: "1.0.0",
    hooks: {
      onMapReady(callback) { hooks.mapReady = callback; },
      onGameLoaded(callback) {
        if (options.throwOnGameLoadedRegistration) throw new Error("hook registration failed");
        hooks.gameLoaded = callback;
      },
      onGameEnd(callback) { hooks.gameEnd = callback; },
      onPauseChanged(callback) { hooks.pauseChanged = callback; },
      onSpeedChanged(callback) { hooks.speedChanged = callback; },
      onGameSaved(callback) { hooks.gameSaved = callback; }
    },
    ui: {
      registerComponent(placement, registration) {
        registrations.push({ placement, registration });
      }
    },
    storage: {
      async get(_key, fallback) {
        return storage.value === undefined ? fallback : storage.value;
      },
      async set(_key, value) {
        storage.value = { ...value };
      }
    },
    gameState: options.gameState === null ? undefined : {
      getGameSpeed() {
        return options.gameSpeed || "normal";
      },
      isPaused() {
        return options.paused === true;
      },
      getSaveName() {
        return options.saveName || "Test Save";
      }
    },
    utils: {
      getMap() {
        return typeof options.getMap === "function"
          ? options.getMap()
          : options.currentMap || null;
      },
      React,
      components: {
        Switch: function Switch() {},
        Label: "label"
      }
    }
  };

  const window = {
    SubwayBuilderAPI: api,
    devicePixelRatio: options.devicePixelRatio || 2,
    localStorage: {
      getItem(key) {
        return localStorageData.has(key) ? localStorageData.get(key) : null;
      },
      setItem(key, value) {
        localStorageData.set(key, String(value));
      },
      removeItem(key) {
        localStorageData.delete(key);
      }
    },
    navigator: {
      clipboard: {
        async writeText(value) {
          clipboardText = value;
        }
      }
    },
    matchMedia(query) {
      const changeListeners = new Set();
      const mediaQuery = {
        media: query,
        matches: true,
        addEventListener(name, callback) {
          if (name === "change") changeListeners.add(callback);
        },
        removeEventListener(name, callback) {
          if (name === "change") changeListeners.delete(callback);
        },
        addListener(callback) {
          changeListeners.add(callback);
        },
        removeListener(callback) {
          changeListeners.delete(callback);
        },
        emitChange() {
          for (const callback of [...changeListeners]) callback({ matches: false, media: query });
        },
        listenerCount() {
          return changeListeners.size;
        }
      };
      mediaQueries.push(mediaQuery);
      return mediaQuery;
    },
    setInterval(callback) {
      const id = nextIntervalId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (windowListeners.get(name) === callback) windowListeners.delete(name);
    }
  };

  const context = vm.createContext({
    window,
    document,
    performance: {
      now: () => now,
      memory: { usedJSHeapSize: 128 * 1_048_576 }
    },
    console: {
      info: (...args) => logs.push(["info", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args])
    },
    Promise,
    Number,
    Object,
    Math,
    String,
    Boolean,
    Array,
    Map,
    Set,
    JSON
  });

  vm.runInContext(source, context, { filename: "index.js" });

  return {
    api,
    bodyChildren,
    documentListeners,
    frames,
    hooks,
    intervals,
    logs,
    localStorageData,
    mediaQueries,
    registrations,
    storage,
    window,
    windowListeners,
    get clipboardText() { return clipboardText; },
    advance(milliseconds) { now += milliseconds; },
    reload() {
      vm.runInContext(source, context, { filename: "index.js" });
    },
    runFrames(count, millisecondsPerFrame) {
      for (let index = 0; index < count; index += 1) {
        now += millisecondsPerFrame;
        const next = frames.entries().next().value;
        assert.ok(next, "an animation frame should be scheduled");
        const [id, callback] = next;
        frames.delete(id);
        callback(now);
      }
    },
    emitWindow(name) {
      const callback = windowListeners.get(name);
      if (callback) callback();
    },
    setHidden(hidden) {
      document.hidden = hidden;
      const callback = documentListeners.get("visibilitychange");
      if (callback) callback();
    }
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mirroredSettings(harness) {
  return JSON.parse(harness.localStorageData.get(LOCAL_SETTINGS_KEY));
}

function findNode(node, predicate, renderComponents = false) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  if (renderComponents && typeof node.type === "function") {
    const rendered = node.type(node.props || {});
    const found = findNode(rendered, predicate, true);
    if (found) return found;
  }
  const children = node.props && node.props.children;
  if (!children) return null;
  for (const child of children.flat(Infinity)) {
    const found = findNode(child, predicate, renderComponents);
    if (found) return found;
  }
  return null;
}

function settingsTree(harness) {
  const Panel = harness.registrations[0].registration.component;
  return Panel();
}

test("Native / Safe preserves the map's captured pixel-ratio baseline", async () => {
  const harness = createHarness();
  await settle();
  const map = createMap({ ratio: 1.8, throwOnResize: true });

  assert.equal(harness.registrations.length, 1);
  assert.equal(harness.registrations[0].placement, "settings-menu");
  harness.hooks.mapReady(map);

  assert.equal(map.ratio, 1.8);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 0);
  assert.equal(map.resized, 0);
  assert.equal(harness.frames.size, 0, "monitoring stays off with native defaults");
});

test("fixed scale is relative to the captured baseline and never calls map.resize directly", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5 } });
  await settle();
  const map = createMap({ ratio: 1.8, throwOnResize: true });
  harness.hooks.mapReady(map);

  assert.equal(map.ratio, 0.9);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 1);
  assert.equal(map.resized, 0);
});

test("recovers an already-loaded map through the documented getMap fallback", async () => {
  const map = createMap({ ratio: 1.8, throwOnResize: true });
  const harness = createHarness({
    savedSettings: { renderScale: 0.5 },
    currentMap: map
  });
  await settle();

  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.map, map);
  assert.equal(map.ratio, 0.9);
  assert.ok(map.listenerCount() > 0);
  assert.equal(map.resized, 0);
});

test("partial initialization restores an already-loaded map if later setup fails", async () => {
  const map = createMap({ ratio: 1.8, throwOnResize: true });
  const harness = createHarness({
    savedSettings: { renderScale: 0.5 },
    currentMap: map,
    throwOnGameLoadedRegistration: true
  });
  await settle();

  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  assert.equal(runtime.disposed, true);
  assert.equal(map.ratio, 1.8);
  assert.equal(map.listenerCount(), 0);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.intervals.size, 0);
  assert.equal(harness.registrations.length, 0);
});

test("v0.1 settings migrate to version two without losing user choices", async () => {
  const harness = createHarness({
    savedSettings: {
      renderScale: 0.5,
      adaptiveRenderScale: true,
      showFps: true,
      diagnosticLogging: true
    }
  });
  await settle();
  const settings = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.settings;

  assert.equal(settings.settingsVersion, 2);
  assert.equal(settings.preset, "custom");
  assert.equal(settings.renderScale, 1);
  assert.equal(settings.adaptiveRenderScale, true);
  assert.equal(settings.adaptiveTargetFps, 30);
  assert.equal(settings.minimumRenderScale, 0.5);
  assert.equal(settings.showFps, true);
  assert.equal(settings.diagnosticLogging, true);
  const mirror = mirroredSettings(harness);
  assert.equal(mirror.settingsVersion, 2);
  assert.equal(mirror.adaptiveRenderScale, true);
  assert.equal(mirror.minimumRenderScale, 0.5);
  assert.equal(mirror.showFps, true);
  assert.equal(mirror.diagnosticLogging, true);

  harness.hooks.gameSaved();
  await settle();
  assert.equal(harness.storage.value.settingsVersion, 2);
  assert.equal(harness.storage.value.adaptiveRenderScale, true);
  assert.equal(harness.storage.value.minimumRenderScale, 0.5);
  assert.equal(harness.storage.value.showFps, true);
  assert.equal(harness.storage.value.diagnosticLogging, true);
});

test("v0.1 fixed quality and monitoring choices survive migration", async () => {
  const harness = createHarness({
    savedSettings: {
      renderScale: 0.7,
      adaptiveRenderScale: false,
      showFps: true,
      diagnosticLogging: false
    }
  });
  await settle();
  const settings = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.settings;

  assert.equal(settings.settingsVersion, 2);
  assert.equal(settings.preset, "custom");
  assert.equal(settings.renderScale, 0.7);
  assert.equal(settings.adaptiveRenderScale, false);
  assert.equal(settings.showFps, true);
  assert.equal(settings.diagnosticLogging, false);
});

test("menu exposes presets, adaptive targets, minimum quality, and safe optional controls", async () => {
  const harness = createHarness();
  await settle();
  const tree = settingsTree(harness);

  for (const id of [
    "subway-builder-performance-preset",
    "subway-builder-performance-render-scale",
    "subway-builder-performance-target-fps",
    "subway-builder-performance-minimum-scale",
    "subway-builder-performance-decorative-lod",
    "subway-builder-performance-transit-lod",
    "subway-builder-performance-inactive-window",
    "subway-builder-performance-detailed-overlay"
  ]) {
    assert.ok(findNode(tree, (node) => node.props && node.props.id === id, true), `missing ${id}`);
  }
  assert.equal(
    findNode(tree, (node) => node.props && node.props.id === "subway-builder-performance-motion-scaling", true),
    null,
    "motion scaling is not exposed because changing the map pixel ratio during a gesture interrupts movement"
  );

  const targetSelect = findNode(
    tree,
    (node) => node.type === "select" && node.props.id === "subway-builder-performance-target-fps",
    true
  );
  const targetValues = targetSelect.props.children.flat(Infinity).map((node) => node.props.value);
  assert.deepEqual(targetValues, ["30", "45", "60"]);

  const minimumSelect = findNode(
    tree,
    (node) => node.type === "select" && node.props.id === "subway-builder-performance-minimum-scale",
    true
  );
  const minimumValues = minimumSelect.props.children.flat(Infinity).map((node) => node.props.value);
  assert.deepEqual(minimumValues, ["0.85", "0.7", "0.5"]);
});

test("every preset persists its documented controls independently", async (t) => {
  const expectedPresets = {
    native: [1, false, 30, 0.5, false, false, false],
    balanced: [1, true, 45, 0.7, true, false, false],
    maximum: [1, true, 60, 0.5, true, true, true],
    battery: [1, true, 30, 0.7, true, false, true]
  };

  for (const [preset, expected] of Object.entries(expectedPresets)) {
    await t.test(preset, async () => {
      const harness = createHarness();
      await settle();
      const presetControl = findNode(
        settingsTree(harness),
        (node) => node.props && node.props.id === "subway-builder-performance-preset"
      );
      assert.ok(presetControl);

      presetControl.props.onChange(preset);
      await settle();

      const persisted = mirroredSettings(harness);
      assert.equal(persisted.preset, preset);
      assert.deepEqual(
        [
          persisted.renderScale,
          persisted.adaptiveRenderScale,
          persisted.adaptiveTargetFps,
          persisted.minimumRenderScale,
          persisted.decorativeLod,
          persisted.transitLod,
          persisted.inactiveWindowMode
        ],
        expected
      );
    });
  }
});

test("monitoring options do not turn a visual preset into Custom", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "balanced",
      adaptiveRenderScale: true,
      adaptiveTargetFps: 45,
      minimumRenderScale: 0.7,
      decorativeLod: true
    }
  });
  await settle();
  const tree = settingsTree(harness);
  const fpsToggle = findNode(
    tree,
    (node) => node.props && node.props.id === "subway-builder-performance-show-fps"
  );

  fpsToggle.props.onChange(true);
  await settle();
  const persisted = mirroredSettings(harness);
  assert.equal(persisted.preset, "balanced");
  assert.equal(persisted.showFps, true);
});

test("settings survive a full app restart even when Mod API UI writes are unavailable", async () => {
  const localStorageData = new Map();
  const firstRun = createHarness({ localStorageData });
  await settle();

  const presetControl = findNode(
    settingsTree(firstRun),
    (node) => node.props && node.props.id === "subway-builder-performance-preset"
  );
  presetControl.props.onChange("balanced");
  const fpsToggle = findNode(
    settingsTree(firstRun),
    (node) => node.props && node.props.id === "subway-builder-performance-show-fps"
  );
  fpsToggle.props.onChange(true);
  await settle();

  const secondRun = createHarness({ localStorageData });
  await settle();
  const settings = secondRun.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.settings;
  assert.equal(settings.preset, "balanced");
  assert.equal(settings.adaptiveTargetFps, 45);
  assert.equal(settings.minimumRenderScale, 0.7);
  assert.equal(settings.decorativeLod, true);
  assert.equal(settings.showFps, true);
});

test("adaptive scaling requires sustained samples, enforces cooldown, and recovers", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      adaptiveRenderScale: true,
      adaptiveTargetFps: 45,
      minimumRenderScale: 0.5
    }
  });
  await settle();
  const map = createMap();
  harness.hooks.mapReady(map);
  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  runtime.adaptiveBlockedUntil = Number.NEGATIVE_INFINITY;
  runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;

  harness.runFrames(40, 50);
  assert.equal(map.ratio, 2, "two slow samples are not enough to lower quality");

  harness.runFrames(20, 50);
  assert.equal(map.ratio, 1.7, "the third slow sample lowers one quality step");

  harness.runFrames(60, 50);
  assert.equal(map.ratio, 1.7, "the cooldown blocks another immediate reduction");

  runtime.adaptiveBlockedUntil = Number.NEGATIVE_INFINITY;
  runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;
  runtime.smoothedFrameMs = null;
  runtime.adaptiveLowSamples = 0;
  runtime.adaptiveHighSamples = 0;
  harness.runFrames(1_600, 10);
  assert.equal(map.ratio, 2, "sustained headroom restores native quality");
});

test("p95 frame time can lower quality while average FPS remains above target", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      adaptiveRenderScale: true,
      adaptiveTargetFps: 45,
      minimumRenderScale: 0.5
    }
  });
  await settle();
  const map = createMap();
  harness.hooks.mapReady(map);
  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  runtime.adaptiveBlockedUntil = Number.NEGATIVE_INFINITY;
  runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;

  for (let sample = 0; sample < 2; sample += 1) {
    harness.runFrames(45, 20);
    harness.runFrames(3, 40);
  }

  assert.ok(runtime.currentFps > 45, "average FPS remains above the selected target");
  assert.equal(runtime.p95FrameMs, 40);
  assert.equal(map.ratio, 2, "two high-p95 samples are not enough to lower quality");

  harness.runFrames(45, 20);
  harness.runFrames(3, 40);
  assert.equal(map.ratio, 1.7, "three high-p95 samples lower quality by one step");
});

test("stabilization windows do not contaminate adaptive averaging", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      adaptiveRenderScale: true,
      adaptiveTargetFps: 60,
      minimumRenderScale: 0.5
    }
  });
  await settle();
  const map = createMap();
  harness.hooks.mapReady(map);
  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;

  harness.hooks.gameSaved();
  harness.runFrames(60, 50);

  assert.equal(runtime.smoothedFrameMs, null);
  assert.equal(runtime.adaptiveLowSamples, 0);
  assert.equal(map.ratio, 2);
});

test("30, 45, and 60 FPS targets make distinct conservative decisions", async (t) => {
  for (const [target, expectedRatio] of [[30, 2], [45, 2], [60, 1.7]]) {
    await t.test(`${target} FPS`, async () => {
      const harness = createHarness({
        savedSettings: {
          settingsVersion: 2,
          preset: "custom",
          adaptiveRenderScale: true,
          adaptiveTargetFps: target,
          minimumRenderScale: 0.5
        }
      });
      await settle();
      const map = createMap();
      harness.hooks.mapReady(map);
      const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
      runtime.adaptiveBlockedUntil = Number.NEGATIVE_INFINITY;
      runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;

      harness.runFrames(180, 20);
      assert.equal(map.ratio, expectedRatio);
    });
  }
});

test("60 FPS adaptive mode can recover to the captured baseline", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      adaptiveRenderScale: true,
      adaptiveTargetFps: 60,
      minimumRenderScale: 0.5
    }
  });
  await settle();
  const map = createMap({ ratio: 1.8 });
  harness.hooks.mapReady(map);
  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  runtime.adaptiveBlockedUntil = Number.NEGATIVE_INFINITY;
  runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;

  harness.runFrames(60, 50);
  assert.ok(Math.abs(map.ratio - 1.53) < 0.001);

  harness.runFrames(2_000, 10);
  assert.equal(map.ratio, 1.8);
});

test("every minimum quality option is a hard adaptive floor", async (t) => {
  for (const [minimumRenderScale, reductions] of [[0.85, 1], [0.7, 2], [0.5, 3]]) {
    await t.test(`${Math.round(minimumRenderScale * 100)}%`, async () => {
      const harness = createHarness({
        savedSettings: {
          settingsVersion: 2,
          preset: "custom",
          adaptiveRenderScale: true,
          adaptiveTargetFps: 60,
          minimumRenderScale
        }
      });
      await settle();
      const map = createMap();
      harness.hooks.mapReady(map);
      const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;

      for (let step = 0; step < reductions; step += 1) {
        runtime.adaptiveBlockedUntil = Number.NEGATIVE_INFINITY;
        runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;
        harness.runFrames(60, 50);
      }
      assert.equal(map.ratio, 2 * minimumRenderScale);

      runtime.adaptiveBlockedUntil = Number.NEGATIVE_INFINITY;
      runtime.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;
      harness.runFrames(60, 50);
      assert.equal(map.ratio, 2 * minimumRenderScale, "slow samples cannot cross the floor");
    });
  }
});

test("legacy motion scaling settings are ignored and map movement never changes pixel ratio", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 1,
      minimumRenderScale: 0.7,
      motionScaling: true
    }
  });
  await settle();
  const map = createMap();
  harness.hooks.mapReady(map);

  map.emit("movestart");
  assert.equal(map.ratio, 2);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 0);
  map.emit("moveend");
  assert.equal(map.ratio, 2);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 0);
  assert.equal(map.resized, 0);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.settings,
      "motionScaling"
    ),
    false
  );
});

test("synthetic movement from an external resize cannot change pixel ratio", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 1,
      minimumRenderScale: 0.7,
      motionScaling: true
    }
  });
  await settle();
  const map = createMap({ isMoving: false });
  harness.hooks.mapReady(map);

  map.emit("movestart");
  map.emit("moveend");

  assert.equal(map.ratio, 2);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 0);
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.mapMoving, false);
});

test("pixel-ratio writes ignore synchronous move and resize emissions", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 0.85,
      minimumRenderScale: 0.5,
      motionScaling: true
    }
  });
  await settle();
  const map = createMap({
    ratio: 2,
    pixelRatioEvents: ["movestart", "resize", "moveend"],
    throwOnResize: true
  });

  harness.hooks.mapReady(map);

  assert.equal(map.ratio, 1.7);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 1);
  assert.equal(map.maxPixelRatioWriteDepth, 1);
  assert.equal(map.resized, 0);
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.mapMoving, false);
});

test("LOD thresholds affect only the audited v1.4.x allowlist and restore effective visibility", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      decorativeLod: true,
      transitLod: true
    }
  });
  await settle();
  const map = createMap({
    zoom: 12,
    layers: [
      { id: "buildings-3d", type: "fill-extrusion" },
      { id: "building-foundations", type: "fill-extrusion", layout: { visibility: "visible" } },
      { id: "signal-lines", type: "line" },
      { id: "signal-lines-under", type: "line", layout: { visibility: "visible" } },
      { id: "signal-points", type: "circle" },
      { id: "signal-points-under", type: "circle" },
      { id: "track-arrows-path", type: "line" },
      { id: "route-arrows-path", type: "line" },
      { id: "city-3d-buildings", type: "fill-extrusion" },
      { id: "route-arrows", type: "symbol" },
      { id: "routes", type: "line" },
      { id: "station-labels", type: "symbol" }
    ]
  });
  harness.hooks.mapReady(map);

  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");
  assert.equal(map.getLayoutProperty("building-foundations", "visibility"), "none");
  assert.equal(map.getLayoutProperty("signal-lines", "visibility"), undefined);
  assert.equal(map.getLayoutProperty("signal-lines-under", "visibility"), "visible");
  assert.equal(map.getLayoutProperty("city-3d-buildings", "visibility"), undefined);
  assert.equal(map.getLayoutProperty("route-arrows", "visibility"), undefined);
  assert.equal(map.getLayoutProperty("routes", "visibility"), undefined);
  assert.equal(map.getLayoutProperty("station-labels", "visibility"), undefined);

  map.zoom = 11;
  map.emit("zoomend");
  for (const id of [
    "signal-lines",
    "signal-lines-under",
    "signal-points",
    "signal-points-under",
    "track-arrows-path",
    "route-arrows-path"
  ]) {
    assert.equal(map.getLayoutProperty(id, "visibility"), "none");
  }
  assert.equal(map.getLayoutProperty("route-arrows", "visibility"), undefined);

  map.zoom = 13;
  map.emit("zoomend");
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");
  assert.equal(map.getLayoutProperty("building-foundations", "visibility"), "none");
  for (const id of [
    "signal-lines",
    "signal-lines-under",
    "signal-points",
    "signal-points-under",
    "track-arrows-path",
    "route-arrows-path"
  ]) {
    assert.equal(map.getLayoutProperty(id, "visibility"), "visible");
  }

  map.zoom = 13.01;
  map.emit("zoomend");
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "visible");
  assert.equal(map.getLayoutProperty("building-foundations", "visibility"), "visible");
});

test("style replacement snapshots and restores the replacement style's effective visibility", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      decorativeLod: true
    }
  });
  await settle();
  const map = createMap({
    zoom: 10,
    layers: [
      { id: "building-foundations", type: "fill-extrusion", layout: { visibility: "visible" } },
      { id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "none" } }
    ]
  });
  harness.hooks.mapReady(map);
  assert.equal(map.getLayoutProperty("building-foundations", "visibility"), "none");
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");

  map.emit("styledataloading");
  assert.equal(map.getLayoutProperty("building-foundations", "visibility"), "visible");
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");

  map.layers = [
    { id: "building-foundations", type: "fill-extrusion", layout: { visibility: "none" } },
    { id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } }
  ];
  map.emit("styledata");
  assert.equal(map.getLayoutProperty("building-foundations", "visibility"), "none");
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");

  const presetControl = findNode(
    settingsTree(harness),
    (node) => node.props && node.props.id === "subway-builder-performance-preset"
  );
  presetControl.props.onChange("native");
  await settle();

  assert.equal(map.getLayoutProperty("building-foundations", "visibility"), "none");
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "visible");
});

test("a transient layer restoration failure is retained and retried", async () => {
  let rejectRestore = false;
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      decorativeLod: true
    }
  });
  await settle();
  const map = createMap({
    zoom: 10,
    layers: [
      { id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } }
    ],
    shouldThrowOnLayout(_id, _property, value) {
      return rejectRestore && value === "visible";
    }
  });
  harness.hooks.mapReady(map);
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");

  rejectRestore = true;
  const presetControl = findNode(
    settingsTree(harness),
    (node) => node.props && node.props.id === "subway-builder-performance-preset"
  );
  presetControl.props.onChange("native");
  await settle();
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");

  rejectRestore = false;
  map.emit("styledata");
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "visible");
});

test("selecting Native / Safe restores optional scale and LOD changes", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "maximum",
      renderScale: 1,
      adaptiveRenderScale: true,
      adaptiveTargetFps: 60,
      minimumRenderScale: 0.5,
      decorativeLod: true,
      transitLod: true,
      inactiveWindowMode: true
    }
  });
  await settle();
  const map = createMap({
    zoom: 10,
    layers: [
      { id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } },
      { id: "route-arrows-path", type: "line" }
    ]
  });
  harness.hooks.mapReady(map);
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");
  assert.equal(map.getLayoutProperty("route-arrows-path", "visibility"), "none");

  const presetControl = findNode(
    settingsTree(harness),
    (node) => node.props && node.props.id === "subway-builder-performance-preset"
  );
  presetControl.props.onChange("native");
  await settle();

  assert.equal(map.ratio, 2);
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "visible");
  assert.equal(map.getLayoutProperty("route-arrows-path", "visibility"), "visible");
});

test("disposing restores map state and detaches all owned work", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 0.5,
      decorativeLod: true,
      showFps: true,
      diagnosticLogging: true
    }
  });
  await settle();
  const map = createMap({
    zoom: 10,
    ratio: 1.8,
    layers: [{ id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } }]
  });
  harness.hooks.mapReady(map);
  assert.equal(map.ratio, 0.9);
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "none");
  assert.ok(map.listenerCount() > 0);
  assert.equal(harness.bodyChildren.length, 1);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.intervals.size, 1);

  harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.dispose();
  assert.equal(map.ratio, 1.8);
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "visible");
  assert.equal(map.listenerCount(), 0);
  assert.equal(harness.bodyChildren.length, 0);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.intervals.size, 0);
  assert.equal(harness.documentListeners.size, 0);
  assert.equal(harness.windowListeners.size, 0);
});

test("hot reload disposes the previous instance before starting the replacement", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 0.5,
      decorativeLod: true,
      showFps: true,
      diagnosticLogging: true
    }
  });
  await settle();
  const map = createMap({
    zoom: 10,
    ratio: 1.8,
    layers: [{ id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } }]
  });
  harness.hooks.mapReady(map);
  const previousRuntime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  assert.equal(map.ratio, 0.9);

  harness.reload();

  assert.equal(previousRuntime.disposed, true);
  assert.equal(map.ratio, 1.8);
  assert.equal(map.getLayoutProperty("buildings-3d", "visibility"), "visible");
  assert.equal(map.listenerCount(), 0);
  assert.equal(harness.bodyChildren.length, 0);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.intervals.size, 0);

  await settle();
  assert.notEqual(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__, previousRuntime);
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.disposed, false);
});

test("repeated map-ready restores the previous map before adopting the replacement", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 0.5,
      decorativeLod: true
    }
  });
  await settle();
  const previousMap = createMap({
    ratio: 1.8,
    zoom: 10,
    layers: [{ id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } }]
  });
  const replacementMap = createMap({
    ratio: 1.6,
    zoom: 10,
    layers: [{ id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } }]
  });

  harness.hooks.mapReady(previousMap);
  assert.equal(previousMap.ratio, 0.9);
  assert.equal(previousMap.getLayoutProperty("buildings-3d", "visibility"), "none");

  harness.hooks.mapReady(replacementMap);
  assert.equal(previousMap.ratio, 1.8);
  assert.equal(previousMap.getLayoutProperty("buildings-3d", "visibility"), "visible");
  assert.equal(previousMap.listenerCount(), 0);
  assert.equal(replacementMap.ratio, 0.8);
  assert.equal(replacementMap.getLayoutProperty("buildings-3d", "visibility"), "none");

  harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.dispose();
  assert.equal(replacementMap.ratio, 1.6);
  assert.equal(replacementMap.getLayoutProperty("buildings-3d", "visibility"), "visible");
});

test("an unsupported replacement map still restores the previous supported map", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 0.5,
      decorativeLod: true
    }
  });
  await settle();
  const previousMap = createMap({
    ratio: 1.8,
    zoom: 10,
    layers: [{ id: "buildings-3d", type: "fill-extrusion", layout: { visibility: "visible" } }]
  });
  harness.hooks.mapReady(previousMap);
  assert.equal(previousMap.ratio, 0.9);
  assert.equal(previousMap.getLayoutProperty("buildings-3d", "visibility"), "none");

  const unsupportedMap = { resize() {} };
  harness.hooks.mapReady(unsupportedMap);

  assert.equal(previousMap.ratio, 1.8);
  assert.equal(previousMap.getLayoutProperty("buildings-3d", "visibility"), "visible");
  assert.equal(previousMap.listenerCount(), 0);
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.map, unsupportedMap);
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.mapSupported, false);
});

test("inactive-window mode lowers quality and pauses this mod's monitoring", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      renderScale: 1,
      minimumRenderScale: 0.5,
      inactiveWindowMode: true,
      showFps: true,
      diagnosticLogging: true
    }
  });
  await settle();
  const map = createMap();
  harness.hooks.mapReady(map);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.intervals.size, 1);

  harness.emitWindow("blur");
  assert.equal(map.ratio, 1);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.intervals.size, 0);

  harness.emitWindow("focus");
  assert.equal(map.ratio, 2);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.intervals.size, 1);
});

test("display DPR changes update the baseline without redundant pixel-ratio writes", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5 } });
  await settle();
  const map = createMap({
    throwOnResize: true,
    getNativePixelRatio: () => harness.window.devicePixelRatio
  });
  harness.hooks.mapReady(map);
  assert.equal(map.ratio, 1);
  assert.equal(map.resized, 0);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 1);

  harness.emitWindow("resize");
  assert.equal(map.resized, 0);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 1);

  harness.window.devicePixelRatio = 1;
  harness.emitWindow("resize");
  assert.equal(map.ratio, 0.5);
  assert.equal(map.resized, 0);
  assert.equal(map.calls.filter(([name]) => name === "setPixelRatio").length, 2);

  harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.dispose();
  assert.equal(map.ratio, 1, "cleanup preserves native quality on the new display");
});

test("DPR media-query watcher re-arms after a display change and detaches on dispose", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5 } });
  await settle();
  const map = createMap({
    throwOnResize: true,
    getNativePixelRatio: () => harness.window.devicePixelRatio
  });
  harness.hooks.mapReady(map);

  assert.equal(harness.mediaQueries.length, 1);
  assert.equal(harness.mediaQueries[0].listenerCount(), 1);

  harness.window.devicePixelRatio = 1;
  harness.mediaQueries[0].emitChange();

  assert.equal(map.ratio, 0.5);
  assert.equal(harness.mediaQueries.length, 2);
  assert.equal(harness.mediaQueries[0].listenerCount(), 0);
  assert.equal(harness.mediaQueries[1].listenerCount(), 1);

  harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.dispose();
  assert.equal(map.ratio, 1);
  assert.equal(harness.mediaQueries[1].listenerCount(), 0);
});

test("detailed overlay and benchmark export report measured session data", async () => {
  const harness = createHarness({
    savedSettings: {
      settingsVersion: 2,
      preset: "custom",
      showFps: true,
      detailedOverlay: true
    },
    gameSpeed: "ultrafast",
    paused: true,
    saveName: "Benchmark Save"
  });
  await settle();
  const map = createMap({ zoom: 11.5 });
  harness.hooks.mapReady(map);
  harness.hooks.pauseChanged(true);
  harness.hooks.speedChanged("ultrafast");
  const initialTree = settingsTree(harness);
  const startButton = findNode(
    initialTree,
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Start capture"),
    true
  );
  startButton.props.onClick();
  harness.hooks.gameSaved();
  harness.runFrames(70, 16.7);

  assert.match(harness.bodyChildren[0].textContent, /FPS · p95/);
  assert.match(harness.bodyChildren[0].textContent, /100% · collecting/);

  const stopButton = findNode(
    settingsTree(harness),
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Stop capture"),
    true
  );
  stopButton.props.onClick();
  map.zoom = 5;
  harness.hooks.pauseChanged(false);
  harness.hooks.speedChanged("normal");

  const tree = settingsTree(harness);
  const copyButton = findNode(
    tree,
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Copy snapshot"),
    true
  );
  await copyButton.props.onClick();
  const summary = JSON.parse(harness.clipboardText);
  assert.equal(summary.modVersion, "0.2.2");
  assert.ok(summary.samples >= 1);
  assert.equal(summary.frameCount, 70);
  assert.ok(summary.durationSeconds >= 1);
  assert.ok(summary.medianFps > 59 && summary.medianFps < 61);
  assert.equal(summary.p95FrameMs, 16.7);
  assert.equal(summary.worstFrameMs, 16.7);
  assert.equal(summary.medianP95FrameMs, 16.7);
  assert.equal(summary.totalLongFrames, 0);
  assert.deepEqual(summary.scaleRangePercent, [100, 100]);
  assert.deepEqual(summary.zoomRange, [11.5, 11.5]);
  assert.equal(summary.paused, true);
  assert.equal(summary.simulationSpeed, "ultrafast");
  assert.equal(summary.saveName, "Benchmark Save");
  assert.equal(summary.zoom, 11.5);
  assert.equal(summary.jsHeapMB, 128);
  assert.equal(summary.medianJsHeapMB, 128);
  assert.equal(summary.peakJsHeapMB, 128);
  assert.equal(summary.configuration.showFps, true);
  assert.equal(summary.configuration.detailedOverlay, true);
  assert.equal(summary.environment.apiVersion, "1.0.0");
  assert.equal(summary.environment.devicePixelRatio, 2);
  assert.equal(summary.environment.mapPixelRatio, 2);
  assert.equal(summary.environment.windowWidth, null);
  assert.equal(summary.environment.windowHeight, null);
  assert.deepEqual(summary.initialState, {
    zoom: 11.5,
    renderScalePercent: 100,
    saveName: "Benchmark Save",
    paused: true,
    simulationSpeed: "ultrafast",
    focused: true,
    jsHeapMB: 128
  });
  assert.deepEqual(summary.finalState, summary.initialState);
  assert.deepEqual(summary.events, [{ type: "game-saved", atSeconds: 0 }]);
});

test("benchmark windows survive camera measurement resets", async () => {
  const harness = createHarness({ savedSettings: { showFps: true } });
  await settle();
  const map = createMap();
  harness.hooks.mapReady(map);
  const startButton = findNode(
    settingsTree(harness),
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Start capture"),
    true
  );
  startButton.props.onClick();

  for (let movement = 0; movement < 4; movement += 1) {
    map.emit("movestart");
    harness.runFrames(30, 16.7);
    map.emit("moveend");
  }

  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  assert.equal(runtime.benchmarkFrameTimes.length, 120);
  assert.ok(runtime.benchmarkSamples.length >= 1);
});

test("benchmark export reads the initial public game state without waiting for hooks", async () => {
  const harness = createHarness({
    savedSettings: { showFps: true },
    gameSpeed: "fast",
    paused: true,
    saveName: "Large Network"
  });
  await settle();
  harness.hooks.mapReady(createMap());
  const initialTree = settingsTree(harness);
  const startButton = findNode(
    initialTree,
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Start capture"),
    true
  );
  startButton.props.onClick();
  harness.runFrames(70, 16.7);

  const tree = settingsTree(harness);
  const copyButton = findNode(
    tree,
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Copy snapshot"),
    true
  );
  await copyButton.props.onClick();
  const summary = JSON.parse(harness.clipboardText);

  assert.equal(summary.simulationSpeed, "fast");
  assert.equal(summary.paused, true);
  assert.equal(summary.saveName, "Large Network");
});

test("starting benchmark capture resets the partial sampling window", async () => {
  const harness = createHarness({ savedSettings: { showFps: true } });
  await settle();
  harness.hooks.mapReady(createMap());
  harness.runFrames(30, 16.7);

  const startButton = findNode(
    settingsTree(harness),
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Start capture"),
    true
  );
  startButton.props.onClick();

  harness.runFrames(30, 16.7);
  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  assert.equal(runtime.benchmarkSamples.length, 0, "pre-capture frames are excluded");

  harness.runFrames(31, 16.7);
  assert.equal(runtime.benchmarkSamples.length, 1);
});

test("benchmark capture stops appending while other monitoring remains active", async () => {
  const harness = createHarness({ savedSettings: { showFps: true } });
  await settle();
  harness.hooks.mapReady(createMap());
  const tree = settingsTree(harness);
  const startButton = findNode(
    tree,
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Start capture"),
    true
  );
  startButton.props.onClick();
  harness.runFrames(70, 16.7);

  const runtime = harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__;
  assert.ok(runtime.benchmarkSamples.length >= 1);
  const capturedSamples = runtime.benchmarkSamples.length;
  const stopButton = findNode(
    settingsTree(harness),
    (node) => node.type === "button" && node.props.children.flat(Infinity).includes("Stop capture"),
    true
  );
  stopButton.props.onClick();
  harness.runFrames(70, 16.7);

  assert.equal(runtime.benchmarkSamples.length, capturedSamples);
  assert.equal(harness.frames.size, 1, "FPS overlay sampling continues independently");
});

test("missing public game-state helpers remain optional", async () => {
  const harness = createHarness({
    savedSettings: { showFps: true },
    gameState: null
  });
  await settle();

  assert.doesNotThrow(() => harness.hooks.mapReady(createMap()));
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.simulationSpeed, "unknown");
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.saveName, null);
});

test("monitoring pauses while hidden and resumes after a stabilization delay", async () => {
  const harness = createHarness({ savedSettings: { showFps: true } });
  await settle();
  harness.hooks.gameLoaded();
  assert.equal(harness.frames.size, 1);

  harness.setHidden(true);
  assert.equal(harness.frames.size, 0);
  harness.setHidden(false);
  assert.equal(harness.frames.size, 1);
  assert.ok(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.adaptiveBlockedUntil > 0);
});

test("unsupported map scaling fails safely without leaving adaptive work", async () => {
  const harness = createHarness({
    savedSettings: { adaptiveRenderScale: true, showFps: false, diagnosticLogging: false }
  });
  await settle();

  assert.doesNotThrow(() => harness.hooks.mapReady({ resize() {} }));
  assert.ok(harness.logs.some((entry) => entry[0] === "warn" && String(entry[1]).includes("does not expose")));
  assert.equal(harness.frames.size, 0);
});

test("game end restores original state, removes overlay, and releases the map", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5, showFps: true } });
  await settle();
  const map = createMap({ ratio: 1.75 });
  harness.hooks.mapReady(map);
  assert.equal(map.ratio, 0.875);
  assert.equal(harness.bodyChildren.length, 1);

  harness.hooks.gameEnd();
  assert.equal(map.ratio, 1.75);
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.map, null);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.bodyChildren.length, 0);
});
