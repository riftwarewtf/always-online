/**
 * Toolbox
 * A configurable message toolkit for Kettu (also loads on Bunny / Vendetta).
 *
 * Every feature is an independent row that appears in the message long-press
 * sheet, and every one of them can be switched off in settings. The headline
 * two are the ones iOS never got: copying the text out of an embed, and reading
 * a text attachment without downloading it.
 *
 * Three ways to reach the same actions, because patching Discord's action sheet
 * is the part most likely to break on a client update:
 *
 *   1. rows injected into the message long-press sheet (the normal path)
 *   2. the Grab tab in settings, which reads the current channel straight out
 *      of MessageStore and needs no patches at all
 *   3. /embed and /preview slash commands
 *
 * Nothing here throws into Discord's render: the row component catches its own
 * errors, every module lookup degrades to a disabled row, and the Status tab
 * reports exactly which patches landed.
 */

/* ------------------------------------------------------------------ *
 * runtime api resolution                                              *
 * ------------------------------------------------------------------ */

var G = typeof globalThis !== "undefined" ? globalThis : window;

/**
 * Kettu evaluates a Vendetta-format plugin as `vendetta => { return <bundle> }`,
 * so the per-plugin api object - the only one carrying real persistent storage -
 * arrives as a function parameter in our enclosing scope, not as a global. The
 * globals exist too but their `plugin` key does not, which is why this has to be
 * checked by identifier and not by property lookup.
 */
var injected = null;
try {
  if (typeof vendetta !== "undefined" && vendetta) injected = vendetta;
} catch (e) {}
try {
  if (!injected && typeof bunny !== "undefined" && bunny && bunny.plugin) injected = bunny;
} catch (e) {}

var api = injected || G.kettu || G.bunny || G.vendetta || {};

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

function getPatcher() {
  // Vendetta exposes patcher at the top level, Bunny nests it under api.
  if (api.patcher && typeof api.patcher.after === "function") return api.patcher;
  if (api.api && api.api.patcher && typeof api.api.patcher.after === "function") return api.api.patcher;
  return null;
}

var common = (api.metro && api.metro.common) || {};
var React = common.React || G.React || findByProps("createElement", "useState");
var ReactNative = common.ReactNative || findByProps("ScrollView", "StyleSheet", "AppState");
var h = React ? React.createElement : null;

// The injected object's plugin.storage is an auto-persisting proxy backed by MMKV.
// Without it we still run, but settings last only until the app restarts.
var storage = (injected && injected.plugin && injected.plugin.storage) || null;
var storageIsPersistent = !!storage;
if (!storage) storage = {};

/** Lazily resolved and cached, so a module that is not initialized yet is retried. */
var cache = {};
function lazy(name, resolver) {
  if (cache[name] === undefined) {
    try {
      cache[name] = resolver() || null;
    } catch (e) {
      cache[name] = null;
    }
  }
  return cache[name];
}

function MessageStore() {
  return lazy("MessageStore", function () {
    return findByStoreName("MessageStore");
  });
}
function ChannelStore() {
  return lazy("ChannelStore", function () {
    return findByStoreName("ChannelStore");
  });
}
function SelectedChannelStore() {
  return lazy("SelectedChannelStore", function () {
    return findByStoreName("SelectedChannelStore");
  });
}
function UserStore() {
  return lazy("UserStore", function () {
    return findByStoreName("UserStore");
  });
}
function ActionSheetModule() {
  return lazy("ActionSheet", function () {
    return findByProps("openLazy", "hideActionSheet");
  });
}
function FluxDispatcher() {
  return lazy("FluxDispatcher", function () {
    return common.FluxDispatcher || findByProps("dispatch", "subscribe", "_subscriptions");
  });
}
function TypingModule() {
  return lazy("Typing", function () {
    return findByProps("startTyping", "stopTyping");
  });
}
function FormRow() {
  return lazy("FormRow", function () {
    var mod = findByProps("FormRow");
    return mod && mod.FormRow;
  });
}

function clipboard() {
  return common.clipboard || findByProps("setString", "getString");
}

function assetId(name) {
  try {
    var assets = (api.ui && api.ui.assets) || api.assets;
    if (assets && typeof assets.getAssetIDByName === "function") return assets.getAssetIDByName(name);
  } catch (e) {}
  return undefined;
}

function toast(text) {
  try {
    var t = (api.ui && api.ui.toasts) || api.toasts;
    if (t && typeof t.showToast === "function") t.showToast(text);
    else if (t && typeof t.open === "function") t.open({ content: text });
  } catch (e) {}
}

function note(text) {
  if (storage.toasts !== false) toast(text);
}

function copy(text, label) {
  var cb = clipboard();
  if (cb && typeof cb.setString === "function") {
    cb.setString(String(text));
    note(label || "Copied");
    return true;
  }
  toast("No clipboard module found");
  return false;
}

function log() {
  // Goes through the real console so the DevTools plugin picks it up.
  try {
    var args = ["[toolbox]"].concat(Array.prototype.slice.call(arguments));
    if (G.console && G.console.log) G.console.log.apply(G.console, args);
  } catch (e) {}
}

/* ------------------------------------------------------------------ *
 * settings defaults                                                   *
 * ------------------------------------------------------------------ */

var DEFAULTS = {
  // sheet rows
  copyEmbed: true,
  previewFile: true,
  copyFileUrl: true,
  copyContent: true,
  copyCode: true,
  copyJson: false,
  copyIds: true,
  copyLink: true,
  copyAvatar: false,
  copySticker: true,
  copyTime: false,
  // behaviour
  embedUrls: true,
  previewLimit: 200000,
  nativeRows: false,
  rowsAtTop: false,
  sheetRows: true,
  commands: true,
  silentTyping: false,
  logDeletes: true,
  logEdits: true,
  archiveLimit: 200,
  overlay: true,
  toasts: true
};

function applyDefaults() {
  for (var key in DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
    if (typeof storage[key] === "undefined") storage[key] = DEFAULTS[key];
  }
}

/* ------------------------------------------------------------------ *
 * small helpers                                                       *
 * ------------------------------------------------------------------ */

function pick(object, a, b, c) {
  if (!object) return undefined;
  if (object[a] !== undefined && object[a] !== null && object[a] !== "") return object[a];
  if (b && object[b] !== undefined && object[b] !== null && object[b] !== "") return object[b];
  if (c && object[c] !== undefined && object[c] !== null && object[c] !== "") return object[c];
  return undefined;
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function clock(ts) {
  var d = new Date(ts);
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function stamp(ts) {
  var d = new Date(ts);
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + clock(ts)
  );
}

function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function truncate(text, limit) {
  text = String(text);
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n\n… truncated, " + (text.length - limit) + " more characters";
}

/**
 * Discord snowflakes carry their own creation time, which is more reliable than
 * message.timestamp - that is a moment-like object on mobile, not a string.
 * The id exceeds 2^53 but the division makes the rounding error microseconds.
 */
function snowflakeTime(id) {
  var n = Number(id);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 4194304) + 1420070400000;
}

function safeStringify(value, limit) {
  var seen = [];
  var text;
  try {
    text = JSON.stringify(
      value,
      function (key, val) {
        if (typeof val === "function") return "[function " + (val.name || "anonymous") + "]";
        if (typeof val === "bigint") return String(val) + "n";
        if (val && typeof val === "object") {
          if (seen.indexOf(val) !== -1) return "[circular]";
          if (seen.length > 4000) return "[elided]";
          seen.push(val);
        }
        return val;
      },
      2
    );
  } catch (e) {
    text = "could not serialise: " + (e && e.message);
  }
  return truncate(text === undefined ? "undefined" : text, limit || 100000);
}

/* ------------------------------------------------------------------ *
 * message extraction                                                  *
 * ------------------------------------------------------------------ */

/** The long-press sheet's props have carried the message under a few shapes. */
function resolveMessage(props) {
  if (!props) return null;
  var m = props.message || props.msg || null;
  if (!m && props.messages && props.messages.length) m = props.messages[0];
  if (m && !m.id && m.message) m = m.message;
  return m && m.id ? m : null;
}

function contextFor(message, channelId) {
  var cid = channelId || message.channel_id || message.channelId || "";
  var channel = null;
  try {
    var cs = ChannelStore();
    if (cs && cid) channel = cs.getChannel(cid);
  } catch (e) {}
  return {
    message: message,
    channelId: cid,
    channel: channel,
    guildId: (channel && (channel.guild_id || channel.guildId)) || null
  };
}

function authorOf(message) {
  return message.author || message.user || {};
}

function authorName(message) {
  var a = authorOf(message);
  return pick(a, "globalName", "global_name") || a.username || a.nick || "unknown";
}

