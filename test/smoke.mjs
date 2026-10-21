/**
 * Smoke test for the built bundle.
 *
 * The bundle is loaded through the exact wrapper Kettu uses for Vendetta-format
 * plugins, taken from its source:
 *
 *   const pluginString = `vendetta=>{return ${plugin.js}}`;
 *   const raw = (0, eval)(pluginString)(vendettaForPlugins);
 *   const ret = typeof raw === "function" ? raw() : raw;
 *   return ret?.default ?? ret ?? {};
 *
 * so a change that breaks the loader contract fails here rather than on a phone.
 *
 *   node build.mjs && node test/smoke.mjs
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const code = await readFile(join(root, "DevTools", "index.js"), "utf8");

/* ------------------------------------------------------------------ *
 * fake react native globals                                           *
 * ------------------------------------------------------------------ */

const realLog = console.log.bind(console);

const passedThrough = [];
globalThis.console = {
  log: (...a) => passedThrough.push(["log", a]),
  info: (...a) => passedThrough.push(["info", a]),
  warn: (...a) => passedThrough.push(["warn", a]),
  error: (...a) => passedThrough.push(["error", a]),
  debug: (...a) => passedThrough.push(["debug", a])
};
const pristineConsoleLog = globalThis.console.log;

let globalHandler = null;
globalThis.ErrorUtils = {
  setGlobalHandler: (fn) => {
    globalHandler = fn;
  },
  getGlobalHandler: () => globalHandler
};
const appErrors = [];
const appErrorHandler = (error, isFatal) => appErrors.push([error.message, isFatal]);
globalThis.ErrorUtils.setGlobalHandler(appErrorHandler);

class FakeXHR {
  constructor() {
    this.listeners = {};
    this.status = 0;
    this.responseText = "";
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  send() {}
  addEventListener(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }
  getAllResponseHeaders() {
    return "content-type: application/json\n";
  }
  fire(name) {
    (this.listeners[name] || []).forEach((fn) => fn());
  }
}
const pristineXhrOpen = FakeXHR.prototype.open;
globalThis.XMLHttpRequest = FakeXHR;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
  }
  send() {}
}
globalThis.WebSocket = FakeWebSocket;

globalThis.HermesInternal = {
  getRuntimeProperties: () => ({ "OSS Release Version": "0.12.0", "Bytecode Version": 96 })
};

/* ------------------------------------------------------------------ *
 * fake react + react native modules                                   *
 * ------------------------------------------------------------------ */

let tabUnderTest = "Console";
let fillTextInputs = false;
let forceOpen = false;
const pendingCleanups = [];

const React = {
  version: "18.2.0",
  Fragment: "Fragment",
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    if (initial === "Console") return [tabUnderTest, () => {}];
    if (initial === false && forceOpen) return [true, () => {}];
    if (initial === "" && fillTextInputs) return ["get", () => {}];
    return [initial, () => {}];
  },
  useRef: (initial) => ({ current: initial }),
  useEffect: (fn) => {
    // Keep effects mounted: cleanups run only when the test asks for them.
    const cleanup = fn();
    if (typeof cleanup === "function") pendingCleanups.push(cleanup);
  }
};

class ValueXY {
  constructor(v) {
    this.x = { _value: v.x };
    this.y = { _value: v.y };
  }
  setOffset() {}
  setValue(v) {
    this.x._value = v.x;
    this.y._value = v.y;
  }
  flattenOffset() {}
  getTranslateTransform() {
    return [{ translateX: this.x._value }, { translateY: this.y._value }];
  }
}

let lastPanConfig = null;
const ReactNative = {
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Pressable: "Pressable",
  Modal: "Modal",
  Animated: { View: "Animated.View", ValueXY },
  PanResponder: {
    create: (config) => {
      lastPanConfig = config;
      return { panHandlers: { onStartShouldSetPanResponder: config.onStartShouldSetPanResponder } };
    }
  },
  Platform: { OS: "ios", Version: "17.4", constants: { Model: "iPhone", systemName: "iOS" } },
  Dimensions: { get: () => ({ width: 393, height: 852, scale: 3 }) },
  useColorScheme: () => "dark",
  StyleSheet: { create: (s) => s, absoluteFillObject: { position: "absolute" } },
  AppState: {}
};

