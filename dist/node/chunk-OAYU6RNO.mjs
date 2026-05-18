import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);

// src/sourcemaps/walk.ts
import { readdirSync, statSync } from "fs";
import { basename, join } from "path";
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
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
      pairs.push({ jsPath: js, mapPath: map, bundleName: basename(js) });
    }
  }
  return pairs;
}

// src/sourcemaps/inject.ts
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
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
  const jsRaw = readFileSync(p.jsPath, "utf8");
  const mapRaw = readFileSync(p.mapPath, "utf8");
  const map = JSON.parse(mapRaw);
  let debugId = typeof map.debugId === "string" ? map.debugId : "";
  const existing = DEBUG_ID_LINE_RE.exec(jsRaw);
  if (existing && existing[1]) debugId = debugId || existing[1];
  const reused = !!debugId;
  if (!debugId) debugId = randomUUID();
  map.debugId = debugId;
  writeFileSync(p.mapPath, JSON.stringify(map));
  let jsOut = stripRegistration(jsRaw.replace(DEBUG_ID_LINE_RE, ""));
  jsOut = jsOut.replace(/\s+$/, "");
  jsOut += `
${buildRegistrationSnippet(jsOut, debugId)}
//# debugId=${debugId}
`;
  writeFileSync(p.jsPath, jsOut);
  return { debugId, reused };
}
function injectAll(pairs) {
  return pairs.map((pair) => ({ pair, result: injectPair(pair) }));
}
function readDebugIdFromMap(mapPath) {
  const json = JSON.parse(readFileSync(mapPath, "utf8"));
  return typeof json.debugId === "string" ? json.debugId : null;
}

// src/sourcemaps/upload.ts
import { createHash } from "crypto";
import { readFileSync as readFileSync2 } from "fs";
import { basename as basename2 } from "path";
var DEFAULT_HOST = "https://api.allstak.sa";
async function uploadOne(type, filePath, debugId, opts) {
  let buf = readFileSync2(filePath);
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
    basename2(filePath)
  );
  const res = await fetch(opts.host.replace(/\/$/, "") + "/api/v1/artifacts/upload", {
    method: "POST",
    headers: { "X-AllStak-Upload-Token": opts.token },
    body: form
  });
  return { status: res.status, body: await res.text(), ok: res.ok };
}
function sha8(filePath) {
  return createHash("sha256").update(readFileSync2(filePath)).digest("hex").slice(0, 8);
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
import { resolve } from "path";
async function processBuildOutput(opts) {
  const dir = resolve(opts.dir);
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

export {
  walk,
  findPairs,
  injectPair,
  injectAll,
  readDebugIdFromMap,
  DEFAULT_HOST,
  uploadPair,
  uploadAll,
  processBuildOutput
};
//# sourceMappingURL=chunk-OAYU6RNO.mjs.map