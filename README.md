# Always Online

A presence plugin for [Kettu](https://codeberg.org/cocobo1/Kettu) — also loads on Bunny and Vendetta, since it resolves its API from whichever global is present.

It stops the Discord mobile client from ever telling the gateway you are idle, afk or offline, and gives you a full custom rich presence.

## Read this first

Your online status is a property of the **gateway websocket**, not of a setting. When the OS suspends Discord, that socket dies and you go offline no matter what any plugin does.

- **iOS** suspends a backgrounded app within seconds. You will go offline shortly after leaving the app.
- **Android** holds much longer with battery optimization disabled for Discord, but it is still not a guarantee.

So this plugin does not give you literal 24/7. What it actually does:

- you never go **idle** while the app is alive, no matter how long you sit there
- backgrounding no longer reports idle, because the frame that does it gets rewritten
- you are online **from the first packet** of every reconnect, including after a suspend
- your presence is re-asserted on a timer, so Discord cannot quietly clear it

For a status that is genuinely always on, you want a standalone gateway client on a machine that never sleeps. This is the honest ceiling on a phone.

## Install

In Kettu: **Settings → Plugins → + ** and paste the folder URL (Kettu appends `manifest.json` itself):

```
https://raw.githubusercontent.com/riftwarewtf/always-online/main/dist/
```

The trailing slash matters, and it has to be the raw host — a normal `github.com/.../tree/...` page will not work. If `raw.githubusercontent.com` is being slow to update, jsDelivr works too, though it caches harder:

```
https://cdn.jsdelivr.net/gh/riftwarewtf/always-online@main/dist/
```

## Settings

**Keep online**

| Setting | What it does |
| --- | --- |
| Enabled | Master switch. Off means no frames are touched at all. |
| Suppress idle detection | Also forces the client's own `IdleStore` to report "not idle", so the UI stops flipping you to idle locally. Needs a reload to change. |
| Appear as desktop | Rewrites the identify handshake's client properties, dropping the mobile indicator. Off by default — it changes what your account reports as its client. |
| Re-assert every | Keepalive interval in seconds. Floored at 15, because gateway presence updates are rate limited (roughly 5 per 20s). 60 is comfortable. |

**Status** — online, idle, dnd or invisible. Whatever you pick is what every outgoing frame says, including the ones Discord meant to send as idle.

**Custom presence** — pick a type and fill in the lines:

- *Playing / Listening to / Watching / Competing in* — `name` is the bold title, `details` is the first line under it, `state` is the second.
- *Streaming* — same, plus a Twitch or YouTube URL to get the purple live treatment.
- *Custom* — a single line of status text. Type 4 is a special shape and other clients render it inconsistently from a gateway presence; Discord's own custom status is more reliable if that is all you want.
- *Show elapsed time* — adds the ticking `00:42 elapsed` timer.

**Images** — asset keys are resolved against an application, so the application ID and the key are a pair. Create an app in the Discord developer portal, upload art under Rich Presence assets, then put the app's ID and your asset names here. Keys without an app ID render nothing.

**Diagnostics** — whether the gateway socket was captured, which encoding it is using, how many frames have been rewritten, and a copyable debug log. Check here first if something looks wrong.

## How it works

Three mechanisms, layered so that a failure in one does not take the feature with it.

**1. Outgoing frame rewriting.** `WebSocket.prototype.send` is monkey-patched, and frames on a socket whose URL looks like the Discord gateway get parsed and edited on the way out:

- **op 2 IDENTIFY** gets `d.presence` injected, so the very first packet of a connection already carries your status. This is what makes reconnects land online instead of flickering.
- **op 3 PRESENCE_UPDATE** is overwritten wholesale. This is the frame Discord fires when it decides you went idle or the app got backgrounded, and rewriting it is cheaper and far more version-proof than hunting the module that produced it. Activities Discord supplied itself (a Spotify session, for instance) are preserved when you have not configured one.

Patching at the socket layer means this does not depend on a single Discord internal module name, which is what usually breaks presence plugins after an app update.

**2. Flux dispatch.** Activities are also pushed through `LOCAL_ACTIVITY_UPDATE` on the FluxDispatcher. Discord serialises that one itself, so it still works when the gateway is speaking ETF rather than JSON — binary frames cannot be safely rewritten and are passed through untouched.

**3. Idle suppression.** If `IdleStore` is findable, its `isIdle` / `isAFK` / `getIdleSince` are overridden so the client's local bookkeeping never considers you away. Every override is restored on unload.

Nothing here writes to your account's saved status. It only edits what goes over the wire, so disabling the plugin leaves no trace on your settings.

## Building

No dependencies, Node 18+ (or Bun):

```sh
node build.mjs            # writes dist/index.js and dist/manifest.json
node test/smoke.mjs       # fake gateway + fake runtime, asserts frames come out rewritten
```

`dist/manifest.json` carries a `hash`, the sha256 of the bundle. Kettu only refetches plugin code when that hash changes, so the build recomputes it every time — commit both files or installs will serve stale code.

For live development, Kettu can load a plugin off a local HTTP server:

```sh
node build.mjs --serve --watch --port=4040
```

Then install `http://<your-lan-ip>:4040/` in Kettu and it rebuilds on every save.

### The one build detail that matters

Kettu evaluates a plugin's main file as `return <file contents>`. JavaScript's automatic semicolon insertion means a newline straight after `return` ends the statement — so a bundle that opens with a banner comment, or with a blank line, silently loads as nothing at all. `dist/index.js` must begin with `(` as its literal first character. `build.mjs` wraps the source in a single IIFE expression that keeps the banner inside, and hands it a CommonJS-shaped `module` so the same file also works under a loader that wraps it as `new Function("module", "exports", code)`.

## Layout

```
src/index.js      the plugin, one self-contained file, no imports
manifest.json     source of truth for name/version/author
build.mjs         wraps src into dist/index.js, stamps the hash, optional dev server
test/smoke.mjs    fake gateway and fake Kettu runtime
dist/             what Kettu actually installs — committed on purpose
```

`src/index.js` deliberately imports nothing. It reads its API off `globalThis.kettu ?? globalThis.bunny ?? globalThis.vendetta` and degrades gracefully when a lookup fails, which is why there is no bundler in the toolchain and why the same file works across all three mods.
