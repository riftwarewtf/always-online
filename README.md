# Kettu Plugins

Plugins for [Kettu](https://codeberg.org/cocobo1/Kettu), laid out so GitHub Pages serves each one from its own folder. They also load on Bunny and Vendetta, since the API is resolved from whichever global is present.

## Install

Kettu takes a **folder URL** and appends `manifest.json` itself. A `github.com/...` repo link will always fail with *"Failed to fetch manifest"* — that URL serves an HTML page, not JSON.

Once Pages is enabled on this repo (Settings → Pages → Deploy from a branch → `main` → `/ (root)`):

```
https://riftwarewtf.github.io/always-online/Toolbox/
https://riftwarewtf.github.io/always-online/ServerDetails/
https://riftwarewtf.github.io/always-online/DevTools/
```

Works right now without Pages, same thing:

```
https://raw.githubusercontent.com/riftwarewtf/always-online/main/Toolbox/
https://raw.githubusercontent.com/riftwarewtf/always-online/main/ServerDetails/
https://raw.githubusercontent.com/riftwarewtf/always-online/main/DevTools/
```

Trailing slash matters.

---

## Toolbox

A message toolkit where every feature is a switch. Long press a message and the
rows appear at the bottom of Discord's own sheet; turn off the ones you do not
want and they are gone from the menu.

| Row | What it does |
| --- | --- |
| **Copy embed content** | Flattens every embed on the message into text — author, title, link, description, every field as `name: value`, footer and timestamp. The one iOS never got. |
| **View embed content** | Same text, in a scrollable viewer first. |
| **Preview file contents** | Reads a text attachment in-app. The CDN is asked for a byte range, so peeking at a 40 MB log costs 200 KB. Several text files on one message get a picker. |
| **Copy file URL** | Every attachment URL, one per line. |
| **Copy message text** | The raw markdown as it was typed, not the rendered version. |
| **Copy code blocks** | Code only, fences and language tag stripped. Falls back to inline `` `code` `` spans. |
| **Copy message JSON** | The whole message object, depth-safe and cycle-safe. Off by default. |
| **View message JSON** | Same, in the viewer. |
| **Copy IDs** | Message, channel, server and author in one block. |
| **Copy message link** | `discord.com/channels/…`, with the guild id read out of ChannelStore. |
| **Copy avatar URL** | Full size, `.gif` when the user's avatar is animated. Off by default. |
| **Copy sticker / emoji URL** | Stickers plus every custom emoji in the message text. |
| **Copy timestamp** | Exact send time, local and ISO, plus a `<t:…:f>` tag. Off by default. |

Recognising a text file goes by content type first and extension second, across
about sixty of them — logs, configs, source, diffs, subtitles, csv.

The rows are drawn with Discord's own sheet component and carry icons, so they
sit in the menu looking like everything else in it. Because a wrong prop on an
internal component would take the whole long-press menu down, they render inside
a class error boundary: if Discord's component ever throws, the boundary swaps in
rows this plugin draws itself — same labels, same icons — remembers not to try
the native ones again that session, and the Status tab says so. **Discord row
style** in settings switches between the two by hand.

### Icons

Asset names move between Discord releases, so guessing one is a coin flip.
Each row names the assets it would like, and if none of them exist in this build
the icon is found by searching the mod's own asset registry by pattern —
`/link/` for the URL rows, `/code|terminal|console/` for the code rows,
`/person|profile|avatar/` for the avatar row — scoring the matches so a plain
24px icon wins over a themed, outlined or oversized variant of the same thing.
Anything still unmatched falls back to the copy icon, so a renamed asset costs an
icon, never a row. Status reports how many resolved.

### The arrow on text files

A text attachment gets Discord's own chevron under the file card, the way the
desktop client has one. Tap it and the first chunk of the file opens inline in
the message, mono-spaced and scrollable, with a Copy button; tap again and it
folds away. The arrow rotates, the body is cached per URL so folding it back and
forth costs one request, and the same byte-range rule applies. Discord's own
tap-to-open behaviour on the file itself is untouched.

So both ways work on a file: **hold** the message for the Toolbox row, or
**tap** the arrow for it inline.

Discord's file card has no name that holds still across builds, and looking for
one is what kept the arrow from showing up at all. So it is not looked up by
name: the arrow attaches at the JSX factory instead. Both factories are hooked —
the modern `jsx`/`jsxs` runtime and the classic `React.createElement`, since
which one a build uses depends on how it was compiled — and any element created
with a text attachment in its props gets the expander appended under it,
whatever that component happens to be called. The guard is two property reads on
an object already in cache, the plugin's own elements are built through a direct
reference captured at load so nothing recurses, and one attachment passing
through several nested components in the same render pass gets exactly one arrow,
the outermost. Composer uploads are skipped — a file still being uploaded is a
local path, not something the CDN can serve a byte range from.

### Three ways to reach the same actions

Patching Discord's action sheet is the part most likely to break on a client
update, so none of it is the only path:

1. **Long-press rows** — the normal way.
2. **Settings → Grab** — lists the last 30 messages in the channel you have
   open, read straight out of MessageStore, and offers the same actions. No
   patches involved at all, so it still works when the rows do not.
3. **`/embed` and `/preview`** — act on the newest message in the channel that
   has an embed or a text attachment.

### Edits

**Show text before an edit** appends the previous version under the edited
message, through a hook on `RowManager.prototype.generate`.

**Archive** is the searchable copy: the old text read out of the store at the one
moment it still exists, kept in memory, 200 entries by default, with the before
and after of each edit, copyable one at a time or all at once. Nothing is sent
anywhere and the list clears on restart. `MESSAGE_UPDATE` also fires when an
embed resolves, which is not an edit, so entries are only made when the text
actually changed.

The dispatcher hook is a `before` — every event continues on to Discord
untouched. Nothing here stops, swallows or rewrites an event.

### Where things render

Previews and JSON dumps open in a modal mounted above the whole app, by wrapping
`ErrorBoundary.prototype.render` — the same mount point Kettu uses to take the
screen over on a crash, and the one component reliably above an action sheet.
Discord instantiates more than one boundary, so the host elects a single owner
and the others render `null`. With the viewer switched off, previews fall back to
the clipboard, and the settings page hosts its own copy of the modal so the Grab
tab still shows them.

Previews also fall back to the clipboard when there is nowhere to draw: a
preview triggered with the viewer switched off copies the file instead of
failing quietly.

### If the rows do not show up

**Status** reports every lookup and every patch by name: whether settings are
persistent, whether the sheet hook is armed, which injection strategy it used
(`row list` or the `wrapped tree` fallback), whether the rows are Discord's or
ours, how many icons resolved, which element factories the file arrow is watching,
and which modules were found. The sheet line only fills in after the first long
press, because that is when Discord loads the sheet module. Without
`RowManager`, the text from before an edit cannot be shown in the chat; the
Archive tab keeps it either way. Alongside DevTools, `[toolbox]` lines show up in
its Console tab, and `__toolbox.state()` works from its Eval tab.

```js
__toolbox.state()                    // every patch and its state
__toolbox.archive                    // edits captured so far
__toolbox.newest((c) => c.message.embeds.length > 0)
__toolbox.embedText(message, true)
```

---

## ServerDetails

A port of [DevilBro's ServerDetails](https://github.com/mwittrien/BetterDiscordAddons/tree/master/Plugins/ServerDetails/)
for BetterDiscord, which puts a server's details in the server list tooltip.

A phone has no hover and no shift key, so the trigger is the gesture that means
the same thing: **long press a server** and *Server details* appears in its
sheet. Tap it and the panel opens with the same items the original shows, each
with its own switch:

| Item | |
| --- | --- |
| **Icon** | Full size, `.gif` when the server's icon is animated, the server's acronym when it has none. |
| **Server owner** | Display name and username. Not in the cache? The profile is requested once and the panel fills itself in rather than showing a blank. |
| **Creation date** | Out of the server's own snowflake. |
| **Join date** | From the guild record, parsed whether it arrives as a string, a number or a moment-like object. |
| **Members** | From MemberCountStore, grouped — `12,345`. |
| **Channels** | Categories are not counted as channels, same as the original. Falls back to counting ChannelStore when the per-guild store is cold. |
| **Roles** | Everyone's own role shares the server's id and is not counted. |
| **Boosts** | `premiumSubscriberCount`, `0` rather than blank. |
| **Language** | The locale spelled out — `English, US (en-US)` — from a table, then `Intl.DisplayNames`, then the raw code. |

Switched off by default, because the original has no equivalent: **server ID**,
**vanity invite**, **boost tier**, **verification level** and **description**.

Dates are local, with the age beside them (`2015-05-01 14:20 (11y 4m ago)`);
**Relative ages** turns that off. **Copy** in the panel writes every visible row
out as text.

### What did not come across

Tooltip **width**, **delay**, **colour**, **show only on shift** and the date
format builder are desktop-only ideas — there is no tooltip to size or delay,
and no shift key to hold — so they are not here. The panel is a sheet-sized
modal instead, and long press is already a deliberate gesture, which is what
show-on-shift was for.

This is a reimplementation rather than a copy: BetterDiscord plugins run against
BDFDB and the desktop DOM, and neither exists in this runtime.

### Reaching it without the gesture

**Settings → Servers** lists every server you are in with a one-line summary,
and opens the same panel for any of them. It reads the stores directly and
patches nothing, so it works even if the sheet row does not.

The row goes into any sheet whose key mentions a guild, because the exact name
moves between builds; **Status** reports which key it matched, whether the row
is Discord's own component or one drawn here (there is the same class error
boundary as in Toolbox, so a wrong prop on Discord's component cannot take the
sheet down), and which stores resolved.

```js
__serverdetails.rows(guildId)        // [{label, value}] for the enabled items
__serverdetails.report(guildId)      // the same thing as copyable text
__serverdetails.open(guildId)        // open the panel
__serverdetails.state()
```

---

## DevTools

A debugging panel in the shape of Safari's Web Inspector, five tabs deep. Capture starts when the plugin loads and keeps running whether or not the panel is open, so you can trigger a bug and then go look at what happened.

**Console** — every `console.log` / `info` / `warn` / `error` / `debug` in the app, with level filters, text search, timestamps. Tap a line to expand it into a full depth-4 inspection of the logged objects, long press to copy. Uncaught errors and fatals land here tagged `crash`, and the app's own handler still runs afterwards — swallowing crashes would hide them from Discord's reporting.

**Eval** — a REPL against the live app. `api`, `metro`, `find(...props)`, `store(name)`, `common`, `React`, `ReactNative`, `storage`, `inspect(v)` and `$` (the previous result) are all in scope. Expressions return their value, multi-line code takes an explicit `return`. History is kept so you can tap a previous snippet to bring it back.

```js
store("UserStore").getCurrentUser().username
find("getCurrentUser", "getUser")
Object.keys($)
```

**Network** — HTTP via `XMLHttpRequest`, which is what React Native's `fetch` is built on, so both show up. Method, status, duration, URL; tap for request body, response headers and response body. WebSocket capture (outgoing frames) is a separate toggle, off by default because the gateway is relentless.

**Modules** — search Metro's registry by exported prop name, see which module ids match, drill into any export to inspect its value. Only already-initialized modules are read: forcing a lazy one runs its side effects, which is a good way to break the app from inside a debugger.

**Device** — build and engine info (Discord build, React, React Native, Hermes bytecode version, device, window metrics), the capture toggles, buffer size, the floating button controls, and the React DevTools bridge.

### Floating button

A draggable bubble that opens the panel from anywhere in the app — no walking back into Settings every time. Tap to open, drag to move (it remembers where you left it and clamps itself inside the screen), and it stands down on Discord's crash screen, because a debug bubble over a crash report helps nobody.

It mounts by patching `ErrorBoundary.prototype.render` and wrapping the returned tree, which is the same mount point Kettu itself uses to take the screen over on a crash — the one component that is reliably above everything. Discord instantiates more than one boundary, so the overlay elects a single owner instance and every other one renders `null`; when the owner unmounts the next one claims it. On a cold start the module may not be initialized yet, so the patch retries every 2s up to 15 times, and the Device tab reports exactly where it got to (`mounted`, `waiting for ErrorBoundary (3)`, `no patcher api`).

Turn it off in Device → Floating button if you want the panel to live in Settings only.

### React DevTools

The one piece that gives you an actual element inspector. On your Mac:

```sh
npx react-devtools
```

Put the machine's LAN address and port in the Device tab (`192.168.1.20:8097`) and hit Connect. You get the real component tree, props and state, live. This needs the mod to expose `connectToDebugger` on its debug API; if the build doesn't have it, the tab says so instead of failing silently.

### What it cannot do

**There is no JavaScript source to show you.** Discord's mobile app ships compiled Hermes bytecode — `Function.prototype.toString` on anything Discord wrote returns `[bytecode]`, and no plugin can recover the original text because it is not in the app. That is the engine, not a missing feature.

What you get instead is the live surface: every export, its type, its current value, store state, function names and arity. For actual decompilation you need the APK/IPA and `hbctool` or `hermes-dec` on a desktop, which is a different job entirely.

Everything is also reachable programmatically while the plugin is loaded, for use from the Eval tab or another plugin:

```js
__devtools.logs          // captured log entries
__devtools.requests      // captured network entries
__devtools.searchModules("getCurrentUser")
__devtools.inspect(value)
```

---

## Building

No dependencies, Node 18+ (or Bun):

```sh
node build.mjs             # builds every plugin in plugins/ to its own folder
node build.mjs Toolbox     # just one
node test/devtools.mjs     # fake RN runtime: capture, eval, module search, all five tabs render
node test/toolbox.mjs      # fake sheet, jsx runtime, RowManager, CDN: icons, rows, embeds, files, edits
node test/serverdetails.mjs  # fake guild stores: every item, uncached owner, sheet row, panel
```

`manifest.json` carries a `hash`, the sha256 of the bundle. Kettu only refetches plugin code when that hash changes, so the build recomputes it every time — commit the built folder or installs serve stale code.

For live development Kettu can load from a local HTTP server:

```sh
node build.mjs Toolbox --serve --watch --port=4040
```

Then install `http://<your-lan-ip>:4040/` and it rebuilds on every save.

### The loader contract

From Kettu's own source (`src/core/vendetta/plugins.ts`), a Vendetta-format plugin is loaded like this:

```js
const pluginString = `vendetta=>{return ${plugin.js}}`;
const raw = (0, eval)(pluginString)(vendettaForPlugins);
const ret = typeof raw === "function" ? raw() : raw;
return ret?.default ?? ret ?? {};
```

Two consequences, and both of them bite silently:

**The bundle must be a single expression starting with `(`.** It lands straight after `return`, and JavaScript's automatic semicolon insertion means a newline there ends the statement — a bundle that opens with a banner comment or a blank line loads as nothing at all, with no error. `build.mjs` keeps the banner inside the IIFE for exactly this reason, and also hands the source a CommonJS-shaped `module` so the same file works under a loader that wraps it as `new Function("module", "exports", code)`.

**The plugin API arrives as a function parameter, not a global.** `window.bunny` and `window.vendetta` do exist, but neither carries `plugin.storage` — that lives only on the per-plugin object passed in as `vendetta`. Reading the global instead gets you an in-memory object that looks like it works and silently forgets everything on restart. `src/index.js` therefore picks up the identifier from its enclosing scope with a `typeof` guard, and the Device tab reports `Settings storage: persistent` or `in-memory only` so the failure is never silent.

`test/smoke.mjs` loads the built bundle through that exact wrapper, so breaking either contract fails the test instead of the phone.

## Layout

```
plugins/<Name>/index.js       the plugin, one self-contained file, no imports
plugins/<Name>/manifest.json  source of truth for name/version/author
build.mjs                     wraps each one into <Name>/, stamps the hash, optional dev server
test/devtools.mjs             fake React Native runtime and fake Kettu api
test/toolbox.mjs              same, plus a fake action sheet, dispatcher and CDN
DevTools/  Toolbox/  ServerDetails/   what Kettu installs - committed on purpose, this is what Pages serves
index.html                    landing page listing the plugins and their install URLs
```

Each `plugins/<Name>/index.js` imports nothing. It takes the per-plugin API from its enclosing scope when there is one and falls back to the globals, tries both the old `findByProps` and the newer `filters.byProps` + `findExports` shapes, finds the patcher at `patcher` (Vendetta) or `api.patcher` (Bunny), and degrades to a message in the UI when a lookup misses rather than throwing. That is why there is no bundler here and why one file works across all three mods.

Adding another plugin means another folder under `plugins/`; the build picks it up, gives it its own output folder, manifest and install URL, and the folders stay independent.