function attachmentsOf(message) {
  var list = message.attachments || message.attachment || [];
  if (!list || typeof list.length !== "number") return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i] || {};
    out.push({
      id: a.id,
      filename: a.filename || a.name || "file",
      size: Number(a.size) || 0,
      url: a.url || a.proxy_url || a.proxyUrl || "",
      contentType: a.content_type || a.contentType || "",
      width: a.width,
      height: a.height
    });
  }
  return out;
}

var TEXT_EXTENSIONS = [
  "txt", "log", "md", "markdown", "json", "jsonc", "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "css", "scss", "less", "html", "htm", "xml", "svg", "yml", "yaml", "toml", "ini", "cfg",
  "conf", "properties", "env", "csv", "tsv", "sh", "bash", "zsh", "fish", "bat", "ps1",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cc", "cs",
  "php", "sql", "lua", "gd", "vb", "r", "pl", "patch", "diff", "gitignore", "gitattributes",
  "dockerfile", "makefile", "gradle", "srt", "vtt", "lrc", "nfo", "asm", "s"
];

function extensionOf(filename) {
  var name = String(filename || "").toLowerCase();
  var dot = name.lastIndexOf(".");
  if (dot === -1) return name;
  return name.slice(dot + 1);
}

function isTextual(attachment) {
  var type = String(attachment.contentType || "").toLowerCase();
  if (type.indexOf("text/") === 0) return true;
  if (type.indexOf("json") !== -1 || type.indexOf("xml") !== -1) return true;
  if (type.indexOf("javascript") !== -1 || type.indexOf("x-sh") !== -1) return true;
  return TEXT_EXTENSIONS.indexOf(extensionOf(attachment.filename)) !== -1;
}

function stickersOf(message) {
  var items = message.stickerItems || message.sticker_items || message.stickers || [];
  if (!items || typeof items.length !== "number") return [];
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var s = items[i] || {};
    var format = Number(s.format_type || s.formatType || s.format || 1);
    var ext = format === 3 ? ".json" : format === 4 ? ".gif" : ".png";
    out.push({ name: s.name || s.id, url: "https://media.discordapp.net/stickers/" + s.id + ext });
  }
  return out;
}

var EMOJI_RE = /<(a?):([A-Za-z0-9_~]+):(\d+)>/g;

function emojisOf(message) {
  var out = [];
  var content = message.content || "";
  EMOJI_RE.lastIndex = 0;
  var match;
  while ((match = EMOJI_RE.exec(content))) {
    out.push({
      name: match[2],
      url:
        "https://cdn.discordapp.com/emojis/" + match[3] + (match[1] === "a" ? ".gif" : ".png") + "?size=4096"
    });
  }
  return out;
}

function avatarUrl(user) {
  if (!user || !user.id) return "";
  if (user.avatar) {
    var animated = String(user.avatar).indexOf("a_") === 0;
    return (
      "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + (animated ? ".gif" : ".png") +
      "?size=4096"
    );
  }
  var index = 0;
  try {
    // Pomelo users index by id, legacy ones by discriminator.
    if (user.discriminator && user.discriminator !== "0") index = Number(user.discriminator) % 5;
    else index = Math.floor(snowflakeTime(user.id) / 1000) % 6;
  } catch (e) {}
  return "https://cdn.discordapp.com/embed/avatars/" + index + ".png";
}

