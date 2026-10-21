/**
 * Smoke test for the built Toolbox bundle.
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
 * Everything Discord-shaped below is a stand-in: an action sheet that resolves a
 * lazy module, a Flux dispatcher, MessageStore, a CDN that honours Range.
 *
 *   node build.mjs && node test/toolbox.mjs
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const code = await readFile(join(root, "Toolbox", "index.js"), "utf8");

const realLog = console.log.bind(console);
const logged = [];
globalThis.console = { ...console, log: (...a) => logged.push(a) };

const flush = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------------ *
 * fake react + react native                                           *
 * ------------------------------------------------------------------ */

let hookIndex = 0;
let hookValues = {};
const setterCalls = [];

function resetHooks(values = {}) {
  hookIndex = 0;
  hookValues = values;
}

const pendingCleanups = [];

const React = {
  version: "18.2.0",
  Fragment: "Fragment",
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = hookIndex++;
    const value = Object.prototype.hasOwnProperty.call(hookValues, index) ? hookValues[index] : initial;
    return [value, (next) => setterCalls.push([index, next])];
  },
  useRef: (initial) => ({ current: initial }),
  useEffect: (fn) => {
    const cleanup = fn();
    if (typeof cleanup === "function") pendingCleanups.push(cleanup);
  }
};

const ReactNative = {
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Pressable: "Pressable",
  Modal: "Modal",
  Platform: { OS: "ios", Version: "17.4" },
  Dimensions: { get: () => ({ width: 393, height: 852, scale: 3 }) },
  useColorScheme: () => "dark",
  StyleSheet: { create: (s) => s },
  AppState: {}
};

/** Depth-first search over the fake element tree. */
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

function walkAll(node, predicate, out = [], seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) walkAll(child, predicate, out, seen);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of [...(node.children ?? []), node.props?.children]) {
    walkAll(child, predicate, out, seen);
  }
  return out;
}

const textOf = (node) =>
  walkAll(node, (n) => n.type === "Text")
    .map((n) => n.children.flat(4).filter((c) => typeof c === "string").join(" "))
    .join(" | ");

/* ------------------------------------------------------------------ *
 * fake discord internals                                             *
 * ------------------------------------------------------------------ */

const message = {
  id: "1200000000000000000",
  channel_id: "chan",
  content: "look at this ```js\nconsole.log(1)\n``` <:kek:999123>",
  author: { id: "7", username: "larpbase", global_name: "Larpbase", avatar: "a_abc" },
  embeds: [
    {
      rawTitle: "Embed title",
      rawDescription: "Embed description here",
      url: "https://example.com/post",
      author: { name: "Example site" },
      fields: [{ rawName: "Field name", rawValue: "Field value" }],
      footer: { text: "footer text" },
      image: { url: "https://example.com/picture.png" }
    }
  ],
  attachments: [
    {
      id: "a1",
      filename: "server.log",
      size: 40 * 1024 * 1024,
      url: "https://cdn.discordapp.com/attachments/1/2/server.log",
      content_type: "text/plain"
    },
    {
      id: "a2",
      filename: "shot.png",
      size: 2048,
      url: "https://cdn.discordapp.com/attachments/1/3/shot.png",
      content_type: "image/png"
    }
  ],
  stickerItems: [{ id: "55", name: "wave", format_type: 1 }]
};

const plainMessage = {
  id: "1200000000000000001",
  channel_id: "chan",
  content: "just text",
  author: { id: "8", username: "someone" },
  embeds: [],
  attachments: []
};

const stored = { chan: [plainMessage, message] };

const MessageStore = {
  getName: () => "MessageStore",
  getMessage: (channelId, id) => (stored[channelId] || []).find((m) => m.id === id) || null,
  getMessages: (channelId) => ({ toArray: () => stored[channelId] || [] })
};
const ChannelStore = { getName: () => "ChannelStore", getChannel: (id) => ({ id, guild_id: "guild9" }) };
const SelectedChannelStore = { getName: () => "SelectedChannelStore", getChannelId: () => "chan" };
const UserStore = {
  getName: () => "UserStore",
  getUser: (id) => ({ id, username: "larpbase", avatar: "a_abc" })
};

let sheetHidden = 0;
let lastOpenLazy = null;
const ActionSheet = {
  openLazy: (promise, key, props) => {
    lastOpenLazy = { promise, key, props };
  },
  hideActionSheet: () => {
    sheetHidden++;
  }
};

