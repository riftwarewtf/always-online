/**
 * Always Online
 * A presence plugin for Kettu (also works on Bunny / Vendetta).
 *
 * How it works, in three sentences:
 *  1. It monkey-patches `WebSocket.prototype.send` and rewrites every frame Discord
 *     sends to the gateway, so an IDENTIFY (op 2) carries our presence from the very
 *     first packet and any PRESENCE_UPDATE (op 3) the client tries to send as
 *     idle/offline/afk comes out as whatever we configured instead.
 *  2. A keepalive timer re-asserts that presence periodically, which also survives
 *     Discord clearing activities on its own.
 *  3. Activities are additionally pushed through FluxDispatcher's LOCAL_ACTIVITY_UPDATE,
 *     which is encoding-agnostic and works even when the gateway speaks ETF.
 *
 * Nothing here touches your account's saved status setting - it only rewrites the wire.
 */

/* ------------------------------------------------------------------ *
 * runtime api resolution                                              *
 * ------------------------------------------------------------------ */

var G = typeof globalThis !== "undefined" ? globalThis : window;

// Kettu and Bunny expose `bunny`; Vendetta exposes `vendetta`. Try all of them.
var api = G.kettu || G.bunny || G.vendetta || {};

var LOG_PREFIX = "[always-online]";
var debugLines = [];

function log() {
  var parts = Array.prototype.slice.call(arguments);
  var line = parts
    .map(function (p) {
      if (p instanceof Error) return p.message;
      if (typeof p === "object") {
        try {
          return JSON.stringify(p);
        } catch (e) {
          return String(p);
        }
      }
      return String(p);
    })
    .join(" ");
  debugLines.push(line);
  if (debugLines.length > 60) debugLines.shift();
  try {
    console.log(LOG_PREFIX + " " + line);
  } catch (e) {}
}

/** metro: find a module by the props it exports, across api generations. */
function findByProps() {
  var props = Array.prototype.slice.call(arguments);
  var m = api.metro;
  if (!m) return undefined;
  try {
    if (typeof m.findByProps === "function") return m.findByProps.apply(m, props);
    var byProps = m.filters && m.filters.byProps;
    if (byProps) {
      var filter = byProps.apply(null, props);
      if (typeof m.findExports === "function") return m.findExports(filter);
      if (typeof m.find === "function") return m.find(filter);
    }
  } catch (e) {
    log("findByProps(" + props.join(",") + ") threw:", e);
  }
  return undefined;
}

/** metro: find a flux store by name, across api generations. */
function findByStoreName(name) {
  var m = api.metro;
  if (!m) return undefined;
  try {
    if (typeof m.findByStoreName === "function") return m.findByStoreName(name);
    var byStoreName = m.filters && m.filters.byStoreName;
    if (byStoreName) {
      var filter = byStoreName(name);
      if (typeof m.findExports === "function") return m.findExports(filter);
      if (typeof m.find === "function") return m.find(filter);
    }
  } catch (e) {
    log("findByStoreName(" + name + ") threw:", e);
  }
  return undefined;
}

var common = (api.metro && api.metro.common) || {};
var React = common.React || G.React || findByProps("createElement", "useState");
var ReactNative = common.ReactNative || findByProps("ScrollView", "StyleSheet", "AppState");
var FluxDispatcher = common.FluxDispatcher || findByProps("dispatch", "subscribe", "_actionHandlers");

/** persistent storage, proxied and auto-saving on Vendetta-family loaders. */
var storage =
  (api.plugin && api.plugin.storage) ||
  (api.plugins && api.plugins.storage) ||
  api.storage ||
  {};

function toast(text) {
  try {
    var t = (api.ui && api.ui.toasts) || api.toasts;
    if (t && typeof t.showToast === "function") t.showToast(text);
    else if (t && typeof t.open === "function") t.open({ content: text });
  } catch (e) {}
}

/* ------------------------------------------------------------------ *
 * settings schema + defaults                                          *
 * ------------------------------------------------------------------ */

var STATUSES = ["online", "idle", "dnd", "invisible"];

var ACTIVITY_TYPES = [
  { value: 0, label: "Playing" },
  { value: 1, label: "Streaming" },
  { value: 2, label: "Listening to" },
  { value: 3, label: "Watching" },
  { value: 5, label: "Competing in" },
  { value: 4, label: "Custom" }
];

