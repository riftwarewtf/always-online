/**
 * DevTools
 * A web-inspector-style debugging panel for Kettu (also loads on Bunny / Vendetta).
 *
 * Tabs: Console, Eval, Network, Modules, Device.
 *
 * Capture starts at plugin load and keeps running whether or not the panel is
 * open, so you can trigger a bug, then come look at what happened.
 *
 * On source viewing: Discord's mobile app ships as Hermes bytecode, so
 * Function.prototype.toString returns "[bytecode]" for anything Discord wrote.
 * No plugin can recover that text - it is not in the binary. What is available,
 * and what the Modules tab shows, is the live export surface: keys, types,
 * values, store state and function arity.
 */

/* ------------------------------------------------------------------ *
 * runtime api resolution                                              *
 * ------------------------------------------------------------------ */

var G = typeof globalThis !== "undefined" ? globalThis : window;
var api = G.kettu || G.bunny || G.vendetta || {};

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
  } catch (e) {}
  return undefined;
}

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
  } catch (e) {}
  return undefined;
}

var common = (api.metro && api.metro.common) || {};
var React = common.React || G.React || findByProps("createElement", "useState");
var ReactNative = common.ReactNative || findByProps("ScrollView", "StyleSheet", "AppState");

var storage =
  (api.plugin && api.plugin.storage) ||
  (api.plugins && api.plugins.storage) ||
  api.storage ||
  {};

function clipboard() {
  return common.clipboard || findByProps("setString", "getString");
}

function toast(text) {
  try {
    var t = (api.ui && api.ui.toasts) || api.toasts;
    if (t && typeof t.showToast === "function") t.showToast(text);
    else if (t && typeof t.open === "function") t.open({ content: text });
  } catch (e) {}
}

function copy(text) {
  var cb = clipboard();
  if (cb && typeof cb.setString === "function") {
    cb.setString(String(text));
    toast("Copied");
    return true;
  }
  toast("No clipboard module found");
  return false;
}

var DEFAULTS = {
  captureConsole: true,
  captureNetwork: true,
  captureWebSocket: false,
  captureErrors: true,
  maxEntries: 500,
  bodyLimit: 2000,
  devtoolsHost: ""
};

function applyDefaults() {
  for (var key in DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
    if (typeof storage[key] === "undefined") storage[key] = DEFAULTS[key];
  }
}

/* ------------------------------------------------------------------ *
 * value inspection                                                    *
 * ------------------------------------------------------------------ */

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describeFunction(fn) {
  var name = fn.name || "anonymous";
  return "ƒ " + name + "(" + fn.length + ")";
}

/** Safe, depth-limited, cycle-aware stringify for display. */
function inspect(value, depth, seen) {
  depth = typeof depth === "number" ? depth : 2;
  seen = seen || [];

  var t = typeOf(value);

  if (t === "undefined") return "undefined";
  if (t === "null") return "null";
  if (t === "string") return JSON.stringify(value);
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return String(value) + "n";
  if (t === "symbol") return String(value);
  if (t === "function") return describeFunction(value);

  if (value instanceof Error) {
    return value.name + ": " + value.message + (value.stack ? "\n" + value.stack : "");
  }

  if (seen.indexOf(value) !== -1) return "[circular]";
  if (depth < 0) return t === "array" ? "[…]" : "{…}";

  var nextSeen = seen.concat([value]);

  if (t === "array") {
    if (!value.length) return "[]";
    var items = [];
    for (var i = 0; i < Math.min(value.length, 50); i++) {
      items.push(inspect(value[i], depth - 1, nextSeen));
    }
    if (value.length > 50) items.push("… " + (value.length - 50) + " more");
    return "[" + items.join(", ") + "]";
  }

  var keys;
  try {
    keys = Object.keys(value);
  } catch (e) {
    return "[unreadable object]";
  }
  if (!keys.length) {
    var ctor = value.constructor && value.constructor.name;
    return ctor && ctor !== "Object" ? ctor + " {}" : "{}";
  }

  var parts = [];
  for (var k = 0; k < Math.min(keys.length, 40); k++) {
    var key = keys[k];
    var entry;
    try {
      entry = inspect(value[key], depth - 1, nextSeen);
    } catch (e) {
      entry = "[throws]";
    }
    parts.push(key + ": " + entry);
  }
  if (keys.length > 40) parts.push("… " + (keys.length - 40) + " more");
  return "{ " + parts.join(", ") + " }";
}

function truncate(text, limit) {
  text = String(text);
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n… truncated, " + (text.length - limit) + " more chars";
}

/* ------------------------------------------------------------------ *
 * capture buffers                                                     *
 * ------------------------------------------------------------------ */

var logs = [];
var requests = [];
var nextId = 1;
var listeners = [];
var emitQueued = false;

function subscribe(fn) {
  listeners.push(fn);
  return function () {
    var i = listeners.indexOf(fn);
    if (i !== -1) listeners.splice(i, 1);
  };
}

/** Coalesce notifications so a chatty log does not re-render the panel per line. */
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  setTimeout(function () {
    emitQueued = false;
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (e) {}
    }
  }, 200);
}

function cap() {
  var max = Number(storage.maxEntries);
  return isNaN(max) || max < 20 ? 500 : max;
}

