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

// Shaped like the real one: an ES5 constructor, so a plugin can inherit from it
// with Component.call(this, props) the way every ES5 React class does.
function Component(props) {
  this.props = props;
}
Component.prototype.isReactComponent = {};
Component.prototype.setState = function (next) {
  this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
};

const React = {
  version: "18.2.0",
  Fragment: "Fragment",
  Component,
  // Shaped like the real one: children arrive as variadic arguments and end up
  // on props too, which is where a class component reads them from.
  createElement: (type, props, ...children) => {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged, children };
  },
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
  Image: "Image",
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

function FormRowComponent(props) {
  return React.createElement("View", props);
}
FormRowComponent.Icon = function Icon() {
  return null;
};
const FormRowModule = { FormRow: FormRowComponent };

/** RowManager.generate is where a mobile message row is built. */
class RowManager {
  generate(data) {
    return { type: 1, message: { ...data, content: [{ type: "text", content: data.content ?? "" }] } };
  }
}
const pristineGenerate = RowManager.prototype.generate;

/** Discord's file card, under a name this plugin deliberately never looks for. */
function FileCard(props) {
  return React.createElement("View", { file: props.attachment.filename });
}

// The modern JSX factory. Elements are built by hand so that hooking jsx and
// hooking createElement can be tested apart from each other.
const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props ?? {}, children: [] }),
  jsxs: (type, props) => ({ type, props: props ?? {}, children: [] })
};
const pristineJsx = jsxRuntime.jsx;
const pristineCreateElement = React.createElement;

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

const propsCandidates = [ActionSheet, FluxDispatcher, FormRowModule, jsxRuntime];
const storesByName = { MessageStore, ChannelStore, SelectedChannelStore, UserStore };

const assetRegistry = {
  ic_message_copy: 42,
  ic_chevron_small_down: 99,
  ic_link_24px: 7,
  ic_code_24px: 8,
  ic_person_24px: 9,
  ic_emoji_24px: 10,
  ic_clock_24px: 11,
  ic_file_text_24px: 12,
  ic_eye_24px: 13,
  ic_hashtag_24px: 14,
  ic_link_24px_light: 77,
  img_emoji_picker_background: 78
};

const registeredCommands = [];

