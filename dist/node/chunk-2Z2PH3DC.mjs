import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  __require
} from "./chunk-6GVGKK5H.mjs";

// src/integrations/db/shared.ts
var traceResolver = null;
function setTraceResolver(resolver) {
  traceResolver = resolver;
}
function getTraceContext() {
  if (!traceResolver) return {};
  try {
    return traceResolver() ?? {};
  } catch {
    return {};
  }
}
function normalizeQuery(sql) {
  if (!sql) return "";
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/'(?:''|[^'])*'/g, "?").replace(/\$[a-zA-Z0-9_]*\$[\s\S]*?\$[a-zA-Z0-9_]*\$/g, "?").replace(/\b\d+(?:\.\d+)?\b/g, "?").replace(/\s+/g, " ").trim();
}
function hashQuery(normalized) {
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + c;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
function detectQueryType(sql) {
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase();
  if (!first) return "OTHER";
  if (["SELECT", "INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "ROLLBACK"].includes(first)) {
    return first;
  }
  return "OTHER";
}
function safeCapture(dbModule, config, item) {
  try {
    const ctx = getTraceContext();
    dbModule.capture({
      ...item,
      service: config.service,
      environment: config.environment,
      traceId: ctx.traceId,
      spanId: ctx.spanId
    });
  } catch {
  }
}
var DEDUPE_SYMBOL = /* @__PURE__ */ Symbol.for("allstak.db.ownedByOrm");
function markOwnedByOrm(target) {
  try {
    if (target && typeof target === "object") {
      target[DEDUPE_SYMBOL] = true;
    }
  } catch {
  }
}
function isOwnedByOrm(target) {
  try {
    if (target && typeof target === "object") {
      return target[DEDUPE_SYMBOL] === true;
    }
  } catch {
  }
  return false;
}
function tryRequire(name) {
  const req = typeof __require !== "undefined" ? __require : null;
  if (!req) {
    if (process?.env?.ALLSTAK_DB_DEBUG === "1") {
      console.error(`[allstak-db] tryRequire('${name}') skipped: no require`);
    }
    return null;
  }
  const bases = [];
  try {
    bases.push(process.cwd());
  } catch {
  }
  try {
    const mainPaths = req.main?.paths;
    if (mainPaths) bases.push(...mainPaths);
  } catch {
  }
  for (const base of bases) {
    try {
      const resolved = req.resolve(name, { paths: [base] });
      return req(resolved);
    } catch {
    }
  }
  try {
    return req(name);
  } catch (e) {
    if (typeof process !== "undefined" && process?.env?.ALLSTAK_DB_DEBUG === "1") {
      console.error(`[allstak-db] tryRequire('${name}') failed:`, e.message);
    }
    return null;
  }
}

// src/integrations/db/pg.ts
var patched = false;
function instrumentPg(dbModule, config = {}) {
  if (patched) return true;
  const pg = tryRequire("pg");
  if (!pg || !pg.Client || !pg.Client.prototype || !pg.Client.prototype.query) {
    return false;
  }
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function patchedPgQuery(...args) {
    if (isOwnedByOrm(this)) {
      return originalQuery.apply(this, args);
    }
    const startTime = Date.now();
    const firstArg = args[0];
    const queryText = typeof firstArg === "string" ? firstArg : firstArg?.text ?? "";
    const normalized = normalizeQuery(queryText);
    const databaseName = this.database ?? "";
    const record2 = (status, err, rowsAffected = -1) => {
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(queryText),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status,
        errorMessage: err?.message?.slice(0, 500),
        databaseName,
        databaseType: "postgresql",
        rowsAffected
      });
    };
    let cbIndex = -1;
    for (let i = args.length - 1; i >= 0; i--) {
      if (typeof args[i] === "function") {
        cbIndex = i;
        break;
      }
    }
    const submittable = firstArg && typeof firstArg === "object" ? firstArg : null;
    if (cbIndex >= 0) {
      const originalCb = args[cbIndex];
      args[cbIndex] = function wrappedCb(err, res) {
        record2(err ? "error" : "success", err ?? void 0, res?.rowCount ?? -1);
        return originalCb.call(this, err, res);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        record2("error", err);
        throw err;
      }
    } else if (submittable?.callback && typeof submittable.callback === "function") {
      const originalCb = submittable.callback;
      submittable.callback = function wrappedCb(err, res) {
        record2(err ? "error" : "success", err ?? void 0, res?.rowCount ?? -1);
        return originalCb.call(this, err, res);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        record2("error", err);
        throw err;
      }
    }
    try {
      const result = originalQuery.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then(
          (res) => {
            record2("success", void 0, res?.rowCount ?? -1);
            return res;
          },
          (err) => {
            record2("error", err);
            throw err;
          }
        );
      }
      const maybeEmitter = result;
      if (maybeEmitter && typeof maybeEmitter.on === "function") {
        maybeEmitter.on("end", () => record2("success"));
        maybeEmitter.on("error", (err) => record2("error", err));
      }
      return result;
    } catch (err) {
      record2("error", err);
      throw err;
    }
  };
  patched = true;
  return true;
}

