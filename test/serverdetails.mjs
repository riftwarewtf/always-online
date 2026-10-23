/**
 * Smoke test for the built ServerDetails bundle.
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
 * The guild stores below are stand-ins shaped like the real ones, including the
 * owner who is not in the cache until someone asks for the profile.
 *
 *   node build.mjs && node test/serverdetails.mjs
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const code = await readFile(join(root, "ServerDetails", "index.js"), "utf8");

const realLog = console.log.bind(console);
const logged = [];
globalThis.console = { ...console, log: (...a) => logged.push(a) };

const flush = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------------ *
 * fake react + react native                                           *
 * ------------------------------------------------------------------ */

let hookIndex = 0;
let hookValues = {};

function resetHooks(values = {}) {
  hookIndex = 0;
  hookValues = values;
}

const pendingCleanups = [];

function Component(props) {
  this.props = props;
}
Component.prototype.isReactComponent = {};
Component.prototype.setState = function () {};

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
    return [value, () => {}];
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
  useColorScheme: () => "dark",
  StyleSheet: { create: (s) => s },
  AppState: {}
};

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
 * fake guild stores                                                   *
 * ------------------------------------------------------------------ */

const guild = {
  id: "41771983423143937", // a 2015 snowflake
  name: "Larpbase's Lab",
  icon: "a_9f1e2c",
  ownerId: "owner1",
  joinedAt: "2023-04-01T12:30:00.000Z",
  premiumSubscriberCount: 14,
  preferredLocale: "en-US",
  premiumTier: 2,
  verificationLevel: 3,
  vanityURLCode: "lab",
  description: "where the macros live"
};

const otherGuild = {
  id: "899999999999999999",
  name: "Another Server",
  icon: null,
  ownerId: "owner2",
  joinedAt: "2024-01-15T08:00:00.000Z",
  premiumSubscriberCount: 0,
  preferredLocale: "de"
};

const guilds = { [guild.id]: guild, [otherGuild.id]: otherGuild };

const GuildStore = {
  getName: () => "GuildStore",
  getGuild: (id) => guilds[id] || null,
  getGuilds: () => guilds
};

const GuildChannelStore = {
  getName: () => "GuildChannelStore",
  getChannels: (id) =>
    id === guild.id
      ? {
          1: [{ channel: { id: "c1", type: 0 } }, { channel: { id: "c2", type: 0 } }],
          2: [{ channel: { id: "c3", type: 2 } }],
          4: [{ channel: { id: "cat", type: 4 } }],
          SELECTABLE: [{ channel: { id: "c1", type: 0 } }]
        }
      : {}
};

const GuildRoleStore = {
  getName: () => "GuildRoleStore",
  // The first one is everyone's own role, which shares the guild's id.
  getSortedRoles: (id) =>
    id === guild.id ? [{ id: guild.id }, { id: "r1" }, { id: "r2" }, { id: "r3" }] : []
};

const GuildMemberCountStore = {
  getName: () => "GuildMemberCountStore",
  getMemberCount: (id) => (id === guild.id ? 12345 : 0)
};

const ChannelStore = { getName: () => "ChannelStore", getMutableGuildChannels: () => ({}) };
const SelectedGuildStore = { getName: () => "SelectedGuildStore", getGuildId: () => guild.id };

const owner = { id: "owner1", username: "larpbase", globalName: "Larpbase" };
let ownerCached = false;
const UserStore = {
  getName: () => "UserStore",
  getUser: (id) => (id === owner.id && ownerCached ? owner : undefined)
};

const profileFetches = [];
const ProfileActions = {
  fetchProfile: (id) => {
    profileFetches.push(id);
    ownerCached = true;
    return Promise.resolve();
  }
};

let sheetHidden = 0;
const ActionSheet = {
  openLazy: () => {},
  hideActionSheet: () => {
    sheetHidden++;
  }
};

function FormRowComponent(props) {
  return React.createElement("View", props);
}
FormRowComponent.Icon = function Icon() {
  return null;
};
const FormRowModule = { FormRow: FormRowComponent };

// What the server sheet in current builds is actually made of: rows inside
// rounded group cards - "Mark As Read", "Permissions".
function TableRow(props) {
  return React.createElement("View", props);
}
TableRow.Icon = function TableRowIcon() {
  return null;
};
function TableRowGroup(props) {
  return React.createElement("View", props);
}
const TableModule = { TableRow, TableRowGroup };

// The round buttons across the top of that sheet: pressable, but not rows.
function CircleButton(props) {
  return React.createElement("View", props);
}

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

// Only one of the names the plugin guesses exists here; the rest of the icon
// has to be found by searching the registry.
const assetRegistry = { ic_info_24px: 21, ic_guild_24px: 22, img_guild_banner: 23 };

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