const pluginStorage = {};
const vendettaForPlugins = {
  patcher: { before, after, instead },
  metro: {
    findByProps: (...props) => propsCandidates.find((c) => props.every((p) => p in c)),
    findByStoreName: (name) => storesByName[name],
    findByName: (name, defaultExport = true) => {
      if (name === "ErrorBoundary") return ErrorBoundary;
      if (name === "RowManager") return defaultExport === false ? { default: RowManager } : RowManager;
      return undefined;
    },
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
    // Only two of the names the plugin guesses exist in this build; everything
    // else has to be found by searching the registry, the way a real client
    // forces it to after Discord renames an asset.
    assets: {
      all: assetRegistry,
      getAssetIDByName: (name) => assetRegistry[name]
    }
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
assert.equal(tb.state().dispatch, "watching edits", "edits are archived by default");
assert.equal(tb.state().chat, "marking edits in chat", "and marked where they were sent");
assert.equal(tb.state().rowStyle, "discord", "rows use Discord's own component by default");
assert.equal(tb.state().files, "watching jsx, jsxs, createElement", "every element factory is hooked");
assert.equal(tb.state().icons, "13/13", "every row should end up with an icon");
assert.ok(tb.state().sheet.indexOf("armed") !== -1, "the action sheet hook should be armed");
assert.notEqual(RowManager.prototype.generate, pristineGenerate, "RowManager should be patched");

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

function renderRows() {
  resetHooks();
  return rowBlock.type(rowBlock.props);
}

/** A row is Discord's component (label in props) or ours (label as text). */
function rowLabels(tree) {
  return walkAll(tree, (n) => typeof n.props?.onPress === "function").map(
    (n) => n.props.label ?? textOf(n).split(" | ")[0]
  );
}

const EXPECTED_ROWS = [
  "Copy embed content",
  "View embed content",
  "Preview file contents",
  "Copy file URL",
  "Copy message text",
  "Copy code blocks",
  "Copy IDs",
  "Copy message link",
  "Copy sticker / emoji URL"
];

/* ---- by default the rows are Discord's own, behind an error boundary ---- */

const guarded = renderRows();
assert.equal(guarded.type.displayName, "ToolboxGuard", "native rows should be wrapped in a boundary");
const nativeRows = guarded.children.flat(4).filter((n) => n && typeof n === "object");
assert.ok(
  nativeRows.every((n) => n.type === FormRowComponent),
  "every row should be Discord's own row component"
);
assert.deepEqual(nativeRows.map((n) => n.props.label), EXPECTED_ROWS, "with our labels on it");
assert.ok(
  nativeRows.every((n) => n.props.leading?.type === FormRowComponent.Icon),
  "every row should carry Discord's icon component"
);
assert.ok(
  nativeRows.every((n) => typeof n.props.leading.props.source === "number"),
  "each pointing at a real asset id"
);

const iconFor = (label) => nativeRows.find((n) => n.props.label === label).props.leading.props.source;
assert.equal(iconFor("Copy embed content"), 42, "an exact name hit uses that asset");
assert.equal(iconFor("Copy file URL"), 7, "a renamed one is found by searching the registry");
assert.equal(iconFor("Copy code blocks"), 8);
assert.equal(iconFor("Copy IDs"), 14);
assert.equal(iconFor("Copy sticker / emoji URL"), 10, "and the picker background is not an icon");
assert.equal(iconFor("Preview file contents"), 12);
assert.notEqual(iconFor("Copy message link"), 77, "a themed variant loses to the plain one");
assert.ok(
  !nativeRows.some((n) => n.props.label === "Copy message JSON"),
  "a disabled feature must not render a row"
);

/* ---- if Discord's component throws, the boundary swaps in ours ---- */

const GuardClass = guarded.type;
const guardInstance = new GuardClass(guarded.props);
assert.equal(guardInstance.render(), guarded.props.children, "a healthy boundary renders the native rows");
guardInstance.componentDidCatch(new Error("bad prop"));
guardInstance.state = GuardClass.getDerivedStateFromError();
assert.equal(guardInstance.render(), guarded.props.fallback, "a broken one renders our rows instead");
assert.equal(globalThis.__toolbox.state().rowStyle, "drawn (native threw)", "and it is remembered");

const rows = renderRows();
assert.equal(rows.type, "View", "after that failure the rows are drawn directly");
assert.deepEqual(rowLabels(rows), EXPECTED_ROWS, "with the same actions");
assert.equal(
  walkAll(rows, (n) => n.type === "Image").length,
  EXPECTED_ROWS.length,
  "and the rows we draw carry the same icons"
);

/* ---- pressing a row ---- */

function pressRow(tree, label) {
  const hit = walkAll(tree, (n) => typeof n.props?.onPress === "function").find(
    (n) => (n.props.label ?? textOf(n)).includes(label)
  );
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
 * the arrow on a text attachment                                      *
 * ------------------------------------------------------------------ */

const textAttachment = message.attachments[0];
const imageAttachment = message.attachments[1];

// The plugin never looks the file card up by name; it watches the JSX factory.
const wrapped = jsxRuntime.jsx(FileCard, { attachment: textAttachment });
assert.equal(wrapped.type, "Fragment", "a text attachment should be wrapped, not replaced");
const card = walk(wrapped, (n) => n.type === FileCard);
assert.ok(card, "Discord's own file card must still be in there");
assert.equal(card.props.attachment, textAttachment, "with its props untouched");
assert.equal(card.props.file, undefined, "and unrendered, exactly as the factory returned it");

const expanderElement = walk(wrapped, (n) => typeof n.type === "function" && n.props?.att);
assert.ok(expanderElement, "and the expander appended under it");

/* ---- one arrow per render pass, not one per nested component ---- */

assert.equal(
  jsxRuntime.jsx(FileCard, { attachment: textAttachment }).type,
  FileCard,
  "an inner component rendering the same attachment must not add a second arrow"
);
await new Promise((r) => setTimeout(r, 170));
assert.equal(
  jsxRuntime.jsx(FileCard, { attachment: textAttachment }).type,
  "Fragment",
  "but the next render pass gets one again"
);

assert.equal(
  jsxRuntime.jsx(FileCard, { attachment: imageAttachment }).type,
  FileCard,
  "an image attachment is left alone - there is nothing to read"
);

// Builds compiled against the classic runtime go through createElement instead.
await new Promise((r) => setTimeout(r, 170));
assert.equal(
  React.createElement(FileCard, { attachment: textAttachment }).type,
  "Fragment",
  "the classic factory is hooked too"
);

/* ---- the expander itself ---- */

const fetchesBefore = fetchCalls.length;
resetHooks();
const collapsed = expanderElement.type(expanderElement.props);
assert.ok(textOf(collapsed).includes("Preview contents"), "collapsed, it offers to open");
const arrow = walk(collapsed, (n) => n.type === "Image");
assert.ok(arrow, "the arrow should be Discord's own asset");
assert.equal(arrow.props.source, 99);
assert.deepEqual(arrow.props.style.transform, [{ rotate: "0deg" }], "pointing down while closed");

// Tapping it reads the file, over a byte range like everything else here.
walk(collapsed, (n) => typeof n.props?.onPress === "function").props.onPress();
await flush();
assert.equal(fetchCalls.length, fetchesBefore + 1, "opening it fetches the file");
assert.equal(fetchCalls.at(-1).options.headers.Range, "bytes=0-199999");

resetHooks({ 0: true, 1: "line one\nline two" });
const expanded = expanderElement.type(expanderElement.props);
const expandedText = textOf(expanded);
assert.ok(expandedText.includes("line one"), "open, it shows the contents inline");
assert.ok(expandedText.includes("Hide contents"), "and offers to close again");
assert.deepEqual(
  walk(expanded, (n) => n.type === "Image").props.style.transform,
  [{ rotate: "180deg" }],
  "with the arrow flipped, like desktop"
);
const expanderCopy = walkAll(expanded, (n) => typeof n.props?.onPress === "function").find((n) =>
  textOf(n).includes("Copy")
);
expanderCopy.props.onPress();
assert.equal(clipboardWrites.at(-1), "line one\nline two", "copying from the expander");

/* ------------------------------------------------------------------ *
 * edits keep their old text                                           *
 * ------------------------------------------------------------------ */

FluxDispatcher.dispatch({
  type: "MESSAGE_UPDATE",
  message: { id: plainMessage.id, channel_id: "chan", content: "edited text" }
});
assert.equal(dispatched.at(-1).type, "MESSAGE_UPDATE", "an edit is always passed through to Discord");
assert.equal(tb.archive.length, 1, "and archived");
assert.equal(tb.archive[0].kind, "edit");
assert.equal(tb.archive[0].before, "just text");
assert.equal(tb.archive[0].after, "edited text");
assert.equal(tb.archive[0].author, "someone");

// The row it generates carries the version from before the edit.
const manager = new RowManager();
const editedRow = manager.generate({ id: plainMessage.id, channel_id: "chan", content: "edited text" });
assert.ok(
  editedRow.message.content.some((node) => String(node.content).includes("before edit: just text")),
  "the previous version shows under the edited message"
);

const untouchedRow = manager.generate({ id: "9999", channel_id: "chan", content: "fine" });
assert.deepEqual(
  untouchedRow.message.content,
  [{ type: "text", content: "fine" }],
  "an ordinary message is left alone"
);

FluxDispatcher.dispatch({
  type: "MESSAGE_UPDATE",
  message: { id: plainMessage.id, channel_id: "chan", content: "just text" }
});
assert.equal(tb.archive.length, 1, "an embed-resolution update is not an edit");

FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: "chan", id: message.id });
assert.equal(dispatched.at(-1).type, "MESSAGE_DELETE", "a delete is none of this plugin's business");
assert.equal(tb.archive.length, 1, "and is not archived");

FluxDispatcher.dispatch({ type: "TYPING_START", channelId: "chan" });
assert.equal(tb.archive.length, 1, "unrelated events are ignored");
assert.equal(dispatched.at(-1).type, "TYPING_START", "and passed straight through");

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
assert.equal(
  walkAll(featureTree, (n) => n.type === "Switch").length,
  11 + 7 + 3,
  "every feature, behaviour and extra switch should be listed"
);

// Grab: the channel's messages, then one message's actions.
resetHooks({ 0: "Grab" });
const grabTree = plugin.settings();
assert.ok(textOf(grabTree).includes("Larpbase"), "the Grab tab lists what the store has");

resetHooks({ 0: "Grab", 2: message.id });
const grabDetail = plugin.settings();
const grabText = textOf(grabDetail);
assert.ok(grabText.includes("Copy embed content"), "and offers the same actions without any patch");
assert.ok(grabText.includes("server.log") || grabText.includes("attachment"), "with a description of the message");

// Archive: the edit is listed, with both versions, and copyable.
resetHooks({ 0: "Archive" });
const archiveTree = plugin.settings();
const archiveText = textOf(archiveTree);
assert.ok(archiveText.includes("edited"), "the entry is marked as an edit");
assert.ok(archiveText.includes("just text"), "with the text from before");
assert.ok(archiveText.includes("edited text"), "and the text after");

const copyAll = walkAll(archiveTree, (n) => typeof n.props?.onPress === "function").find((n) =>
  textOf(n).includes("Copy all")
);
copyAll.props.onPress();
assert.ok(clipboardWrites.at(-1).includes("just text"), "copy all writes the whole archive out");

// Status: honest about what resolved.
resetHooks({ 0: "Status" });
const statusText = textOf(plugin.settings());
assert.ok(statusText.includes("persistent"), "storage state is reported");
assert.ok(statusText.includes("mounted"), "viewer state is reported");
assert.ok(!statusText.includes("missing"), "every fake module should have resolved");

/* ------------------------------------------------------------------ *
 * switching the file arrow off releases the factories                 *
 * ------------------------------------------------------------------ */

plugin.onUnload();
assert.equal(jsxRuntime.jsx, pristineJsx, "jsx is handed back on unload");
assert.equal(React.createElement, pristineCreateElement, "so is createElement");

pluginStorage.inlineFiles = false;
plugin.onLoad();
assert.equal(globalThis.__toolbox.state().files, "off", "with the arrow off, nothing is hooked");
assert.equal(jsxRuntime.jsx, pristineJsx, "and the factory is left alone");
assert.equal(
  jsxRuntime.jsx(FileCard, { attachment: textAttachment }).type,
  FileCard,
  "so a text attachment renders exactly as Discord built it"
);

/* ------------------------------------------------------------------ *
 * teardown                                                            *
 * ------------------------------------------------------------------ */

plugin.onUnload();
assert.equal(ErrorBoundary.prototype.render, pristineBoundaryRender, "ErrorBoundary unpatched");
assert.equal(RowManager.prototype.generate, pristineGenerate, "RowManager unpatched");
assert.equal(registeredCommands.length, 0, "commands unregistered");
assert.equal(globalThis.__toolbox, undefined, "internals bridge removed");

const afterUnload = new RowManager().generate({ id: plainMessage.id, channel_id: "chan", content: "edited text" });
assert.deepEqual(
  afterUnload.message.content,
  [{ type: "text", content: "edited text" }],
  "and nothing is marked any more"
);

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
  "all toolbox smoke tests passed " +
    `(${clipboardWrites.length} clipboard writes, ${fetchCalls.length} range requests, 13 icons resolved, ` +
    "native rows + fallback, jsx-hooked file arrow, edit marking, 4 tabs, 2 commands)"
);
