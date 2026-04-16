/**
 * Prisma integration.
 *
 * Opt-in API: the user must call `instrumentPrisma(prismaClient)` because
 * we don't auto-patch `@prisma/client` at import time (Prisma uses generated
 * code; there's no stable prototype to monkey-patch).
 *
 * Implementation: uses Prisma's built-in `$on('query', ...)` event, which
 * fires for every query with { query, params, duration, target }. This is
 * Prisma's supported observability hook and is stable across versions.
 *
 * Side effect: marks the underlying driver connection as ORM-owned so the
 * pg/mysql2 driver-level wrappers skip it (avoiding double-capture).
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

interface PrismaClientLike {
  $on: (event: 'query', cb: (e: PrismaQueryEvent) => void) => void;
  $connect?: () => Promise<void>;
  _engine?: unknown;
  _engineConfig?: { datamodel?: string };
}

interface PrismaQueryEvent {
  timestamp: Date;
  query: string;
  params?: string;
  duration: number; // milliseconds
  target?: string;
}

/**
 * Attach Prisma query instrumentation. Returns true if the hook was wired.
 *
 * IMPORTANT: the caller must have instantiated the client with
 *   `new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })`
 * — otherwise Prisma won't emit query events. We document this in the README.
 */
export function instrumentPrisma(
  prisma: PrismaClientLike,
  dbModule: DatabaseModule,
  config: DbIntegrationConfig & { databaseType?: 'postgresql' | 'mysql' | 'sqlite' } = {},
): boolean {
  if (!prisma || typeof prisma.$on !== 'function') return false;

  try {
    prisma.$on('query', (e: PrismaQueryEvent) => {
      const normalized = normalizeQuery(e.query);
      safeCapture(dbModule, config, {
        normalizedQuery: normalized,
        queryHash: hashQuery(normalized),
        queryType: detectQueryType(e.query),
        durationMs: Math.max(0, Math.round(e.duration ?? 0)),
        timestampMillis: e.timestamp ? new Date(e.timestamp).getTime() : Date.now(),
        status: 'success',
        databaseName: '',
        databaseType: config.databaseType ?? 'postgresql',
        rowsAffected: -1,
      });
    });

    // Mark the engine so driver-level wrappers skip anything owned by Prisma.
    if (prisma._engine) markOwnedByOrm(prisma._engine);
    return true;
  } catch {
    return false;
  }
}