function pushLog(level, parts, source) {
  var summary = parts
    .map(function (p) {
      return typeof p === "string" ? p : inspect(p, 2);
    })
    .join(" ");

  logs.push({
    id: nextId++,
    level: level,
    source: source || "app",
    time: Date.now(),
    summary: summary,
    detail: parts.length === 1 ? inspect(parts[0], 4) : parts.map(function (p) {
      return inspect(p, 4);
    }).join("\n")
  });

  while (logs.length > cap()) logs.shift();
  emit();
}

function pushRequest(entry) {
  requests.push(entry);
  while (requests.length > cap()) requests.shift();
  emit();
}

/* ------------------------------------------------------------------ *
 * console capture                                                     *
 * ------------------------------------------------------------------ */

var CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];
var originalConsole = {};

function patchConsole() {
  if (!storage.captureConsole || !G.console) return;
  CONSOLE_METHODS.forEach(function (method) {
    var original = G.console[method];
    if (typeof original !== "function") return;
    originalConsole[method] = original;
    G.console[method] = function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        pushLog(method === "info" ? "log" : method, args);
      } catch (e) {}
      // Always pass through, so the real logger (and any other hook) still sees it.
      return original.apply(G.console, arguments);
    };
    G.console[method].__devtools = true;
  });
}

function unpatchConsole() {
  CONSOLE_METHODS.forEach(function (method) {
    if (!originalConsole[method]) return;
    if (G.console[method] && G.console[method].__devtools) {
      G.console[method] = originalConsole[method];
    }
    delete originalConsole[method];
  });
}

/* ------------------------------------------------------------------ *
 * uncaught error capture                                              *
 * ------------------------------------------------------------------ */

var previousErrorHandler = null;
var errorHandlerInstalled = false;

function patchErrors() {
  if (!storage.captureErrors) return;
  var EU = G.ErrorUtils;
  if (!EU || typeof EU.setGlobalHandler !== "function") return;

  previousErrorHandler =
    typeof EU.getGlobalHandler === "function" ? EU.getGlobalHandler() : null;

  EU.setGlobalHandler(function (error, isFatal) {
    try {
      pushLog("error", [(isFatal ? "[fatal] " : "[uncaught] ") + (error && error.message), error], "crash");
    } catch (e) {}
    if (typeof previousErrorHandler === "function") {
      return previousErrorHandler(error, isFatal);
    }
  });
  errorHandlerInstalled = true;
}

function unpatchErrors() {
  if (!errorHandlerInstalled) return;
  var EU = G.ErrorUtils;
  if (EU && typeof EU.setGlobalHandler === "function") {
    // If there was no handler before us, leave a no-op rather than our own:
    // setGlobalHandler(null) is not safe on every runtime.
    EU.setGlobalHandler(
      typeof previousErrorHandler === "function" ? previousErrorHandler : function () {}
    );
  }
  errorHandlerInstalled = false;
  previousErrorHandler = null;
}

/* ------------------------------------------------------------------ *
 * network capture                                                     *
 * ------------------------------------------------------------------ */

var originalOpen = null;
var originalXhrSend = null;

/** fetch() in React Native is implemented on top of XMLHttpRequest, so one hook covers both. */
function patchNetwork() {
  if (!storage.captureNetwork) return;
  var XHR = G.XMLHttpRequest;
  if (!XHR || !XHR.prototype) return;

  originalOpen = XHR.prototype.open;
  originalXhrSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    try {
      this.__devtools = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
    } catch (e) {}
    return originalOpen.apply(this, arguments);
  };

  XHR.prototype.send = function (body) {
    var meta = this.__devtools;
    if (meta) {
      meta.started = Date.now();
      meta.requestBody = body ? truncate(typeof body === "string" ? body : inspect(body, 2), Number(storage.bodyLimit) || 2000) : "";

      var self = this;
      var finish = function (outcome) {
        if (meta.done) return;
        meta.done = true;

        var responseBody = "";
        try {
          // responseText throws for blob/arraybuffer response types.
          if (!self.responseType || self.responseType === "text") {
            responseBody = truncate(self.responseText || "", Number(storage.bodyLimit) || 2000);
          } else {
            responseBody = "[" + self.responseType + " response]";
          }
        } catch (e) {
          responseBody = "[unreadable response]";
        }

        var headers = "";
        try {
          headers = self.getAllResponseHeaders ? self.getAllResponseHeaders() : "";
        } catch (e) {}

        pushRequest({
          id: nextId++,
          kind: "http",
          method: meta.method,
          url: meta.url,
          status: outcome === "error" ? 0 : self.status,
          outcome: outcome,
          ms: Date.now() - meta.started,
          time: meta.started,
          requestBody: meta.requestBody,
          responseHeaders: headers,
          responseBody: responseBody
        });
      };

      try {
        if (typeof this.addEventListener === "function") {
          this.addEventListener("load", function () {
            finish("load");
          });
          this.addEventListener("error", function () {
            finish("error");
          });
          this.addEventListener("abort", function () {
            finish("abort");
          });
          this.addEventListener("timeout", function () {
            finish("timeout");
          });
        } else {
          var previous = this.onreadystatechange;
          this.onreadystatechange = function () {
            if (self.readyState === 4) finish("load");
            if (typeof previous === "function") return previous.apply(self, arguments);
          };
        }
      } catch (e) {}
    }
    return originalXhrSend.apply(this, arguments);
  };
  XHR.prototype.open.__devtools = true;
  XHR.prototype.send.__devtools = true;
}

function unpatchNetwork() {
  var XHR = G.XMLHttpRequest;
  if (!XHR || !XHR.prototype) return;
  if (originalOpen && XHR.prototype.open && XHR.prototype.open.__devtools) XHR.prototype.open = originalOpen;
  if (originalXhrSend && XHR.prototype.send && XHR.prototype.send.__devtools) XHR.prototype.send = originalXhrSend;
  originalOpen = null;
  originalXhrSend = null;
}