/* ------------------------------------------------------------------ *
 * fake metro, patcher and the error boundary we mount on              *
 * ------------------------------------------------------------------ */

const fakeUserStore = {
  getCurrentUser: function getCurrentUser() {
    return { id: "1", username: "larpbase" };
  },
  getUser: function getUser(id) {
    return { id };
  },
  getName: () => "UserStore"
};

class ErrorBoundary {
  constructor() {
    this.state = {};
  }
  render() {
    return { type: "App", props: {}, children: [] };
  }
}
const pristineBoundaryRender = ErrorBoundary.prototype.render;

const registry = {
  12: { isInitialized: true, publicModule: { exports: fakeUserStore } },
  13: { isInitialized: true, publicModule: { exports: { somethingElse: 1, nested: { deep: true } } } },
  14: { isInitialized: false, publicModule: { exports: { shouldNotBeRead: true } } }
};

// spitroast's `after`: the callback sees (args, ret) with `this` bound, and a
// returned value replaces the original return.
function after(name, object, callback) {
  const original = object[name];
  object[name] = function (...args) {
    const ret = original.apply(this, args);
    const replaced = callback.call(this, args, ret);
    return replaced === undefined ? ret : replaced;
  };
  return () => {
    object[name] = original;
  };
}

const clipboardWrites = [];

/* ------------------------------------------------------------------ *
 * load the bundle the way Kettu loads it                              *
 * ------------------------------------------------------------------ */

// Vendetta-format plugins get this object as a PARAMETER, not as a global.
// plugin.storage is the auto-persisting proxy; here a plain object stands in.
const pluginStorage = { captureWebSocket: true };
const vendettaForPlugins = {
  patcher: { before: () => () => {}, after, instead: () => () => {} },
  metro: {
    modules: registry,
    findByProps: (...props) => (props.every((p) => p in fakeUserStore) ? fakeUserStore : undefined),
    findByStoreName: (name) => (name === "UserStore" ? fakeUserStore : undefined),
    findByName: (name) => (name === "ErrorBoundary" ? ErrorBoundary : undefined),
    common: {
      React,
      ReactNative,
      clipboard: { setString: (s) => clipboardWrites.push(s) }
    }
  },
  plugin: { id: "devtools", manifest: { name: "DevTools" }, storage: pluginStorage },
  debug: { versions: { discord: "250.0", reactNative: "0.75.4" } },
  ui: { toasts: { showToast: () => {} } }
};

// A global exists too, deliberately WITHOUT a usable plugin.storage, so that
// picking the global over the injected object would show up as a failure below.
globalThis.bunny = { metro: vendettaForPlugins.metro, ui: vendettaForPlugins.ui };

const instantiate = new Function("return vendetta=>{return " + code + "}")();
const raw = instantiate(vendettaForPlugins);
const evaluated = typeof raw === "function" ? raw() : raw;
const plugin = evaluated?.default ?? evaluated ?? {};

assert.equal(typeof plugin.onLoad, "function", "Kettu's loader must end up with an onLoad");
assert.equal(typeof plugin.onUnload, "function", "and an onUnload");
assert.equal(typeof plugin.settings, "function", "and a settings component");

/* ---- lifecycle ---- */

plugin.onLoad();
const dt = globalThis.__devtools;
assert.ok(dt, "internals bridge should be exposed on load");
assert.notEqual(globalThis.console.log, pristineConsoleLog, "console should be patched");
assert.notEqual(FakeXHR.prototype.open, pristineXhrOpen, "XHR should be patched");
assert.notEqual(ErrorBoundary.prototype.render, pristineBoundaryRender, "ErrorBoundary should be patched");

/* ---- settings land in the injected storage, not a throwaway object ---- */

assert.equal(pluginStorage.captureConsole, true, "defaults must be written into the persistent storage");
assert.equal(pluginStorage.maxEntries, 500);
assert.equal(pluginStorage.floatingButton, true);

/* ---- console capture ---- */

console.log("hello", { a: 1, b: [1, 2, 3] });
console.warn("careful");
console.error("broke", new Error("boom"));

