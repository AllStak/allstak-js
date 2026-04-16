/**
 * Sequelize integration.
 *
 * Opt-in API. Sequelize is a classic ORM that sits on top of pg/mysql2/sqlite.
 * We hook its `beforeQuery` / `afterQuery` lifecycle events via
 * `sequelize.addHook(...)`. These hooks give us:
 *   - The final SQL string that will be executed
 *   - The options object (bind / replacements / type)
 *   - The timing between before and after (we record start time in a
 *     per-invocation symbol on the options object)
 *
 * The SDK's Sequelize integration also marks the underlying pg/mysql2
 * connection manager as ORM-owned so the driver-level wrappers don't
 * double-capture.
 */

import type { DatabaseModule } from '../../modules/database';
import {
  DbIntegrationConfig,
  detectQueryType,
  hashQuery,
  markOwnedByOrm,
  normalizeQuery,
  safeCapture,
} from './shared';

interface SequelizeLike {
  addHook: (event: string, cb: (...args: unknown[]) => void) => unknown;
  options?: { dialect?: string; database?: string };
  connectionManager?: {
    pool?: unknown;
    getConnection?: (options?: unknown) => Promise<unknown>;
  };
  config?: { database?: string };
}

const START_SYMBOL = Symbol.for('allstak.sequelize.start');

export function instrumentSequelize(
  sequelize: SequelizeLike,
  dbModule: DatabaseModule,
  config: DbIntegrationConfig = {},
): boolean {
  if (!sequelize || typeof sequelize.addHook !== 'function') return false;

  const dialect = sequelize.options?.dialect;
  const databaseType = mapDialect(dialect);
  const databaseName = sequelize.options?.database ?? sequelize.config?.database ?? '';

  try {
    // Mark every raw connection Sequelize opens so the underlying pg /
    // mysql2 / sqlite3 driver wrappers skip it (prevents double-capture).
    sequelize.addHook('afterConnect', (...args: unknown[]) => {
      const conn = args[0];
      if (conn && typeof conn === 'object') markOwnedByOrm(conn);
    });

    sequelize.addHook('beforeQuery', (...args: unknown[]) => {
      const options = args[0];
      if (options && typeof options === 'object') {
        (options as Record<symbol, number>)[START_SYMBOL] = Date.now();
      }
    });

    sequelize.addHook('afterQuery', (...args: unknown[]) => {
      const options = args[0];
      const query = args[1] as { sql?: string } | undefined;
      const startTime =
        (options as Record<symbol, number> | undefined)?.[START_SYMBOL] ?? Date.now();
      const sql = query?.sql ?? '';
      const normalized = normalizeQuery(sql);
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(sql),
        durationMs: Date.now() - startTime,
        timestampMillis: startTime,
        status: 'success',
        databaseName,
        databaseType,
        rowsAffected: -1,
      });
    });

    // Mark the connection manager so driver-level wrappers skip queries
    // that Sequelize dispatches via its own pool.
    if (sequelize.connectionManager) {
      markOwnedByOrm(sequelize.connectionManager);
      if ((sequelize.connectionManager as { pool?: unknown }).pool) {
        markOwnedByOrm((sequelize.connectionManager as { pool?: unknown }).pool);
      }

      // Belt-and-suspenders: some dialects (notably sqlite) have their own
      // getConnection() that bypasses the abstract pool's afterConnect
      // hook. Wrap it here so every returned raw connection is marked
      // regardless of dialect.
      const cm = sequelize.connectionManager;
      if (cm.getConnection && typeof cm.getConnection === 'function') {
        const origGetConnection = cm.getConnection.bind(cm);
        cm.getConnection = async function wrappedGetConnection(options?: unknown) {
          const conn = await origGetConnection(options);
          if (conn && typeof conn === 'object') markOwnedByOrm(conn);
          return conn;
        };
      }
    }

    return true;
  } catch {
    return false;
  }
}

function mapDialect(dialect?: string): string {
  switch (dialect) {
    case 'postgres':
      return 'postgresql';
    case 'mysql':
    case 'mariadb':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'mssql':
      return 'mssql';
    default:
      return dialect ?? 'unknown';
  }
}
