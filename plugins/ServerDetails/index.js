/**
 * ServerDetails
 * Server details for Kettu (also loads on Bunny / Vendetta).
 *
 * A port of DevilBro's ServerDetails for BetterDiscord, which puts a server's
 * details in the server list tooltip. A phone has no hover and no shift key, so
 * the trigger is the one mobile gesture that means "tell me more": long press
 * the server in the guild list and the details open as a panel. Settings also
 * list every server you are in, so the same panel is reachable without any
 * gesture at all.
 *
 * Same items as the original, each with its own switch: icon, owner, creation
 * date, join date, members, channels, roles, boosts and language. The settings
 * that only make sense for a tooltip - width, delay, colour, show-on-shift and
 * the date format builder - have no mobile equivalent and are not here; dates
 * are local, with an optional relative age beside them.
 *
 * This is a reimplementation for a different runtime, not a copy: BetterDiscord
 * plugins run against BDFDB and the desktop DOM, neither of which exists here.
 */

/* ------------------------------------------------------------------ *
 * runtime api resolution                                              *
 * ------------------------------------------------------------------ */

var G = typeof globalThis !== "undefined" ? globalThis : window;

/**
 * Kettu evaluates a Vendetta-format plugin as `vendetta => { return <bundle> }`,
 * so the per-plugin api object - the only one carrying real persistent storage -
 * arrives as a function parameter in our enclosing scope, not as a global.
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

function getPatcher() {
  if (api.patcher && typeof api.patcher.after === "function") return api.patcher;
  if (api.api && api.api.patcher && typeof api.api.patcher.after === "function") return api.api.patcher;
  return null;
}

var common = (api.metro && api.metro.common) || {};
var React = common.React || G.React || findByProps("createElement", "useState");
var ReactNative = common.ReactNative || findByProps("ScrollView", "StyleSheet", "AppState");
var h = React ? React.createElement : null;

var storage = (injected && injected.plugin && injected.plugin.storage) || null;
var storageIsPersistent = !!storage;
if (!storage) storage = {};

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

function GuildStore() {
  return lazy("GuildStore", function () {
    return findByStoreName("GuildStore");
  });
}
function GuildChannelStore() {
  return lazy("GuildChannelStore", function () {
    return findByStoreName("GuildChannelStore");
  });
}
function GuildRoleStore() {
  return lazy("GuildRoleStore", function () {
    return findByStoreName("GuildRoleStore");
  });
}
function GuildMemberCountStore() {
  return lazy("GuildMemberCountStore", function () {
    return findByStoreName("GuildMemberCountStore");
  });
}
function ChannelStore() {
  return lazy("ChannelStore", function () {
    return findByStoreName("ChannelStore");
  });
}
function UserStore() {
  return lazy("UserStore", function () {
    return findByStoreName("UserStore");
  });
}
function SelectedGuildStore() {
  return lazy("SelectedGuildStore", function () {
    return findByStoreName("SelectedGuildStore");
  });
}
function ActionSheetModule() {
  return lazy("ActionSheet", function () {
    return findByProps("openLazy", "hideActionSheet");
  });
}
function FormRow() {
  return lazy("FormRow", function () {
    var mod = findByProps("FormRow");
    return mod && mod.FormRow;
  });
}
function ProfileActions() {
  return lazy("ProfileActions", function () {
    return findByProps("fetchProfile") || findByProps("getUser", "fetchCurrentUser");
  });
}

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
  try {
    var args = ["[serverdetails]"].concat(Array.prototype.slice.call(arguments));
    if (G.console && G.console.log) G.console.log.apply(G.console, args);
  } catch (e) {}
}

/* ------------------------------------------------------------------ *
 * assets                                                              *
 * ------------------------------------------------------------------ */

function assetModule() {
  return (api.ui && api.ui.assets) || api.assets || null;
}

function assetId(name) {
  if (!name) return undefined;
  try {
    var assets = assetModule();
    if (assets && typeof assets.getAssetIDByName === "function") {
      var id = assets.getAssetIDByName(name);
      if (id !== undefined && id !== null) return id;
    }
  } catch (e) {}
  return undefined;
}

/** Asset names move between Discord releases, so the registry is searched too. */
function assetNames() {
  return lazy("assetNames", function () {
    var assets = assetModule();
    if (!assets) return null;
    var registry = assets.all || assets.assets || assets.registry || null;
    if (registry && typeof registry === "object") {
      var keys = Object.keys(registry);
      if (keys.length) return keys;
    }
    if (typeof assets.getAssets === "function") {
      var all = assets.getAssets();
      if (all && typeof all === "object") {
        var fromGetter = Object.keys(all);
        if (fromGetter.length) return fromGetter;
      }
    }
    return null;
  });
}