var DEFAULTS = {
  enabled: true,
  status: "online",
  keepaliveSeconds: 60,
  suppressIdle: true,
  spoofDesktop: false,
  activity: {
    enabled: false,
    type: 0,
    name: "",
    details: "",
    state: "",
    url: "",
    applicationId: "",
    largeImage: "",
    largeText: "",
    smallImage: "",
    smallText: "",
    showElapsed: true
  }
};

/** fill in anything missing without clobbering what the user already set. */
function applyDefaults() {
  for (var key in DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
    var def = DEFAULTS[key];
    if (def && typeof def === "object" && !Array.isArray(def)) {
      if (typeof storage[key] !== "object" || storage[key] === null) storage[key] = {};
      for (var sub in def) {
        if (!Object.prototype.hasOwnProperty.call(def, sub)) continue;
        if (typeof storage[key][sub] === "undefined") storage[key][sub] = def[sub];
      }
    } else if (typeof storage[key] === "undefined") {
      storage[key] = def;
    }
  }
}

/* ------------------------------------------------------------------ *
 * live state                                                          *
 * ------------------------------------------------------------------ */

var state = {
  running: false,
  socket: null,
  socketEncoding: "unknown",
  identifyRewrites: 0,
  presenceRewrites: 0,
  keepalivesSent: 0,
  lastApplied: null,
  activityStartedAt: Date.now(),
  originalSend: null,
  idleUnpatchers: [],
  timer: null
};

/* ------------------------------------------------------------------ *
 * presence construction                                              *
 * ------------------------------------------------------------------ */

function buildActivity() {
  var cfg = storage.activity || {};
  if (!cfg.enabled) return null;

  var type = Number(cfg.type);
  if (isNaN(type)) type = 0;

  // Custom status (type 4) has its own shape: the text lives in `state` and the
  // name is required to be the literal "Custom Status".
  if (type === 4) {
    if (!cfg.state) return null;
    return { name: "Custom Status", type: 4, state: String(cfg.state) };
  }

  if (!cfg.name) return null;

  var activity = { name: String(cfg.name), type: type };

  if (cfg.details) activity.details = String(cfg.details);
  if (cfg.state) activity.state = String(cfg.state);

  // Streaming only renders as a purple "live" presence with a twitch/youtube url.
  if (type === 1 && cfg.url) activity.url = String(cfg.url);

  var assets = {};
  if (cfg.largeImage) assets.large_image = String(cfg.largeImage);
  if (cfg.largeText) assets.large_text = String(cfg.largeText);
  if (cfg.smallImage) assets.small_image = String(cfg.smallImage);
  if (cfg.smallText) assets.small_text = String(cfg.smallText);
  if (Object.keys(assets).length) activity.assets = assets;

  // Asset keys are resolved against an application, so images need the app id too.
  if (cfg.applicationId) activity.application_id = String(cfg.applicationId);

  if (cfg.showElapsed) activity.timestamps = { start: state.activityStartedAt };

  return activity;
}

/** the `d` payload of a gateway PRESENCE_UPDATE (op 3). */
function buildPresence() {
  var status = STATUSES.indexOf(storage.status) === -1 ? "online" : storage.status;
  var activity = buildActivity();
  return {
    status: status,
    since: 0,
    activities: activity ? [activity] : [],
    afk: false
  };
}

/* ------------------------------------------------------------------ *
 * gateway frame rewriting                                             *
 * ------------------------------------------------------------------ */

function isGatewayUrl(url) {
  if (typeof url !== "string") return false;
  return url.indexOf("gateway") !== -1 && url.indexOf("discord") !== -1;
}

/**
 * Rewrites one outgoing gateway frame. Returns the replacement string, or null
 * to send the original untouched.
 */
function rewriteFrame(raw) {
  var payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  // op 2 IDENTIFY: ride along on the handshake so we are online from packet one.
  if (payload.op === 2 && payload.d) {
    payload.d.presence = buildPresence();
    if (storage.spoofDesktop && payload.d.properties) {
      payload.d.properties.browser = "Discord Client";
      payload.d.properties.os = "Mac OS X";
      delete payload.d.properties.browser_user_agent;
    }
    state.identifyRewrites++;
    state.lastApplied = Date.now();
    log("rewrote IDENTIFY, presence =", payload.d.presence.status);
    try {
      return JSON.stringify(payload);
    } catch (e) {
      return null;
    }
  }

  // op 3 PRESENCE_UPDATE: this is the one Discord fires when it thinks you went
  // idle or the app got backgrounded. Overwrite it wholesale.
  if (payload.op === 3) {
    var wanted = buildPresence();
    var incoming = payload.d || {};
    // Keep the client's own activities when we are not supplying any, so things
    // like Spotify or a voice session are not wiped out.
    if (!wanted.activities.length && Array.isArray(incoming.activities)) {
      wanted.activities = incoming.activities;
    }
    payload.d = wanted;
    state.presenceRewrites++;
    state.lastApplied = Date.now();
    try {
      return JSON.stringify(payload);
    } catch (e) {
      return null;
    }
  }

  return null;
}