const dispatched = [];
const FluxDispatcher = {
  _subscriptions: {},
  subscribe: () => {},
  dispatch: (event) => {
    dispatched.push(event);
  }
};

const typingCalls = [];
const Typing = {
  startTyping: (channelId) => typingCalls.push(channelId),
  stopTyping: () => {}
};

function FormRowComponent(props) {
  return React.createElement("View", props);
}
FormRowComponent.Icon = function Icon() {
  return null;
};
const FormRowModule = { FormRow: FormRowComponent };

class ErrorBoundary {
  constructor() {
    this.state = {};
  }
  render() {
    return { type: "App", props: {}, children: [] };
  }
}
const pristineBoundaryRender = ErrorBoundary.prototype.render;

const clipboardWrites = [];
const toasts = [];

/* ---- the CDN, honouring Range ---- */

const fetchCalls = [];
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url, options });
  return Promise.resolve({
    status: 206,
    text: () => Promise.resolve("2026-10-21 boot\n2026-10-21 crash\n")
  });
};

/* ---- spitroast-shaped patcher ---- */

function before(name, object, callback) {
  const original = object[name];
  object[name] = function (...args) {
    const replaced = callback.call(this, args);
    return original.apply(this, Array.isArray(replaced) ? replaced : args);
  };
  return () => {
    object[name] = original;
  };
}

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

function instead(name, object, callback) {
  const original = object[name];
  object[name] = function (...args) {
    return callback.call(this, args, original);
  };
  return () => {
    object[name] = original;
  };
}

/* ---- metro ---- */

const propsCandidates = [ActionSheet, FluxDispatcher, Typing, FormRowModule];
const storesByName = { MessageStore, ChannelStore, SelectedChannelStore, UserStore };

const registeredCommands = [];

const pluginStorage = {};
const vendettaForPlugins = {
  patcher: { before, after, instead },
  metro: {
    findByProps: (...props) => propsCandidates.find((c) => props.every((p) => p in c)),
    findByStoreName: (name) => storesByName[name],
    findByName: (name) => (name === "ErrorBoundary" ? ErrorBoundary : undefined),
    common: {
      React,
      ReactNative,
      FluxDispatcher,
      clipboard: { setString: (s) => clipboardWrites.push(s), getString: () => "" }
    }
  },
  plugin: { id: "toolbox", manifest: { name: "Toolbox" }, storage: pluginStorage },
  commands: {
    registerCommand: (definition) => {
      registeredCommands.push(definition);
      return () => {
        const i = registeredCommands.indexOf(definition);
        if (i !== -1) registeredCommands.splice(i, 1);
      };
    }
  },
  ui: {
    toasts: { showToast: (text) => toasts.push(text) },
    assets: { getAssetIDByName: (name) => (name === "ic_message_copy" ? 42 : undefined) }
  }
};

// A global exists too, deliberately WITHOUT a usable plugin.storage, so picking
// the global over the injected object would show up as a failure below.
globalThis.bunny = { metro: vendettaForPlugins.metro, ui: vendettaForPlugins.ui };

/* ------------------------------------------------------------------ *
 * load it the way Kettu does                                          *
 * ------------------------------------------------------------------ */

const instantiate = new Function("return vendetta=>{return " + code + "}")();
const raw = instantiate(vendettaForPlugins);
const evaluated = typeof raw === "function" ? raw() : raw;
const plugin = evaluated?.default ?? evaluated ?? {};

assert.equal(typeof plugin.onLoad, "function", "Kettu's loader must end up with an onLoad");
assert.equal(typeof plugin.onUnload, "function", "and an onUnload");
assert.equal(typeof plugin.settings, "function", "and a settings component");

plugin.onLoad();
const tb = globalThis.__toolbox;
assert.ok(tb, "the internals bridge should be exposed on load");

/* ---- settings land in the injected storage, not a throwaway object ---- */

assert.equal(pluginStorage.copyEmbed, true, "defaults must be written into the persistent storage");
assert.equal(pluginStorage.previewFile, true);
assert.equal(pluginStorage.copyJson, false, "the debug rows stay off until asked for");
assert.equal(tb.state().persistent, true, "the injected storage must be the one in use");

/* ---- patches landed ---- */

