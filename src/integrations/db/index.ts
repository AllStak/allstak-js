/**
 * Public entry-point for the AllStak DB integrations.
 *
 * Usage:
 *   import { AllStak } from 'allstak-js';
 *   import { instrumentPrisma, instrumentMongoose } from 'allstak-js/db';
 *
 *   AllStak.init({ apiKey: '…' });
 *   instrumentPrisma(prisma, AllStak.database);
 *   instrumentMongoose(mongoose, AllStak.database);
 *
 * The pg, mysql2, and SQLite driver-level integrations are wired
 * automatically by AllStak.init() unless `autoDbInstrumentation: false`
 * is passed. Prisma, Sequelize, MongoDB, and Mongoose are explicit opt-in
 * because they require a live client instance.
 */

export { instrumentPg } from './pg';
export { instrumentMysql2 } from './mysql2';
export { instrumentSqlite } from './sqlite';
export { instrumentPrisma } from './prisma';
export { instrumentSequelize } from './sequelize';
export { instrumentMongo, instrumentMongoose } from './mongoose';
export type { DbIntegrationConfig, TraceResolver } from './shared';
export { normalizeQuery, hashQuery, detectQueryType } from './shared';