function patchWebSocket() {
  var WS = G.WebSocket;
  if (!WS || !WS.prototype || typeof WS.prototype.send !== "function") {
    log("WebSocket.prototype.send not available - gateway rewriting disabled");
    return false;
  }

  var original = WS.prototype.send;
  state.originalSend = original;

  WS.prototype.send = function alwaysOnlineSend(data) {
    try {
      var url = this.url || this._url;
      if (isGatewayUrl(url) && storage.enabled) {
        state.socket = this;
        if (typeof data === "string") {
          state.socketEncoding = "json";
          var replacement = rewriteFrame(data);
          if (replacement !== null) {
            return original.call(this, replacement);
          }
        } else {
          // ETF / binary frame. We cannot safely rewrite it, so activities go
          // through FluxDispatcher instead and status relies on idle suppression.
          state.socketEncoding = "etf";
        }
      }
    } catch (e) {
      log("send hook error:", e);
    }
    return original.apply(this, arguments);
  };
  WS.prototype.send.__alwaysOnline = true;

  log("patched WebSocket.prototype.send");
  return true;
}

function unpatchWebSocket() {
  var WS = G.WebSocket;
  if (!WS || !state.originalSend) return;
  // Only restore if nobody patched on top of us, otherwise we would clobber them.
  if (WS.prototype.send && WS.prototype.send.__alwaysOnline) {
    WS.prototype.send = state.originalSend;
    log("restored WebSocket.prototype.send");
  }
  state.originalSend = null;
}

/* ------------------------------------------------------------------ *
 * idle suppression                                                    *
 * ------------------------------------------------------------------ */

/** Make the client's own idle bookkeeping report "not idle, ever". */
function patchIdleStore() {
  if (!storage.suppressIdle) return;
  var store = findByStoreName("IdleStore");
  if (!store) {
    log("IdleStore not found - relying on frame rewriting alone");
    return;
  }
  var overrides = {
    isIdle: false,
    isAFK: false,
    getIdleSince: 0,
    idleSince: 0
  };
  Object.keys(overrides).forEach(function (key) {
    if (typeof store[key] !== "function") return;
    var original = store[key];
    store[key] = function () {
      return overrides[key];
    };
    state.idleUnpatchers.push(function () {
      store[key] = original;
    });
    log("suppressed IdleStore." + key);
  });
}

function unpatchIdleStore() {
  state.idleUnpatchers.forEach(function (undo) {
    try {
      undo();
    } catch (e) {
      log("idle unpatch failed:", e);
    }
  });
  state.idleUnpatchers = [];
}

/* ------------------------------------------------------------------ *
 * applying presence                                                   *
 * ------------------------------------------------------------------ */

/**
 * Push the activity through Flux. This path is encoding-agnostic: Discord
 * serialises it itself, so it works on ETF connections where we cannot touch
 * the raw frames.
 */
function dispatchActivity() {
  if (!FluxDispatcher || typeof FluxDispatcher.dispatch !== "function") return;
  var activity = buildActivity();
  try {
    FluxDispatcher.dispatch({
      type: "LOCAL_ACTIVITY_UPDATE",
      activity: activity || {},
      socketId: "always-online"
    });
  } catch (e) {
    log("LOCAL_ACTIVITY_UPDATE failed:", e);
  }
}

/** Send a PRESENCE_UPDATE right now, if we have a live socket. */
function sendPresence() {
  dispatchActivity();

  var socket = state.socket;
  if (!socket || socket.readyState !== 1) return false;
  if (state.socketEncoding === "etf") return false;

  try {
    // This goes back through our own hook, which is harmless - rewriting an
    // already-correct op 3 is a no-op.
    socket.send(JSON.stringify({ op: 3, d: buildPresence() }));
    state.keepalivesSent++;
    state.lastApplied = Date.now();
    return true;
  } catch (e) {
    log("presence send failed:", e);
    return false;
  }
}