function assetScore(name) {
  var score = -Math.min(4, Math.floor(name.length / 10));
  if (name.indexOf("ic_") === 0) score += 5;
  if (/24(px)?$/.test(name)) score += 3;
  else if (/16(px)?$/.test(name)) score += 2;
  if (/light|dark|disabled|selected|active|outline|filled|large|big/.test(name)) score -= 4;
  return score;
}

function iconFor(spec) {
  if (!spec) return null;
  if (spec.__icon !== undefined) return spec.__icon;
  var id;
  var names = spec.icons || [];
  for (var i = 0; i < names.length && !id; i++) id = assetId(names[i]);
  if (!id && spec.iconMatch) {
    var registry = assetNames();
    if (registry) {
      var best = null;
      for (var j = 0; j < registry.length; j++) {
        var name = registry[j];
        if (!spec.iconMatch.test(name)) continue;
        if (spec.iconAvoid && spec.iconAvoid.test(name)) continue;
        if (!best || assetScore(name) > assetScore(best)) best = name;
      }
      if (best) id = assetId(best);
    }
  }
  if (!id && spec.iconFallback !== false) {
    var fallbacks = ["ic_info_24px", "ic_info", "ic_message_copy"];
    for (var k = 0; k < fallbacks.length && !id; k++) id = assetId(fallbacks[k]);
  }
  spec.__icon = id === undefined ? null : id;
  return spec.__icon;
}

var ROW_ICON = {
  icons: ["ic_info_24px", "ic_info", "ic_guild_24px"],
  iconMatch: /info|about|detail|guild|server/,
  iconAvoid: /add|invite|leave|mute|notification/
};

/* ------------------------------------------------------------------ *
 * settings defaults                                                   *
 * ------------------------------------------------------------------ */

// The nine items the original shows, in its order, each with its own switch.
var DEFAULTS = {
  icon: true,
  owner: true,
  creationDate: true,
  joinDate: true,
  members: true,
  channels: true,
  roles: true,
  boosts: true,
  language: true,
  // Beyond the original, off until asked for.
  serverId: false,
  vanity: false,
  tier: false,
  verification: false,
  description: false,
  // Behaviour.
  sheetRow: true,
  nativeRows: true,
  relative: true,
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
 * dates, numbers, locales                                             *
 * ------------------------------------------------------------------ */

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

/** Discord snowflakes carry their own creation time. */
function snowflakeTime(id) {
  var n = Number(id);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 4194304) + 1420070400000;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    var parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : 0;
  }
  try {
    // Moment-like objects, which is what mobile records carry.
    if (typeof value.valueOf === "function") {
      var ms = Number(value.valueOf());
      if (isFinite(ms) && ms > 0) return ms;
    }
    if (typeof value.toISOString === "function") return Date.parse(value.toISOString());
  } catch (e) {}
  return 0;
}

function ago(ms) {
  if (!ms) return "";
  var seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 90) return "just now";
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  var days = Math.floor(hours / 24);
  if (days < 365) return days + "d ago";
  var years = Math.floor(days / 365);
  var rest = days - years * 365;
  var months = Math.floor(rest / 30);
  return years + "y" + (months ? " " + months + "m" : "") + " ago";
}

function dateText(ms) {
  if (!ms) return "unknown";
  var d = new Date(ms);
  var text = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  text += " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (storage.relative !== false) {
    var relative = ago(ms);
    if (relative) text += " (" + relative + ")";
  }
  return text;
}

function thousands(value) {
  var n = Number(value);
  if (!isFinite(n)) return String(value);
  var text = String(Math.floor(Math.abs(n)));
  var out = "";
  for (var i = 0; i < text.length; i++) {
    if (i && (text.length - i) % 3 === 0) out += ",";
    out += text.charAt(i);
  }
  return (n < 0 ? "-" : "") + out;
}

var LOCALES = {
  bg: "Bulgarian",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  "en-GB": "English, UK",
  "en-US": "English, US",
  "es-ES": "Spanish",
  "es-419": "Spanish, Latin America",
  fi: "Finnish",
  fr: "French",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  lt: "Lithuanian",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  "pt-BR": "Portuguese, Brazilian",
  ro: "Romanian",
  ru: "Russian",
  "sv-SE": "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  "zh-CN": "Chinese, China",
  "zh-TW": "Chinese, Taiwan"
};

function localeName(code) {
  if (!code) return "unknown";
  if (LOCALES[code]) return LOCALES[code] + " (" + code + ")";
  try {
    if (G.Intl && typeof G.Intl.DisplayNames === "function") {
      var names = new G.Intl.DisplayNames(["en"], { type: "language" });
      var name = names.of(code);
      if (name && name !== code) return name + " (" + code + ")";
    }
  } catch (e) {}
  return String(code);
}

