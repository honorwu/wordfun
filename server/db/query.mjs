export const runTransaction = (db, fn) => {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

export const allRows = (db, sql, ...params) => db.prepare(sql).all(...params);
export const oneRow = (db, sql, ...params) => db.prepare(sql).get(...params);
export const hasTable = (db, table) => Boolean(oneRow(db, "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", table));
