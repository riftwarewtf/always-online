/**
 * Zero-dependency build for the Always Online plugin.
 *
 *   node build.mjs            build dist/
 *   node build.mjs --serve    build, then serve dist/ over http for Kettu's dev loader
 *   node build.mjs --watch    rebuild whenever src/ changes (combine with --serve)
 *
 * Kettu evaluates a plugin's main file as `return <file contents>`, so the bundle
 * has to be a single JavaScript expression. The wrapper below is one IIFE that
 * hands the source a CommonJS-looking `module`, then returns its exports - and
 * also assigns them to an outer `module` if the loader supplied one, so the same
 * file works under either convention.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, watch } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname);
const SRC = join(root, "src", "index.js");
const MANIFEST = join(root, "manifest.json");
const DIST = join(root, "dist");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const flagValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

function wrap(source, manifest) {
  // The bundle MUST begin with "(" on the very first character. Kettu evaluates it
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
  const hash = createHash("sha256").update(bundle).digest("hex");

  await mkdir(DIST, { recursive: true });
  await writeFile(join(DIST, "index.js"), bundle);
  // Kettu only refetches a plugin's code when this hash changes.
  await writeFile(
    join(DIST, "manifest.json"),
    JSON.stringify({ ...manifest, hash }, null, 2) + "\n"
  );

  console.log(
    `built dist/index.js (${(bundle.length / 1024).toFixed(1)} kb)\n` +
      `  hash ${hash}`
  );
  return { bundle, manifest, hash };
}

const TYPES = { ".js": "application/javascript", ".json": "application/json" };

function serve(port) {
  createServer(async (req, res) => {
    const name = (req.url || "/").split("?")[0].replace(/^\/+/, "") || "index.js";
    try {
      const body = await readFile(join(DIST, name));
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
    console.log(`serving dist/ on http://0.0.0.0:${port}/`);
    console.log("point Kettu's plugin install at http://<this-machine-lan-ip>:" + port + "/");
  });
}

await build();

if (flag("serve")) serve(Number(flagValue("port", 4040)));

if (flag("watch")) {
  console.log("watching src/ and manifest.json");
  for await (const _ of watch(join(root, "src"), { recursive: true })) {
    try {
      await build();
    } catch (e) {
      console.error("build failed:", e.message);
    }
  }
}
