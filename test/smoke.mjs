/**
 * Smoke test for the built bundle. Stands up a fake React Native runtime and a
 * fake Kettu api, then asserts that capture, eval, module search and the whole
 * settings tree actually work.
 *
 *   node build.mjs && node test/smoke.mjs
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const code = await readFile(join(root, "DevTools", "index.js"), "utf8");

/* ---- fake react native globals ---- */

const realConsole = { log: console.log.bind(console) };
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

// The app already has a handler; ours must chain to it and put it back on unload.
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

/* ---- fake react + react native modules ---- */

let tabUnderTest = "Console";
let fillTextInputs = false;

const React = {
  version: "18.2.0",
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => {
    if (initial === "Console") return [tabUnderTest, () => {}];
    if (initial === "" && fillTextInputs) return ["get", () => {}];
    return [initial, () => {}];
  },
  useEffect: (fn) => {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanup();
  }
};

const passthroughComponent = (name) => name;
const ReactNative = {
  View: passthroughComponent("View"),
  Text: passthroughComponent("Text"),
  TextInput: passthroughComponent("TextInput"),
  ScrollView: passthroughComponent("ScrollView"),
  Switch: passthroughComponent("Switch"),
  Pressable: passthroughComponent("Pressable"),
  Platform: { OS: "ios", Version: "17.4", constants: { Model: "iPhone", systemName: "iOS" } },
  Dimensions: { get: () => ({ width: 393, height: 852, scale: 3 }) },
  useColorScheme: () => "dark",
  StyleSheet: { create: (s) => s },
  AppState: {}
};

/* ---- fake metro registry ---- */

const fakeUserStore = {
  getCurrentUser: function getCurrentUser() {
    return { id: "1", username: "larpbase" };
  },
  getUser: function getUser(id) {
    return { id };
  },
  getName: () => "UserStore"
};

const registry = {
  12: { isInitialized: true, publicModule: { exports: fakeUserStore } },
  13: { isInitialized: true, publicModule: { exports: { somethingElse: 1, nested: { deep: true } } } },
  14: { isInitialized: false, publicModule: { exports: { shouldNotBeRead: true } } }
};

const clipboardWrites = [];
const storage = { captureWebSocket: true };

globalThis.bunny = {
  metro: {
    modules: registry,
    findByProps: (...props) =>
      props.every((p) => p in fakeUserStore) ? fakeUserStore : undefined,
    findByStoreName: (name) => (name === "UserStore" ? fakeUserStore : undefined),
    common: {
      React,
      ReactNative,
      clipboard: { setString: (s) => clipboardWrites.push(s) }
    }
  },
  plugin: { storage },
  debug: { versions: { discord: "250.0", reactNative: "0.75.4" } },
  ui: { toasts: { showToast: () => {} } }
};

const plugin = new Function("return " + code)();

/* ---- lifecycle ---- */

plugin.onLoad();
const dt = globalThis.__devtools;
assert.ok(dt, "internals bridge should be exposed on load");
assert.notEqual(globalThis.console.log, pristineConsoleLog, "console should be patched");
assert.notEqual(FakeXHR.prototype.open, pristineXhrOpen, "XHR should be patched");

/* ---- console capture ---- */

console.log("hello", { a: 1, b: [1, 2, 3] });
console.warn("careful");
console.error("broke", new Error("boom"));

assert.ok(dt.logs.length >= 4, "logs should include the attach line plus three entries");
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

assert.equal(typeof globalHandler, "function", "a global error handler should be installed");
assert.notEqual(globalHandler, appErrorHandler, "ours should be in front");
globalHandler(new Error("fatal thing"), true);
const crash = dt.logs.find((l) => l.source === "crash");
assert.ok(crash, "uncaught errors should be captured");
assert.ok(crash.summary.includes("[fatal]"), "fatality should be marked");
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
assert.ok(req, "http request should be captured");
assert.equal(req.method, "GET");
assert.equal(req.status, 200);
assert.equal(req.responseBody, '{"id":"1"}');
assert.ok(req.responseHeaders.includes("content-type"));
assert.ok(typeof req.ms === "number", "duration should be recorded");

const failing = new FakeXHR();
failing.open("POST", "https://discord.com/api/v9/nope");
failing.send("{}");
failing.fire("error");
const failed = dt.requests.find((r) => r.url.endsWith("/nope"));
assert.equal(failed.outcome, "error", "failed requests should be recorded as errors");
assert.equal(failed.requestBody, "{}");

/* ---- websocket capture (enabled via storage before load) ---- */

new FakeWebSocket("wss://gateway.discord.gg/?v=9").send(JSON.stringify({ op: 1, d: null }));
const frame = dt.requests.find((r) => r.kind === "ws");
assert.ok(frame, "outgoing ws frames should be captured when enabled");
assert.ok(frame.requestBody.includes('"op":1'));

new FakeWebSocket("wss://gateway.discord.gg/?v=9").send(new Uint8Array([1, 2, 3]).buffer);
const binary = dt.requests.filter((r) => r.kind === "ws").pop();
assert.ok(binary.requestBody.includes("binary frame"), "binary frames should be labelled, not stringified");

/* ---- eval ---- */

assert.equal(dt.runEval("1 + 1").text, "2", "expressions should return their value");
assert.equal(dt.runEval("$ + 1").text, "3", "$ should hold the previous result");
assert.ok(dt.runEval('store("UserStore").getCurrentUser()').text.includes("larpbase"), "store() helper should resolve");
assert.ok(dt.runEval('find("getCurrentUser")').text.includes("getCurrentUser"), "find() helper should resolve");
assert.ok(dt.runEval("var a = 2; return a * 21;").text === "42", "statement bodies should work");
const bad = dt.runEval("this is not javascript");
assert.equal(bad.ok, false, "syntax errors should be reported, not thrown");
assert.ok(bad.text.includes("Error"), "the error text should say what happened");
const thrown = dt.runEval("throw new Error('nope')");
assert.equal(thrown.ok, false);
assert.ok(thrown.text.includes("nope"));

/* ---- module search ---- */

const found = dt.searchModules("getCurrentUser");
assert.equal(found.available, true, "registry should be reachable");
assert.equal(found.results.length, 1, "exactly one module exports getCurrentUser");
assert.equal(found.results[0].id, "12");
assert.equal(found.results[0].label, "UserStore", "getName() should be used as the label");
assert.ok(found.results[0].hits.includes("getCurrentUser"));
assert.equal(dt.searchModules("shouldNotBeRead").results.length, 0, "uninitialized modules must not be read");

/* ---- inspect ---- */

const cyclic = { name: "x" };
cyclic.self = cyclic;
assert.ok(dt.inspect(cyclic).includes("[circular]"), "cycles must not blow the stack");
assert.ok(dt.inspect(function namedFn(a, b) {}).includes("namedFn(2)"), "functions show name and arity");
assert.equal(dt.inspect(undefined), "undefined");
assert.equal(dt.inspect(null), "null");

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
assert.equal(globalHandler, appErrorHandler, "the app's error handler should be put back");
assert.equal(globalThis.__devtools, undefined, "internals bridge should be removed");

const before = passedThrough.length;
console.log("after unload");
assert.equal(passedThrough.length, before + 1, "console still works after unload");

realConsole.log(
  `all smoke tests passed (${dt.logs.length} logs, ${dt.requests.length} requests, 10 tab renders)`
);