var VERIFICATION = ["none", "low", "medium", "high", "highest"];

/* ------------------------------------------------------------------ *
 * guild data                                                          *
 * ------------------------------------------------------------------ */

function guildById(id) {
  if (!id) return null;
  try {
    var store = GuildStore();
    if (store && typeof store.getGuild === "function") return store.getGuild(id) || null;
  } catch (e) {}
  return null;
}

function guildList() {
  var store = GuildStore();
  var out = [];
  if (!store) return out;
  var map = null;
  try {
    if (typeof store.getGuilds === "function") map = store.getGuilds();
  } catch (e) {}
  if (!map || typeof map !== "object") return out;
  for (var id in map) {
    var guild = map[id];
    if (guild && guild.id) out.push(guild);
  }
  out.sort(function (a, b) {
    return String(a.name || "").toLowerCase() < String(b.name || "").toLowerCase() ? -1 : 1;
  });
  return out;
}

function currentGuildId() {
  try {
    var store = SelectedGuildStore();
    if (store && typeof store.getGuildId === "function") return store.getGuildId();
  } catch (e) {}
  return null;
}

var fetchedOwners = {};

/** Asks for the owner's profile once if the store has never seen them. */
function requestOwner(id) {
  if (!id || fetchedOwners[id]) return;
  fetchedOwners[id] = true;
  var actions = ProfileActions();
  if (!actions) return;
  try {
    var result = null;
    if (typeof actions.fetchProfile === "function") result = actions.fetchProfile(id);
    else if (typeof actions.getUser === "function") result = actions.getUser(id);
    if (result && typeof result.then === "function") {
      result.then(function () {
        panelChanged();
      }, function () {});
    }
  } catch (e) {}
}

function ownerOf(guild) {
  var id = guild.ownerId || guild.owner_id;
  if (!id) return null;
  try {
    var store = UserStore();
    var user = store && typeof store.getUser === "function" ? store.getUser(id) : null;
    if (user) return user;
  } catch (e) {}
  requestOwner(id);
  return null;
}

function ownerText(guild) {
  var user = ownerOf(guild);
  if (!user) {
    var id = guild.ownerId || guild.owner_id;
    return id ? id + " (not cached)" : "unknown";
  }
  var name = user.globalName || user.global_name || user.username || "unknown";
  if (user.username && name !== user.username) name += " (" + user.username + ")";
  return name;
}

function memberCount(guild) {
  var store = GuildMemberCountStore();
  try {
    if (store && typeof store.getMemberCount === "function") {
      var n = store.getMemberCount(guild.id);
      if (typeof n === "number" && n > 0) return n;
    }
  } catch (e) {}
  if (typeof guild.memberCount === "number") return guild.memberCount;
  if (typeof guild.member_count === "number") return guild.member_count;
  return null;
}

/** GuildChannelStore keys its result by channel type, and shapes differ. */
function channelCount(guildId) {
  var store = GuildChannelStore();
  var result = null;
  try {
    if (store && typeof store.getChannels === "function") result = store.getChannels(guildId);
  } catch (e) {}

  if (result && typeof result === "object") {
    if (typeof result.count === "number" && result.count > 0) return result.count;
    var seen = {};
    var total = 0;
    for (var key in result) {
      var value = result[key];
      if (!Array.isArray(value)) continue;
      for (var i = 0; i < value.length; i++) {
        var entry = value[i];
        var channel = entry && entry.channel ? entry.channel : entry;
        if (!channel || !channel.id || seen[channel.id]) continue;
        seen[channel.id] = true;
        if (channel.type === 4) continue;
        total++;
      }
    }
    if (total) return total;
  }

  // Fall back to counting what ChannelStore holds for this guild.
  var channels = ChannelStore();
  try {
    var map = channels && typeof channels.getMutableGuildChannels === "function"
      ? channels.getMutableGuildChannels()
      : null;
    if (map) {
      var count = 0;
      for (var id in map) {
        var c = map[id];
        if (!c || c.type === 4) continue;
        if ((c.guild_id || c.guildId) !== guildId) continue;
        count++;
      }
      if (count) return count;
    }
  } catch (e) {}
  return null;
}

/** Everyone's own role shares the guild's id and is not counted, as in the original. */
function roleCount(guild) {
  var store = GuildRoleStore();
  var roles = null;
  try {
    if (store && typeof store.getSortedRoles === "function") roles = store.getSortedRoles(guild.id);
    else if (store && typeof store.getRoles === "function") roles = store.getRoles(guild.id);
  } catch (e) {}
  if (!roles && guild.roles) roles = guild.roles;
  if (!roles) return null;

  var count = 0;
  if (Array.isArray(roles)) {
    for (var i = 0; i < roles.length; i++) {
      if (roles[i] && roles[i].id !== guild.id) count++;
    }
  } else if (typeof roles === "object") {
    for (var id in roles) {
      if (id !== guild.id && roles[id]) count++;
    }
  }
  return count;
}

