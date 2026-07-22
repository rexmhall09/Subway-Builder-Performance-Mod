"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

test("keeps the runtime and Railyard mod IDs aligned", () => {
  assert.equal(manifest.id, "subway-builder-performance");
  assert.match(source, /const MOD_ID = "subway-builder-performance";/);
});

function createHarness(options = {}) {
  const elements = new Map();
  const bodyChildren = [];
  const storage = { value: options.savedSettings };
  const hooks = {};
  const registrations = [];
  const logs = [];
  const frames = new Map();
  const listeners = new Map();
  let nextFrameId = 1;
  let now = 0;

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
      listeners.set(name, callback);
    },
    removeEventListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
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
      onGameLoaded(callback) { hooks.gameLoaded = callback; },
      onGameEnd(callback) { hooks.gameEnd = callback; }
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
    utils: {
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
    setInterval(callback) {
      window.intervalCallback = callback;
      return 91;
    },
    clearInterval() {},
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
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
    Set
  });

  vm.runInContext(source, context, { filename: "index.js" });

  return {
    api,
    bodyChildren,
    frames,
    hooks,
    logs,
    registrations,
    storage,
    window,
    advance(milliseconds) { now += milliseconds; },
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
    setHidden(hidden) {
      document.hidden = hidden;
      const callback = listeners.get("visibilitychange");
      if (callback) callback();
    }
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  const children = node.props && node.props.children;
  if (!children) return null;
  for (const child of children.flat(Infinity)) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test("registers one Performance settings panel and keeps native scale by default", async () => {
  const harness = createHarness();
  await settle();

  assert.equal(harness.registrations.length, 1);
  assert.equal(harness.registrations[0].placement, "settings-menu");

  const calls = [];
  const map = {
    ratio: 2,
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; calls.push(value); },
    resize() { calls.push("resize"); }
  };
  harness.hooks.mapReady(map);

  assert.equal(map.ratio, 2);
  assert.deepEqual(calls, ["resize"]);
  assert.equal(harness.frames.size, 0, "FPS sampler stays off by default");
});

test("applies a saved render scale through the public map methods", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5, showFps: false, diagnosticLogging: false } });
  await settle();

  const map = {
    ratio: 2,
    resized: 0,
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; },
    resize() { this.resized += 1; }
  };
  harness.hooks.mapReady(map);

  assert.equal(map.ratio, 1);
  assert.equal(map.resized, 1);
});

test("render scale menu includes automatic mode and settings persist independently", async () => {
  const harness = createHarness();
  await settle();

  const Panel = harness.registrations[0].registration.component;
  const tree = Panel();
  const select = findNode(tree, (node) => node.type === "select");
  assert.ok(select);
  assert.ok(findNode(select, (node) => node.type === "option" && node.props.value === "automatic"));
  select.props.onChange({ target: { value: "0.7" } });
  await settle();
  assert.equal(harness.storage.value.renderScale, 0.7);
  assert.equal(harness.storage.value.adaptiveRenderScale, false);

  select.props.onChange({ target: { value: "automatic" } });
  await settle();
  assert.equal(harness.storage.value.renderScale, 1);
  assert.equal(harness.storage.value.adaptiveRenderScale, true);

  const fpsToggle = findNode(
    tree,
    (node) => typeof node.type === "function" && node.props && String(node.props.id).endsWith("show-fps")
  );
  assert.ok(fpsToggle);
  fpsToggle.props.onChange(true);
  await settle();

  assert.equal(harness.storage.value.showFps, true);
  assert.equal(harness.bodyChildren.length, 0, "the FPS overlay stays off outside an active game");
  assert.equal(harness.frames.size, 0, "the FPS sampler stays off outside an active game");

  harness.hooks.gameLoaded();
  assert.equal(harness.bodyChildren.length, 1);
  assert.equal(harness.bodyChildren[0].textContent, "… FPS");
  assert.equal(harness.frames.size, 1);
});

test("unsupported map hooks fail safely", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5, adaptiveRenderScale: true } });
  await settle();

  assert.doesNotThrow(() => harness.hooks.mapReady({ resize() {} }));
  assert.ok(harness.logs.some((entry) => entry[0] === "warn" && String(entry[1]).includes("does not expose")));
  assert.equal(harness.frames.size, 0, "unsupported adaptive scaling does not leave a sampler running");
});

test("legacy automatic settings migrate to the full render-scale range", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5, adaptiveRenderScale: true } });
  await settle();

  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.settings.renderScale, 1);
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.settings.adaptiveRenderScale, true);
});

test("adaptive render scale uses sustained samples and cooldowns", async () => {
  const harness = createHarness({
    savedSettings: {
      renderScale: 1,
      adaptiveRenderScale: true,
      showFps: false,
      diagnosticLogging: false
    }
  });
  await settle();

  const map = {
    ratio: 2,
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; },
    resize() {}
  };
  harness.hooks.mapReady(map);

  assert.equal(harness.frames.size, 1, "adaptive mode samples without showing the overlay");
  harness.runFrames(60, 50);
  assert.equal(map.ratio, 1.7, "three one-second samples near 20 FPS step from 100% to 85%");
  harness.runFrames(60, 50);
  assert.equal(map.ratio, 1.7, "the cooldown prevents another immediate quality change");

  harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.lastAdaptiveChangeAt = Number.NEGATIVE_INFINITY;
  harness.runFrames(800, 10);
  assert.equal(map.ratio, 2, "eight one-second samples with headroom restore the next quality step");
  assert.equal(harness.bodyChildren.length, 0, "adaptive mode does not force the FPS overlay on");
});

test("monitoring pauses while the game document is hidden", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 1, showFps: true } });
  await settle();

  harness.hooks.gameLoaded();
  assert.equal(harness.frames.size, 1);
  harness.setHidden(true);
  assert.equal(harness.frames.size, 0);
  harness.setHidden(false);
  assert.equal(harness.frames.size, 1);
});

test("game end stops monitoring and releases the map", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5, showFps: true } });
  await settle();

  const map = {
    ratio: 2,
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; },
    resize() {}
  };
  harness.hooks.mapReady(map);
  assert.equal(map.ratio, 1);
  assert.equal(harness.frames.size, 1);
  assert.equal(harness.bodyChildren.length, 1);

  harness.hooks.gameEnd();
  assert.equal(map.ratio, 2, "native quality is restored before releasing the map");
  assert.equal(harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.map, null);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.bodyChildren.length, 0);
});

test("hot reload disposes the old overlay and restores native pixel ratio", async () => {
  const harness = createHarness({ savedSettings: { renderScale: 0.5, showFps: true } });
  await settle();

  const map = {
    ratio: 2,
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; },
    resize() {}
  };
  harness.hooks.mapReady(map);
  assert.equal(map.ratio, 1);
  assert.equal(harness.bodyChildren.length, 1);

  harness.window.__SUBWAY_BUILDER_PERFORMANCE_MOD__.dispose();
  assert.equal(map.ratio, 2);
  assert.equal(harness.bodyChildren.length, 0);
  assert.equal(harness.frames.size, 0);
});
