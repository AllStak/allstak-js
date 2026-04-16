/**
 * MongoDB + Mongoose integration.
 *
 * Strategy: the official `mongodb` driver exposes APM (Application
 * Performance Monitoring) events on the MongoClient via the constructor
 * option `monitorCommands: true`. Events `commandStarted`,
 * `commandSucceeded`, `commandFailed` give us per-operation timing + the
 * command body (filter/doc/update spec) + the database and collection name.
 *
 * Because Mongoose is a layer on top of the `mongodb` driver, hooking the
 * underlying MongoClient transparently covers Mongoose too — we just need
 * the caller to pass the right client in (either `mongoose.connection.client`
 * or the MongoClient they created manually).
 *
 * Mapping to the SQL-shaped backend ingest contract:
 *   - normalizedQuery = "<commandName> <collection>"  e.g. "find tasks"
 *   - queryType       = uppercased commandName e.g. "FIND" / "INSERT" / "UPDATE" / "DELETE"
 *   - databaseType    = "mongodb"
 *   - databaseName    = the databaseName from the APM event
 *   - durationMs      = event.duration  (mongodb driver gives this in microseconds)
 *   - status          = success | error
 *   - errorMessage    = on failure
 *   - rowsAffected    = n / nModified / deletedCount when present
 *
 * We never ship document values or filter fields — only command shape. This
 * avoids leaking PII the way raw SQL normalization does.
 */

import type { DatabaseModule } from '../../modules/database';
import {
  DbIntegrationConfig,
  hashQuery,
  safeCapture,
} from './shared';

interface MongoClientLike {
  on?: (event: string, cb: (evt: MongoApmEvent) => void) => unknown;
  s?: unknown;
}

interface MongoApmEvent {
  requestId: number;
  commandName: string;
  databaseName?: string;
  command?: Record<string, unknown>;
  duration?: number; // micros on most driver versions
  reply?: Record<string, unknown>;
  failure?: Error & { message?: string };
}

// commandName -> queryType normalization (uppercase)
const MONGO_WRITE_COMMANDS = new Set([
  'insert',
  'update',
  'delete',
  'findAndModify',
  'findandmodify',
]);

function normalizeCommandName(name: string): string {
  if (!name) return 'OTHER';
  if (name === 'find') return 'SELECT';
  if (name === 'getMore') return 'SELECT';
  if (name === 'aggregate') return 'SELECT';
  if (name === 'count') return 'SELECT';
  if (name === 'distinct') return 'SELECT';
  if (name === 'insert') return 'INSERT';
  if (name === 'update') return 'UPDATE';
  if (name === 'delete') return 'DELETE';
  if (name === 'findAndModify' || name === 'findandmodify') return 'UPDATE';
  return name.toUpperCase();
}

function extractCollection(evt: MongoApmEvent): string {
  const cmd = evt.command ?? {};
  const name = evt.commandName;
  const target = (cmd as Record<string, unknown>)[name];
  return typeof target === 'string' ? target : '';
}

function extractRows(evt: MongoApmEvent): number {
  const reply = evt.reply ?? {};
  const n = (reply as { n?: number }).n;
  const nModified = (reply as { nModified?: number }).nModified;
  const deletedCount = (reply as { deletedCount?: number }).deletedCount;
  return (
    nModified ??
    deletedCount ??
    n ??
    -1
  );
}

/** Record in-flight commands so we can resolve duration on success/failure. */
const inFlight = new Map<number, { startTime: number; normalized: string; collection: string; commandName: string }>();

export function instrumentMongo(
  client: MongoClientLike,
  dbModule: DatabaseModule,
  config: DbIntegrationConfig = {},
): boolean {
  if (!client || typeof client.on !== 'function') return false;

  try {
    client.on('commandStarted', (evt: MongoApmEvent) => {
      const commandName = evt.commandName ?? 'unknown';
      const collection = extractCollection(evt);
      const normalized = `${commandName} ${collection}`.trim();
      inFlight.set(evt.requestId, {
        startTime: Date.now(),
        normalized,
        collection,
        commandName,
      });
    });

    client.on('commandSucceeded', (evt: MongoApmEvent) => {
      const pending = inFlight.get(evt.requestId);
      inFlight.delete(evt.requestId);
      const startTime = pending?.startTime ?? Date.now();
      const normalized = pending?.normalized ?? `${evt.commandName ?? 'unknown'}`;
      const rows = extractRows(evt);
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: normalizeCommandName(pending?.commandName ?? evt.commandName ?? 'OTHER'),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status: 'success',
        databaseName: evt.databaseName ?? '',
        databaseType: 'mongodb',
        rowsAffected: rows,
      });
    });

    client.on('commandFailed', (evt: MongoApmEvent) => {
      const pending = inFlight.get(evt.requestId);
      inFlight.delete(evt.requestId);
      const startTime = pending?.startTime ?? Date.now();
      const normalized = pending?.normalized ?? `${evt.commandName ?? 'unknown'}`;
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: normalizeCommandName(pending?.commandName ?? evt.commandName ?? 'OTHER'),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status: 'error',
        errorMessage: evt.failure?.message?.slice(0, 500),
        databaseName: evt.databaseName ?? '',
        databaseType: 'mongodb',
        rowsAffected: -1,
      });
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Mongoose convenience wrapper. Given a mongoose instance (or connection),
 * locate the underlying MongoClient and hook it.
 *
 * IMPORTANT: the user must have connected with `monitorCommands: true`, e.g.:
 *   mongoose.connect(uri, { monitorCommands: true })
 */
export function instrumentMongoose(
  mongoose: {
    connection?: { client?: MongoClientLike; db?: { serverConfig?: unknown } };
    connections?: Array<{ client?: MongoClientLike }>;
  },
  dbModule: DatabaseModule,
  config: DbIntegrationConfig = {},
): boolean {
  const client = mongoose?.connection?.client;
  if (!client) return false;
  return instrumentMongo(client, dbModule, config);
}
