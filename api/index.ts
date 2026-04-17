import app from '../src/index.js';

// Connection pooling implementation
interface PooledConnection {
  acquire: () => Promise<any>;
  release: (conn: any) => void;
  query: (sql: string, params?: any[]) => Promise<any>;
}

class ConnectionPool {
  private pool: any[] = [];
  private waiting: Array<(conn: any) => void> = [];
  private readonly poolSize: number;
  private readonly maxWaitTime: number;

  constructor(
    connectionFactory: () => Promise<any>,
    poolSize: number = 10,
    maxWaitTime: number = 5000
  ) {
    this.poolSize = poolSize;
    this.maxWaitTime = maxWaitTime;
    this.initializePool(connectionFactory);
  }

  private async initializePool(factory: () => Promise<any>): Promise<void> {
    for (let i = 0; i < this.poolSize; i++) {
      const conn = await factory();
      this.pool.push(conn);
    }
  }

  async acquire(): Promise<any> {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(resolve), 1);
      }, this.maxWaitTime);
    });
  }

  release(conn: any): void {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      resolve?.(conn);
    } else {
      this.pool.push(conn);
    }
  }
}

// Global pool instance for reuse
let dbPool: ConnectionPool | null = null;

export function initializeDatabase(factory: () => Promise<any>, poolSize?: number) {
  dbPool = new ConnectionPool(factory, poolSize);
  return dbPool;
}

export function getConnection() {
  return dbPool?.acquire();
}

export function releaseConnection(conn: any) {
  dbPool?.release(conn);
}

/**
 * Batch query utilities to eliminate N+1 patterns
 */

/**
 * Batch fetch multiple IDs at once instead of looping
 * Instead of: for (id of ids) { db.query('SELECT * FROM items WHERE id = ?', id) }
 * Use: db.query('SELECT * FROM items WHERE id IN (?, ?, ?)', ids)
 */
export async function batchFetchByIds<T>(
  table: string,
  ids: any[],
  idColumn: string = 'id'
): Promise<T[]> {
  if (!ids.length) return [];
  const pool = dbPool;
  if (!pool) throw new Error('Database pool not initialized');
  
  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT * FROM ${table} WHERE ${idColumn} IN (${placeholders})`;
  const result = await (pool as any).query?.(sql, ids);
  return result || [];
}

/**
 * Fetch records with eager-loaded relationships using a single JOIN query
 * Instead of: SELECT * FROM users; for each user SELECT * FROM orders WHERE user_id = user.id
 * Use: SELECT users.*, orders.* FROM users LEFT JOIN orders ON users.id = orders.user_id
 */
export async function fetchWithRelationships(
  sql: string,
  params?: any[],
  relationshipBuilder?: (rows: any[]) => any[]
): Promise<any[]> {
  if (!dbPool) throw new Error('Database pool not initialized');
  const rows = await (dbPool as any).query?.(sql, params);
  return relationshipBuilder ? relationshipBuilder(rows) : rows || [];
}

export default app;