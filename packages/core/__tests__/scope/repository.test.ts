/**
 * Scoped-repository helpers — unit tests.
 */

import { setCurrentDataScope, resetDataScope } from '../../src/scope/data_scope';
import {
  DATA_SCOPE_COLUMN,
  scopedInsertFields,
  scopedWhere,
  scopedParams,
  scopedTableDeleter,
} from '../../src/scope/repository';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

describe('scoped repository helpers', () => {
  afterEach(() => resetDataScope());

  it('scopedInsertFields defaults to the current scope (and accepts override)', () => {
    expect(scopedInsertFields()).toEqual({ data_scope: 'user' });
    setCurrentDataScope('guided_demo:x');
    expect(scopedInsertFields()).toEqual({ data_scope: 'guided_demo:x' });
    expect(scopedInsertFields('user')).toEqual({ data_scope: 'user' });
  });

  it('scopedWhere builds the predicate with an optional alias', () => {
    expect(scopedWhere()).toBe('data_scope = ?');
    expect(scopedWhere('r')).toBe('r.data_scope = ?');
  });

  it('scopedParams defaults to the current scope (and accepts override)', () => {
    expect(scopedParams()).toEqual(['user']);
    setCurrentDataScope('guided_demo:x');
    expect(scopedParams()).toEqual(['guided_demo:x']);
    expect(scopedParams('user')).toEqual(['user']);
  });

  it('DATA_SCOPE_COLUMN is the column name', () => {
    expect(DATA_SCOPE_COLUMN).toBe('data_scope');
  });

  it('scopedTableDeleter deletes only the requested scope + counts accurately + idempotent', () => {
    const rows: { data_scope: string }[] = [
      { data_scope: 'user' },
      { data_scope: 'user' },
      { data_scope: 'guided_demo:x' },
      { data_scope: 'guided_demo:x' },
      { data_scope: 'guided_demo:x' },
    ];
    const db = {
      query: <T>(_sql: string, params?: unknown[]): T[] => {
        const scope = (params as string[])[0];
        return [{ c: rows.filter((r) => r.data_scope === scope).length }] as unknown as T[];
      },
      execute: (_sql: string, params?: unknown[]): void => {
        const scope = (params as string[])[0];
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].data_scope === scope) rows.splice(i, 1);
        }
      },
    } as unknown as DatabaseAdapter;

    const del = scopedTableDeleter(() => db, 'reminders');
    expect(del('guided_demo:x')).toBe(3);
    expect(rows.filter((r) => r.data_scope === 'user').length).toBe(2);
    expect(del('guided_demo:x')).toBe(0); // idempotent — nothing left
  });

  it('scopedTableDeleter is a no-op (0) when the db is not wired', () => {
    expect(scopedTableDeleter(() => null, 't')('guided_demo:x')).toBe(0);
  });
});