assert.notEqual(ErrorBoundary.prototype.render, pristineBoundaryRender, "the viewer host should be mounted");
assert.equal(tb.state().overlay, "mounted");
assert.equal(tb.state().flux, "watching", "deletes and edits are archived by default");
assert.equal(tb.state().typing, "off", "silent typing is off by default");
assert.ok(tb.state().sheet.indexOf("armed") !== -1, "the action sheet hook should be armed");

/* ------------------------------------------------------------------ *
 * long press: rows get injected into the sheet                        *
 * ------------------------------------------------------------------ */

const sheetRows = [
  React.createElement(FormRowComponent, { key: "reply", label: "Reply", onPress() {} }),
  React.createElement(FormRowComponent, { key: "edit", label: "Edit", onPress() {} })
];
const sheetModule = { default: () => React.createElement("View", null, sheetRows) };
const pristineSheetRender = sheetModule.default;

ActionSheet.openLazy(Promise.resolve(sheetModule), "MessageLongPressActionSheet", {
  message,
  channel: { id: "chan" }
});
await flush();

assert.notEqual(sheetModule.default, pristineSheetRender, "the sheet component should be patched");
assert.equal(lastOpenLazy.key, "MessageLongPressActionSheet", "and the original openLazy still ran");

resetHooks();
const sheetTree = sheetModule.default({ message });
assert.equal(sheetModule.default, pristineSheetRender, "the inner patch must remove itself after one render");
assert.equal(tb.state().strategy, "row list", "rows belong in the sheet's own row list");
assert.equal(sheetRows.length, 3, "our row block should be appended to Discord's rows");

const rowBlock = sheetRows[2];
resetHooks();
const rows = rowBlock.type(rowBlock.props);
const labels = textOf(rows);

for (const expected of [
  "Copy embed content",
  "View embed content",
  "Preview file contents",
  "Copy file URL",
  "Copy message text",
  "Copy code blocks",
  "Copy IDs",
  "Copy message link",
  "Copy sticker / emoji URL"
]) {
  assert.ok(labels.includes(expected), `the sheet should offer "${expected}"`);
}
assert.ok(!labels.includes("Copy message JSON"), "a disabled feature must not render a row");

/* ---- pressing a row ---- */

function pressRow(tree, label) {
  const hit = walkAll(tree, (n) => typeof n.props?.onPress === "function").find((n) => textOf(n).includes(label));
  assert.ok(hit, `row "${label}" should be pressable`);
  hit.props.onPress();
}

const hiddenBefore = sheetHidden;
pressRow(rows, "Copy embed content");
assert.equal(sheetHidden, hiddenBefore + 1, "pressing a row should dismiss the sheet first");
await new Promise((r) => setTimeout(r, 120));

const embedText = clipboardWrites.at(-1);
for (const fragment of [
  "Example site",
  "Embed title",
  "https://example.com/post",
  "Embed description here",
  "Field name:",
  "Field value",
  "footer text",
  "image: https://example.com/picture.png"
]) {
  assert.ok(embedText.includes(fragment), `copied embed should carry ${fragment}`);
}

/* ---- the other copy rows ---- */

pressRow(rows, "Copy IDs");
await new Promise((r) => setTimeout(r, 120));
const ids = clipboardWrites.at(-1);
assert.ok(ids.includes("message " + message.id) && ids.includes("guild9") && ids.includes("author  7"));

pressRow(rows, "Copy message link");
await new Promise((r) => setTimeout(r, 120));
assert.equal(
  clipboardWrites.at(-1),
  "https://discord.com/channels/guild9/chan/" + message.id,
  "the link needs the guild id out of ChannelStore"
);

pressRow(rows, "Copy code blocks");
await new Promise((r) => setTimeout(r, 120));
assert.equal(clipboardWrites.at(-1), "console.log(1)", "fences and language tag stripped");

pressRow(rows, "Copy sticker / emoji URL");
await new Promise((r) => setTimeout(r, 120));
const media = clipboardWrites.at(-1);
assert.ok(media.includes("media.discordapp.net/stickers/55.png"), "sticker URL");
assert.ok(media.includes("cdn.discordapp.com/emojis/999123.png"), "custom emoji out of the message text");

pressRow(rows, "Copy file URL");
await new Promise((r) => setTimeout(r, 120));
assert.equal(clipboardWrites.at(-1).split("\n").length, 2, "both attachments, one per line");