function startTimer() {
  stopTimer();
  var seconds = Number(storage.keepaliveSeconds);
  if (isNaN(seconds) || seconds < 15) seconds = 15; // op 3 is rate limited; stay polite
  state.timer = setInterval(function () {
    if (!storage.enabled) return;
    sendPresence();
  }, seconds * 1000);
  log("keepalive every " + seconds + "s");
}

function stopTimer() {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/** Re-read settings and push them out immediately. */
function reapply() {
  state.activityStartedAt = Date.now();
  startTimer();
  var sent = sendPresence();
  toast(sent ? "Presence applied" : "Presence queued (no live gateway yet)");
  return sent;
}

function start() {
  if (state.running) return;
  applyDefaults();
  state.running = true;
  state.activityStartedAt = Date.now();
  patchWebSocket();
  patchIdleStore();
  startTimer();
  sendPresence();
  log("started");
}

function stop() {
  if (!state.running) return;
  stopTimer();
  unpatchIdleStore();
  unpatchWebSocket();

  // Drop our activity so we do not leave a ghost presence behind.
  if (FluxDispatcher && typeof FluxDispatcher.dispatch === "function") {
    try {
      FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: {},
        socketId: "always-online"
      });
    } catch (e) {}
  }

  state.running = false;
  state.socket = null;
  log("stopped");
}

/* ------------------------------------------------------------------ *
 * settings ui                                                         *
 * ------------------------------------------------------------------ */

var h = React ? React.createElement : null;

function palette(dark) {
  return dark
    ? {
        bg: "transparent",
        card: "rgba(255,255,255,0.06)",
        border: "rgba(255,255,255,0.10)",
        text: "#f2f3f5",
        dim: "#b5bac1",
        field: "rgba(0,0,0,0.30)",
        accent: "#5865f2",
        chip: "rgba(255,255,255,0.08)",
        good: "#3ba55d",
        bad: "#ed4245"
      }
    : {
        bg: "transparent",
        card: "rgba(0,0,0,0.04)",
        border: "rgba(0,0,0,0.10)",
        text: "#060607",
        dim: "#4e5058",
        field: "rgba(0,0,0,0.06)",
        accent: "#5865f2",
        chip: "rgba(0,0,0,0.06)",
        good: "#1a7f37",
        bad: "#d1242f"
      };
}