const logged = dt.logs.find((l) => l.summary.startsWith("hello"));
assert.ok(logged, "console.log should be captured");
assert.ok(logged.summary.includes("a: 1"), "objects should be inspected, not [object Object]");
assert.equal(dt.logs.find((l) => l.summary === "careful").level, "warn");
assert.equal(dt.logs.find((l) => l.summary.startsWith("broke")).level, "error");
assert.ok(
  passedThrough.some((p) => p[0] === "log" && p[1][0] === "hello"),
  "patched console must still pass through to the original"
);

/* ---- uncaught errors ---- */

assert.notEqual(globalHandler, appErrorHandler, "ours should be in front");
globalHandler(new Error("fatal thing"), true);
const crash = dt.logs.find((l) => l.source === "crash");
assert.ok(crash && crash.summary.includes("[fatal]"), "fatals should be captured and marked");
assert.deepEqual(
  appErrors.at(-1),
  ["fatal thing", true],
  "the app's own handler must still run - swallowing crashes would hide them from Discord"
);

/* ---- network capture ---- */

const xhr = new FakeXHR();
xhr.open("GET", "https://discord.com/api/v9/users/@me");
xhr.send();
xhr.status = 200;
xhr.responseText = '{"id":"1"}';
xhr.fire("load");

const req = dt.requests.find((r) => r.kind === "http");
assert.ok(req && req.method === "GET" && req.status === 200, "http request should be captured");
assert.equal(req.responseBody, '{"id":"1"}');
assert.ok(req.responseHeaders.includes("content-type"));

const failing = new FakeXHR();
failing.open("POST", "https://discord.com/api/v9/nope");
failing.send("{}");
failing.fire("error");
const failed = dt.requests.find((r) => r.url.endsWith("/nope"));
assert.equal(failed.outcome, "error", "failed requests should be recorded as errors");
assert.equal(failed.requestBody, "{}");

/* ---- websocket capture ---- */

new FakeWebSocket("wss://gateway.discord.gg/?v=9").send(JSON.stringify({ op: 1, d: null }));
const frame = dt.requests.find((r) => r.kind === "ws");
assert.ok(frame && frame.requestBody.includes('"op":1'), "outgoing ws frames should be captured");

new FakeWebSocket("wss://gateway.discord.gg/?v=9").send(new Uint8Array([1, 2, 3]).buffer);
assert.ok(
  dt.requests.filter((r) => r.kind === "ws").pop().requestBody.includes("binary frame"),
  "binary frames should be labelled, not stringified"
);

/* ---- eval ---- */

assert.equal(dt.runEval("1 + 1").text, "2", "expressions should return their value");
assert.equal(dt.runEval("$ + 1").text, "3", "$ should hold the previous result");
assert.ok(dt.runEval('store("UserStore").getCurrentUser()').text.includes("larpbase"));
assert.ok(dt.runEval('find("getCurrentUser")').text.includes("getCurrentUser"));
assert.equal(dt.runEval("var a = 2; return a * 21;").text, "42", "statement bodies should work");
const bad = dt.runEval("this is not javascript");
assert.equal(bad.ok, false, "syntax errors should be reported, not thrown");
const thrown = dt.runEval("throw new Error('nope')");
assert.ok(!thrown.ok && thrown.text.includes("nope"));

/* ---- module search ---- */

const found = dt.searchModules("getCurrentUser");
assert.equal(found.results.length, 1, "exactly one module exports getCurrentUser");
assert.equal(found.results[0].label, "UserStore", "getName() should be used as the label");
assert.equal(dt.searchModules("shouldNotBeRead").results.length, 0, "uninitialized modules must not be read");

/* ---- inspect ---- */

const cyclic = { name: "x" };
cyclic.self = cyclic;
assert.ok(dt.inspect(cyclic).includes("[circular]"), "cycles must not blow the stack");
assert.ok(dt.inspect(function namedFn(a, b) {}).includes("namedFn(2)"));

/* ------------------------------------------------------------------ *
 * floating button                                                     *
 * ------------------------------------------------------------------ */

function walk(node, predicate, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = walk(child, predicate, seen);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const child of [...(node.children ?? []), node.props?.children]) {
    const hit = walk(child, predicate, seen);
    if (hit) return hit;
  }
  return null;
}