/* ------------------------------------------------------------------ *
 * file preview                                                        *
 * ------------------------------------------------------------------ */

pressRow(rows, "Preview file contents");
await new Promise((r) => setTimeout(r, 120));
await flush();

assert.equal(fetchCalls.length, 1, "only the text attachment should be fetched");
assert.equal(fetchCalls[0].url, message.attachments[0].url, "the .png must be skipped");
assert.equal(
  fetchCalls[0].options.headers.Range,
  "bytes=0-199999",
  "a 40 MB log must be range-requested, not downloaded"
);

resetHooks();
const hostElement = walk(new ErrorBoundary().render(), (n) => typeof n.type === "function");
assert.ok(hostElement, "the viewer host should be in the app tree");

/**
 * The host elects an owner, then renders the modal component itself. Each fake
 * render is a fresh instance, so the previous one is unmounted first - otherwise
 * it still holds ownership and the new one correctly draws nothing.
 */
function renderViewer() {
  pendingCleanups.splice(0).forEach((fn) => fn());
  resetHooks();
  const hosted = hostElement.type();
  if (!hosted) return null;
  assert.equal(typeof hosted.type, "function", "the host should render the viewer component");
  resetHooks();
  return hosted.type();
}

const modal = walk(renderViewer(), (n) => n.type === "Modal");
assert.ok(modal, "the viewer is a modal");
assert.equal(modal.props.visible, true, "and it should be open after a preview");
const viewerText = textOf(modal);
assert.ok(viewerText.includes("server.log"), "titled with the filename");
assert.ok(viewerText.includes("2026-10-21 crash"), "and showing the file contents");

// Copy from the viewer, then close it.
const copyButton = walkAll(modal, (n) => typeof n.props?.onPress === "function").find((n) =>
  textOf(n).includes("Copy")
);
copyButton.props.onPress();
assert.ok(clipboardWrites.at(-1).includes("boot"), "the viewer's copy button takes the body");

const closeButton = walkAll(modal, (n) => typeof n.props?.onPress === "function").find((n) =>
  textOf(n).includes("Close")
);
closeButton.props.onPress();
assert.equal(walk(renderViewer(), (n) => n.type === "Modal").props.visible, false, "closing hides it");

// Only one host may draw the viewer, however many boundaries Discord mounts.
renderViewer();
resetHooks();
assert.equal(hostElement.type(), null, "a second host must render nothing while the first is mounted");
pendingCleanups.splice(0).forEach((fn) => fn());

/* ---- the crash screen is left alone ---- */

const crashing = new ErrorBoundary();
crashing.state = { error: new Error("render blew up") };
assert.deepEqual(crashing.render(), { type: "App", props: {}, children: [] }, "no overlay over a crash report");

/* ------------------------------------------------------------------ *
 * archive of deletes and edits                                        *
 * ------------------------------------------------------------------ */

FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: "chan", id: message.id });
assert.equal(tb.archive.length, 1, "a delete should be archived");
assert.equal(tb.archive[0].kind, "delete");
assert.ok(tb.archive[0].content.includes("look at this"), "with the body the store still had");
assert.equal(tb.archive[0].author, "Larpbase");
assert.deepEqual(tb.archive[0].attachments, ["server.log", "shot.png"]);
assert.equal(dispatched.at(-1).type, "MESSAGE_DELETE", "and the dispatch must still reach Discord");

FluxDispatcher.dispatch({
  type: "MESSAGE_UPDATE",
  message: { id: plainMessage.id, channel_id: "chan", content: "edited text" }
});
assert.equal(tb.archive.length, 2, "an edit should be archived");
assert.equal(tb.archive[0].before, "just text");
assert.equal(tb.archive[0].after, "edited text");

FluxDispatcher.dispatch({
  type: "MESSAGE_UPDATE",
  message: { id: plainMessage.id, channel_id: "chan", content: "just text" }
});
assert.equal(tb.archive.length, 2, "an embed-resolution update is not an edit");

FluxDispatcher.dispatch({ type: "TYPING_START", channelId: "chan" });
assert.equal(tb.archive.length, 2, "unrelated events are ignored");

/* ------------------------------------------------------------------ *
 * slash commands                                                      *
 * ------------------------------------------------------------------ */

assert.deepEqual(
  registeredCommands.map((c) => c.name),
  ["embed", "preview"],
  "both commands should register"
);
assert.equal(registeredCommands[0].applicationId, "-1", "built-in commands carry the sentinel app id");