function iconUrl(guild, size) {
  if (!guild || !guild.icon) return null;
  var animated = String(guild.icon).indexOf("a_") === 0;
  return (
    "https://cdn.discordapp.com/icons/" + guild.id + "/" + guild.icon +
    (animated ? ".gif" : ".png") + "?size=" + (size || 512)
  );
}

function acronym(guild) {
  if (guild && guild.acronym) return guild.acronym;
  var name = String((guild && guild.name) || "?");
  var letters = name.replace(/'s /g, " ").match(/[^\s]/g);
  if (!letters) return "?";
  var words = name.replace(/'s /g, " ").split(/\s+/);
  var out = "";
  for (var i = 0; i < words.length && out.length < 4; i++) {
    if (words[i]) out += words[i].charAt(0);
  }
  return out.toUpperCase();
}

/**
 * The rows the panel shows, in the original's order, each one skipped when its
 * switch is off or the value is genuinely not known.
 */
function detailRows(guild) {
  var rows = [];
  function push(key, label, value) {
    if (!storage[key]) return;
    if (value === null || value === undefined || value === "") return;
    rows.push({ key: key, label: label, value: String(value) });
  }

  push("owner", "Server owner", ownerText(guild));
  push("creationDate", "Creation date", dateText(snowflakeTime(guild.id)));
  push("joinDate", "Join date", dateText(toMillis(guild.joinedAt || guild.joined_at)));

  var members = memberCount(guild);
  push("members", "Members", members === null ? "unknown" : thousands(members));

  var channels = channelCount(guild.id);
  push("channels", "Channels", channels === null ? "unknown" : thousands(channels));

  var roles = roleCount(guild);
  push("roles", "Roles", roles === null ? "unknown" : thousands(roles));

  var boosts = guild.premiumSubscriberCount;
  if (boosts === undefined) boosts = guild.premium_subscriber_count;
  push("boosts", "Boosts", boosts === undefined || boosts === null ? "0" : thousands(boosts));

  push("language", "Language", localeName(guild.preferredLocale || guild.preferred_locale));

  push("serverId", "Server ID", guild.id);

  var vanity = guild.vanityURLCode || guild.vanity_url_code;
  push("vanity", "Vanity invite", vanity ? "discord.gg/" + vanity : "none");

  var tier = guild.premiumTier;
  if (tier === undefined) tier = guild.premium_tier;
  push("tier", "Boost tier", tier === undefined || tier === null ? "unknown" : "level " + tier);

  var level = guild.verificationLevel;
  if (level === undefined) level = guild.verification_level;
  push("verification", "Verification", VERIFICATION[level] || (level === undefined ? "unknown" : String(level)));

  push("description", "Description", guild.description);

  return rows;
}

function reportFor(guild) {
  var rows = detailRows(guild);
  var lines = [guild.name || guild.id];
  for (var i = 0; i < rows.length; i++) lines.push(rows[i].label + ": " + rows[i].value);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * the panel                                                           *
 * ------------------------------------------------------------------ */

var panel = null;
var panelListeners = [];
var settingsMounted = 0;

function panelChanged() {
  for (var i = 0; i < panelListeners.length; i++) {
    try {
      panelListeners[i]();
    } catch (e) {}
  }
}

function subscribePanel(fn) {
  panelListeners.push(fn);
  return function () {
    var i = panelListeners.indexOf(fn);
    if (i !== -1) panelListeners.splice(i, 1);
  };
}

function panelAvailable() {
  return overlayMountState === "mounted" || settingsMounted > 0;
}

function openPanel(guildId) {
  var guild = guildById(guildId);
  if (!guild) {
    toast("That server is not in the store");
    return;
  }
  if (!panelAvailable()) {
    // Nowhere to draw: hand over the same text the panel would show.
    copy(reportFor(guild), "No panel mounted - details copied");
    return;
  }
  panel = guildId;
  panelChanged();
}

function closePanel() {
  panel = null;
  panelChanged();
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
 * the details panel                                                   *
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

function GuildIcon(guild, c, size) {
  var RN = ReactNative;
  var url = storage.icon ? iconUrl(guild, 512) : null;
  if (!storage.icon) return null;
  if (url && RN.Image) {
    return h(RN.Image, {
      source: { uri: url },
      style: { width: size, height: size, borderRadius: Math.round(size / 4), backgroundColor: c.field }
    });
  }
  return h(
    RN.View,
    {
      style: {
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        backgroundColor: c.field,
        alignItems: "center",
        justifyContent: "center"
      }
    },
    h(RN.Text, { style: { color: c.dim, fontSize: Math.round(size / 3), fontWeight: "700" } }, acronym(guild))
  );
}

function DetailsPanel() {
  var RN = ReactNative;
  var c = useScheme();
  var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;

  var state = React.useState(0);
  var bump = state[1];
  React.useEffect(function () {
    return subscribePanel(function () {
      bump(function (n) {
        return n + 1;
      });
    });
  }, []);

  var guild = panel ? guildById(panel) : null;
  var rows = guild ? detailRows(guild) : [];

  return h(
    RN.Modal,
    { visible: !!guild, transparent: true, animationType: "fade", onRequestClose: closePanel },
    h(
      RN.View,
      {
        style: {
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.55)",
          justifyContent: "center",
          paddingHorizontal: 16,
          paddingVertical: 60
        }
      },
      guild
        ? h(
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
            h(
              RN.ScrollView,
              { contentContainerStyle: { paddingBottom: 6 }, style: { maxHeight: 460 } },
              h(
                RN.View,
                { style: { alignItems: "center", paddingTop: 20, paddingHorizontal: 18 } },
                GuildIcon(guild, c, 88),
                h(
                  RN.Text,
                  {
                    style: {
                      color: c.text,
                      fontSize: 17,
                      fontWeight: "700",
                      marginTop: storage.icon ? 10 : 0,
                      textAlign: "center"
                    }
                  },
                  guild.name || guild.id
                )
              ),
              h(
                RN.View,
                { style: { paddingHorizontal: 18, paddingTop: 14 } },
                rows.length
                  ? rows.map(function (row, index) {
                      return h(
                        RN.View,
                        {
                          key: "row" + index,
                          style: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 5 }
                        },
                        h(RN.Text, { style: { color: c.dim, fontSize: 13, width: 112 } }, row.label),
                        h(
                          RN.Text,
                          { selectable: true, style: { color: c.text, fontSize: 13, flex: 1, fontWeight: "500" } },
                          row.value
                        )
                      );
                    })
                  : h(
                      RN.Text,
                      { style: { color: c.dim, fontSize: 13, textAlign: "center", paddingVertical: 20 } },
                      "Every item is switched off in settings."
                    )
              )
            ),
            h(
              RN.View,
              {
                style: {
                  flexDirection: "row",
                  borderTopWidth: 1,
                  borderTopColor: c.border,
                  padding: 10
                }
              },
              h(
                Touchable,
                {
                  onPress: function () {
                    copy(reportFor(guild), "Details copied");
                  },
                  style: {
                    flex: 1,
                    backgroundColor: c.chip,
                    borderRadius: 10,
                    paddingVertical: 11,
                    alignItems: "center",
                    marginRight: 8
                  }
                },
                h(RN.Text, { style: { color: c.text, fontSize: 14, fontWeight: "700" } }, "Copy")
              ),
              h(
                Touchable,
                {
                  onPress: closePanel,
                  style: {
                    flex: 1,
                    backgroundColor: c.accent,
                    borderRadius: 10,
                    paddingVertical: 11,
                    alignItems: "center"
                  }
                },
                h(RN.Text, { style: { color: "#ffffff", fontSize: 14, fontWeight: "700" } }, "Close")
              )
            )
          )
        : null
    )
  );
}

/** Mounted above the whole app so the panel can open from the server list. */
function PanelHost() {
  var isOwner = useIsOverlayOwner();
  if (!isOwner) return null;
  if (!ReactNative || !h) return null;
  return h(DetailsPanel, null);
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
      return h(React.Fragment, null, ret, h(PanelHost, null));
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
 * the row in the server's long-press sheet                            *
 * ------------------------------------------------------------------ */

var sheetUnpatch = null;
var sheetState = "not started";
var sheetStrategy = "";
var sheetKeys = [];
var sheetRetryTimer = null;
var sheetRetries = 0;

function hideSheet() {
  try {
    var mod = ActionSheetModule();
    if (mod && typeof mod.hideActionSheet === "function") mod.hideActionSheet();
  } catch (e) {}
}

/**
 * A class error boundary, so Discord's own row component can be the default
 * without risking the sheet: if it throws, the boundary swaps in a row drawn
 * here and remembers not to try the native one again this session.
 */
var nativeBroken = false;
var Guard = null;
(function () {
  if (!React || !React.Component) return;

  function Boundary(props) {
    React.Component.call(this, props);
    this.state = { failed: false };
  }
  Boundary.prototype = Object.create(React.Component.prototype);
  Boundary.prototype.constructor = Boundary;
  Boundary.displayName = "ServerDetailsGuard";
  Boundary.getDerivedStateFromError = function () {
    return { failed: true };
  };
  Boundary.prototype.componentDidCatch = function (error) {
    nativeBroken = true;
    log("Discord's row component threw, drawing our own instead", error);
  };
  Boundary.prototype.render = function () {
    if (this.state.failed) return this.props.fallback || null;
    return this.props.children;
  };

  Guard = Boundary;
})();

/** Discord's own sheet row, newest shape first. */
function nativeRow() {
  return lazy("nativeRow", function () {
    var sheet = findByProps("ActionSheetRow");
    if (sheet && sheet.ActionSheetRow) return { component: sheet.ActionSheetRow, iconProp: "icon" };
    var form = FormRow();
    if (form) return { component: form, iconProp: "leading" };
    return null;
  });
}

function SheetRow(props) {
  try {
    var RN = ReactNative;
    if (!RN || !h) return null;
    var guildId = props.guildId;
    var c = useScheme();
    var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;
    var id = iconFor(ROW_ICON);

    function open() {
      hideSheet();
      // Let the sheet finish dismissing, otherwise the panel opens behind it.
      setTimeout(function () {
        openPanel(guildId);
      }, 80);
    }

    var drawn = h(
      Touchable,
      {
        onPress: open,
        style: {
          minHeight: 48,
          paddingHorizontal: 16,
          flexDirection: "row",
          alignItems: "center"
        }
      },
      id && RN.Image
        ? h(RN.Image, { source: id, style: { width: 24, height: 24, marginRight: 16, tintColor: c.text } })
        : null,
      h(RN.Text, { style: { color: c.text, fontSize: 16, fontWeight: "500" } }, "Server details")
    );

    var native = storage.nativeRows !== false && !nativeBroken ? nativeRow() : null;
    if (!native || !Guard) return drawn;

    var Row = native.component;
    var rowProps = { label: "Server details", onPress: open };
    try {
      if (id) {
        rowProps[native.iconProp] = Row.Icon
          ? h(Row.Icon, { source: id })
          : RN.Image
            ? h(RN.Image, { source: id, style: { width: 24, height: 24, tintColor: c.text } })
            : undefined;
      }
    } catch (e) {}

    return h(Guard, { fallback: drawn }, h(Row, rowProps));
  } catch (e) {
    log("row render failed", e);
    return null;
  }
}

function elementName(node) {
  if (!node || typeof node !== "object") return "";
  var type = node.type;
  if (!type) return "";
  if (typeof type === "string") return type;
  return type.displayName || type.name || "";
}

/**
 * Finds the array of children holding the sheet's rows, scoring candidates so a
 * stray array of text nodes is never mistaken for the row list. Bounded visit
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

function injectRow(tree, guildId) {
  if (!h) return undefined;
  var element = h(SheetRow, { guildId: guildId, key: "serverdetails-row" });
  var container = findRowContainer(tree);
  if (container) {
    container.push(element);
    sheetStrategy = "row list";
    sheetState = "row injected";
    return undefined;
  }
  sheetStrategy = "wrapped tree";
  sheetState = "row injected (fallback layout)";
  return h(React.Fragment, null, tree, element);
}

/** Any sheet about a guild will do; the key's exact name moves between builds. */
function guildIdFromProps(props) {
  if (!props || typeof props !== "object") return null;
  if (props.guild && props.guild.id) return props.guild.id;
  if (props.guildId) return props.guildId;
  if (props.guild_id) return props.guild_id;
  if (props.guild && typeof props.guild === "string") return props.guild;
  return null;
}

function patchSheet() {
  if (sheetUnpatch || !storage.sheetRow) return;
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
        if (!key || typeof key !== "string" || !/guild|server/i.test(key)) return;
        if (!promise || typeof promise.then !== "function") return;

        var guildId = guildIdFromProps(props);
        if (!guildId) {
          sheetState = "a guild sheet opened with no guild in its props";
          return;
        }
        if (sheetKeys.indexOf(key) === -1) sheetKeys.push(key);

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
                  return injectRow(tree, guildId);
                } catch (e) {
                  sheetState = "injection failed: " + ((e && e.message) || "unknown");
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

/* ------------------------------------------------------------------ *
 * settings                                                            *
 * ------------------------------------------------------------------ */

var TABS = ["Servers", "Items", "Status"];

// The original's nine, in its order.
var ITEMS = [
  { key: "icon", label: "Icon" },
  { key: "owner", label: "Server owner" },
  { key: "creationDate", label: "Creation date" },
  { key: "joinDate", label: "Join date" },
  { key: "members", label: "Members" },
  { key: "channels", label: "Channels" },
  { key: "roles", label: "Roles" },
  { key: "boosts", label: "Boosts" },
  { key: "language", label: "Language" }
];

var MORE = [
  { key: "serverId", label: "Server ID" },
  { key: "vanity", label: "Vanity invite" },
  { key: "tier", label: "Boost tier" },
  { key: "verification", label: "Verification level" },
  { key: "description", label: "Description" }
];

var BEHAVIOUR = [
  { key: "sheetRow", label: "Long-press row", hint: "Add \"Server details\" to a server's long-press sheet" },
  { key: "nativeRows", label: "Discord row style", hint: "Draw the row with Discord's own sheet component" },
  { key: "relative", label: "Relative ages", hint: "Add \"3y ago\" beside each date" },
  { key: "overlay", label: "In-app panel", hint: "Needed to open the panel outside of settings" },
  { key: "toasts", label: "Confirmation toasts", hint: "Say so when details are copied" }
];

function SettingsPage() {
  if (!h || !ReactNative) return null;

  var RN = ReactNative;
  var Touchable = RN.Pressable || RN.TouchableOpacity || RN.View;
  var c = useScheme();

  var tabState = React.useState("Servers");
  var tab = tabState[0];
  var setTab = tabState[1];

  var tickState = React.useState(0);
  var setTick = tickState[1];

  var queryState = React.useState("");
  var query = queryState[0];
  var setQuery = queryState[1];

  function refresh() {
    setTick(function (n) {
      return n + 1;
    });
  }

  React.useEffect(function () {
    return subscribePanel(refresh);
  }, []);

  // While settings is open it can host the panel itself, so the Servers tab
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
      {
        style: {
          color: c.dim,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.6,
          marginHorizontal: 18,
          marginTop: 18
        }
      },
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

  function SearchBox(value, onChange, placeholder) {
    return h(
      RN.View,
      { style: { paddingHorizontal: 10, paddingVertical: 10 } },
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

  function Switches(list, keyPrefix) {
    return list.map(function (item, index) {
      return h(
        RN.View,
        { key: keyPrefix + index },
        index ? Divider() : null,
        ToggleRow(item.label, item.hint, storage[item.key], function (next) {
          set(item.key, next);
        }, keyPrefix + "t" + index)
      );
    });
  }

  /* ---- servers tab ---- */

  function ServersTab() {
    var guilds = guildList();
    var needle = query.toLowerCase();
    var rows = guilds.filter(function (guild) {
      if (!needle) return true;
      return String(guild.name || "").toLowerCase().indexOf(needle) !== -1;
    });
    var here = currentGuildId();

    return h(
      RN.View,
      null,
      Caption(
        "Long press a server in the list for its details. This tab does the same thing without any patches, so it works even when the row does not."
      ),
      here
        ? Shell(ButtonRow([Button("Details for " + (guildName(here) || "this server"), function () {
            openPanel(here);
          })]))
        : null,
      Shell([
        SearchBox(query, setQuery, "Filter " + guilds.length + " servers"),
        Divider(),
        rows.length
          ? h(
              RN.View,
              { key: "list" },
              rows.slice(0, 200).map(function (guild, index) {
                var members = memberCount(guild);
                return h(
                  Touchable,
                  {
                    key: "g" + guild.id + index,
                    onPress: function () {
                      openPanel(guild.id);
                    },
                    style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10 }
                  },
                  GuildIcon(guild, c, 32),
                  h(
                    RN.View,
                    { style: { flex: 1, marginLeft: storage.icon ? 12 : 0 } },
                    h(
                      RN.Text,
                      { numberOfLines: 1, style: { color: c.text, fontSize: 14, fontWeight: "600" } },
                      guild.name || guild.id
                    ),
                    h(
                      RN.Text,
                      { style: { color: c.dim, fontSize: 11, marginTop: 1 } },
                      (members === null ? "members unknown" : thousands(members) + " members") +
                        " · created " + dateText(snowflakeTime(guild.id)).split(" ")[0]
                    )
                  )
                );
              })
            )
          : Empty(guilds.length ? "No server matches that." : "No servers in the store.")
      ])
    );
  }

  /* ---- items tab ---- */

  function ItemsTab() {
    return h(
      RN.View,
      null,
      Caption("The same items the BetterDiscord original shows, each with its own switch."),
      Shell(Switches(ITEMS, "it")),
      Heading("Beyond the original"),
      Shell(Switches(MORE, "mo")),
      Heading("Behaviour"),
      Shell(Switches(BEHAVIOUR, "bh")),
      Caption(
        "Tooltip width, delay, colour, show-on-shift and the date format builder are desktop-only ideas - a phone has no hover and no shift key - so they are not here."
      )
    );
  }

  /* ---- status tab ---- */

  function StatusTab() {
    var modules = [
      ["GuildStore", !!GuildStore()],
      ["GuildChannelStore", !!GuildChannelStore()],
      ["GuildRoleStore", !!GuildRoleStore()],
      ["MemberCountStore", !!GuildMemberCountStore()],
      ["UserStore", !!UserStore()],
      ["SelectedGuild", !!SelectedGuildStore()],
      ["ActionSheet", !!ActionSheetModule()],
      ["Sheet row", !!nativeRow()],
      ["Asset names", !!assetNames()]
    ];
    var guilds = guildList();

    return h(
      RN.View,
      null,
      Heading("Plugin"),
      Shell([
        InfoRow("Settings", storageIsPersistent ? "persistent" : "in-memory only", storageIsPersistent ? c.good : c.warn),
        Divider(),
        InfoRow(
          "Long-press row",
          sheetState + (sheetStrategy ? " · " + sheetStrategy : ""),
          sheetState.indexOf("injected") !== -1 ? c.good : c.dim
        ),
        Divider(),
        InfoRow("Sheets seen", sheetKeys.length ? sheetKeys.join(", ") : "none yet", sheetKeys.length ? c.good : c.dim),
        Divider(),
        InfoRow(
          "Row style",
          nativeBroken ? "ours - Discord's threw" : storage.nativeRows !== false ? "Discord's own" : "ours",
          nativeBroken ? c.warn : c.good
        ),
        Divider(),
        InfoRow("Panel", overlayMountState, overlayMountState === "mounted" ? c.good : c.dim),
        Divider(),
        InfoRow("Row icon", iconFor(ROW_ICON) ? "resolved" : "none found", iconFor(ROW_ICON) ? c.good : c.warn),
        Divider(),
        InfoRow("Servers", guilds.length + " in the store", guilds.length ? c.good : c.warn)
      ]),
      Caption(
        "The long-press row only reports its state after the first long press - that is when Discord loads the sheet module. " +
          "Any sheet whose key mentions a guild is matched, since the exact name moves between builds."
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
            nativeBroken = false;
            cache = {};
            sheetRetries = 0;
            overlayRetries = 0;
            syncPatches();
            refresh();
            note("Patches re-applied");
          }, "quiet")
        ])
      ),
      Caption("ServerDetails " + VERSION + " · after DevilBro's BetterDiscord plugin of the same name")
    );
  }

  var body = tab === "Servers" ? ServersTab() : tab === "Items" ? ItemsTab() : StatusTab();

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
    // With the overlay off, settings hosts the panel itself.
    overlayMountState === "mounted" ? null : h(DetailsPanel, null),
    h(RN.View, { style: { height: 44 } })
  );
}