// Rendering the patched boundary should wrap the app tree, not replace it.
const boundary = new ErrorBoundary();
const rendered = boundary.render();
assert.equal(rendered.type, "Fragment", "the patch should wrap the app in a fragment");
assert.ok(walk(rendered, (n) => n.type === "App"), "the real app tree must still be in there");

const hostElement = walk(rendered, (n) => typeof n.type === "function");
assert.ok(hostElement, "the overlay host component should be mounted");

const overlay = hostElement.type();
assert.ok(overlay, "the overlay should render for the first mounted host");
assert.equal(overlay.props.pointerEvents, "box-none", "the overlay must not eat touches meant for the app");

const bubble = walk(overlay, (n) => n.type === "Animated.View");
assert.ok(bubble, "there should be a draggable bubble");
assert.equal(bubble.props.style.position, "absolute");
assert.ok(walk(bubble, (n) => n.children?.includes("</>")), "bubble should carry its label");

const closedModal = walk(overlay, (n) => n.type === "Modal");
assert.ok(closedModal, "the panel modal should exist");
assert.equal(closedModal.props.visible, false, "and start closed");

// A second host must not draw a second bubble.
const secondHost = hostElement.type;
assert.equal(secondHost(), null, "only one host may own the overlay");

// Dragging clamps to the screen and remembers where it was left.
assert.ok(lastPanConfig, "a pan responder should have been created");
assert.equal(lastPanConfig.onMoveShouldSetPanResponder(null, { dx: 1, dy: 1 }), false, "a small move is a tap");
assert.equal(lastPanConfig.onMoveShouldSetPanResponder(null, { dx: 20, dy: 0 }), true, "a big move is a drag");
lastPanConfig.onPanResponderGrant();
lastPanConfig.onPanResponderMove(null, { dx: 9999, dy: 9999 });
lastPanConfig.onPanResponderRelease(null, { dx: 9999, dy: 9999 });
assert.ok(pluginStorage.bubbleX <= 393 - 52 - 8, "x should be clamped inside the screen");
assert.ok(pluginStorage.bubbleY <= 852 - 52 - 48, "y should be clamped inside the screen");

// Opening it shows the panel. Unmount the current host first: each fake render
// is a fresh instance, so ownership has to be released before the next claim.
pendingCleanups.splice(0).forEach((fn) => fn());
forceOpen = true;
const openOverlay = walk(new ErrorBoundary().render(), (n) => typeof n.type === "function");
const openTree = openOverlay.type();
const openModal = walk(openTree, (n) => n.type === "Modal");
assert.equal(openModal.props.visible, true, "tapping should open the panel");
assert.ok(walk(openModal, (n) => n.children?.includes("DevTools")), "the panel should be titled");
forceOpen = false;

// On the crash screen the bubble stands down.
const crashing = new ErrorBoundary();
crashing.state = { error: new Error("render blew up") };
assert.equal(crashing.render().type, "App", "no bubble over the error screen");

/* ---- every tab renders ---- */

for (const tab of ["Console", "Eval", "Network", "Modules", "Device"]) {
  for (const filled of [false, true]) {
    tabUnderTest = tab;
    fillTextInputs = filled;
    const tree = plugin.settings();
    assert.ok(tree && tree.type === "ScrollView", `${tab} tab should render a tree`);
  }
}
tabUnderTest = "Console";
fillTextInputs = false;

/* ---- teardown ---- */

plugin.onUnload();
assert.equal(globalThis.console.log, pristineConsoleLog, "console should be restored");
assert.equal(FakeXHR.prototype.open, pristineXhrOpen, "XHR should be restored");
assert.equal(ErrorBoundary.prototype.render, pristineBoundaryRender, "ErrorBoundary should be unpatched");
assert.equal(globalHandler, appErrorHandler, "the app's error handler should be put back");
assert.equal(globalThis.__devtools, undefined, "internals bridge should be removed");
assert.deepEqual(new ErrorBoundary().render(), { type: "App", props: {}, children: [] }, "no overlay after unload");

pendingCleanups.forEach((fn) => fn());

realLog(
  `all smoke tests passed (${dt.logs.length} logs, ${dt.requests.length} requests, 10 tab renders, overlay verified)`
);