registeredCommands[0].execute([], { channel: { id: "chan" } });
assert.ok(clipboardWrites.at(-1).includes("Embed title"), "/embed copies the newest embed in the channel");

/* ------------------------------------------------------------------ *
 * every tab renders                                                   *
 * ------------------------------------------------------------------ */

const tabs = {
  Features: {},
  Grab: {},
  Archive: {},
  Status: {}
};
for (const [tab, extra] of Object.entries(tabs)) {
  resetHooks({ 0: tab, ...extra });
  const tree = plugin.settings();
  assert.equal(tree.type, "ScrollView", `${tab} tab should render`);
  const text = textOf(tree);
  assert.ok(text.includes(tab), `${tab} tab should be selectable`);
}

// Features: a toggle writes through to storage.
resetHooks({ 0: "Features" });
const featureTree = plugin.settings();
const jsonSwitch = walkAll(featureTree, (n) => n.type === "Switch").length;
assert.ok(jsonSwitch >= 20, "every feature and behaviour switch should be listed");

// Grab: the channel's messages, then one message's actions.
resetHooks({ 0: "Grab" });
const grabTree = plugin.settings();
assert.ok(textOf(grabTree).includes("Larpbase"), "the Grab tab lists what the store has");

resetHooks({ 0: "Grab", 2: message.id });
const grabDetail = plugin.settings();
const grabText = textOf(grabDetail);
assert.ok(grabText.includes("Copy embed content"), "and offers the same actions without any patch");
assert.ok(grabText.includes("server.log") || grabText.includes("attachment"), "with a description of the message");

// Archive: entries are listed and copyable.
resetHooks({ 0: "Archive" });
const archiveTree = plugin.settings();
const archiveText = textOf(archiveTree);
assert.ok(archiveText.includes("DELETE") && archiveText.includes("EDIT"), "both kinds show up");
assert.ok(archiveText.includes("look at this"), "with the recovered text");

const copyAll = walkAll(archiveTree, (n) => typeof n.props?.onPress === "function").find((n) =>
  textOf(n).includes("Copy all")
);
copyAll.props.onPress();
assert.ok(clipboardWrites.at(-1).includes("delete"), "copy all writes the whole archive out");

// Status: honest about what resolved.
resetHooks({ 0: "Status" });
const statusText = textOf(plugin.settings());
assert.ok(statusText.includes("persistent"), "storage state is reported");
assert.ok(statusText.includes("mounted"), "viewer state is reported");
assert.ok(!statusText.includes("missing"), "every fake module should have resolved");

/* ------------------------------------------------------------------ *
 * silent typing, off by default and switchable                        *
 * ------------------------------------------------------------------ */

const pristineStartTyping = Typing.startTyping;
Typing.startTyping("chan");
assert.equal(typingCalls.length, 1, "typing is sent while the feature is off");

plugin.onUnload();
pluginStorage.silentTyping = true;
plugin.onLoad();
assert.notEqual(Typing.startTyping, pristineStartTyping, "enabling it should patch startTyping");
Typing.startTyping("chan");
assert.equal(typingCalls.length, 1, "and then swallow the call");
assert.equal(globalThis.__toolbox.state().typing, "typing suppressed");

/* ------------------------------------------------------------------ *
 * teardown                                                            *
 * ------------------------------------------------------------------ */

plugin.onUnload();
assert.equal(Typing.startTyping, pristineStartTyping, "startTyping restored");
assert.equal(ErrorBoundary.prototype.render, pristineBoundaryRender, "ErrorBoundary unpatched");
assert.equal(registeredCommands.length, 0, "commands unregistered");
assert.equal(globalThis.__toolbox, undefined, "internals bridge removed");

const unpatchedSheet = { default: () => React.createElement("View", null, [React.createElement("View", { label: "Reply" })]) };
ActionSheet.openLazy(Promise.resolve(unpatchedSheet), "MessageLongPressActionSheet", { message });
await flush();
resetHooks();
assert.equal(
  walk(unpatchedSheet.default({}), (n) => typeof n.type === "function"),
  null,
  "no rows injected after unload"
);

pendingCleanups.forEach((fn) => fn());
realLog(
  `all toolbox smoke tests passed (${clipboardWrites.length} clipboard writes, ${fetchCalls.length} range request, 4 tabs, 2 commands)`
);