function codeblocksOf(message) {
  var content = message.content || "";
  var re = /```[A-Za-z0-9_+\-#.]*\r?\n?([\s\S]*?)```/g;
  var out = [];
  var match;
  while ((match = re.exec(content))) {
    var body = match[1];
    if (body !== undefined && String(body).trim()) out.push(String(body).replace(/\s+$/, ""));
  }
  if (!out.length) {
    // Fall back to inline code spans, which is what short snippets usually are.
    var inline = /`([^`\n]+)`/g;
    while ((match = inline.exec(content))) out.push(match[1]);
  }
  return out;
}

function embedsOf(message) {
  var list = message.embeds || [];
  return list && typeof list.length === "number" ? list : [];
}

/** Flattens one embed into the text a human would want on their clipboard. */
function embedToText(embed, withUrls) {
  var lines = [];
  var author = embed.author || {};
  var embedAuthor = pick(author, "name", "rawName");
  if (embedAuthor) lines.push(embedAuthor + (withUrls && author.url ? " <" + author.url + ">" : ""));

  var title = pick(embed, "rawTitle", "title");
  if (title) lines.push(title);
  if (withUrls && embed.url) lines.push(embed.url);

  var description = pick(embed, "rawDescription", "description");
  if (description) {
    if (lines.length) lines.push("");
    lines.push(description);
  }

  var fields = embed.fields || [];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i] || {};
    var name = pick(field, "rawName", "name") || "";
    var value = pick(field, "rawValue", "value") || "";
    lines.push("");
    lines.push(name ? name + ":" : "-");
    if (value) lines.push(value);
  }

  var footer = embed.footer || {};
  var footerText = pick(footer, "text", "rawText");
  var ts = embed.timestamp;
  if (footerText || ts) {
    var tail = footerText || "";
    if (ts) {
      var asText = "";
      try {
        asText = typeof ts === "string" ? ts : typeof ts.toISOString === "function" ? ts.toISOString() : String(ts);
      } catch (e) {}
      if (asText) tail = tail ? tail + " · " + asText : asText;
    }
    lines.push("");
    lines.push(tail);
  }

  if (withUrls) {
    var image = embed.image || (embed.images && embed.images[0]);
    if (image && (image.url || image.proxyURL || image.proxy_url)) {
      lines.push("");
      lines.push("image: " + (image.url || image.proxyURL || image.proxy_url));
    }
    var thumb = embed.thumbnail;
    if (thumb && (thumb.url || thumb.proxyURL || thumb.proxy_url)) {
      lines.push("thumbnail: " + (thumb.url || thumb.proxyURL || thumb.proxy_url));
    }
    var video = embed.video;
    if (video && (video.url || video.proxyURL || video.proxy_url)) {
      lines.push("video: " + (video.url || video.proxyURL || video.proxy_url));
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
}

function allEmbedsText(message, withUrls) {
  var list = embedsOf(message);
  var parts = [];
  for (var i = 0; i < list.length; i++) {
    var text = embedToText(list[i], withUrls);
    if (text) parts.push(list.length > 1 ? "— embed " + (i + 1) + " —\n" + text : text);
  }
  return parts.join("\n\n");
}

function messageLink(ctx) {
  var scope = ctx.guildId || "@me";
  return "https://discord.com/channels/" + scope + "/" + ctx.channelId + "/" + ctx.message.id;
}

function describeMessage(message) {
  var content = (message.content || "").replace(/\s+/g, " ").trim();
  if (content) return content.slice(0, 120);
  var atts = attachmentsOf(message);
  if (atts.length) return atts.length + " attachment" + (atts.length > 1 ? "s" : "") + ": " + atts[0].filename;
  var embeds = embedsOf(message);
  if (embeds.length) {
    var title = pick(embeds[0], "rawTitle", "title") || pick(embeds[0], "rawDescription", "description");
    return embeds.length + " embed" + (embeds.length > 1 ? "s" : "") + (title ? ": " + String(title).slice(0, 90) : "");
  }
  var stickers = stickersOf(message);
  if (stickers.length) return "sticker: " + stickers[0].name;
  return "(no text)";
}

/* ------------------------------------------------------------------ *
 * channel reads that need no patches                                  *
 * ------------------------------------------------------------------ */

function findByName(name, defaultExport) {
  var m = api.metro;
  if (!m) return undefined;
  try {
    if (typeof m.findByName === "function") return m.findByName(name, defaultExport);
    var byName = m.filters && m.filters.byName;
    if (byName) {
      var filter = byName(name, defaultExport);
      if (typeof m.findExports === "function") return m.findExports(filter);
      if (typeof m.find === "function") return m.find(filter);
    }
  } catch (e) {}
  return undefined;
}

function currentChannelId() {
  try {
    var store = SelectedChannelStore();
    if (store && typeof store.getChannelId === "function") return store.getChannelId();
  } catch (e) {}
  return null;
}

/** MessageStore hands back a collection, not an array, and its shape varies. */
function channelMessages(channelId) {
  var store = MessageStore();
  if (!store || !channelId) return [];
  var set = null;
  try {
    set = store.getMessages(channelId);
  } catch (e) {}
  if (!set) return [];
  try {
    if (typeof set.toArray === "function") return set.toArray() || [];
    if (Array.isArray(set._array)) return set._array;
    if (Array.isArray(set)) return set;
  } catch (e) {}
  return [];
}

function newestMatching(test) {
  var channelId = currentChannelId();
  var list = channelMessages(channelId);
  for (var i = list.length - 1; i >= 0; i--) {
    var message = list[i];
    if (!message || !message.id) continue;
    var ctx = contextFor(message, channelId);
    try {
      if (test(ctx)) return ctx;
    } catch (e) {}
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * reading a file without downloading it                               *
 * ------------------------------------------------------------------ */

/**
 * Asks the CDN for only the first `limit` bytes. Discord honours Range, but if
 * it ever stops doing so the body is truncated on this side instead.
 */
function fetchText(url, limit, done) {
  var capped = Math.max(1000, Number(limit) || DEFAULTS.previewLimit);
  var range = "bytes=0-" + (capped - 1);

  if (typeof G.fetch === "function") {
    try {
      G.fetch(url, { headers: { Range: range } })
        .then(function (res) {
          if (res.status >= 400) throw new Error("HTTP " + res.status);
          return res.text();
        })
        .then(function (text) {
          done(null, truncate(text, capped));
        })
        .catch(function (e) {
          done(e || new Error("request failed"));
        });
      return;
    } catch (e) {
      /* fall through to XHR */
    }
  }

  try {
    var xhr = new G.XMLHttpRequest();
    xhr.open("GET", url);
    try {
      xhr.setRequestHeader("Range", range);
    } catch (e) {}
    xhr.onload = function () {
      if (xhr.status >= 400) done(new Error("HTTP " + xhr.status));
      else done(null, truncate(xhr.responseText || "", capped));
    };
    xhr.onerror = function () {
      done(new Error("request failed"));
    };
    xhr.send();
  } catch (e) {
    done(e);
  }
}

/* ------------------------------------------------------------------ *
 * viewer                                                              *
 * ------------------------------------------------------------------ */

var viewer = null;
var viewerListeners = [];
var settingsMounted = 0;

function viewerChanged() {
  for (var i = 0; i < viewerListeners.length; i++) {
    try {
      viewerListeners[i]();
    } catch (e) {}
  }
}

function subscribeViewer(fn) {
  viewerListeners.push(fn);
  return function () {
    var i = viewerListeners.indexOf(fn);
    if (i !== -1) viewerListeners.splice(i, 1);
  };
}

function setViewer(next) {
  viewer = next;
  viewerChanged();
}

function closeViewer() {
  setViewer(null);
}

/** The overlay host is what lets a modal open from the action sheet. */
function viewerAvailable() {
  return overlayMountState === "mounted" || settingsMounted > 0;
}

/** Falls back to the clipboard when there is nowhere to draw a modal. */
function showText(title, subtitle, body) {
  if (!body) {
    note("Nothing to show");
    return;
  }
  if (!viewerAvailable()) {
    copy(body, "No viewer mounted - copied instead");
    return;
  }
  setViewer({ kind: "text", title: title, subtitle: subtitle, body: body });
}

function previewAttachment(att) {
  var limit = Number(storage.previewLimit) || DEFAULTS.previewLimit;
  var live = viewerAvailable();
  if (live) {
    setViewer({ kind: "text", title: att.filename, subtitle: bytes(att.size) + " · reading…", body: "", loading: true });
  } else {
    note("Reading " + att.filename + "…");
  }
  fetchText(att.url, limit, function (err, text) {
    if (err) {
      var message = "Could not read this file.\n\n" + ((err && err.message) || err) + "\n\n" + att.url;
      if (live) setViewer({ kind: "text", title: att.filename, subtitle: "failed", body: message });
      else toast("Preview failed: " + ((err && err.message) || "unknown"));
      return;
    }
    var subtitle = bytes(att.size) + (att.contentType ? " · " + att.contentType : "");
    if (live) setViewer({ kind: "text", title: att.filename, subtitle: subtitle, body: text || "(empty file)" });
    else copy(text || "", "Copied " + att.filename);
  });
}

/* ------------------------------------------------------------------ *
 * features                                                            *
 * ------------------------------------------------------------------ */

/**
 * One table drives all three entry points: the action sheet rows, the Grab tab
 * and the toggles in settings. `match` decides whether a row is worth showing
 * for a given message, `run` is the action.
 */
var FEATURES = [
  {
    key: "copyEmbed",
    label: "Copy embed content",
    hint: "Title, description, every field, footer - as text",
    icon: "ic_message_copy",
    match: function (ctx) {
      return embedsOf(ctx.message).length > 0;
    },
    run: function (ctx) {
      var text = allEmbedsText(ctx.message, storage.embedUrls !== false);
      if (!text) {
        note("That embed carries no text");
        return;
      }
      copy(text, "Embed copied");
    }
  },
  {
    key: "copyEmbed",
    label: "View embed content",
    hint: null,
    secondary: true,
    icon: "ic_eye",
    match: function (ctx) {
      return embedsOf(ctx.message).length > 0;
    },
    run: function (ctx) {
      var text = allEmbedsText(ctx.message, storage.embedUrls !== false);
      showText("Embed", embedsOf(ctx.message).length + " embed(s)", text);
    }
  },
  {
    key: "previewFile",
    label: "Preview file contents",
    hint: "Reads text attachments in-app, first 200 KB",
    icon: "ic_file_text",
    match: function (ctx) {
      var atts = attachmentsOf(ctx.message);
      for (var i = 0; i < atts.length; i++) if (isTextual(atts[i])) return true;
      return false;
    },
    run: function (ctx) {
      var textual = [];
      var atts = attachmentsOf(ctx.message);
      for (var i = 0; i < atts.length; i++) if (isTextual(atts[i])) textual.push(atts[i]);
      if (!textual.length) {
        note("No text file on this message");
        return;
      }
      if (textual.length === 1) {
        previewAttachment(textual[0]);
        return;
      }
      if (!viewerAvailable()) {
        previewAttachment(textual[0]);
        return;
      }
      setViewer({ kind: "files", title: "Preview file", subtitle: textual.length + " text files", items: textual });
    }
  },
  {
    key: "copyFileUrl",
    label: "Copy file URL",
    hint: "Every attachment on the message, one per line",
    icon: "ic_link",
    match: function (ctx) {
      return attachmentsOf(ctx.message).length > 0;
    },
    run: function (ctx) {
      var atts = attachmentsOf(ctx.message);
      var lines = [];
      for (var i = 0; i < atts.length; i++) lines.push(atts[i].url);
      copy(lines.join("\n"), atts.length > 1 ? atts.length + " URLs copied" : "URL copied");
    }
  },
  {
    key: "copyContent",
    label: "Copy message text",
    hint: "The raw markdown, as it was typed",
    icon: "ic_message_copy",
    match: function (ctx) {
      return !!(ctx.message.content && String(ctx.message.content).length);
    },
    run: function (ctx) {
      copy(ctx.message.content, "Text copied");
    }
  },
  {
    key: "copyCode",
    label: "Copy code blocks",
    hint: "Code only, fences stripped",
    icon: "ic_code",
    match: function (ctx) {
      return codeblocksOf(ctx.message).length > 0;
    },
    run: function (ctx) {
      var blocks = codeblocksOf(ctx.message);
      copy(blocks.join("\n\n"), blocks.length > 1 ? blocks.length + " blocks copied" : "Code copied");
    }
  },
  {
    key: "copyJson",
    label: "Copy message JSON",
    hint: "The whole message object, for debugging",
    icon: "ic_code",
    match: function () {
      return true;
    },
    run: function (ctx) {
      copy(safeStringify(ctx.message, 200000), "JSON copied");
    }
  },
  {
    key: "copyJson",
    label: "View message JSON",
    hint: null,
    secondary: true,
    icon: "ic_code",
    match: function () {
      return true;
    },
    run: function (ctx) {
      showText("Message JSON", ctx.message.id, safeStringify(ctx.message, 200000));
    }
  },
  {
    key: "copyIds",
    label: "Copy IDs",
    hint: "Message, channel, server and author",
    icon: "ic_id_card",
    match: function () {
      return true;
    },
    run: function (ctx) {
      var author = authorOf(ctx.message);
      var lines = [
        "message " + ctx.message.id,
        "channel " + ctx.channelId,
        "guild   " + (ctx.guildId || "(dm)"),
        "author  " + (author.id || "?") + " (" + authorName(ctx.message) + ")"
      ];
      copy(lines.join("\n"), "IDs copied");
    }
  },
  {
    key: "copyLink",
    label: "Copy message link",
    hint: null,
    icon: "ic_link",
    match: function (ctx) {
      return !!ctx.channelId;
    },
    run: function (ctx) {
      copy(messageLink(ctx), "Link copied");
    }
  },
  {
    key: "copyAvatar",
    label: "Copy avatar URL",
    hint: "Full size, animated when the user has one",
    icon: "ic_person",
    match: function (ctx) {
      return !!authorOf(ctx.message).id;
    },
    run: function (ctx) {
      var author = authorOf(ctx.message);
      var user = author;
      try {
        var store = UserStore();
        if (store && typeof store.getUser === "function") user = store.getUser(author.id) || author;
      } catch (e) {}
      copy(avatarUrl(user), "Avatar URL copied");
    }
  },
  {
    key: "copySticker",
    label: "Copy sticker / emoji URL",
    hint: "Stickers and every custom emoji in the text",
    icon: "ic_emoji",
    match: function (ctx) {
      return stickersOf(ctx.message).length > 0 || emojisOf(ctx.message).length > 0;
    },
    run: function (ctx) {
      var items = stickersOf(ctx.message).concat(emojisOf(ctx.message));
      var lines = [];
      for (var i = 0; i < items.length; i++) {
        lines.push(items.length > 1 ? items[i].name + ": " + items[i].url : items[i].url);
      }
      copy(lines.join("\n"), lines.length > 1 ? lines.length + " URLs copied" : "URL copied");
    }
  },
  {
    key: "copyTime",
    label: "Copy timestamp",
    hint: "Exact send time, from the message id",
    icon: "ic_clock",
    match: function () {
      return true;
    },
    run: function (ctx) {
      var ms = snowflakeTime(ctx.message.id);
      var lines = [
        stamp(ms),
        new Date(ms).toISOString(),
        "<t:" + Math.floor(ms / 1000) + ":f>"
      ];
      copy(lines.join("\n"), "Timestamp copied");
    }
  }
];

/** Toggle rows are one per key; the table holds secondary actions per key too. */
var FEATURE_KEYS = [];
(function () {
  for (var i = 0; i < FEATURES.length; i++) {
    if (FEATURES[i].secondary) continue;
    FEATURE_KEYS.push(FEATURES[i]);
  }
})();

function activeFeatures(ctx) {
  var out = [];
  for (var i = 0; i < FEATURES.length; i++) {
    var feature = FEATURES[i];
    if (!storage[feature.key]) continue;
    try {
      if (!feature.match(ctx)) continue;
    } catch (e) {
      continue;
    }
    out.push(feature);
  }
  return out;
}

function runFeature(feature, ctx) {
  try {
    feature.run(ctx);
  } catch (e) {
    log("feature failed", feature.label, e);
    toast(feature.label + " failed: " + ((e && e.message) || "unknown"));
  }
}

/* ------------------------------------------------------------------ *
 * archive of deletes and edits                                        *
 * ------------------------------------------------------------------ */

var archive = [];
var archiveListeners = [];
var archiveSeq = 0;

function archiveChanged() {
  for (var i = 0; i < archiveListeners.length; i++) {
    try {
      archiveListeners[i]();
    } catch (e) {}
  }
}

function subscribeArchive(fn) {
  archiveListeners.push(fn);
  return function () {
    var i = archiveListeners.indexOf(fn);
    if (i !== -1) archiveListeners.splice(i, 1);
  };
}

function pushArchive(entry) {
  entry.key = ++archiveSeq;
  entry.at = Date.now();
  archive.unshift(entry);
  var limit = Math.max(10, Number(storage.archiveLimit) || DEFAULTS.archiveLimit);
  if (archive.length > limit) archive.length = limit;
  archiveChanged();
}

function archiveFrom(message, kind, extra) {
  var atts = attachmentsOf(message);
  var names = [];
  for (var i = 0; i < atts.length; i++) names.push(atts[i].filename);
  var entry = {
    kind: kind,
    id: message.id,
    channelId: message.channel_id || message.channelId || "",
    author: authorName(message),
    authorId: authorOf(message).id || "",
    content: message.content || "",
    attachments: names,
    urls: atts.map(function (a) {
      return a.url;
    }),
    embeds: embedsOf(message).length,
    sentAt: snowflakeTime(message.id)
  };
  if (extra) for (var key in extra) entry[key] = extra[key];
  pushArchive(entry);
}

function captureEvent(event) {
  if (!event || !event.type) return;
  var type = event.type;
  if (type !== "MESSAGE_DELETE" && type !== "MESSAGE_DELETE_BULK" && type !== "MESSAGE_UPDATE") return;

  var store = MessageStore();
  if (!store || typeof store.getMessage !== "function") return;

  if (type === "MESSAGE_DELETE") {
    if (!storage.logDeletes) return;
    var channelId = event.channelId || event.channel_id;
    // Read before the stores do, which is the only moment the body still exists.
    var gone = store.getMessage(channelId, event.id);
    if (gone) archiveFrom(gone, "delete");
    return;
  }

  if (type === "MESSAGE_DELETE_BULK") {
    if (!storage.logDeletes) return;
    var ids = event.ids || [];
    var bulkChannel = event.channelId || event.channel_id;
    for (var i = 0; i < ids.length && i < 50; i++) {
      var one = store.getMessage(bulkChannel, ids[i]);
      if (one) archiveFrom(one, "delete");
    }
    return;
  }

  if (!storage.logEdits) return;
  var next = event.message;
  if (!next || !next.id) return;
  var previous = store.getMessage(next.channel_id || next.channelId, next.id);
  if (!previous) return;
  var before = previous.content || "";
  var after = next.content;
  // MESSAGE_UPDATE also fires for embed resolution, which is not an edit.
  if (typeof after !== "string" || after === before) return;
  archiveFrom(previous, "edit", { before: before, after: after, content: after });
}

/* ------------------------------------------------------------------ *
 * patches                                                            *
 * ------------------------------------------------------------------ */

var sheetUnpatch = null;
var sheetState = "not started";
var sheetStrategy = "";
var sheetRetryTimer = null;
var sheetRetries = 0;

var typingUnpatch = null;
var typingState = "off";

var fluxUnpatch = null;
var fluxState = "off";

var commandHandles = [];
var commandState = "off";

function hideSheet() {
  try {
    var mod = ActionSheetModule();
    if (mod && typeof mod.hideActionSheet === "function") mod.hideActionSheet();
  } catch (e) {}
}

function elementName(node) {
  if (!node || typeof node !== "object") return "";
  var type = node.type;
  if (!type) return "";
  if (typeof type === "string") return type;
  return type.displayName || type.name || "";
}

/**
 * Finds the array of children that holds the sheet's rows, scoring candidates so
 * a stray array of text nodes is never mistaken for the row list. Bounded visit
 * count: this runs inside Discord's render and must never hang it.
 */
function findRowContainer(root) {
  var queue = [root];
  var seen = [];
  var best = null;
  var bestScore = 0;
  var visits = 0;

  while (queue.length && visits < 3000) {
    var node = queue.shift();
    visits++;
    if (!node || typeof node !== "object") continue;
    if (seen.indexOf(node) !== -1) continue;
    seen.push(node);

    if (Array.isArray(node)) {
      var elements = 0;
      var rowish = 0;
      for (var i = 0; i < node.length; i++) {
        var child = node[i];
        if (child && typeof child === "object" && (child.type || child.props)) {
          elements++;
          if (/row|button|item|option/i.test(elementName(child))) rowish++;
          if (child.props && (child.props.label !== undefined || child.props.onPress !== undefined)) rowish++;
        }
        queue.push(child);
      }
      if (elements) {
        var score = rowish * 10 + elements;
        if (score > bestScore && rowish > 0) {
          bestScore = score;
          best = node;
        }
      }
      continue;
    }

    if (node.props) {
      if (node.props.children !== undefined) queue.push(node.props.children);
      for (var key in node.props) {
        if (key === "children") continue;
        if (Array.isArray(node.props[key])) queue.push(node.props[key]);
      }
    }
    if (node.children !== undefined) queue.push(node.children);
  }

  return best;
}

function injectRows(tree, ctx) {
  if (!h) return undefined;
  var element = h(SheetRows, { ctx: ctx, key: "toolbox-rows" });
  var container = findRowContainer(tree);
  if (container) {
    if (storage.rowsAtTop) container.unshift(element);
    else container.push(element);
    sheetStrategy = "row list";
    sheetState = "rows injected";
    return undefined;
  }
  // No recognisable row list: hang them off the end of the sheet instead of
  // giving up, and say so in the Status tab.
  sheetStrategy = "wrapped tree";
  sheetState = "rows injected (fallback layout)";
  return h(React.Fragment, null, tree, element);
}

function patchSheet() {
  if (sheetUnpatch || !storage.sheetRows) return;
  if (!h || !React) {
    sheetState = "no react";
    return;
  }
  var patcher = getPatcher();
  if (!patcher || typeof patcher.before !== "function") {
    sheetState = "no patcher api";
    return;
  }

  var mod = ActionSheetModule();
  if (!mod) {
    // Not initialized on a cold start; back off and retry.
    cache.ActionSheet = undefined;
    sheetState = "waiting for the action sheet module (" + sheetRetries + ")";
    if (sheetRetries < 15 && sheetRetryTimer === null) {
      sheetRetryTimer = setTimeout(function () {
        sheetRetryTimer = null;
        sheetRetries++;
        patchSheet();
      }, 2000);
    }
    return;
  }

  try {
    sheetUnpatch = patcher.before("openLazy", mod, function (args) {
      try {
        var promise = args[0];
        var key = args[1];
        var props = args[2];
        if (key !== "MessageLongPressActionSheet") return;
        if (!promise || typeof promise.then !== "function") return;

        var message = resolveMessage(props);
        if (!message) {
          sheetState = "long press seen, but no message in its props";
          return;
        }
        var ctx = contextFor(message, props && props.channel && props.channel.id);

        promise.then(
          function (instance) {
            try {
              if (!instance || typeof instance !== "object" || !("default" in instance)) {
                sheetState = "sheet module has no default export";
                return;
              }
              var off = patcher.after("default", instance, function (inner, tree) {
                try {
                  off();
                } catch (e) {}
                try {
                  return injectRows(tree, ctx);
                } catch (e) {
                  sheetState = "injection failed: " + ((e && e.message) || "unknown");
                  log("injection failed", e);
                }
                return undefined;
              });
            } catch (e) {
              sheetState = "could not patch the sheet: " + ((e && e.message) || "unknown");
            }
          },
          function () {
            sheetState = "the sheet module never loaded";
          }
        );
      } catch (e) {
        log("openLazy hook failed", e);
      }
    });
    sheetState = "armed, waiting for a long press";
    log("action sheet patched");
  } catch (e) {
    sheetState = "patch failed: " + ((e && e.message) || "unknown");
  }
}

function unpatchSheet() {
  if (sheetRetryTimer !== null) {
    clearTimeout(sheetRetryTimer);
    sheetRetryTimer = null;
  }
  if (sheetUnpatch) {
    try {
      sheetUnpatch();
    } catch (e) {}
    sheetUnpatch = null;
  }
  sheetState = "off";
  sheetStrategy = "";
}

function patchTyping() {
  if (typingUnpatch || !storage.silentTyping) return;
  var patcher = getPatcher();
  if (!patcher || typeof patcher.instead !== "function") {
    typingState = "no patcher api";
    return;
  }
  var mod = TypingModule();
  if (!mod) {
    cache.Typing = undefined;
    typingState = "typing module not found";
    return;
  }
  try {
    typingUnpatch = patcher.instead("startTyping", mod, function () {
      return undefined;
    });
    typingState = "typing suppressed";
  } catch (e) {
    typingState = "patch failed: " + ((e && e.message) || "unknown");
  }
}

function unpatchTyping() {
  if (typingUnpatch) {
    try {
      typingUnpatch();
    } catch (e) {}
    typingUnpatch = null;
  }
  typingState = "off";
}

function patchFlux() {
  if (fluxUnpatch) return;
  if (!storage.logDeletes && !storage.logEdits) {
    fluxState = "off";
    return;
  }
  var patcher = getPatcher();
  if (!patcher || typeof patcher.before !== "function") {
    fluxState = "no patcher api";
    return;
  }
  var dispatcher = FluxDispatcher();
  if (!dispatcher) {
    cache.FluxDispatcher = undefined;
    fluxState = "dispatcher not found";
    return;
  }
  try {
    // before(), not subscribe(): the stores have to still hold the old message.
    fluxUnpatch = patcher.before("dispatch", dispatcher, function (args) {
      try {
        captureEvent(args[0]);
      } catch (e) {}
    });
    fluxState = "watching";
  } catch (e) {
    fluxState = "patch failed: " + ((e && e.message) || "unknown");
  }
}

function unpatchFlux() {
  if (fluxUnpatch) {
    try {
      fluxUnpatch();
    } catch (e) {}
    fluxUnpatch = null;
  }
  fluxState = "off";
}

/* ------------------------------------------------------------------ *
 * slash commands                                                      *
 * ------------------------------------------------------------------ */

function registerCommands() {
  if (commandHandles.length) return;
  if (!storage.commands) {
    commandState = "off";
    return;
  }
  var commands = api.commands || (api.api && api.api.commands);
  if (!commands || typeof commands.registerCommand !== "function") {
    commandState = "no commands api in this mod";
    return;
  }

  function define(name, description, action) {
    try {
      commandHandles.push(
        commands.registerCommand({
          name: name,
          displayName: name,
          description: description,
          displayDescription: description,
          type: 1,
          inputType: 0,
          applicationId: "-1",
          options: [],
          execute: function () {
            try {
              action();
            } catch (e) {
              toast("/" + name + " failed: " + ((e && e.message) || "unknown"));
            }
            return undefined;
          }
        })
      );
    } catch (e) {
      commandState = "registration failed: " + ((e && e.message) || "unknown");
    }
  }

  define("embed", "Copy the newest embed in this channel", function () {
    var ctx = newestMatching(function (c) {
      return embedsOf(c.message).length > 0;
    });
    if (!ctx) {
      toast("No embed in the loaded messages");
      return;
    }
    copy(allEmbedsText(ctx.message, storage.embedUrls !== false), "Embed copied");
  });

  define("preview", "Read the newest text attachment in this channel", function () {
    var ctx = newestMatching(function (c) {
      var atts = attachmentsOf(c.message);
      for (var i = 0; i < atts.length; i++) if (isTextual(atts[i])) return true;
      return false;
    });
    if (!ctx) {
      toast("No text attachment in the loaded messages");
      return;
    }
    var atts = attachmentsOf(ctx.message);
    for (var i = 0; i < atts.length; i++) {
      if (isTextual(atts[i])) {
        previewAttachment(atts[i]);
        return;
      }
    }
  });

  if (commandHandles.length && commandState.indexOf("failed") === -1) {
    commandState = "/embed and /preview registered";
  }
}

function unregisterCommands() {
  for (var i = 0; i < commandHandles.length; i++) {
    try {
      if (typeof commandHandles[i] === "function") commandHandles[i]();
    } catch (e) {}
  }
  commandHandles = [];
  commandState = "off";
}

/* ------------------------------------------------------------------ *
 * ui primitives                                                       *
 * ------------------------------------------------------------------ */

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
        sheet: "#1e1f22",
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
        sheet: "#ffffff",
        warn: "#a84300",
        error: "#d1242f",
        good: "#1a7f37"
      };
}

function useScheme() {
  var RN = ReactNative;
  var scheme = typeof RN.useColorScheme === "function" ? RN.useColorScheme() : "dark";
  return palette(scheme !== "light");
}

/* ------------------------------------------------------------------ *
 * action sheet rows                                                   *
 * ------------------------------------------------------------------ */

/**
 * Rendered inside Discord's sheet, so every failure is caught here: a throw in
 * this function would take the whole long-press menu down with it.
 */
function SheetRows(props) {
  try {
    var RN = ReactNative;
    if (!RN || !h) return null;
    var ctx = props.ctx;
    var features = activeFeatures(ctx);
    if (!features.length) return null;

    var c = useScheme();
    var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;
    var Native = storage.nativeRows ? FormRow() : null;

    function act(feature) {
      return function () {
        hideSheet();
        // Let the sheet finish dismissing, otherwise a modal opens behind it.
        setTimeout(function () {
          runFeature(feature, ctx);
        }, 80);
      };
    }

    return h(
      RN.View,
      { style: { paddingBottom: 6 } },
      features.map(function (feature, index) {
        if (Native) {
          var icon = null;
          try {
            var id = assetId(feature.icon);
            if (id && Native.Icon) icon = h(Native.Icon, { source: id });
          } catch (e) {}
          return h(Native, {
            key: "tb" + index,
            label: feature.label,
            subLabel: feature.hint || undefined,
            leading: icon || undefined,
            onPress: act(feature)
          });
        }
        return h(
          Touchable,
          {
            key: "tb" + index,
            onPress: act(feature),
            style: { paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center" }
          },
          h(
            RN.View,
            { style: { flex: 1 } },
            h(RN.Text, { style: { color: c.text, fontSize: 16, fontWeight: "500" } }, feature.label),
            feature.hint
              ? h(RN.Text, { style: { color: c.dim, fontSize: 12, marginTop: 1 } }, feature.hint)
              : null
          ),
          h(RN.Text, { style: { color: c.dim, fontSize: 12, fontWeight: "600" } }, "Toolbox")
        );
      })
    );
  } catch (e) {
    log("row render failed", e);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * viewer modal + overlay host                                         *
 * ------------------------------------------------------------------ */

var overlayListeners = [];
var overlayUnpatchFn = null;
var overlayMountState = "not started";
var overlayRetryTimer = null;
var overlayRetries = 0;

var hostSeq = 0;
var hostsMounted = [];
var hostOwner = null;

function overlayChanged() {
  for (var i = 0; i < overlayListeners.length; i++) {
    try {
      overlayListeners[i]();
    } catch (e) {}
  }
}

function subscribeOverlay(fn) {
  overlayListeners.push(fn);
  return function () {
    var i = overlayListeners.indexOf(fn);
    if (i !== -1) overlayListeners.splice(i, 1);
  };
}

/** True for exactly one mounted host at a time - Discord mounts several. */
function useIsOverlayOwner() {
  var idRef = React.useRef(null);
  if (idRef.current === null) idRef.current = ++hostSeq;
  var id = idRef.current;

  var state = React.useState(0);
  var bump = state[1];

  React.useEffect(function () {
    return subscribeOverlay(function () {
      bump(function (n) {
        return n + 1;
      });
    });
  }, []);

  React.useEffect(function () {
    hostsMounted.push(id);
    if (hostOwner === null) {
      hostOwner = id;
      overlayChanged();
    }
    return function () {
      var i = hostsMounted.indexOf(id);
      if (i !== -1) hostsMounted.splice(i, 1);
      if (hostOwner === id) {
        hostOwner = hostsMounted.length ? hostsMounted[0] : null;
        overlayChanged();
      }
    };
  }, []);

  return hostOwner === id;
}

function ViewerModal() {
  var RN = ReactNative;
  var c = useScheme();
  var mono = RN.Platform && RN.Platform.OS === "ios" ? "Menlo" : "monospace";
  var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;

  var state = React.useState(0);
  var bump = state[1];
  React.useEffect(function () {
    return subscribeViewer(function () {
      bump(function (n) {
        return n + 1;
      });
    });
  }, []);

  var open = !!viewer;
  var current = viewer || {};

  function Header() {
    return h(
      RN.View,
      {
        style: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
          borderBottomWidth: 1,
          borderBottomColor: c.border
        }
      },
      h(
        RN.View,
        { style: { flex: 1, paddingRight: 10 } },
        h(
          RN.Text,
          { numberOfLines: 1, style: { color: c.text, fontSize: 16, fontWeight: "700" } },
          current.title || "Toolbox"
        ),
        current.subtitle
          ? h(RN.Text, { numberOfLines: 1, style: { color: c.dim, fontSize: 12, marginTop: 2 } }, current.subtitle)
          : null
      ),
      current.kind === "text" && current.body
        ? h(
            Touchable,
            {
              onPress: function () {
                copy(current.body, "Copied");
              },
              style: { backgroundColor: c.chip, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8 }
            },
            h(RN.Text, { style: { color: c.text, fontSize: 13, fontWeight: "600" } }, "Copy")
          )
        : null,
      h(
        Touchable,
        {
          onPress: closeViewer,
          style: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }
        },
        h(RN.Text, { style: { color: "#ffffff", fontSize: 13, fontWeight: "700" } }, "Close")
      )
    );
  }

  function Body() {
    if (current.loading) {
      return h(
        RN.Text,
        { style: { color: c.dim, fontSize: 13, padding: 20, textAlign: "center" } },
        "Reading…"
      );
    }
    if (current.kind === "files") {
      var items = current.items || [];
      return h(
        RN.View,
        { style: { paddingVertical: 6 } },
        items.map(function (att, index) {
          return h(
            Touchable,
            {
              key: "f" + index,
              onPress: function () {
                previewAttachment(att);
              },
              style: { paddingHorizontal: 16, paddingVertical: 12 }
            },
            h(RN.Text, { style: { color: c.text, fontSize: 15, fontWeight: "600" } }, att.filename),
            h(RN.Text, { style: { color: c.dim, fontSize: 12, marginTop: 2 } }, bytes(att.size))
          );
        })
      );
    }
    return h(
      RN.ScrollView,
      { style: { maxHeight: 440 }, contentContainerStyle: { padding: 14 } },
      h(
        RN.Text,
        { selectable: true, style: { color: c.text, fontSize: 12, fontFamily: mono, lineHeight: 17 } },
        current.body || ""
      )
    );
  }

  return h(
    RN.Modal,
    { visible: open, transparent: true, animationType: "fade", onRequestClose: closeViewer },
    h(
      RN.View,
      {
        style: {
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.55)",
          justifyContent: "center",
          paddingHorizontal: 14,
          paddingVertical: 60
        }
      },
      h(
        RN.View,
        {
          style: {
            backgroundColor: c.sheet,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: c.border,
            overflow: "hidden"
          }
        },
        Header(),
        Body()
      )
    )
  );
}

/** Mounted above the whole app so a preview can open from the action sheet. */
function ViewerHost() {
  var isOwner = useIsOverlayOwner();
  if (!isOwner) return null;
  if (!ReactNative || !h) return null;
  return h(ViewerModal, null);
}

function resolveErrorBoundary() {
  var candidates = [];
  try {
    candidates.push(findByName("ErrorBoundary", false));
  } catch (e) {}
  try {
    candidates.push(findByName("ErrorBoundary"));
  } catch (e) {}

  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (!candidate) continue;
    if (candidate.prototype && typeof candidate.prototype.render === "function") return candidate;
    if (candidate.default && candidate.default.prototype && typeof candidate.default.prototype.render === "function") {
      return candidate.default;
    }
  }
  return null;
}

function patchOverlay() {
  if (overlayUnpatchFn || !storage.overlay) return;
  if (!h || !ReactNative || !React) {
    overlayMountState = "no react";
    return;
  }
  var patcher = getPatcher();
  if (!patcher) {
    overlayMountState = "no patcher api";
    return;
  }

  var ErrorBoundary = resolveErrorBoundary();
  if (!ErrorBoundary) {
    // The module may not be initialized yet on a cold start; back off and retry.
    overlayMountState = "waiting for ErrorBoundary (" + overlayRetries + ")";
    if (overlayRetries < 15 && overlayRetryTimer === null) {
      overlayRetryTimer = setTimeout(function () {
        overlayRetryTimer = null;
        overlayRetries++;
        patchOverlay();
      }, 2000);
    }
    return;
  }

  try {
    overlayUnpatchFn = patcher.after("render", ErrorBoundary.prototype, function (args, ret) {
      // Leave the crash screen alone.
      try {
        if (this && this.state && this.state.error) return;
      } catch (e) {}
      return h(React.Fragment, null, ret, h(ViewerHost, null));
    });
    overlayMountState = "mounted";
  } catch (e) {
    overlayMountState = "patch failed: " + ((e && e.message) || "unknown");
  }
}

function unpatchOverlay() {
  if (overlayRetryTimer !== null) {
    clearTimeout(overlayRetryTimer);
    overlayRetryTimer = null;
  }
  if (overlayUnpatchFn) {
    try {
      overlayUnpatchFn();
    } catch (e) {}
    overlayUnpatchFn = null;
  }
  hostOwner = null;
  hostsMounted.length = 0;
  overlayMountState = "not started";
  overlayChanged();
}

/* ------------------------------------------------------------------ *
 * settings                                                            *
 * ------------------------------------------------------------------ */

var TABS = ["Features", "Grab", "Archive", "Status"];

var BEHAVIOUR = [
  { key: "sheetRows", label: "Long-press rows", hint: "Add the rows to Discord's message sheet" },
  { key: "rowsAtTop", label: "Rows at the top", hint: "Put them above Discord's own rows instead of below" },
  { key: "nativeRows", label: "Native row style", hint: "Use Discord's FormRow - looks native, breaks more often" },
  { key: "embedUrls", label: "Include URLs in embeds", hint: "Link, image and thumbnail URLs in copied embeds" },
  { key: "overlay", label: "In-app viewer", hint: "Needed to show previews outside of settings" },
  { key: "toasts", label: "Confirmation toasts", hint: "Say so when something is copied" }
];

var EXTRAS = [
  { key: "silentTyping", label: "Silent typing", hint: "Never send the typing indicator" },
  { key: "logDeletes", label: "Archive deleted messages", hint: "Keep what you saw before it vanished" },
  { key: "logEdits", label: "Archive edits", hint: "Keep the text from before an edit" },
  { key: "commands", label: "Slash commands", hint: "/embed and /preview act on the newest match" }
];

var PREVIEW_SIZES = [
  { value: 50000, label: "50 KB" },
  { value: 200000, label: "200 KB" },
  { value: 1000000, label: "1 MB" }
];

var ARCHIVE_SIZES = [
  { value: 50, label: "50" },
  { value: 200, label: "200" },
  { value: 500, label: "500" }
];

function SettingsPage() {
  if (!h || !ReactNative) return null;

  var RN = ReactNative;
  var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;
  var c = useScheme();
  var mono = RN.Platform && RN.Platform.OS === "ios" ? "Menlo" : "monospace";

  var tabState = React.useState("Features");
  var tab = tabState[0];
  var setTab = tabState[1];

  var tickState = React.useState(0);
  var setTick = tickState[1];

  var grabState = React.useState(null);
  var grabId = grabState[0];
  var setGrabId = grabState[1];

  var filterState = React.useState("all");
  var filter = filterState[0];
  var setFilter = filterState[1];

  var queryState = React.useState("");
  var query = queryState[0];
  var setQuery = queryState[1];

  var expandedState = React.useState(null);
  var expanded = expandedState[0];
  var setExpanded = expandedState[1];

  function refresh() {
    setTick(function (n) {
      return n + 1;
    });
  }

  React.useEffect(function () {
    return subscribeArchive(refresh);
  }, []);

  React.useEffect(function () {
    return subscribeViewer(refresh);
  }, []);

  // While settings is open its own modal can host a preview, so the Grab tab
  // works even with the overlay turned off.
  React.useEffect(function () {
    settingsMounted++;
    return function () {
      settingsMounted--;
    };
  }, []);

  function set(key, value) {
    storage[key] = value;
    syncPatches();
    refresh();
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

  function Heading(text) {
    return h(
      RN.Text,
      { style: { color: c.dim, fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginHorizontal: 18, marginTop: 18 } },
      String(text).toUpperCase()
    );
  }

  function Button(label, onPress, tone) {
    return h(
      Touchable,
      {
        key: label,
        onPress: onPress,
        style: {
          flex: 1,
          backgroundColor: tone === "quiet" ? c.chip : tone === "danger" ? c.error : c.accent,
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

  function Empty(text) {
    return h(
      RN.Text,
      { style: { color: c.dim, fontSize: 13, textAlign: "center", paddingVertical: 26 } },
      text
    );
  }

  function ToggleRow(label, hint, value, onChange, key) {
    return h(
      RN.View,
      {
        key: key || label,
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

  function InfoRow(label, value, tone) {
    return h(
      RN.View,
      {
        key: label,
        style: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 14, paddingVertical: 9 }
      },
      h(RN.Text, { style: { color: c.dim, fontSize: 13, width: 128 } }, label),
      h(RN.Text, { style: { color: tone || c.text, fontSize: 13, flex: 1, fontWeight: "500" } }, String(value))
    );
  }

  /* ---- features tab ---- */

  function FeaturesTab() {
    return h(
      RN.View,
      null,
      Caption(
        "Each row below is an entry in the message long-press menu. Turn off what you do not want to see there."
      ),
      Shell(
        FEATURE_KEYS.map(function (feature, index) {
          return h(
            RN.View,
            { key: "fk" + index },
            index ? Divider() : null,
            ToggleRow(feature.label, feature.hint, storage[feature.key], function (next) {
              set(feature.key, next);
            }, "t" + index)
          );
        })
      ),
      Heading("Behaviour"),
      Shell(
        BEHAVIOUR.map(function (item, index) {
          return h(
            RN.View,
            { key: "bh" + index },
            index ? Divider() : null,
            ToggleRow(item.label, item.hint, storage[item.key], function (next) {
              set(item.key, next);
            }, "b" + index)
          );
        })
      ),
      Heading("Extras"),
      Shell(
        EXTRAS.map(function (item, index) {
          return h(
            RN.View,
            { key: "ex" + index },
            index ? Divider() : null,
            ToggleRow(item.label, item.hint, storage[item.key], function (next) {
              set(item.key, next);
            }, "e" + index)
          );
        })
      ),
      Heading("Limits"),
      Shell([
        h(RN.Text, { key: "pl", style: { color: c.text, fontSize: 15, fontWeight: "600", paddingHorizontal: 14, paddingTop: 12 } }, "File preview size"),
        Chips(PREVIEW_SIZES, Number(storage.previewLimit), function (value) {
          set("previewLimit", value);
        }, "pv"),
        Divider(),
        h(RN.Text, { key: "al", style: { color: c.text, fontSize: 15, fontWeight: "600", paddingHorizontal: 14, paddingTop: 12 } }, "Archive size"),
        Chips(ARCHIVE_SIZES, Number(storage.archiveLimit), function (value) {
          set("archiveLimit", value);
        }, "ar")
      ]),
      Caption(
        "Only the first chunk of a file is fetched - the CDN is asked for a byte range, so a 40 MB log costs 200 KB to peek at."
      )
    );
  }

  /* ---- grab tab ---- */

  function GrabTab() {
    var channelId = currentChannelId();
    var messages = channelMessages(channelId);

    if (!channelId) {
      return h(RN.View, null, Shell(Empty("Open a channel first, then come back.")));
    }

    if (grabId) {
      var found = null;
      for (var i = 0; i < messages.length; i++) {
        if (messages[i] && messages[i].id === grabId) found = messages[i];
      }
      if (!found) {
        return h(
          RN.View,
          null,
          Shell([
            Empty("That message is no longer loaded."),
            ButtonRow([Button("Back", function () {
              setGrabId(null);
            }, "quiet")])
          ])
        );
      }
      var ctx = contextFor(found, channelId);
      var features = activeFeatures(ctx);
      return h(
        RN.View,
        null,
        Shell([
          h(
            RN.View,
            { key: "head", style: { paddingHorizontal: 14, paddingVertical: 12 } },
            h(RN.Text, { style: { color: c.text, fontSize: 14, fontWeight: "700" } }, authorName(found)),
            h(RN.Text, { style: { color: c.dim, fontSize: 12, marginTop: 3 } }, describeMessage(found)),
            h(RN.Text, { style: { color: c.dim, fontSize: 11, marginTop: 3 } }, stamp(snowflakeTime(found.id)))
          ),
          Divider(),
          features.length
            ? h(
                RN.View,
                { key: "acts" },
                features.map(function (feature, index) {
                  return h(
                    Touchable,
                    {
                      key: "ga" + index,
                      onPress: function () {
                        runFeature(feature, ctx);
                        refresh();
                      },
                      style: { paddingHorizontal: 14, paddingVertical: 12 }
                    },
                    h(RN.Text, { style: { color: c.text, fontSize: 15, fontWeight: "600" } }, feature.label),
                    feature.hint
                      ? h(RN.Text, { style: { color: c.dim, fontSize: 12, marginTop: 2 } }, feature.hint)
                      : null
                  );
                })
              )
            : Empty("Nothing applies to this message."),
          Divider(),
          ButtonRow([
            Button("Back", function () {
              setGrabId(null);
            }, "quiet"),
            Button("Refresh", refresh, "quiet")
          ])
        ])
      );
    }

    var recent = messages.slice(-30).reverse();
    return h(
      RN.View,
      null,
      Caption(
        "The last messages in the channel you have open, read straight from the store. This path needs no patches, so it works even when the long-press rows do not."
      ),
      Shell([
        ButtonRow([Button("Refresh", refresh, "quiet")]),
        Divider(),
        recent.length
          ? h(
              RN.View,
              { key: "list" },
              recent.map(function (message, index) {
                if (!message || !message.id) return null;
                return h(
                  Touchable,
                  {
                    key: "gm" + message.id + index,
                    onPress: function () {
                      setGrabId(message.id);
                    },
                    style: { paddingHorizontal: 14, paddingVertical: 10 }
                  },
                  h(
                    RN.View,
                    { style: { flexDirection: "row", alignItems: "center" } },
                    h(
                      RN.Text,
                      { style: { color: c.text, fontSize: 13, fontWeight: "700", flex: 1 } },
                      authorName(message)
                    ),
                    h(RN.Text, { style: { color: c.dim, fontSize: 11 } }, clock(snowflakeTime(message.id)))
                  ),
                  h(
                    RN.Text,
                    { numberOfLines: 2, style: { color: c.dim, fontSize: 12, marginTop: 2 } },
                    describeMessage(message)
                  )
                );
              })
            )
          : Empty("No messages loaded for this channel.")
      ])
    );
  }

  /* ---- archive tab ---- */

  function ArchiveTab() {
    var needle = query.toLowerCase();
    var rows = archive.filter(function (entry) {
      if (filter !== "all" && entry.kind !== filter) return false;
      if (!needle) return true;
      var haystack = (entry.author + " " + (entry.content || "") + " " + (entry.before || "")).toLowerCase();
      return haystack.indexOf(needle) !== -1;
    });

    return h(
      RN.View,
      null,
      Caption(
        storage.logDeletes || storage.logEdits
          ? "Deletes and edits are read out of the store before Discord drops them. Nothing is sent anywhere; the list lives in memory and clears on restart."
          : "Archiving is off - turn it on under Features → Extras."
      ),
      Shell([
        Chips(
          [
            { value: "all", label: "All " + archive.length },
            { value: "delete", label: "Deleted" },
            { value: "edit", label: "Edited" }
          ],
          filter,
          setFilter,
          "af"
        ),
        SearchBox(query, setQuery, "Filter by author or text"),
        Divider(),
        rows.length
          ? h(
              RN.View,
              { key: "rows" },
              rows.slice(0, 120).map(function (entry) {
                var open = expanded === entry.key;
                var body = entry.kind === "edit"
                  ? "before:\n" + (entry.before || "(empty)") + "\n\nafter:\n" + (entry.after || "(empty)")
                  : entry.content || "(no text)";
                return h(
                  Touchable,
                  {
                    key: "ae" + entry.key,
                    onPress: function () {
                      setExpanded(open ? null : entry.key);
                    },
                    onLongPress: function () {
                      copy(body, "Copied");
                    },
                    style: { paddingHorizontal: 14, paddingVertical: 10 }
                  },
                  h(
                    RN.View,
                    { style: { flexDirection: "row", alignItems: "center" } },
                    h(
                      RN.Text,
                      {
                        style: {
                          color: entry.kind === "delete" ? c.error : c.warn,
                          fontSize: 11,
                          fontWeight: "700",
                          width: 54
                        }
                      },
                      entry.kind === "delete" ? "DELETE" : "EDIT"
                    ),
                    h(RN.Text, { style: { color: c.text, fontSize: 13, fontWeight: "600", flex: 1 } }, entry.author),
                    h(RN.Text, { style: { color: c.dim, fontSize: 11 } }, clock(entry.at))
                  ),
                  h(
                    RN.Text,
                    { numberOfLines: open ? 0 : 2, style: { color: c.dim, fontSize: 12, marginTop: 3 } },
                    body
                  ),
                  open && entry.attachments && entry.attachments.length
                    ? h(
                        RN.Text,
                        { style: { color: c.dim, fontSize: 11, marginTop: 4 } },
                        "files: " + entry.attachments.join(", ")
                      )
                    : null,
                  open
                    ? h(
                        RN.Text,
                        { style: { color: c.dim, fontSize: 11, marginTop: 4, fontFamily: mono } },
                        "message " + entry.id + " · long press to copy"
                      )
                    : null
                );
              })
            )
          : Empty(archive.length ? "Nothing matches that filter." : "Nothing archived yet."),
        Divider(),
        ButtonRow([
          Button("Copy all", function () {
            var lines = rows.map(function (entry) {
              return (
                "[" + stamp(entry.at) + "] " + entry.kind + " · " + entry.author + "\n" +
                (entry.kind === "edit" ? (entry.before || "") + "\n→ " + (entry.after || "") : entry.content || "")
              );
            });
            copy(lines.join("\n\n"), rows.length + " entries copied");
          }, "quiet"),
          Button("Clear", function () {
            archive.length = 0;
            setExpanded(null);
            archiveChanged();
          }, "danger")
        ])
      ])
    );
  }

  /* ---- status tab ---- */

  function StatusTab() {
    var sheetDetail = sheetState + (sheetStrategy ? " · " + sheetStrategy : "");
    var modules = [
      ["ActionSheet", !!ActionSheetModule()],
      ["MessageStore", !!MessageStore()],
      ["ChannelStore", !!ChannelStore()],
      ["SelectedChannel", !!SelectedChannelStore()],
      ["FluxDispatcher", !!FluxDispatcher()],
      ["Typing", !!TypingModule()],
      ["Clipboard", !!clipboard()],
      ["FormRow", !!FormRow()]
    ];

    return h(
      RN.View,
      null,
      Heading("Plugin"),
      Shell([
        InfoRow("Settings", storageIsPersistent ? "persistent" : "in-memory only", storageIsPersistent ? c.good : c.warn),
        Divider(),
        InfoRow("Long-press rows", sheetDetail, sheetState.indexOf("injected") !== -1 ? c.good : c.dim),
        Divider(),
        InfoRow("Viewer", overlayMountState, overlayMountState === "mounted" ? c.good : c.dim),
        Divider(),
        InfoRow("Silent typing", typingState, typingState === "typing suppressed" ? c.good : c.dim),
        Divider(),
        InfoRow("Archive", fluxState + " · " + archive.length + " kept", fluxState === "watching" ? c.good : c.dim),
        Divider(),
        InfoRow("Commands", commandState, commandHandles.length ? c.good : c.dim)
      ]),
      Caption(
        "The long-press rows only report their state after the first long press - that is when Discord loads the sheet module."
      ),
      Heading("Modules"),
      Shell(
        modules.map(function (pair, index) {
          return h(
            RN.View,
            { key: "md" + index },
            index ? Divider() : null,
            InfoRow(pair[0], pair[1] ? "found" : "missing", pair[1] ? c.good : c.error)
          );
        })
      ),
      Heading("Runtime"),
      Shell([
        InfoRow("Mod", injected ? "injected api" : G.kettu ? "kettu global" : G.bunny ? "bunny global" : "unknown"),
        Divider(),
        InfoRow("React", (React && React.version) || "?"),
        Divider(),
        InfoRow("Platform", (RN.Platform && RN.Platform.OS) + " " + ((RN.Platform && RN.Platform.Version) || "")),
        Divider(),
        InfoRow("Patcher", getPatcher() ? "available" : "missing", getPatcher() ? c.good : c.error)
      ]),
      Shell(
        ButtonRow([
          Button("Reset settings", function () {
            for (var key in DEFAULTS) {
              if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) storage[key] = DEFAULTS[key];
            }
            syncPatches();
            refresh();
            note("Settings reset");
          }, "danger"),
          Button("Re-apply patches", function () {
            unpatchSheet();
            unpatchOverlay();
            sheetRetries = 0;
            overlayRetries = 0;
            syncPatches();
            refresh();
            note("Patches re-applied");
          }, "quiet")
        ])
      ),
      Caption("Toolbox " + VERSION + " · riftwarewtf/always-online")
    );
  }

  var body =
    tab === "Features" ? FeaturesTab() : tab === "Grab" ? GrabTab() : tab === "Archive" ? ArchiveTab() : StatusTab();

  return h(
    RN.ScrollView,
    { style: { flex: 1 }, keyboardShouldPersistTaps: "handled" },
    h(
      RN.View,
      { style: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 10, paddingTop: 12 } },
      TABS.map(function (name) {
        var active = name === tab;
        return h(
          Touchable,
          {
            key: "tab" + name,
            onPress: function () {
              setTab(name);
            },
            style: {
              backgroundColor: active ? c.accent : c.chip,
              borderRadius: 999,
              paddingHorizontal: 14,
              paddingVertical: 7,
              marginRight: 7,
              marginBottom: 8
            }
          },
          h(
            RN.Text,
            { style: { color: active ? "#ffffff" : c.text, fontSize: 13, fontWeight: active ? "700" : "500" } },
            name
          )
        );
      })
    ),
    body,
    // With the overlay off, settings hosts the viewer itself.
    overlayMountState === "mounted" ? null : h(ViewerModal, null),
    h(RN.View, { style: { height: 44 } })
  );
}

/* ------------------------------------------------------------------ *
 * lifecycle                                                          *
 * ------------------------------------------------------------------ */

var VERSION = "1.0.0";
var running = false;

function syncPatches() {
  if (storage.sheetRows) patchSheet();
  else unpatchSheet();

  if (storage.silentTyping) patchTyping();
  else unpatchTyping();

  if (storage.logDeletes || storage.logEdits) patchFlux();
  else unpatchFlux();

  if (storage.commands) registerCommands();
  else unregisterCommands();

  if (storage.overlay) patchOverlay();
  else unpatchOverlay();
}

function start() {
  if (running) return;
  running = true;
  applyDefaults();
  syncPatches();

  // Reachable from the DevTools Eval tab, or from another plugin.
  G.__toolbox = {
    version: VERSION,
    features: FEATURES,
    archive: archive,
    storage: storage,
    run: function (key, ctx) {
      for (var i = 0; i < FEATURES.length; i++) {
        if (FEATURES[i].key === key) return runFeature(FEATURES[i], ctx || newestMatching(FEATURES[i].match));
      }
      return undefined;
    },
    newest: newestMatching,
    context: contextFor,
    embedText: allEmbedsText,
    preview: previewAttachment,
    show: showText,
    state: function () {
      return {
        sheet: sheetState,
        strategy: sheetStrategy,
        overlay: overlayMountState,
        typing: typingState,
        flux: fluxState,
        commands: commandState,
        persistent: storageIsPersistent,
        archived: archive.length
      };
    }
  };

  log("loaded", VERSION);
}

function stop() {
  running = false;
  unpatchSheet();
  unpatchTyping();
  unpatchFlux();
  unregisterCommands();
  unpatchOverlay();
  viewer = null;
  viewerListeners.length = 0;
  archive.length = 0;
  archiveListeners.length = 0;
  cache = {};
  try {
    delete G.__toolbox;
  } catch (e) {
    G.__toolbox = undefined;
  }
}

function onLoad() {
  try {
    start();
  } catch (e) {
    log("onLoad failed", e);
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