/* ------------------------------------------------------------------ *
 * websocket capture (outgoing frames)                                 *
 * ------------------------------------------------------------------ */

var originalWsSend = null;

function patchWebSocket() {
  if (!storage.captureWebSocket) return;
  var WS = G.WebSocket;
  if (!WS || !WS.prototype || typeof WS.prototype.send !== "function") return;

  originalWsSend = WS.prototype.send;
  WS.prototype.send = function (data) {
    try {
      pushRequest({
        id: nextId++,
        kind: "ws",
        method: "SEND",
        url: this.url || this._url || "websocket",
        status: this.readyState,
        outcome: "sent",
        ms: 0,
        time: Date.now(),
        requestBody: typeof data === "string"
          ? truncate(data, Number(storage.bodyLimit) || 2000)
          : "[binary frame, " + (data && data.byteLength ? data.byteLength + " bytes" : "unknown size") + "]",
        responseHeaders: "",
        responseBody: ""
      });
    } catch (e) {}
    return originalWsSend.apply(this, arguments);
  };
  WS.prototype.send.__devtools = true;
}

function unpatchWebSocket() {
  var WS = G.WebSocket;
  if (!WS || !WS.prototype || !originalWsSend) return;
  if (WS.prototype.send && WS.prototype.send.__devtools) WS.prototype.send = originalWsSend;
  originalWsSend = null;
}

/* ------------------------------------------------------------------ *
 * eval                                                                *
 * ------------------------------------------------------------------ */

var lastResult = undefined;

/**
 * Runs a snippet with the mod's api in scope. Tries expression form first so
 * `1 + 1` returns 2, then falls back to a statement body for multi-line code.
 */
function runEval(source) {
  var scope = {
    api: api,
    metro: api.metro,
    find: findByProps,
    store: findByStoreName,
    common: common,
    React: React,
    ReactNative: ReactNative,
    storage: storage,
    $: lastResult,
    inspect: inspect
  };
  var names = Object.keys(scope);
  var values = names.map(function (n) {
    return scope[n];
  });

  function build(body) {
    return Function.apply(null, names.concat([body]));
  }

  var fn;
  try {
    fn = build("return (" + source + "\n);");
  } catch (e) {
    try {
      fn = build(source);
    } catch (e2) {
      return { ok: false, text: "SyntaxError: " + e2.message };
    }
  }

  try {
    var result = fn.apply(null, values);
    lastResult = result;
    return { ok: true, value: result, text: inspect(result, 4) };
  } catch (e) {
    // Hermes refuses Function/eval when the runtime was built without it.
    return { ok: false, text: (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : String(e)) };
  }
}

/* ------------------------------------------------------------------ *
 * module registry                                                     *
 * ------------------------------------------------------------------ */

function getRegistry() {
  var m = api.metro;
  if (m && m.modules) return m.modules;
  if (G.modules) return G.modules;
  return null;
}

/** Only read already-initialized modules; forcing lazy ones can have side effects. */
function exportsOf(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  try {
    if (entry.publicModule) {
      if (entry.isInitialized === false) return undefined;
      return entry.publicModule.exports;
    }
    if (entry.isInitialized === false) return undefined;
    if (entry.exports) return entry.exports;
  } catch (e) {}
  return undefined;
}

function moduleLabel(exp) {
  if (!exp) return "";
  try {
    if (typeof exp.getName === "function") return exp.getName();
    if (typeof exp.name === "string" && exp.name) return exp.name;
    if (exp.default && typeof exp.default.name === "string" && exp.default.name) return exp.default.name;
  } catch (e) {}
  return "";
}

function searchModules(query) {
  var registry = getRegistry();
  var results = [];
  if (!registry) return { results: results, scanned: 0, available: false };

  var needle = String(query || "").toLowerCase();
  var ids = Object.keys(registry);
  var scanned = 0;

  for (var i = 0; i < ids.length && results.length < 60; i++) {
    var id = ids[i];
    var exp = exportsOf(registry[id]);
    if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;
    scanned++;
    if (!needle) continue;

    var keys = [];
    try {
      keys = Object.keys(exp);
    } catch (e) {
      continue;
    }

    var label = moduleLabel(exp);
    var hits = keys.filter(function (k) {
      return k.toLowerCase().indexOf(needle) !== -1;
    });

    if (hits.length || (label && label.toLowerCase().indexOf(needle) !== -1)) {
      results.push({
        id: id,
        label: label,
        keyCount: keys.length,
        hits: hits.slice(0, 6),
        keys: keys.slice(0, 120),
        exports: exp
      });
    }
  }

  return { results: results, scanned: scanned, available: true };
}

/* ------------------------------------------------------------------ *
 * lifecycle                                                           *
 * ------------------------------------------------------------------ */

var running = false;

function start() {
  if (running) return;
  applyDefaults();
  patchConsole();
  patchErrors();
  patchNetwork();
  patchWebSocket();
  running = true;

  // Reachable from the Eval tab and from other plugins: `__devtools.logs`, etc.
  G.__devtools = {
    logs: logs,
    requests: requests,
    inspect: inspect,
    runEval: runEval,
    searchModules: searchModules,
    find: findByProps,
    store: findByStoreName
  };

  pushLog("log", ["DevTools attached. Console, errors" +
    (storage.captureNetwork ? ", network" : "") +
    (storage.captureWebSocket ? ", websocket frames" : "") +
    " are being captured."], "devtools");
}