// src/integrations/db/mysql2.ts
var patched2 = false;
function instrumentMysql2(dbModule, config = {}) {
  if (patched2) return true;
  const mysql2 = tryRequire("mysql2");
  if (!mysql2?.Connection?.prototype) return false;
  const proto = mysql2.Connection.prototype;
  const getSql = (args) => {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const o = first;
      if (typeof o.sql === "string") return o.sql;
    }
    return "";
  };
  const wrapProtoMethod = (methodName) => {
    const original = proto[methodName];
    if (typeof original !== "function") return;
    proto[methodName] = function wrapped(...args) {
      if (isOwnedByOrm(this)) {
        return original.apply(this, args);
      }
      const startTime = Date.now();
      const sql = getSql(args);
      const normalized = normalizeQuery(sql);
      const databaseName = this.config?.database ?? "";
      const record2 = (status, err, rowsAffected = -1) => {
        safeCapture(dbModule, config, {
          normalizedQuery: normalized,
          queryHash: hashQuery(normalized),
          queryType: detectQueryType(sql),
          durationMs: Date.now() - startTime,
          timestampMillis: startTime,
          status,
          errorMessage: err?.message?.slice(0, 500),
          databaseName,
          databaseType: "mysql",
          rowsAffected
        });
      };
      let cbIndex = -1;
      for (let i = args.length - 1; i >= 0; i--) {
        if (typeof args[i] === "function") {
          cbIndex = i;
          break;
        }
      }
      const wrapOriginalCb = (original2) => {
        return function wrappedCb(err, results, fields) {
          const rows = results?.affectedRows ?? results?.length ?? -1;
          record2(err ? "error" : "success", err ?? void 0, rows);
          return original2.call(this, err, results, fields);
        };
      };
      if (cbIndex >= 0) {
        const originalCb = args[cbIndex];
        args[cbIndex] = wrapOriginalCb(originalCb);
        try {
          return original.apply(this, args);
        } catch (err) {
          record2("error", err);
          throw err;
        }
      }
      const first = args[0];
      if (first && typeof first.onResult === "function") {
        const origOnResult = first.onResult;
        first.onResult = wrapOriginalCb(origOnResult);
        try {
          return original.apply(this, args);
        } catch (err) {
          record2("error", err);
          throw err;
        }
      }
      try {
        const result = original.apply(this, args);
        record2("success");
        return result;
      } catch (err) {
        record2("error", err);
        throw err;
      }
    };
  };
  wrapProtoMethod("query");
  wrapProtoMethod("execute");
  patched2 = true;
  return true;
}

