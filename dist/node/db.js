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

// src/integrations/db/index.ts
var db_exports = {};
__export(db_exports, {
  detectQueryType: () => detectQueryType,
  hashQuery: () => hashQuery,
  instrumentMongo: () => instrumentMongo,
  instrumentMongoose: () => instrumentMongoose,
  instrumentMysql2: () => instrumentMysql2,
  instrumentPg: () => instrumentPg,
  instrumentPrisma: () => instrumentPrisma,
  instrumentSequelize: () => instrumentSequelize,
  instrumentSqlite: () => instrumentSqlite,
  normalizeQuery: () => normalizeQuery
});
module.exports = __toCommonJS(db_exports);

// src/integrations/db/shared.ts
var traceResolver = null;
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
  const req = typeof require !== "undefined" ? require : null;
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

// src/integrations/db/prisma.ts
function instrumentPrisma(prisma, dbModule, config = {}) {
  if (!prisma || typeof prisma.$on !== "function") return false;
  try {
    prisma.$on("query", (e) => {
      const normalized = normalizeQuery(e.query);
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(e.query),
        durationMs: Math.max(0, Math.round(e.duration ?? 0)),
        timestampMillis: e.timestamp ? new Date(e.timestamp).getTime() : Date.now(),
        status: "success",
        databaseName: "",
        databaseType: config.databaseType ?? "postgresql",
        rowsAffected: -1
      });
    });
    if (prisma._engine) markOwnedByOrm(prisma._engine);
    return true;
  } catch {
    return false;
  }
}

// src/integrations/db/sequelize.ts
var START_SYMBOL = /* @__PURE__ */ Symbol.for("allstak.sequelize.start");
function instrumentSequelize(sequelize, dbModule, config = {}) {
  if (!sequelize || typeof sequelize.addHook !== "function") return false;
  const dialect = sequelize.options?.dialect;
  const databaseType = mapDialect(dialect);
  const databaseName = sequelize.options?.database ?? sequelize.config?.database ?? "";
  try {
    sequelize.addHook("afterConnect", (...args) => {
      const conn = args[0];
      if (conn && typeof conn === "object") markOwnedByOrm(conn);
    });
    sequelize.addHook("beforeQuery", (...args) => {
      const options = args[0];
      if (options && typeof options === "object") {
        options[START_SYMBOL] = Date.now();
      }
    });
    sequelize.addHook("afterQuery", (...args) => {
      const options = args[0];
      const query = args[1];
      const startTime = options?.[START_SYMBOL] ?? Date.now();
      const sql = query?.sql ?? "";
      const normalized = normalizeQuery(sql);
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(sql),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status: "success",
        databaseName,
        databaseType,
        rowsAffected: -1
      });
    });
    if (sequelize.connectionManager) {
      markOwnedByOrm(sequelize.connectionManager);
      if (sequelize.connectionManager.pool) {
        markOwnedByOrm(sequelize.connectionManager.pool);
      }
      const cm = sequelize.connectionManager;
      if (cm.getConnection && typeof cm.getConnection === "function") {
        const origGetConnection = cm.getConnection.bind(cm);
        cm.getConnection = async function wrappedGetConnection(options) {
          const conn = await origGetConnection(options);
          if (conn && typeof conn === "object") markOwnedByOrm(conn);
          return conn;
        };
      }
    }
    return true;
  } catch {
    return false;
  }
}
function mapDialect(dialect) {
  switch (dialect) {
    case "postgres":
      return "postgresql";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case "mssql":
      return "mssql";
    default:
      return dialect ?? "unknown";
  }
}

// src/integrations/db/mongoose.ts
function normalizeCommandName(name) {
  if (!name) return "OTHER";
  if (name === "find") return "SELECT";
  if (name === "getMore") return "SELECT";
  if (name === "aggregate") return "SELECT";
  if (name === "count") return "SELECT";
  if (name === "distinct") return "SELECT";
  if (name === "insert") return "INSERT";
  if (name === "update") return "UPDATE";
  if (name === "delete") return "DELETE";
  if (name === "findAndModify" || name === "findandmodify") return "UPDATE";
  return name.toUpperCase();
}
function extractCollection(evt) {
  const cmd = evt.command ?? {};
  const name = evt.commandName;
  const target = cmd[name];
  return typeof target === "string" ? target : "";
}
function extractRows(evt) {
  const reply = evt.reply ?? {};
  const n = reply.n;
  const nModified = reply.nModified;
  const deletedCount = reply.deletedCount;
  return nModified ?? deletedCount ?? n ?? -1;
}
var inFlight = /* @__PURE__ */ new Map();
function instrumentMongo(client, dbModule, config = {}) {
  if (!client || typeof client.on !== "function") return false;
  try {
    client.on("commandStarted", (evt) => {
      const commandName = evt.commandName ?? "unknown";
      const collection = extractCollection(evt);
      const normalized = `${commandName} ${collection}`.trim();
      inFlight.set(evt.requestId, {
        startTime: Date.now(),
        normalized,
        collection,
        commandName
      });
    });
    client.on("commandSucceeded", (evt) => {
      const pending = inFlight.get(evt.requestId);
      inFlight.delete(evt.requestId);
      const startTime = pending?.startTime ?? Date.now();
      const normalized = pending?.normalized ?? `${evt.commandName ?? "unknown"}`;
      const rows = extractRows(evt);
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: normalizeCommandName(pending?.commandName ?? evt.commandName ?? "OTHER"),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status: "success",
        databaseName: evt.databaseName ?? "",
        databaseType: "mongodb",
        rowsAffected: rows
      });
    });
    client.on("commandFailed", (evt) => {
      const pending = inFlight.get(evt.requestId);
      inFlight.delete(evt.requestId);
      const startTime = pending?.startTime ?? Date.now();
      const normalized = pending?.normalized ?? `${evt.commandName ?? "unknown"}`;
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: normalizeCommandName(pending?.commandName ?? evt.commandName ?? "OTHER"),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status: "error",
        errorMessage: evt.failure?.message?.slice(0, 500),
        databaseName: evt.databaseName ?? "",
        databaseType: "mongodb",
        rowsAffected: -1
      });
    });
    return true;
  } catch {
    return false;
  }
}
function instrumentMongoose(mongoose, dbModule, config = {}) {
  const client = mongoose?.connection?.client;
  if (!client) return false;
  return instrumentMongo(client, dbModule, config);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  detectQueryType,
  hashQuery,
  instrumentMongo,
  instrumentMongoose,
  instrumentMysql2,
  instrumentPg,
  instrumentPrisma,
  instrumentSequelize,
  instrumentSqlite,
  normalizeQuery
});
//# sourceMappingURL=db.js.map