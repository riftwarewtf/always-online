/**
 * Zero-dependency build.
 *
 *   node build.mjs                     build DevTools/
 *   node build.mjs --serve --watch     rebuild on save and serve over http for Kettu's dev loader
 *
 * Output goes to a folder named after the plugin at the repo root, so GitHub
 * Pages serves it at https://<user>.github.io/<repo>/<Plugin>/ - the layout
 * Kettu expects, where the install URL is a folder and Kettu appends
 * manifest.json itself.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, watch } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname);
const SRC = join(root, "src", "index.js");
const MANIFEST = join(root, "manifest.json");
const PLUGIN_DIR = "DevTools";
const OUT = join(root, PLUGIN_DIR);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const flagValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

function wrap(source, manifest) {
  // The bundle MUST begin with "(" as its very first character. Kettu evaluates it
  // as `return <contents>`, and a newline (or a leading comment followed by one)
  // right after `return` triggers automatic semicolon insertion, which turns the
  // entire plugin into dead code that silently loads as nothing. Banner goes inside.
  return `(function () {
  "use strict";
  /* ${manifest.name} v${manifest.version} - built ${new Date().toISOString()} */
  var __mod = { exports: {} };
  (function (module, exports) {
${source}
  })(__mod, __mod.exports);
  try {
    if (typeof module !== "undefined" && module && typeof module === "object") {
      module.exports = __mod.exports;
    }
  } catch (e) {}
  return __mod.exports;
})()`;
}

async function build() {
  const source = await readFile(SRC, "utf8");
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));

  const bundle = wrap(source, manifest);
  // Kettu only refetches a plugin's code when this hash changes.
  const hash = createHash("sha256").update(bundle).digest("hex");

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "index.js"), bundle);
  await writeFile(join(OUT, "manifest.json"), JSON.stringify({ ...manifest, hash }, null, 2) + "\n");

  console.log(`built ${PLUGIN_DIR}/index.js (${(bundle.length / 1024).toFixed(1)} kb)\n  hash ${hash}`);
  return { bundle, manifest, hash };
}

const TYPES = { ".js": "application/javascript", ".json": "application/json", ".html": "text/html" };

function serve(port) {
  createServer(async (req, res) => {
    // Accept both "/" and "/DevTools/" so the same URL shape works in dev and in prod.
    let name = (req.url || "/").split("?")[0].replace(/^\/+/, "").replace(/^DevTools\/?/, "");
    if (!name) name = "manifest.json";
    try {
      const body = await readFile(join(OUT, name));
      res.writeHead(200, {
        "content-type": TYPES[extname(name)] ?? "text/plain",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      });
      res.end(body);
      console.log(`200 ${name}`);
    } catch {
      res.writeHead(404).end("not found");
      console.log(`404 ${name}`);
    }
  }).listen(port, () => {
    console.log(`serving ${PLUGIN_DIR}/ on http://0.0.0.0:${port}/`);
    console.log(`install http://<this-machine-lan-ip>:${port}/ in Kettu`);
  });
}

await build();

if (flag("serve")) serve(Number(flagValue("port", 4040)));

if (flag("watch")) {
  console.log("watching src/");
  for await (const _ of watch(join(root, "src"), { recursive: true })) {
    try {
      await build();
    } catch (e) {
      console.error("build failed:", e.message);
    }
  }
}
