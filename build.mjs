/**
 * Zero-dependency build for every plugin in plugins/.
 *
 *   node build.mjs                            build all of them
 *   node build.mjs Toolbox                    build one
 *   node build.mjs Toolbox --serve --watch    rebuild on save and serve it to Kettu's loader
 *
 * Each plugins/<Name>/ holds an index.js and a manifest.json, and builds to a
 * folder named <Name> at the repo root, so GitHub Pages serves it at
 * https://<user>.github.io/<repo>/<Name>/ - the layout Kettu expects, where the
 * install URL is a folder and Kettu appends manifest.json itself.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, writeFile, watch } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname);
const SRC_ROOT = join(root, "plugins");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const flagValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const named = args.filter((a) => !a.startsWith("--"));

async function discover() {
  const entries = await readdir(SRC_ROOT, { withFileTypes: true });
  const all = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (!named.length) return all;
  for (const name of named) {
    if (!all.includes(name)) throw new Error(`no plugin named ${name} in plugins/ (have: ${all.join(", ")})`);
  }
  return named;
}

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

async function build(name) {
  const source = await readFile(join(SRC_ROOT, name, "index.js"), "utf8");
  const manifest = JSON.parse(await readFile(join(SRC_ROOT, name, "manifest.json"), "utf8"));

  const bundle = wrap(source, manifest);
  // Kettu only refetches a plugin's code when this hash changes.
  const hash = createHash("sha256").update(bundle).digest("hex");

  const out = join(root, name);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "index.js"), bundle);
  await writeFile(join(out, "manifest.json"), JSON.stringify({ ...manifest, hash }, null, 2) + "\n");

  console.log(`built ${name}/index.js (${(bundle.length / 1024).toFixed(1)} kb)\n  hash ${hash}`);
}

async function buildAll(names) {
  for (const name of names) await build(name);
}

const TYPES = { ".js": "application/javascript", ".json": "application/json", ".html": "text/html" };

function serve(port, name) {
  const out = join(root, name);
  createServer(async (req, res) => {
    // Accept both "/" and "/<Name>/" so the same URL shape works in dev and in prod.
    let file = (req.url || "/").split("?")[0].replace(/^\/+/, "");
    if (file === name || file === `${name}/`) file = "";
    else if (file.startsWith(`${name}/`)) file = file.slice(name.length + 1);
    if (!file) file = "manifest.json";
    try {
      const body = await readFile(join(out, file));
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "text/plain",
        "access-control-allow-origin": "*",
        "cache-control": "no-store"
      });
      res.end(body);
      console.log(`200 ${file}`);
    } catch {
      res.writeHead(404).end("not found");
      console.log(`404 ${file}`);
    }
  }).listen(port, () => {
    console.log(`serving ${name}/ on http://0.0.0.0:${port}/`);
    console.log(`install http://<this-machine-lan-ip>:${port}/ in Kettu`);
  });
}

const names = await discover();
await buildAll(names);

if (flag("serve")) serve(Number(flagValue("port", 4040)), names[0]);

if (flag("watch")) {
  console.log(`watching plugins/${names.length === 1 ? names[0] : ""}`);
  for await (const _ of watch(SRC_ROOT, { recursive: true })) {
    try {
      await buildAll(names);
    } catch (e) {
      console.error("build failed:", e.message);
    }
  }
}
