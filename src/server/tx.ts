import type { DatabaseSync } from 'node:sqlite';

/** fn をひとつのトランザクションで実行する（例外が出たら巻き戻す） */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