const propsCandidates = [ActionSheet, TableModule, FormRowModule, ProfileActions];
const storesByName = {
  GuildStore,
  GuildChannelStore,
  GuildRoleStore,
  GuildMemberCountStore,
  ChannelStore,
  SelectedGuildStore,
  UserStore
};

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
      clipboard: { setString: (s) => clipboardWrites.push(s), getString: () => "" }
    }
  },
  plugin: { id: "serverdetails", manifest: { name: "ServerDetails" }, storage: pluginStorage },
  ui: {
    toasts: { showToast: (text) => toasts.push(text) },
    assets: { all: assetRegistry, getAssetIDByName: (name) => assetRegistry[name] }
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
const sd = globalThis.__serverdetails;
assert.ok(sd, "the internals bridge should be exposed on load");

/* ---- settings land in the injected storage, not a throwaway object ---- */

assert.equal(pluginStorage.icon, true, "defaults must be written into the persistent storage");
assert.equal(pluginStorage.owner, true);
assert.equal(pluginStorage.serverId, false, "the extras stay off until asked for");
assert.equal(sd.state().persistent, true, "the injected storage must be the one in use");
assert.equal(sd.state().panel, "mounted", "the panel host should be mounted");
assert.equal(sd.state().icon, "resolved", "the row icon should resolve");
assert.equal(sd.state().row, "TableRow", "and Discord's table row is what the sheet is built from");
assert.equal(sd.state().servers, 2);
assert.ok(sd.state().sheet.indexOf("armed") !== -1, "the sheet hook should be armed");
assert.notEqual(ErrorBoundary.prototype.render, pristineBoundaryRender, "ErrorBoundary should be patched");

/* ------------------------------------------------------------------ *
 * the details themselves                                              *
 * ------------------------------------------------------------------ */

const byLabel = (rows) => Object.fromEntries(rows.map((r) => [r.label, r.value]));

// The owner is not in the cache yet, so the first read says so and asks for it.
let rows = byLabel(sd.rows(guild.id));
assert.equal(rows["Server owner"], "owner1 (not cached)", "an uncached owner is named by id, not invented");
assert.deepEqual(profileFetches, ["owner1"], "and their profile is requested once");

await flush();
rows = byLabel(sd.rows(guild.id));
assert.equal(rows["Server owner"], "Larpbase (larpbase)", "once cached, both names are shown");

assert.ok(rows["Creation date"].startsWith("2015-"), "the creation date comes out of the snowflake");
assert.ok(rows["Creation date"].includes("ago"), "with its age beside it");
assert.ok(rows["Join date"].startsWith("2023-04-01"), "the join date is parsed from the record");
assert.equal(rows["Members"], "12,345", "member counts are grouped");
assert.equal(rows["Channels"], "3", "categories are not counted as channels");
assert.equal(rows["Roles"], "3", "and everyone's own role is not counted");
assert.equal(rows["Boosts"], "14");
assert.equal(rows["Language"], "English, US (en-US)", "locale codes are spelled out");
assert.equal(rows["Server ID"], undefined, "an item that is switched off is absent");

assert.equal(
  sd.icon(guild.id, 512),
  "https://cdn.discordapp.com/icons/41771983423143937/a_9f1e2c.gif?size=512",
  "an animated icon hash asks for the gif"
);
assert.ok(sd.icon(otherGuild.id) === null, "a server with no icon has no url");

// Switching an item on adds it; switching one off takes it away.
pluginStorage.serverId = true;
pluginStorage.vanity = true;
pluginStorage.boosts = false;
rows = byLabel(sd.rows(guild.id));
assert.equal(rows["Server ID"], guild.id);
assert.equal(rows["Vanity invite"], "discord.gg/lab");
assert.equal(rows["Boosts"], undefined, "a switched-off item disappears");
pluginStorage.boosts = true;
pluginStorage.serverId = false;
pluginStorage.vanity = false;

const report = sd.report(guild.id);
assert.ok(report.startsWith("Larpbase's Lab"), "the copyable report is titled with the server");
for (const label of ["Server owner", "Creation date", "Members", "Channels", "Roles", "Language"]) {
  assert.ok(report.includes(label + ":"), `the report should carry ${label}`);
}

/* ------------------------------------------------------------------ *
 * the row in a server's sheet                                         *
 * ------------------------------------------------------------------ */

const row = (label) => React.createElement(TableRow, { label, onPress() {} });

/** Shaped like the real server sheet: a header, round buttons, then cards. */
function buildServerSheet() {
  const content = [
    React.createElement("View", { key: "header" }, "Discord Town Hall"),
    React.createElement("View", { key: "circles" }, [
      React.createElement(CircleButton, { key: "b", onPress() {} }),
      React.createElement(CircleButton, { key: "i", onPress() {} }),
      React.createElement(CircleButton, { key: "n", onPress() {} })
    ]),
    React.createElement(TableRowGroup, { key: "g1" }, [row("Mark As Read"), row("Channels & Roles")]),
    React.createElement(TableRowGroup, { key: "g2" }, [row("Permissions")])
  ];
  return { content, module: { default: () => React.createElement("ScrollView", null, content) } };
}

/* ---- sheets that are not about a server are left alone ---- */

const messageSheet = { default: () => React.createElement("View", null, []) };
const pristineMessageSheet = messageSheet.default;
// A guild rides along in the message sheet's props; it is still not ours.
ActionSheet.openLazy(Promise.resolve(messageSheet), "MessageLongPressActionSheet", { guild, message: {} });
await flush();
assert.equal(messageSheet.default, pristineMessageSheet, "the message sheet belongs to Toolbox, not this");
assert.equal(sd.state().keys.length, 0, "and is not counted as a server sheet");
assert.ok(sd.state().seen.includes("MessageLongPressActionSheet"), "but it is still recorded for Status");

/* ---- the server sheet gets a card at the end ---- */

const sheet = buildServerSheet();
ActionSheet.openLazy(Promise.resolve(sheet.module), "GuildProfileActionSheet", { guild });
await flush();
assert.deepEqual(sd.state().keys, ["GuildProfileActionSheet"], "the server sheet is matched and recorded");

resetHooks();
sheet.module.default({ guild });
assert.equal(sd.state().strategy, "card at the end", "a card belongs beside the other cards");
assert.equal(sheet.content.length, 5, "appended after the last group");

const rowBlock = sheet.content[4];
assert.equal(rowBlock.props.mode, "card");

resetHooks();
const rendered = rowBlock.type(rowBlock.props);
assert.equal(rendered.type.displayName, "ServerDetailsGuard", "the native row sits behind a boundary");

const group = rendered.props.children;
assert.equal(group.type, TableRowGroup, "wrapped in Discord's group card, so it has a background");
const nativeRow = group.props.children;
assert.equal(nativeRow.type, TableRow, "and is Discord's own table row");
assert.equal(nativeRow.props.label, "Server Info");
assert.equal(nativeRow.props.icon.props.source, 21, "with an icon out of the registry");

/* ---- an older, flat sheet gets a plain row instead ---- */

const flatRows = [
  React.createElement(FormRowComponent, { key: "invite", label: "Invite people", onPress() {} }),
  React.createElement(FormRowComponent, { key: "mute", label: "Mute server", onPress() {} })
];
const flatSheet = { default: () => React.createElement("View", null, flatRows) };
// No guild in the props at all: the open server is used.
ActionSheet.openLazy(Promise.resolve(flatSheet), "GuildLongPressActionSheet", {});
await flush();
resetHooks();
flatSheet.default({});
assert.equal(sd.state().strategy, "row list", "a flat sheet takes a plain row");
assert.equal(flatRows.length, 3, "appended after Discord's own rows");
assert.equal(flatRows[2].props.mode, "row");
assert.equal(flatRows[2].props.guildId, guild.id, "falling back to the server that is open");

/* ---- if Discord's component throws, ours is drawn instead ---- */

const GuardClass = rendered.type;
const guardInstance = new GuardClass(rendered.props);
assert.equal(guardInstance.render(), rendered.props.children, "a healthy boundary renders the native card");
guardInstance.componentDidCatch(new Error("bad prop"));
guardInstance.state = GuardClass.getDerivedStateFromError();
assert.equal(guardInstance.render(), rendered.props.fallback, "a broken one renders ours");
assert.equal(sd.state().rowStyle, "drawn (native threw)", "and it is remembered");

resetHooks();
const drawn = rowBlock.type(rowBlock.props);
assert.ok(textOf(drawn).includes("Server Info"), "the drawn card carries the same label");
assert.equal(walk(drawn, (n) => n.type === "Image").props.source, 21, "and the same icon");
assert.equal(drawn.props.style.borderRadius, 16, "styled as a card, like the ones around it");

/* ---- pressing it opens the panel ---- */

const hiddenBefore = sheetHidden;
walk(drawn, (n) => typeof n.props?.onPress === "function").props.onPress();
assert.equal(sheetHidden, hiddenBefore + 1, "the sheet is dismissed first");
await new Promise((r) => setTimeout(r, 120));

resetHooks();
const hostElement = walk(new ErrorBoundary().render(), (n) => typeof n.type === "function");
assert.ok(hostElement, "the panel host should be in the app tree");

/**
 * The host elects an owner, then renders the panel itself. Each fake render is a
 * fresh instance, so the previous one is unmounted first - otherwise it still
 * holds ownership and the new one correctly draws nothing.
 */
function renderPanel() {
  pendingCleanups.splice(0).forEach((fn) => fn());
  resetHooks();
  const hosted = hostElement.type();
  if (!hosted) return null;
  assert.equal(typeof hosted.type, "function", "the host should render the panel component");
  resetHooks();
  return hosted.type();
}

const modal = walk(renderPanel(), (n) => n.type === "Modal");
assert.ok(modal, "the panel is a modal");
assert.equal(modal.props.visible, true, "open after the row was pressed");

const panelText = textOf(modal);
assert.ok(panelText.includes("Larpbase's Lab"), "titled with the server");
assert.ok(panelText.includes("Larpbase (larpbase)"), "owner");
assert.ok(panelText.includes("12,345"), "members");
assert.ok(panelText.includes("English, US (en-US)"), "language");
assert.ok(panelText.includes("Server owner") && panelText.includes("Join date"), "with labels");

const panelIcon = walk(modal, (n) => n.type === "Image");
assert.ok(panelIcon, "the icon is shown");
assert.equal(panelIcon.props.source.uri, sd.icon(guild.id, 512), "at full size");

const copyButton = walkAll(modal, (n) => typeof n.props?.onPress === "function").find((n) =>
  textOf(n).includes("Copy")
);
copyButton.props.onPress();
assert.ok(clipboardWrites.at(-1).includes("Members: 12,345"), "copying writes the whole report");

const closeButton = walkAll(modal, (n) => typeof n.props?.onPress === "function").find((n) =>
  textOf(n).includes("Close")
);
closeButton.props.onPress();
assert.equal(walk(renderPanel(), (n) => n.type === "Modal").props.visible, false, "closing hides it");

// Only one host may draw the panel, however many boundaries Discord mounts.
renderPanel();
resetHooks();
assert.equal(hostElement.type(), null, "a second host must render nothing while the first is mounted");
pendingCleanups.splice(0).forEach((fn) => fn());

// On the crash screen it stands down.
const crashing = new ErrorBoundary();
crashing.state = { error: new Error("render blew up") };
assert.deepEqual(crashing.render(), { type: "App", props: {}, children: [] }, "no panel over a crash report");

/* ------------------------------------------------------------------ *
 * settings                                                            *
 * ------------------------------------------------------------------ */

for (const tab of ["Servers", "Items", "Status"]) {
  resetHooks({ 0: tab });
  const tree = plugin.settings();
  assert.equal(tree.type, "ScrollView", `${tab} tab should render`);
  assert.ok(textOf(tree).includes(tab), `${tab} tab should be selectable`);
}

resetHooks({ 0: "Servers" });
const serversTab = plugin.settings();
const serversText = textOf(serversTab);
assert.ok(serversText.includes("Larpbase's Lab"), "every server is listed");
assert.ok(serversText.includes("Another Server"));
assert.ok(serversText.includes("12,345 members"), "with a one-line summary");
assert.ok(serversText.includes("Details for Larpbase's Lab"), "and a shortcut for the open one");

resetHooks({ 0: "Items" });
assert.equal(
  walkAll(plugin.settings(), (n) => n.type === "Switch").length,
  9 + 5 + 5,
  "nine items, five extras, five behaviour switches"
);

resetHooks({ 0: "Status" });
const statusText = textOf(plugin.settings());
assert.ok(statusText.includes("persistent"), "storage state is reported");
assert.ok(statusText.includes("GuildProfileActionSheet"), "so is the sheet key it matched");
assert.ok(statusText.includes("MessageLongPressActionSheet"), "and every key seen, for when it matches none");
assert.ok(statusText.includes("TableRow"), "and which row component it found");
assert.ok(!statusText.includes("missing"), "every fake module should have resolved");

/* ------------------------------------------------------------------ *
 * teardown                                                            *
 * ------------------------------------------------------------------ */

plugin.onUnload();
assert.equal(ErrorBoundary.prototype.render, pristineBoundaryRender, "ErrorBoundary unpatched");
assert.equal(globalThis.__serverdetails, undefined, "internals bridge removed");

const afterUnload = { default: () => React.createElement("View", null, []) };
ActionSheet.openLazy(Promise.resolve(afterUnload), "GuildProfileActionSheet", { guild });
await flush();
resetHooks();
assert.equal(
  walk(afterUnload.default({}), (n) => typeof n.type === "function"),
  null,
  "no row injected after unload"
);

pendingCleanups.forEach((fn) => fn());
realLog(
  "all serverdetails smoke tests passed " +
    `(${clipboardWrites.length} clipboard writes, 9 items verified, card + row injection, ` +
    "native row + fallback, 3 tabs)"
);
