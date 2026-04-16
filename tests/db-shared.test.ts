import { describe, it, expect } from 'vitest';
import {
  normalizeQuery,
  hashQuery,
  detectQueryType,
  markOwnedByOrm,
  isOwnedByOrm,
} from '../src/integrations/db/shared';

describe('normalizeQuery', () => {
  it('masks single-quoted string literals', () => {
    expect(normalizeQuery("SELECT * FROM users WHERE email = 'alice@example.com'"))
      .toBe('SELECT * FROM users WHERE email = ?');
  });

  it('masks single-quoted string with escaped quotes', () => {
    expect(normalizeQuery("INSERT INTO notes (body) VALUES ('it''s fine')"))
      .toBe('INSERT INTO notes (body) VALUES (?)');
  });

  it('masks numeric literals', () => {
    expect(normalizeQuery('SELECT * FROM orders WHERE amount > 99.99 AND id = 42'))
      .toBe('SELECT * FROM orders WHERE amount > ? AND id = ?');
  });

  it('preserves double-quoted identifiers (pg/ANSI SQL)', () => {
    expect(normalizeQuery('SELECT "public"."Task"."id" FROM "public"."Task"'))
      .toBe('SELECT "public"."Task"."id" FROM "public"."Task"');
  });

  it('strips line comments', () => {
    expect(normalizeQuery('SELECT 1 -- this is a comment\nFROM dual'))
      .toBe('SELECT ? FROM dual');
  });

  it('strips block comments', () => {
    expect(normalizeQuery('SELECT /* hot path */ 1 FROM dual'))
      .toBe('SELECT ? FROM dual');
  });

  it('collapses whitespace', () => {
    expect(normalizeQuery('SELECT   id,\n  name\nFROM    users'))
      .toBe('SELECT id, name FROM users');
  });

  it('handles empty input', () => {
    expect(normalizeQuery('')).toBe('');
  });
});

describe('hashQuery', () => {
  it('is deterministic', () => {
    expect(hashQuery('SELECT * FROM users')).toBe(hashQuery('SELECT * FROM users'));
  });

  it('differs for different queries', () => {
    expect(hashQuery('SELECT * FROM users')).not.toBe(hashQuery('SELECT * FROM tasks'));
  });
});

describe('detectQueryType', () => {
  it.each([
    ['SELECT * FROM t', 'SELECT'],
    ['insert into t values (1)', 'INSERT'],
    ['UPDATE t SET x = 1', 'UPDATE'],
    ['DELETE FROM t', 'DELETE'],
    ['BEGIN', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['ROLLBACK', 'ROLLBACK'],
    ['EXPLAIN SELECT 1', 'OTHER'],
    ['', 'OTHER'],
  ])('detects %s as %s', (sql, type) => {
    expect(detectQueryType(sql)).toBe(type);
  });
});

describe('ORM dedup markers', () => {
  it('marks and reads ownership', () => {
    const obj = {};
    expect(isOwnedByOrm(obj)).toBe(false);
    markOwnedByOrm(obj);
    expect(isOwnedByOrm(obj)).toBe(true);
  });

  it('tolerates nullish inputs', () => {
    expect(isOwnedByOrm(null)).toBe(false);
    expect(isOwnedByOrm(undefined)).toBe(false);
    expect(() => markOwnedByOrm(null)).not.toThrow();
  });
});