function stop() {
  if (!running) return;
  unpatchWebSocket();
  unpatchNetwork();
  unpatchErrors();
  unpatchConsole();
  try {
    delete G.__devtools;
  } catch (e) {
    G.__devtools = undefined;
  }
  running = false;
}

/* ------------------------------------------------------------------ *
 * ui                                                                  *
 * ------------------------------------------------------------------ */

var h = React ? React.createElement : null;
var TABS = ["Console", "Eval", "Network", "Modules", "Device"];
var evalHistory = [];

function palette(dark) {
  return dark
    ? {
        card: "rgba(255,255,255,0.06)",
        border: "rgba(255,255,255,0.10)",
        text: "#f2f3f5",
        dim: "#b5bac1",
        field: "rgba(0,0,0,0.30)",
        accent: "#5865f2",
        chip: "rgba(255,255,255,0.08)",
        warn: "#f0b232",
        error: "#ed4245",
        good: "#3ba55d"
      }
    : {
        card: "rgba(0,0,0,0.04)",
        border: "rgba(0,0,0,0.10)",
        text: "#060607",
        dim: "#4e5058",
        field: "rgba(0,0,0,0.06)",
        accent: "#5865f2",
        chip: "rgba(0,0,0,0.06)",
        warn: "#a84300",
        error: "#d1242f",
        good: "#1a7f37"
      };
}