function SettingsPage() {
  if (!h || !ReactNative) {
    return null;
  }

  var RN = ReactNative;
  var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;
  var scheme = typeof RN.useColorScheme === "function" ? RN.useColorScheme() : "dark";
  var c = palette(scheme !== "light");

  var tick = React.useState(0);
  var version = tick[0];
  var setVersion = tick[1];

  // Vendetta-family storage is a proxy that persists on write, so mutate it
  // directly and force a re-render.
  function set(key, value) {
    storage[key] = value;
    setVersion(version + 1);
  }
  function setActivity(key, value) {
    if (typeof storage.activity !== "object" || storage.activity === null) storage.activity = {};
    storage.activity[key] = value;
    setVersion(version + 1);
  }

  function Section(title, subtitle, children) {
    return h(
      RN.View,
      { style: { marginHorizontal: 12, marginTop: 16 } },
      h(
        RN.Text,
        {
          style: {
            color: c.dim,
            fontSize: 12,
            fontWeight: "700",
            letterSpacing: 0.6,
            textTransform: "uppercase",
            marginBottom: 2,
            marginLeft: 4
          }
        },
        title
      ),
      subtitle
        ? h(
            RN.Text,
            { style: { color: c.dim, fontSize: 12, marginBottom: 8, marginLeft: 4 } },
            subtitle
          )
        : null,
      h(
        RN.View,
        {
          style: {
            backgroundColor: c.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: c.border,
            overflow: "hidden",
            marginTop: subtitle ? 0 : 6
          }
        },
        children
      )
    );
  }

  function Divider() {
    return h(RN.View, { style: { height: 1, backgroundColor: c.border } });
  }

  function ToggleRow(label, hint, value, onChange) {
    return h(
      RN.View,
      {
        style: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          paddingVertical: 12
        }
      },
      h(
        RN.View,
        { style: { flex: 1, paddingRight: 12 } },
        h(RN.Text, { style: { color: c.text, fontSize: 15, fontWeight: "600" } }, label),
        hint ? h(RN.Text, { style: { color: c.dim, fontSize: 12, marginTop: 2 } }, hint) : null
      ),
      h(RN.Switch, {
        value: !!value,
        onValueChange: onChange,
        trackColor: { false: c.field, true: c.accent }
      })
    );
  }

  function Field(label, hint, value, onChangeText, extra) {
    var props = {
      value: value === undefined || value === null ? "" : String(value),
      onChangeText: onChangeText,
      placeholder: hint || "",
      placeholderTextColor: c.dim,
      autoCapitalize: "none",
      autoCorrect: false,
      style: {
        color: c.text,
        backgroundColor: c.field,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 15
      }
    };
    if (extra) {
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) props[k] = extra[k];
    }
    return h(
      RN.View,
      { style: { paddingHorizontal: 14, paddingVertical: 10 } },
      h(
        RN.Text,
        { style: { color: c.dim, fontSize: 12, fontWeight: "600", marginBottom: 6 } },
        label
      ),
      h(RN.TextInput, props)
    );
  }

  function Chips(options, selected, onSelect) {
    return h(
      RN.View,
      {
        style: {
          flexDirection: "row",
          flexWrap: "wrap",
          paddingHorizontal: 10,
          paddingTop: 10,
          paddingBottom: 4
        }
      },
      options.map(function (opt) {
        var active = opt.value === selected;
        return h(
          Touchable,
          {
            key: String(opt.value),
            onPress: function () {
              onSelect(opt.value);
            },
            style: {
              backgroundColor: active ? c.accent : c.chip,
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 7,
              marginRight: 8,
              marginBottom: 8
            }
          },
          h(
            RN.Text,
            {
              style: {
                color: active ? "#ffffff" : c.text,
                fontSize: 14,
                fontWeight: active ? "700" : "500"
              }
            },
            opt.label
          )
        );
      })
    );
  }

  function Button(label, onPress, tone) {
    return h(
      Touchable,
      {
        onPress: onPress,
        style: {
          backgroundColor: tone === "quiet" ? c.chip : c.accent,
          borderRadius: 10,
          paddingVertical: 12,
          alignItems: "center",
          marginHorizontal: 14,
          marginVertical: 8
        }
      },
      h(
        RN.Text,
        {
          style: {
            color: tone === "quiet" ? c.text : "#ffffff",
            fontSize: 15,
            fontWeight: "700"
          }
        },
        label
      )
    );
  }

  var activity = storage.activity || {};
  var isCustom = Number(activity.type) === 4;
  var isStreaming = Number(activity.type) === 1;

  var socketLabel = !state.socket
    ? "not captured yet"
    : state.socket.readyState === 1
      ? "connected (" + state.socketEncoding + ")"
      : "closed (" + state.socketEncoding + ")";

  var statusLines = [
    ["Gateway socket", socketLabel],
    ["Identify rewrites", String(state.identifyRewrites)],
    ["Presence rewrites", String(state.presenceRewrites)],
    ["Keepalives sent", String(state.keepalivesSent)],
    ["Frame hook", state.originalSend ? "active" : "inactive"],
    ["Idle suppression", state.idleUnpatchers.length ? "active" : "not applied"],
    [
      "Last applied",
      state.lastApplied ? Math.round((Date.now() - state.lastApplied) / 1000) + "s ago" : "never"
    ]
  ];

  return h(
    RN.ScrollView,
    { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 48, paddingTop: 4 } },

    Section(
      "Keep online",
      "Rewrites outgoing gateway frames so the client never reports idle, afk or offline.",
      [
        ToggleRow("Enabled", "Master switch for all rewriting", storage.enabled, function (v) {
          set("enabled", v);
          if (v) reapply();
        }),
        Divider(),
        ToggleRow(
          "Suppress idle detection",
          "Also stops the UI from flipping you to idle locally",
          storage.suppressIdle,
          function (v) {
            set("suppressIdle", v);
            toast("Reload the app to change idle patching");
          }
        ),
        Divider(),
        ToggleRow(
          "Appear as desktop",
          "Drops the mobile indicator by editing the identify handshake",
          storage.spoofDesktop,
          function (v) {
            set("spoofDesktop", v);
            toast("Applies on the next gateway connection");
          }
        ),
        Divider(),
        Field("Re-assert every (seconds)", "60", storage.keepaliveSeconds, function (text) {
          var digits = text.replace(/[^0-9]/g, "");
          set("keepaliveSeconds", digits === "" ? "" : Number(digits));
        }, { keyboardType: "number-pad" })
      ]
    ),

    Section("Status", null, [
      Chips(
        STATUSES.map(function (s) {
          return { value: s, label: s === "dnd" ? "Do Not Disturb" : s[0].toUpperCase() + s.slice(1) };
        }),
        storage.status,
        function (v) {
          set("status", v);
          sendPresence();
        }
      )
    ]),

    Section("Custom presence", "Pushed over the gateway and through Flux, so it survives both encodings.", [
      ToggleRow("Enabled", null, activity.enabled, function (v) {
        setActivity("enabled", v);
        reapply();
      }),
      Divider(),
      Chips(ACTIVITY_TYPES, Number(activity.type), function (v) {
        setActivity("type", v);
        reapply();
      }),
      Divider(),
      isCustom
        ? Field("Status text", "vibing", activity.state, function (t) {
            setActivity("state", t);
          })
        : h(
            RN.View,
            null,
            Field("Name", "Minecraft", activity.name, function (t) {
              setActivity("name", t);
            }),
            Divider(),
            Field("Details (first line)", "In a world", activity.details, function (t) {
              setActivity("details", t);
            }),
            Divider(),
            Field("State (second line)", "Mining", activity.state, function (t) {
              setActivity("state", t);
            }),
            isStreaming ? Divider() : null,
            isStreaming
              ? Field("Stream URL", "https://twitch.tv/...", activity.url, function (t) {
                  setActivity("url", t);
                })
              : null,
            Divider(),
            ToggleRow("Show elapsed time", "Adds a ticking timer", activity.showElapsed, function (v) {
              setActivity("showElapsed", v);
              reapply();
            })
          ),
      Divider(),
      Button("Apply now", function () {
        reapply();
      })
    ]),

    isCustom
      ? null
      : Section("Images", "Asset keys are resolved against the application id, so set both.", [
          Field("Application ID", "1234567890", activity.applicationId, function (t) {
            setActivity("applicationId", t.replace(/[^0-9]/g, ""));
          }, { keyboardType: "number-pad" }),
          Divider(),
          Field("Large image key", "big_icon", activity.largeImage, function (t) {
            setActivity("largeImage", t);
          }),
          Divider(),
          Field("Large image tooltip", "", activity.largeText, function (t) {
            setActivity("largeText", t);
          }),
          Divider(),
          Field("Small image key", "small_icon", activity.smallImage, function (t) {
            setActivity("smallImage", t);
          }),
          Divider(),
          Field("Small image tooltip", "", activity.smallText, function (t) {
            setActivity("smallText", t);
          })
        ]),

    Section("Diagnostics", null, [
      h(
        RN.View,
        { style: { paddingHorizontal: 14, paddingVertical: 12 } },
        statusLines.map(function (row, i) {
          return h(
            RN.View,
            {
              key: row[0],
              style: {
                flexDirection: "row",
                justifyContent: "space-between",
                paddingVertical: 3
              }
            },
            h(RN.Text, { style: { color: c.dim, fontSize: 13 } }, row[0]),
            h(
              RN.Text,
              { style: { color: c.text, fontSize: 13, fontWeight: "600" } },
              row[1]
            )
          );
        })
      ),
      Divider(),
      Button("Refresh", function () {
        setVersion(version + 1);
      }, "quiet"),
      Button("Copy debug log", function () {
        var text = debugLines.join("\n");
        try {
          var clipboard = common.clipboard || findByProps("setString", "getString");
          if (clipboard && clipboard.setString) {
            clipboard.setString(text);
            toast("Debug log copied");
          } else {
            log("no clipboard module available");
            toast("No clipboard module");
          }
        } catch (e) {
          toast("Copy failed");
        }
      }, "quiet")
    ]),

    h(
      RN.Text,
      {
        style: {
          color: c.dim,
          fontSize: 11,
          lineHeight: 16,
          marginHorizontal: 18,
          marginTop: 18
        }
      },
      "Your status lives on the gateway websocket, which dies when the OS suspends Discord. " +
        "This keeps you online for as long as the app process survives and puts you back online " +
        "the instant it reconnects. For literal 24/7, run a gateway client on a machine that never sleeps."
    )
  );
}

/* ------------------------------------------------------------------ *
 * plugin exports                                                      *
 * ------------------------------------------------------------------ */

function onLoad() {
  try {
    start();
  } catch (e) {
    log("onLoad failed:", e);
  }
}

function onUnload() {
  try {
    stop();
  } catch (e) {
    log("onUnload failed:", e);
  }
}

var plugin = {
  onLoad: onLoad,
  onUnload: onUnload,
  settings: SettingsPage
};

// Loaders in this family read either the module itself or its default export.
plugin.default = plugin;
module.exports = plugin;