// src/integrations/db/sqlite.ts
var patched3 = false;
function record(dbModule, config, startTime, sql, databaseName, status, err, rowsAffected = -1) {
  const normalized = normalizeQuery(sql);
  safeCapture(dbModule, config, {
    normalizedQuery: normalized,
    queryHash: hashQuery(normalized),
    queryType: detectQueryType(sql),
    durationMs: Date.now() - startTime,
    timestampMillis: startTime,
    status,
    errorMessage: err?.message?.slice(0, 500),
    databaseName,
    databaseType: "sqlite",
    rowsAffected
  });
}
function patchBetterSqlite3(dbModule, config) {
  const mod = tryRequire("better-sqlite3");
  if (!mod || !mod.prototype) return false;
  const origPrepare = mod.prototype.prepare;
  const origExec = mod.prototype.exec;
  if (typeof origPrepare === "function") {
    mod.prototype.prepare = function(sql) {
      if (isOwnedByOrm(this)) {
        return origPrepare.call(this, sql);
      }
      const databaseName = this.name ?? "";
      let stmt;
      try {
        stmt = origPrepare.call(this, sql);
      } catch (err) {
        record(dbModule, config, Date.now(), sql, databaseName, "error", err);
        throw err;
      }
      for (const method of ["run", "get", "all", "iterate"]) {
        const original = stmt[method];
        if (typeof original === "function") {
          stmt[method] = function(...args) {
            const startTime = Date.now();
            try {
              const result = original.apply(this, args);
              const rows = result?.changes ?? (Array.isArray(result) ? result.length : -1);
              record(dbModule, config, startTime, sql, databaseName, "success", void 0, rows);
              return result;
            } catch (err) {
              record(dbModule, config, startTime, sql, databaseName, "error", err);
              throw err;
            }
          };
        }
      }
      return stmt;
    };
  }
  if (typeof origExec === "function") {
    mod.prototype.exec = function(sql) {
      if (isOwnedByOrm(this)) return origExec.call(this, sql);
      const startTime = Date.now();
      const databaseName = this.name ?? "";
      try {
        const result = origExec.call(this, sql);
        record(dbModule, config, startTime, sql, databaseName, "success");
        return result;
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, "error", err);
        throw err;
      }
    };
  }
  return true;
}
function patchSqlite3(dbModule, config) {
  const mod = tryRequire("sqlite3");
  if (!mod?.Database?.prototype) return false;
  const proto = mod.Database.prototype;
  for (const method of ["run", "get", "all", "each", "exec"]) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function(...args) {
      if (isOwnedByOrm(this)) {
        return original.apply(this, args);
      }
      const startTime = Date.now();
      const sql = typeof args[0] === "string" ? args[0] : "";
      const databaseName = this.filename ?? "";
      const cbIndex = args.findIndex((a) => typeof a === "function");
      if (cbIndex >= 0) {
        const cb = args[cbIndex];
        args[cbIndex] = function(err, ...rest) {
          const rows = this?.changes ?? -1;
          record(
            dbModule,
            config,
            startTime,
            sql,
            databaseName,
            err ? "error" : "success",
            err ?? void 0,
            rows
          );
          return cb.apply(this, [err, ...rest]);
        };
      } else {
        record(dbModule, config, startTime, sql, databaseName, "success");
      }
      try {
        return original.apply(this, args);
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, "error", err);
        throw err;
      }
    };
  }
  return true;
}
function patchNodeSqlite(dbModule, config) {
  const origEmit = process.emitWarning;
  process.emitWarning = function(warning, ...args) {
    if (typeof warning === "string" && warning.includes("SQLite is an experimental feature")) return;
    return origEmit.call(process, warning, ...args);
  };
  const mod = tryRequire("node:sqlite");
  process.emitWarning = origEmit;
  if (!mod?.DatabaseSync?.prototype) return false;
  const dbProto = mod.DatabaseSync.prototype;
  const origPrepare = dbProto.prepare;
  if (typeof origPrepare === "function") {
    dbProto.prepare = function(sql) {
      const stmt = origPrepare.call(this, sql);
      const databaseName = this.location ?? "";
      for (const method of ["run", "get", "all"]) {
        const original = stmt[method];
        if (typeof original === "function") {
          stmt[method] = function(...args) {
            const startTime = Date.now();
            try {
              const result = original.apply(this, args);
              const rows = result?.changes ?? (Array.isArray(result) ? result.length : -1);
              record(dbModule, config, startTime, sql, databaseName, "success", void 0, rows);
              return result;
            } catch (err) {
              record(dbModule, config, startTime, sql, databaseName, "error", err);
              throw err;
            }
          };
        }
      }
      return stmt;
    };
  }
  const origExec = dbProto.exec;
  if (typeof origExec === "function") {
    dbProto.exec = function(sql) {
      const startTime = Date.now();
      const databaseName = this.location ?? "";
      try {
        const result = origExec.call(this, sql);
        record(dbModule, config, startTime, sql, databaseName, "success");
        return result;
      } catch (err) {
        record(dbModule, config, startTime, sql, databaseName, "error", err);
        throw err;
      }
    };
  }
  return true;
}
function instrumentSqlite(dbModule, config = {}) {
  if (patched3) return true;
  let any = false;
  any = patchBetterSqlite3(dbModule, config) || any;
  any = patchSqlite3(dbModule, config) || any;
  any = patchNodeSqlite(dbModule, config) || any;
  if (any) patched3 = true;
  return any;
}

export {
  setTraceResolver,
  normalizeQuery,
  hashQuery,
  detectQueryType,
  safeCapture,
  markOwnedByOrm,
  instrumentPg,
  instrumentMysql2,
  instrumentSqlite
};
//# sourceMappingURL=chunk-2Z2PH3DC.mjs.map