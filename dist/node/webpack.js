"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/integrations/webpack.ts
var webpack_exports = {};
__export(webpack_exports, {
  AllStakWebpackPlugin: () => AllStakWebpackPlugin
});
module.exports = __toCommonJS(webpack_exports);

// src/sourcemaps/walk.ts
var import_node_fs = require("fs");
var import_node_path = require("path");
function walk(dir, out = []) {
  for (const name of (0, import_node_fs.readdirSync)(dir)) {
    const full = (0, import_node_path.join)(dir, name);
    const st = (0, import_node_fs.statSync)(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
function findPairs(root) {
  const all = walk(root);
  const maps = new Set(all.filter((p) => p.endsWith(".map")));
  const pairs = [];
  for (const js of all) {
    if (!js.endsWith(".js") && !js.endsWith(".mjs") && !js.endsWith(".cjs")) continue;
    const map = js + ".map";
    if (maps.has(map)) {
      pairs.push({ jsPath: js, mapPath: map, bundleName: (0, import_node_path.basename)(js) });
    }
  }
  return pairs;
}

// src/sourcemaps/inject.ts
var import_node_fs2 = require("fs");
var import_node_crypto = require("crypto");
var DEBUG_ID_LINE_RE = /^\/\/# debugId=([0-9a-f-]{36})\s*$/m;
var REGISTRATION_MARKER = "/*!__allstak_debug_id_registration__*/";
function buildRegistrationSnippet(jsBody, debugId) {
  const isEsm = /\bimport\.meta\b/.test(jsBody) || /^\s*(?:import|export)\b/m.test(jsBody);
  if (isEsm) {
    return `${REGISTRATION_MARKER}try{(globalThis._allstakDebugIds=globalThis._allstakDebugIds||{})[import.meta.url]="${debugId}"}catch(_){}`;
  }
  return `${REGISTRATION_MARKER}(function(){try{var u=(typeof document!=="undefined"&&document.currentScript&&document.currentScript.src)||(typeof location!=="undefined"?location.href:"");(globalThis._allstakDebugIds=globalThis._allstakDebugIds||{})[u]="${debugId}"}catch(_){}})();`;
}
function stripRegistration(js) {
  const lineRe = new RegExp(
    "^" + REGISTRATION_MARKER.replace(/[/*!]/g, (c) => "\\" + c) + ".*$",
    "m"
  );
  return js.replace(lineRe, "");
}
function injectPair(p) {
  const jsRaw = (0, import_node_fs2.readFileSync)(p.jsPath, "utf8");
  const mapRaw = (0, import_node_fs2.readFileSync)(p.mapPath, "utf8");
  const map = JSON.parse(mapRaw);
  let debugId = typeof map.debugId === "string" ? map.debugId : "";
  const existing = DEBUG_ID_LINE_RE.exec(jsRaw);
  if (existing && existing[1]) debugId = debugId || existing[1];
  const reused = !!debugId;
  if (!debugId) debugId = (0, import_node_crypto.randomUUID)();
  map.debugId = debugId;
  (0, import_node_fs2.writeFileSync)(p.mapPath, JSON.stringify(map));
  let jsOut = stripRegistration(jsRaw.replace(DEBUG_ID_LINE_RE, ""));
  jsOut = jsOut.replace(/\s+$/, "");
  jsOut += `
${buildRegistrationSnippet(jsOut, debugId)}
//# debugId=${debugId}
`;
  (0, import_node_fs2.writeFileSync)(p.jsPath, jsOut);
  return { debugId, reused };
}
function injectAll(pairs) {
  return pairs.map((pair) => ({ pair, result: injectPair(pair) }));
}
function readDebugIdFromMap(mapPath) {
  const json = JSON.parse((0, import_node_fs2.readFileSync)(mapPath, "utf8"));
  return typeof json.debugId === "string" ? json.debugId : null;
}

// src/sourcemaps/upload.ts
var import_node_crypto2 = require("crypto");
var import_node_fs3 = require("fs");
var import_node_path2 = require("path");
var DEFAULT_HOST = "https://api.allstak.sa";
async function uploadOne(type, filePath, debugId, opts) {
  let buf = (0, import_node_fs3.readFileSync)(filePath);
  if (type === "sourcemap" && opts.stripSources) {
    const json = JSON.parse(buf.toString("utf8"));
    if (Array.isArray(json.sourcesContent)) delete json.sourcesContent;
    buf = Buffer.from(JSON.stringify(json));
  }
  const form = new FormData();
  form.append("debugId", debugId);
  form.append("type", type);
  form.append("release", opts.release);
  if (opts.dist) form.append("dist", opts.dist);
  form.append(
    "file",
    new Blob([buf], {
      type: type === "sourcemap" ? "application/json" : "application/javascript"
    }),
    (0, import_node_path2.basename)(filePath)
  );
  const res = await fetch(opts.host.replace(/\/$/, "") + "/api/v1/artifacts/upload", {
    method: "POST",
    headers: { "X-AllStak-Upload-Token": opts.token },
    body: form
  });
  return { status: res.status, body: await res.text(), ok: res.ok };
}
function sha8(filePath) {
  return (0, import_node_crypto2.createHash)("sha256").update((0, import_node_fs3.readFileSync)(filePath)).digest("hex").slice(0, 8);
}
async function uploadPair(pair, opts) {
  const debugId = readDebugIdFromMap(pair.mapPath);
  if (!debugId) {
    throw new Error(
      `[allstak/sourcemaps] no debugId in ${pair.mapPath} \u2014 run injectPair() before upload`
    );
  }
  const required = {
    release: opts.release,
    host: opts.host ?? DEFAULT_HOST,
    token: opts.token,
    dist: opts.dist,
    stripSources: opts.stripSources ?? false
  };
  const steps = [];
  const mapStep = await uploadOne("sourcemap", pair.mapPath, debugId, required);
  steps.push({ type: "sourcemap", status: mapStep.status, sha8: sha8(pair.mapPath), body: mapStep.body });
  if (!mapStep.ok) {
    return { bundleName: pair.bundleName, debugId, ok: false, steps };
  }
  if (opts.uploadBundles) {
    const bundleStep = await uploadOne("bundle", pair.jsPath, debugId, required);
    steps.push({ type: "bundle", status: bundleStep.status, sha8: sha8(pair.jsPath), body: bundleStep.body });
    if (!bundleStep.ok) {
      return { bundleName: pair.bundleName, debugId, ok: false, steps };
    }
  }
  return { bundleName: pair.bundleName, debugId, ok: true, steps };
}
async function uploadAll(pairs, opts) {
  const out = [];
  for (const p of pairs) out.push(await uploadPair(p, opts));
  return out;
}

// src/sourcemaps/index.ts
var import_node_path3 = require("path");
async function processBuildOutput(opts) {
  const dir = (0, import_node_path3.resolve)(opts.dir);
  const pairs = findPairs(dir);
  const log = opts.silent ? () => void 0 : (m) => console.log(`[allstak/sourcemaps] ${m}`);
  log(`scanning ${dir} \u2014 ${pairs.length} bundle/map pair(s)`);
  if (pairs.length === 0) {
    return { dir, pairs: 0, injected: [] };
  }
  const injectedRaw = injectAll(pairs);
  const injected = injectedRaw.map(({ pair, result }) => ({
    bundleName: pair.bundleName,
    debugId: result.debugId,
    reused: result.reused
  }));
  for (const i of injected) {
    log(`  ${i.bundleName}  ${i.debugId}  ${i.reused ? "(reused)" : "(new)"}`);
  }
  if (opts.injectOnly || !opts.token) {
    if (!opts.injectOnly && !opts.token) {
      log("skipping upload \u2014 no token provided (set ALLSTAK_UPLOAD_TOKEN or pass `token`)");
    }
    return { dir, pairs: pairs.length, injected };
  }
  const uploaded = await uploadAll(pairs, opts);
  for (const u of uploaded) {
    if (u.ok) {
      log(`  ${u.bundleName}  uploaded debugId=${u.debugId}`);
    } else {
      const last = u.steps[u.steps.length - 1];
      log(`  ${u.bundleName}  FAIL status=${last?.status ?? "?"} body=${last?.body ?? ""}`);
    }
  }
  return { dir, pairs: pairs.length, injected, uploaded };
}

// src/integrations/webpack.ts
var AllStakWebpackPlugin = class {
  constructor(opts = {}) {
    this.opts = opts;
    /** Last successful report — exposed for tests / programmatic inspection. */
    this.lastReport = null;
  }
  apply(compiler) {
    if (this.opts.disabled) return;
    compiler.hooks.afterEmit.tapPromise("AllStakWebpackPlugin", async (compilation) => {
      const dir = this.opts.dir ?? compilation.compiler?.outputPath ?? compiler.outputPath ?? compiler.options?.output?.path ?? process.cwd();
      try {
        this.lastReport = await processBuildOutput({
          ...this.opts,
          dir,
          silent: this.opts.silent ?? false
        });
      } catch (e) {
        console.error(`[allstak/webpack] failed: ${e.message}`);
      }
    });
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AllStakWebpackPlugin
});
//# sourceMappingURL=webpack.js.map