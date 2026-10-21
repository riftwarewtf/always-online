# Kettu Plugins

Plugins for [Kettu](https://codeberg.org/cocobo1/Kettu), laid out so GitHub Pages serves each one from its own folder. They also load on Bunny and Vendetta, since the API is resolved from whichever global is present.

## Install

Kettu takes a **folder URL** and appends `manifest.json` itself. A `github.com/...` repo link will always fail with *"Failed to fetch manifest"* — that URL serves an HTML page, not JSON.

Once Pages is enabled on this repo (Settings → Pages → Deploy from a branch → `main` → `/ (root)`):

```
https://riftwarewtf.github.io/always-online/DevTools/
```

Works right now without Pages, same thing:

```
https://raw.githubusercontent.com/riftwarewtf/always-online/main/DevTools/
```

Trailing slash matters.

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
node build.mjs          # writes DevTools/index.js and DevTools/manifest.json
node test/smoke.mjs     # fake RN runtime: capture, eval, module search, all five tabs render
```

`manifest.json` carries a `hash`, the sha256 of the bundle. Kettu only refetches plugin code when that hash changes, so the build recomputes it every time — commit the built folder or installs serve stale code.

For live development Kettu can load from a local HTTP server:

```sh
node build.mjs --serve --watch --port=4040
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
src/index.js       the plugin, one self-contained file, no imports
manifest.json      source of truth for name/version/author
build.mjs          wraps src into DevTools/, stamps the hash, optional dev server
test/smoke.mjs     fake React Native runtime and fake Kettu api
DevTools/          what Kettu installs - committed on purpose, this is what Pages serves
index.html         landing page listing the plugins and their install URLs
```

`src/index.js` imports nothing. It takes the per-plugin API from its enclosing scope when there is one and falls back to the globals, tries both the old `findByProps` and the newer `filters.byProps` + `findExports` shapes, finds the patcher at `patcher` (Vendetta) or `api.patcher` (Bunny), and degrades to a message in the UI when a lookup misses rather than throwing. That is why there is no bundler here and why one file works across all three mods.

Adding a second plugin means a second source file and a second output folder, each with its own manifest and install URL — the folders are independent.