function guildName(guildId) {
  var guild = guildById(guildId);
  return guild && guild.name ? guild.name : null;
}

/* ------------------------------------------------------------------ *
 * lifecycle                                                          *
 * ------------------------------------------------------------------ */

var VERSION = "1.0.0";
var running = false;

function syncPatches() {
  if (storage.sheetRow) patchSheet();
  else unpatchSheet();

  if (storage.overlay) patchOverlay();
  else unpatchOverlay();
}

function start() {
  if (running) return;
  running = true;
  applyDefaults();
  syncPatches();

  // Reachable from the DevTools Eval tab, or from another plugin.
  G.__serverdetails = {
    version: VERSION,
    open: openPanel,
    close: closePanel,
    guilds: guildList,
    rows: function (guildId) {
      var guild = guildById(guildId);
      return guild ? detailRows(guild) : null;
    },
    report: function (guildId) {
      var guild = guildById(guildId);
      return guild ? reportFor(guild) : null;
    },
    icon: function (guildId, size) {
      return iconUrl(guildById(guildId), size);
    },
    state: function () {
      return {
        sheet: sheetState,
        strategy: sheetStrategy,
        keys: sheetKeys.slice(0),
        rowStyle: nativeBroken ? "drawn (native threw)" : storage.nativeRows !== false ? "discord" : "drawn",
        panel: overlayMountState,
        icon: iconFor(ROW_ICON) ? "resolved" : "none",
        persistent: storageIsPersistent,
        servers: guildList().length
      };
    }
  };

  log("loaded", VERSION);
}

function stop() {
  running = false;
  unpatchSheet();
  unpatchOverlay();
  panel = null;
  panelListeners.length = 0;
  fetchedOwners = {};
  cache = {};
  try {
    delete G.__serverdetails;
  } catch (e) {
    G.__serverdetails = undefined;
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
