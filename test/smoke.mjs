/**
 * Smoke test for the built bundle. Stands up a fake Kettu runtime and a fake
 * gateway socket, then asserts that outgoing frames come out rewritten.
 *
 *   node build.mjs && node test/smoke.mjs
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const code = await readFile(join(root, "dist", "index.js"), "utf8");

/* ---- fake runtime ---- */

const sent = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
  }
  send(data) {
    sent.push(data);
  }
}
const pristineSend = FakeWebSocket.prototype.send;
globalThis.WebSocket = FakeWebSocket;

const dispatched = [];
const idleStore = { isIdle: () => true, isAFK: () => true, getIdleSince: () => 1234 };

const storage = {};
globalThis.bunny = {
  metro: {
    findByProps: () => undefined,
    findByStoreName: (name) => (name === "IdleStore" ? idleStore : undefined),
    common: {
      React: { createElement: () => null, useState: (v) => [v, () => {}] },
      ReactNative: null,
      FluxDispatcher: { dispatch: (a) => dispatched.push(a) }
    }
  },
  plugin: { storage },
  ui: { toasts: { showToast: () => {} } }
};

const plugin = new Function("return " + code)();

/* ---- lifecycle ---- */

plugin.onLoad();
assert.notEqual(FakeWebSocket.prototype.send, pristineSend, "send should be patched on load");
assert.equal(idleStore.isIdle(), false, "IdleStore.isIdle should be suppressed");
assert.equal(idleStore.getIdleSince(), 0, "IdleStore.getIdleSince should be suppressed");

const gateway = new FakeWebSocket("wss://gateway.discord.gg/?v=9&encoding=json&compress=zlib-stream");

/* ---- identify rewriting ---- */

gateway.send(
  JSON.stringify({
    op: 2,
    d: { token: "x", properties: { browser: "Discord Android", os: "Android" }, intents: 0 }
  })
);
let frame = JSON.parse(sent.at(-1));
assert.equal(frame.op, 2);
assert.equal(frame.d.presence.status, "online", "identify should carry our status");
assert.equal(frame.d.presence.afk, false, "identify should never be afk");
assert.equal(frame.d.properties.browser, "Discord Android", "desktop spoof is off by default");

/* ---- the idle frame the client fires on backgrounding ---- */

gateway.send(JSON.stringify({ op: 3, d: { status: "idle", since: Date.now(), afk: true, activities: [] } }));
frame = JSON.parse(sent.at(-1));
assert.equal(frame.d.status, "online", "idle presence should be rewritten to online");
assert.equal(frame.d.afk, false, "afk should be forced false");

/* ---- an offline frame ---- */

gateway.send(JSON.stringify({ op: 3, d: { status: "offline", since: 0, afk: false, activities: [] } }));
assert.equal(JSON.parse(sent.at(-1)).d.status, "online", "offline presence should be rewritten");

/* ---- foreign activities survive when we supply none ---- */

gateway.send(
  JSON.stringify({ op: 3, d: { status: "idle", since: 0, afk: true, activities: [{ name: "Spotify", type: 2 }] } })
);
frame = JSON.parse(sent.at(-1));
assert.equal(frame.d.activities.length, 1, "client activities should be preserved");
assert.equal(frame.d.activities[0].name, "Spotify");

/* ---- custom presence ---- */

storage.status = "dnd";
storage.activity = {
  enabled: true,
  type: 0,
  name: "Minecraft",
  details: "In a world",
  state: "Mining",
  applicationId: "123456789",
  largeImage: "big",
  largeText: "tooltip",
  showElapsed: true
};
gateway.send(JSON.stringify({ op: 3, d: { status: "idle", since: 0, afk: true, activities: [] } }));
frame = JSON.parse(sent.at(-1));
assert.equal(frame.d.status, "dnd", "configured status should win");
const act = frame.d.activities[0];
assert.equal(act.name, "Minecraft");
assert.equal(act.details, "In a world");
assert.equal(act.state, "Mining");
assert.equal(act.application_id, "123456789");
assert.equal(act.assets.large_image, "big");
assert.equal(act.assets.large_text, "tooltip");
assert.ok(act.timestamps.start > 0, "elapsed timer should be set");

/* ---- custom status shape (type 4) ---- */

storage.activity = { enabled: true, type: 4, state: "vibing", name: "ignored" };
gateway.send(JSON.stringify({ op: 3, d: { status: "idle", since: 0, afk: true, activities: [] } }));
const custom = JSON.parse(sent.at(-1)).d.activities[0];
assert.equal(custom.name, "Custom Status", "type 4 requires the literal name");
assert.equal(custom.state, "vibing");
assert.equal(custom.type, 4);

/* ---- desktop spoof ---- */

storage.spoofDesktop = true;
gateway.send(JSON.stringify({ op: 2, d: { token: "x", properties: { browser: "Discord Android", os: "Android", browser_user_agent: "ua" } } }));
frame = JSON.parse(sent.at(-1));
assert.equal(frame.d.properties.browser, "Discord Client");
assert.equal(frame.d.properties.browser_user_agent, undefined, "mobile user agent should be dropped");

/* ---- non-gateway sockets are untouched ---- */

const voice = new FakeWebSocket("wss://some-voice-node.discord.media/?v=7");
voice.send(JSON.stringify({ op: 3, d: { status: "idle" } }));
assert.equal(JSON.parse(sent.at(-1)).d.status, "idle", "non-gateway traffic must pass through");

/* ---- binary (ETF) frames are passed through, not corrupted ---- */

const binary = new Uint8Array([131, 116, 0, 0, 0, 1]);
gateway.send(binary);
assert.equal(sent.at(-1), binary, "binary frames should pass through untouched");

/* ---- flux path ---- */

assert.ok(
  dispatched.some((d) => d.type === "LOCAL_ACTIVITY_UPDATE" && d.socketId === "always-online"),
  "activity should also go through FluxDispatcher"
);

/* ---- teardown ---- */

plugin.onUnload();
assert.equal(FakeWebSocket.prototype.send, pristineSend, "send should be restored on unload");
assert.equal(idleStore.isIdle(), true, "IdleStore should be restored on unload");
assert.equal(
  dispatched.at(-1).type,
  "LOCAL_ACTIVITY_UPDATE",
  "unload should clear the activity"
);
assert.deepEqual(dispatched.at(-1).activity, {}, "cleared activity should be empty");

gateway.send(JSON.stringify({ op: 3, d: { status: "idle", afk: true } }));
assert.equal(JSON.parse(sent.at(-1)).d.status, "idle", "no rewriting after unload");

console.log("all smoke tests passed (" + sent.length + " frames exercised)");