function clock(ts) {
  var d = new Date(ts);
  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function SettingsPage() {
  if (!h || !ReactNative) return null;

  var RN = ReactNative;
  var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;
  var scheme = typeof RN.useColorScheme === "function" ? RN.useColorScheme() : "dark";
  var c = palette(scheme !== "light");
  var mono = RN.Platform && RN.Platform.OS === "ios" ? "Menlo" : "monospace";

  var tabState = React.useState("Console");
  var tab = tabState[0];
  var setTab = tabState[1];

  var tickState = React.useState(0);
  var setTick = tickState[1];

  var filterState = React.useState("all");
  var filter = filterState[0];
  var setFilter = filterState[1];

  var queryState = React.useState("");
  var query = queryState[0];
  var setQuery = queryState[1];

  var expandedState = React.useState(null);
  var expanded = expandedState[0];
  var setExpanded = expandedState[1];

  var sourceState = React.useState("");
  var source = sourceState[0];
  var setSource = sourceState[1];

  var resultState = React.useState(null);
  var result = resultState[0];
  var setResult = resultState[1];

  var moduleQueryState = React.useState("");
  var moduleQuery = moduleQueryState[0];
  var setModuleQuery = moduleQueryState[1];

  var selectedModuleState = React.useState(null);
  var selectedModule = selectedModuleState[0];
  var setSelectedModule = selectedModuleState[1];

  var selectedKeyState = React.useState(null);
  var selectedKey = selectedKeyState[0];
  var setSelectedKey = selectedKeyState[1];

  // Live updates while the panel is open.
  React.useEffect(function () {
    return subscribe(function () {
      setTick(function (t) {
        return t + 1;
      });
    });
  }, []);

  function refresh() {
    setTick(function (t) {
      return t + 1;
    });
  }

  /* ---- primitives ---- */

  function Shell(children) {
    return h(
      RN.View,
      {
        style: {
          backgroundColor: c.card,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: c.border,
          marginHorizontal: 12,
          marginTop: 10,
          overflow: "hidden"
        }
      },
      children
    );
  }

  function Divider() {
    return h(RN.View, { style: { height: 1, backgroundColor: c.border } });
  }

  function Caption(text) {
    return h(
      RN.Text,
      { style: { color: c.dim, fontSize: 11, marginHorizontal: 18, marginTop: 8, lineHeight: 15 } },
      text
    );
  }

  function Button(label, onPress, tone) {
    return h(
      Touchable,
      {
        onPress: onPress,
        style: {
          flex: 1,
          backgroundColor: tone === "quiet" ? c.chip : c.accent,
          borderRadius: 10,
          paddingVertical: 11,
          alignItems: "center",
          marginHorizontal: 4
        }
      },
      h(
        RN.Text,
        { style: { color: tone === "quiet" ? c.text : "#ffffff", fontSize: 14, fontWeight: "700" } },
        label
      )
    );
  }

  function ButtonRow(buttons) {
    return h(
      RN.View,
      { style: { flexDirection: "row", paddingHorizontal: 10, paddingVertical: 10 } },
      buttons
    );
  }

  function Chips(options, selected, onSelect, keyPrefix) {
    return h(
      RN.View,
      { style: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 10, paddingTop: 10 } },
      options.map(function (opt) {
        var value = typeof opt === "string" ? opt : opt.value;
        var label = typeof opt === "string" ? opt : opt.label;
        var active = value === selected;
        return h(
          Touchable,
          {
            key: (keyPrefix || "") + String(value),
            onPress: function () {
              onSelect(value);
            },
            style: {
              backgroundColor: active ? c.accent : c.chip,
              borderRadius: 999,
              paddingHorizontal: 13,
              paddingVertical: 6,
              marginRight: 7,
              marginBottom: 8
            }
          },
          h(
            RN.Text,
            { style: { color: active ? "#ffffff" : c.text, fontSize: 13, fontWeight: active ? "700" : "500" } },
            label
          )
        );
      })
    );
  }

  function SearchBox(value, onChange, placeholder) {
    return h(
      RN.View,
      { style: { paddingHorizontal: 10, paddingBottom: 10 } },
      h(RN.TextInput, {
        value: value,
        onChangeText: onChange,
        placeholder: placeholder,
        placeholderTextColor: c.dim,
        autoCapitalize: "none",
        autoCorrect: false,
        style: {
          color: c.text,
          backgroundColor: c.field,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          fontSize: 14
        }
      })
    );
  }

  function Mono(text, color) {
    return h(
      RN.Text,
      {
        selectable: true,
        style: { color: color || c.text, fontSize: 12, fontFamily: mono, lineHeight: 17 }
      },
      text
    );
  }

  function Empty(text) {
    return h(
      RN.Text,
      { style: { color: c.dim, fontSize: 13, textAlign: "center", paddingVertical: 26 } },
      text
    );
  }

  function ToggleRow(label, hint, value, onChange) {
    return h(
      RN.View,
      {
        style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 11 }
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

  /* ---- console ---- */

  function levelColor(level) {
    if (level === "error") return c.error;
    if (level === "warn") return c.warn;
    if (level === "debug") return c.dim;
    return c.good;
  }

  function ConsoleTab() {
    var needle = query.toLowerCase();
    var rows = logs.filter(function (entry) {
      if (filter !== "all" && entry.level !== filter) return false;
      if (needle && entry.summary.toLowerCase().indexOf(needle) === -1) return false;
      return true;
    });
    var visible = rows.slice(-150).reverse();

    return h(
      RN.View,
      null,
      Shell([
        Chips(
          [
            { value: "all", label: "All " + logs.length },
            { value: "log", label: "Log" },
            { value: "warn", label: "Warn" },
            { value: "error", label: "Error" },
            { value: "debug", label: "Debug" }
          ],
          filter,
          setFilter,
          "lvl"
        ),
        SearchBox(query, setQuery, "Filter log text"),
        Divider(),
        visible.length
          ? h(
              RN.View,
              null,
              visible.map(function (entry) {
                var open = expanded === "log" + entry.id;
                return h(
                  Touchable,
                  {
                    key: "log" + entry.id,
                    onPress: function () {
                      setExpanded(open ? null : "log" + entry.id);
                    },
                    onLongPress: function () {
                      copy(entry.detail || entry.summary);
                    },
                    style: { paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.border }
                  },
                  h(
                    RN.View,
                    { style: { flexDirection: "row", alignItems: "center", marginBottom: 3 } },
                    h(
                      RN.Text,
                      { style: { color: levelColor(entry.level), fontSize: 10, fontWeight: "800", letterSpacing: 0.5 } },
                      entry.level.toUpperCase()
                    ),
                    h(RN.Text, { style: { color: c.dim, fontSize: 10, marginLeft: 8 } }, clock(entry.time)),
                    entry.source !== "app"
                      ? h(RN.Text, { style: { color: c.dim, fontSize: 10, marginLeft: 8 } }, entry.source)
                      : null
                  ),
                  h(
                    RN.Text,
                    {
                      numberOfLines: open ? undefined : 3,
                      selectable: open,
                      style: { color: c.text, fontSize: 12, fontFamily: mono, lineHeight: 17 }
                    },
                    open ? entry.detail || entry.summary : entry.summary
                  )
                );
              })
            )
          : Empty(logs.length ? "Nothing matches that filter." : "No output captured yet."),
        ButtonRow([
          Button("Clear", function () {
            logs.length = 0;
            setExpanded(null);
            refresh();
          }, "quiet"),
          Button("Copy visible", function () {
            copy(
              visible
                .slice()
                .reverse()
                .map(function (e) {
                  return clock(e.time) + " [" + e.level + "] " + e.summary;
                })
                .join("\n")
            );
          }, "quiet")
        ])
      ]),
      Caption("Tap a line to expand it, long press to copy. Newest first. Uncaught errors and native crashes land here tagged 'crash'.")
    );
  }

  /* ---- eval ---- */

  function EvalTab() {
    return h(
      RN.View,
      null,
      Shell([
        h(
          RN.View,
          { style: { padding: 10 } },
          h(RN.TextInput, {
            value: source,
            onChangeText: setSource,
            placeholder: "find(\"getCurrentUser\").getCurrentUser()",
            placeholderTextColor: c.dim,
            multiline: true,
            autoCapitalize: "none",
            autoCorrect: false,
            style: {
              color: c.text,
              backgroundColor: c.field,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 10,
              fontSize: 13,
              fontFamily: mono,
              minHeight: 92,
              textAlignVertical: "top"
            }
          })
        ),
        ButtonRow([
          Button("Run", function () {
            if (!source.trim()) return;
            var outcome = runEval(source);
            setResult(outcome);
            if (evalHistory[evalHistory.length - 1] !== source) evalHistory.push(source);
            while (evalHistory.length > 12) evalHistory.shift();
          }),
          Button("Clear", function () {
            setSource("");
            setResult(null);
          }, "quiet")
        ]),
        result
          ? h(
              RN.View,
              null,
              Divider(),
              h(
                RN.ScrollView,
                { style: { maxHeight: 280 }, nestedScrollEnabled: true },
                h(
                  RN.View,
                  { style: { padding: 12 } },
                  Mono(result.text, result.ok ? c.text : c.error)
                )
              ),
              Divider(),
              ButtonRow([
                Button("Copy result", function () {
                  copy(result.text);
                }, "quiet")
              ])
            )
          : null,
        evalHistory.length
          ? h(
              RN.View,
              null,
              Divider(),
              h(
                RN.Text,
                { style: { color: c.dim, fontSize: 11, fontWeight: "700", marginTop: 10, marginLeft: 14 } },
                "HISTORY"
              ),
              h(
                RN.View,
                { style: { paddingBottom: 6 } },
                evalHistory
                  .slice()
                  .reverse()
                  .map(function (snippet, i) {
                    return h(
                      Touchable,
                      {
                        key: "hist" + i,
                        onPress: function () {
                          setSource(snippet);
                        },
                        style: { paddingHorizontal: 14, paddingVertical: 7 }
                      },
                      h(
                        RN.Text,
                        { numberOfLines: 1, style: { color: c.dim, fontSize: 12, fontFamily: mono } },
                        snippet
                      )
                    );
                  })
              )
            )
          : null
      ]),
      Caption(
        "In scope: api, metro, find(...props), store(name), common, React, ReactNative, storage, inspect(v), and $ for the previous result. " +
          "Expressions return their value; multi-line code needs an explicit return."
      )
    );
  }

  /* ---- network ---- */

  function statusColor(entry) {
    if (entry.kind === "ws") return c.dim;
    if (entry.outcome !== "load") return c.error;
    if (entry.status >= 500) return c.error;
    if (entry.status >= 400) return c.warn;
    return c.good;
  }

  function NetworkTab() {
    var needle = query.toLowerCase();
    var rows = requests.filter(function (entry) {
      if (filter === "http" && entry.kind !== "http") return false;
      if (filter === "ws" && entry.kind !== "ws") return false;
      if (needle && entry.url.toLowerCase().indexOf(needle) === -1) return false;
      return true;
    });
    var visible = rows.slice(-150).reverse();

    return h(
      RN.View,
      null,
      Shell([
        Chips(
          [
            { value: "all", label: "All " + requests.length },
            { value: "http", label: "HTTP" },
            { value: "ws", label: "WebSocket" }
          ],
          filter,
          setFilter,
          "net"
        ),
        SearchBox(query, setQuery, "Filter by URL"),
        Divider(),
        visible.length
          ? h(
              RN.View,
              null,
              visible.map(function (entry) {
                var open = expanded === "net" + entry.id;
                var short = entry.url.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
                return h(
                  Touchable,
                  {
                    key: "net" + entry.id,
                    onPress: function () {
                      setExpanded(open ? null : "net" + entry.id);
                    },
                    onLongPress: function () {
                      copy(entry.method + " " + entry.url + "\n\n" + entry.requestBody + "\n\n" + entry.responseBody);
                    },
                    style: { paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.border }
                  },
                  h(
                    RN.View,
                    { style: { flexDirection: "row", alignItems: "center", marginBottom: 3 } },
                    h(
                      RN.Text,
                      { style: { color: statusColor(entry), fontSize: 10, fontWeight: "800" } },
                      entry.kind === "ws" ? "WS" : String(entry.status || entry.outcome)
                    ),
                    h(RN.Text, { style: { color: c.dim, fontSize: 10, marginLeft: 8, fontWeight: "700" } }, entry.method),
                    entry.kind === "http"
                      ? h(RN.Text, { style: { color: c.dim, fontSize: 10, marginLeft: 8 } }, entry.ms + "ms")
                      : null,
                    h(RN.Text, { style: { color: c.dim, fontSize: 10, marginLeft: 8 } }, clock(entry.time))
                  ),
                  h(
                    RN.Text,
                    { numberOfLines: open ? undefined : 2, style: { color: c.text, fontSize: 12, fontFamily: mono } },
                    short
                  ),
                  open
                    ? h(
                        RN.View,
                        { style: { marginTop: 8 } },
                        entry.requestBody
                          ? h(
                              RN.View,
                              { style: { marginBottom: 8 } },
                              h(RN.Text, { style: { color: c.dim, fontSize: 10, fontWeight: "700", marginBottom: 3 } }, "REQUEST"),
                              Mono(entry.requestBody, c.dim)
                            )
                          : null,
                        entry.responseHeaders
                          ? h(
                              RN.View,
                              { style: { marginBottom: 8 } },
                              h(RN.Text, { style: { color: c.dim, fontSize: 10, fontWeight: "700", marginBottom: 3 } }, "RESPONSE HEADERS"),
                              Mono(entry.responseHeaders.trim(), c.dim)
                            )
                          : null,
                        entry.responseBody
                          ? h(
                              RN.View,
                              null,
                              h(RN.Text, { style: { color: c.dim, fontSize: 10, fontWeight: "700", marginBottom: 3 } }, "RESPONSE"),
                              Mono(entry.responseBody)
                            )
                          : null
                      )
                    : null
                );
              })
            )
          : Empty(
              storage.captureNetwork
                ? requests.length
                  ? "Nothing matches that filter."
                  : "No requests captured yet."
                : "Network capture is off. Turn it on in Device."
            ),
        ButtonRow([
          Button("Clear", function () {
            requests.length = 0;
            setExpanded(null);
            refresh();
          }, "quiet"),
          Button("Copy visible", function () {
            copy(
              visible
                .slice()
                .reverse()
                .map(function (e) {
                  return (e.status || e.outcome) + " " + e.method + " " + e.url + " (" + e.ms + "ms)";
                })
                .join("\n")
            );
          }, "quiet")
        ])
      ]),
      Caption(
        "fetch() in React Native runs on XMLHttpRequest, so both show up here. Bodies are truncated to the limit set in Device. " +
          "WebSocket capture records outgoing frames only and is off by default - the gateway is extremely chatty."
      )
    );
  }

  /* ---- modules ---- */

  function ModulesTab() {
    var found = searchModules(moduleQuery);
    var selectedExports = selectedModule ? selectedModule.exports : null;

    function keyDetail() {
      if (!selectedExports || selectedKey === null) return null;
      var value;
      try {
        value = selectedExports[selectedKey];
      } catch (e) {
        return "[reading this key throws: " + e.message + "]";
      }
      if (typeof value === "function") {
        var src;
        try {
          src = String(value);
        } catch (e) {
          src = "[unavailable]";
        }
        return describeFunction(value) + "\n\n" + src;
      }
      return inspect(value, 4);
    }

    return h(
      RN.View,
      null,
      Shell([
        SearchBox(moduleQuery, function (text) {
          setModuleQuery(text);
          setSelectedModule(null);
          setSelectedKey(null);
        }, "Search exports, e.g. getCurrentUser"),
        Divider(),
        !found.available
          ? Empty("No module registry exposed by this mod build.")
          : !moduleQuery
            ? Empty("Scanned " + found.scanned + " initialized modules. Type to search.")
            : !found.results.length
              ? Empty("Nothing in " + found.scanned + " initialized modules exports that.")
              : h(
                  RN.View,
                  null,
                  found.results.map(function (mod) {
                    var open = selectedModule && selectedModule.id === mod.id;
                    return h(
                      RN.View,
                      { key: "mod" + mod.id },
                      h(
                        Touchable,
                        {
                          onPress: function () {
                            setSelectedModule(open ? null : mod);
                            setSelectedKey(null);
                          },
                          style: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border }
                        },
                        h(
                          RN.View,
                          { style: { flexDirection: "row", alignItems: "center" } },
                          h(RN.Text, { style: { color: c.accent, fontSize: 12, fontWeight: "800" } }, "#" + mod.id),
                          mod.label
                            ? h(RN.Text, { style: { color: c.text, fontSize: 12, marginLeft: 8, fontWeight: "600" } }, mod.label)
                            : null,
                          h(RN.Text, { style: { color: c.dim, fontSize: 11, marginLeft: 8 } }, mod.keyCount + " exports")
                        ),
                        mod.hits.length
                          ? h(
                              RN.Text,
                              { numberOfLines: 1, style: { color: c.dim, fontSize: 11, fontFamily: mono, marginTop: 3 } },
                              mod.hits.join(", ")
                            )
                          : null
                      ),
                      open
                        ? h(
                            RN.View,
                            { style: { backgroundColor: c.field, paddingBottom: 8 } },
                            Chips(
                              mod.keys.map(function (k) {
                                return { value: k, label: k };
                              }),
                              selectedKey,
                              setSelectedKey,
                              "key" + mod.id
                            ),
                            selectedKey !== null
                              ? h(
                                  RN.ScrollView,
                                  { style: { maxHeight: 240 }, nestedScrollEnabled: true },
                                  h(RN.View, { style: { paddingHorizontal: 12, paddingVertical: 8 } }, Mono(keyDetail()))
                                )
                              : null,
                            selectedKey !== null
                              ? ButtonRow([
                                  Button("Copy value", function () {
                                    copy(keyDetail());
                                  }, "quiet")
                                ])
                              : null
                          )
                        : null
                    );
                  })
                )
      ]),
      Caption(
        "Only already-initialized modules are read, because forcing a lazy one can run its side effects. " +
          "Function bodies read as [bytecode]: Discord ships Hermes bytecode, and the original source is not in the app to recover."
      )
    );
  }

  /* ---- device ---- */

  function DeviceTab() {
    var info = [];

    function add(label, value) {
      if (value === undefined || value === null || value === "") return;
      info.push([label, String(value)]);
    }

    try {
      var debug = api.debug || {};
      var versions = debug.versions || {};
      add("Discord", versions.discord || (debug.getDebugInfo && debug.getDebugInfo().discord));
      add("React", versions.react || (React && React.version));
      add("React Native", versions.reactNative);
      add("Mod", (api.version || (api.debug && api.debug.version)) || "");
    } catch (e) {}

    try {
      if (RN.Platform) {
        add("Platform", RN.Platform.OS + (RN.Platform.Version ? " " + RN.Platform.Version : ""));
        if (RN.Platform.constants) {
          add("Device", RN.Platform.constants.Model || RN.Platform.constants.Brand);
          add("System", RN.Platform.constants.systemName);
        }
      }
      if (RN.Dimensions) {
        var win = RN.Dimensions.get("window");
        add("Window", Math.round(win.width) + " x " + Math.round(win.height) + " @" + win.scale + "x");
      }
    } catch (e) {}

    try {
      if (G.HermesInternal && typeof G.HermesInternal.getRuntimeProperties === "function") {
        var props = G.HermesInternal.getRuntimeProperties();
        add("Hermes", props["OSS Release Version"] || props.Build || "yes");
        add("Bytecode version", props["Bytecode Version"]);
      } else {
        add("Engine", "JSC (no Hermes)");
      }
    } catch (e) {}

    add("Captured logs", logs.length);
    add("Captured requests", requests.length);

    return h(
      RN.View,
      null,
      Shell([
        h(
          RN.View,
          { style: { paddingHorizontal: 14, paddingVertical: 12 } },
          info.length
            ? info.map(function (row) {
                return h(
                  RN.View,
                  { key: row[0], style: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 } },
                  h(RN.Text, { style: { color: c.dim, fontSize: 13 } }, row[0]),
                  h(RN.Text, { style: { color: c.text, fontSize: 13, fontWeight: "600", flexShrink: 1, textAlign: "right" } }, row[1])
                );
              })
            : Empty("No build info exposed.")
        ),
        Divider(),
        ButtonRow([
          Button("Copy info", function () {
            copy(
              info
                .map(function (r) {
                  return r[0] + ": " + r[1];
                })
                .join("\n")
            );
          }, "quiet")
        ])
      ]),

      Shell([
        h(
          RN.Text,
          { style: { color: c.dim, fontSize: 11, fontWeight: "700", margin: 14, marginBottom: 4 } },
          "REACT DEVTOOLS"
        ),
        h(
          RN.View,
          { style: { paddingHorizontal: 14, paddingBottom: 4 } },
          h(RN.TextInput, {
            value: storage.devtoolsHost || "",
            onChangeText: function (text) {
              storage.devtoolsHost = text;
              refresh();
            },
            placeholder: "192.168.1.20:8097",
            placeholderTextColor: c.dim,
            autoCapitalize: "none",
            autoCorrect: false,
            style: {
              color: c.text,
              backgroundColor: c.field,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              fontSize: 14,
              fontFamily: mono
            }
          })
        ),
        ButtonRow([
          Button("Connect", function () {
            var host = String(storage.devtoolsHost || "").trim();
            if (!host) return toast("Enter host:port first");
            var url = host.indexOf("://") === -1 ? "ws://" + host : host;
            var connect =
              (api.debug && api.debug.connectToDebugger) ||
              (api.debug && api.debug.connectToDevTools) ||
              null;
            if (typeof connect !== "function") {
              toast("This mod build exposes no devtools bridge");
              pushLog("warn", ["No connectToDebugger on api.debug; keys: " + Object.keys(api.debug || {}).join(", ")], "devtools");
              return;
            }
            try {
              connect(url);
              toast("Connecting to " + url);
              pushLog("log", ["React DevTools -> " + url], "devtools");
            } catch (e) {
              toast("Connect failed");
              pushLog("error", ["connectToDebugger failed", e], "devtools");
            }
          })
        ]),
        Caption(
          "Run `npx react-devtools` on your Mac, put its LAN address here, and you get the real component tree with props and state - " +
            "the closest thing to Safari's element inspector for a React Native app."
        ),
        h(RN.View, { style: { height: 10 } })
      ]),

      Shell([
        ToggleRow("Capture console", "console.log / warn / error", storage.captureConsole, function (v) {
          storage.captureConsole = v;
          if (v) patchConsole();
          else unpatchConsole();
          refresh();
        }),
        Divider(),
        ToggleRow("Capture uncaught errors", "Global handler, including fatals", storage.captureErrors, function (v) {
          storage.captureErrors = v;
          if (v) patchErrors();
          else unpatchErrors();
          refresh();
        }),
        Divider(),
        ToggleRow("Capture network", "HTTP via XMLHttpRequest and fetch", storage.captureNetwork, function (v) {
          storage.captureNetwork = v;
          if (v) patchNetwork();
          else unpatchNetwork();
          refresh();
        }),
        Divider(),
        ToggleRow("Capture websocket frames", "Outgoing only, very noisy", storage.captureWebSocket, function (v) {
          storage.captureWebSocket = v;
          if (v) patchWebSocket();
          else unpatchWebSocket();
          refresh();
        }),
        Divider(),
        h(
          RN.View,
          { style: { paddingHorizontal: 14, paddingVertical: 10 } },
          h(RN.Text, { style: { color: c.dim, fontSize: 12, fontWeight: "600", marginBottom: 6 } }, "Buffer size (entries)"),
          h(RN.TextInput, {
            value: String(storage.maxEntries),
            onChangeText: function (text) {
              var digits = text.replace(/[^0-9]/g, "");
              storage.maxEntries = digits === "" ? "" : Number(digits);
              refresh();
            },
            keyboardType: "number-pad",
            placeholderTextColor: c.dim,
            style: {
              color: c.text,
              backgroundColor: c.field,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              fontSize: 14
            }
          })
        )
      ])
    );
  }

  /* ---- shell ---- */

  var body =
    tab === "Console"
      ? ConsoleTab()
      : tab === "Eval"
        ? EvalTab()
        : tab === "Network"
          ? NetworkTab()
          : tab === "Modules"
            ? ModulesTab()
            : DeviceTab();

  return h(
    RN.ScrollView,
    { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 60 }, keyboardShouldPersistTaps: "handled" },
    h(
      RN.View,
      { style: { paddingTop: 8 } },
      Chips(
        TABS,
        tab,
        function (value) {
          setTab(value);
          setExpanded(null);
          setFilter("all");
          setQuery("");
        },
        "tab"
      )
    ),
    body
  );
}

/* ------------------------------------------------------------------ *
 * plugin exports                                                      *
 * ------------------------------------------------------------------ */

function onLoad() {
  try {
    start();
  } catch (e) {
    if (originalConsole.error) originalConsole.error("[devtools] onLoad failed", e);
  }
}

function onUnload() {
  try {
    stop();
  } catch (e) {}
}

var plugin = {
  onLoad: onLoad,
  onUnload: onUnload,
  settings: SettingsPage
};

// Loaders in this family read either the module itself or its default export.
plugin.default = plugin;
module.exports = plugin;
