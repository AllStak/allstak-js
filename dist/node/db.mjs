import { createRequire as __allstakCreateRequire } from 'node:module';
const require = __allstakCreateRequire(import.meta.url);
import {
  detectQueryType,
  hashQuery,
  instrumentMysql2,
  instrumentPg,
  instrumentSqlite,
  markOwnedByOrm,
  normalizeQuery,
  safeCapture
} from "./chunk-2Z2PH3DC.mjs";
import "./chunk-6GVGKK5H.mjs";

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
export {
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
};
//# sourceMappingURL=db.mjs.map