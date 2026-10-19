/**
 * PostgreSQL Auth State Adapter for @whiskeysockets/baileys
 * 
 * Provides session persistence across restarts and container redeploys
 * on Google Cloud SQL (PostgreSQL) or any Postgres instance.
 */

import pg from 'pg';
import { BufferJSON, initAuthCreds, proto, AuthenticationCreds, SignalKeyStoreWithTransaction } from '@whiskeysockets/baileys';

const { Pool } = pg;

export interface PostgresAuthConfig {
  sessionId?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface PostgresAuthStateResult {
  state: {
    creds: AuthenticationCreds;
    keys: SignalKeyStoreWithTransaction;
  };
  saveCreds: () => Promise<void>;
  clearSession: () => Promise<void>;
  isDatabaseConnected: () => boolean;
  getStoredKeysCount: () => Promise<number>;
  pool: pg.Pool | null;
}

// In-memory fallback if PostgreSQL is not reachable in local dev
const memoryStore = new Map<string, string>();

/**
 * Creates or retrieves a PostgreSQL connection pool configured for
 * Google Cloud SQL (direct, SSL, or Unix socket)
 */
export function createPostgresPool(config?: PostgresAuthConfig): pg.Pool {
  const connectionString = config?.connectionString || process.env.DATABASE_URL;

  // Google Cloud SQL Unix socket format: /cloudsql/PROJECT:REGION:INSTANCE
  const cloudSqlSocketPath = process.env.INSTANCE_CONNECTION_NAME 
    ? `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}` 
    : undefined;

  const poolConfig: pg.PoolConfig = {
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  if (connectionString) {
    poolConfig.connectionString = connectionString;
    if (process.env.DB_SSL === 'true' || connectionString.includes('sslmode=require')) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  } else if (cloudSqlSocketPath) {
    poolConfig.host = cloudSqlSocketPath;
    poolConfig.user = config?.user || process.env.DB_USER || 'postgres';
    poolConfig.password = config?.password || process.env.DB_PASSWORD || '';
    poolConfig.database = config?.database || process.env.DB_NAME || 'baileys_db';
  } else {
    poolConfig.host = config?.host || process.env.DB_HOST || 'localhost';
    poolConfig.port = config?.port || Number(process.env.DB_PORT) || 5432;
    poolConfig.user = config?.user || process.env.DB_USER || 'postgres';
    poolConfig.password = config?.password || process.env.DB_PASSWORD || '';
    poolConfig.database = config?.database || process.env.DB_NAME || 'baileys_db';

    if (process.env.DB_SSL === 'true') {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  }

  return new Pool(poolConfig);
}

import { adminManager } from './adminManager.ts';

/**
 * Initializes the database schema for Baileys session storage and admin management
 */
export async function initSessionSchema(pool: pg.Pool): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS baileys_sessions (
      session_id VARCHAR(128) NOT NULL,
      key_id VARCHAR(255) NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, key_id)
    );
    CREATE INDEX IF NOT EXISTS idx_baileys_sessions_lookup 
      ON baileys_sessions(session_id, key_id);
  `;
  await pool.query(ddl);
  await adminManager.initSchema(pool);
}

/**
 * Custom Baileys Auth State using PostgreSQL
 */
export async function usePostgresAuthState(
  sessionId: string = 'default_session',
  customPool?: pg.Pool
): Promise<PostgresAuthStateResult> {
  let pool = customPool || null;
  let dbConnected = false;

  // Try connecting to PostgreSQL
  try {
    if (!pool) {
      pool = createPostgresPool();
    }
    const client = await pool.connect();
    await initSessionSchema(pool);
    adminManager.setPool(pool);
    client.release();
    dbConnected = true;
    console.log(`[PostgreSQL] Connected successfully to session storage for session '${sessionId}'`);
  } catch (err: any) {
    console.warn(`[PostgreSQL] Could not connect to PostgreSQL (${err.message}). Using memory fallback for local preview.`);
    dbConnected = false;
  }

  // Safe file key sanitizer
  const fixFileName = (file: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

  // Read data from Postgres or fallback memory
  const readData = async (key: string): Promise<any> => {
    const sanitizedKey = fixFileName(key);
    if (dbConnected && pool) {
      try {
        const res = await pool.query(
          'SELECT data FROM baileys_sessions WHERE session_id = $1 AND key_id = $2 LIMIT 1',
          [sessionId, sanitizedKey]
        );
        if (res.rows.length > 0) {
          const raw = typeof res.rows[0].data === 'string' 
            ? res.rows[0].data 
            : JSON.stringify(res.rows[0].data);
          return JSON.parse(raw, BufferJSON.reviver);
        }
        return null;
      } catch (error) {
        console.error(`[PostgreSQL] Error reading key ${sanitizedKey}:`, error);
        return null;
      }
    } else {
      const data = memoryStore.get(`${sessionId}:${sanitizedKey}`);
      if (!data) return null;
      try {
        return JSON.parse(data, BufferJSON.reviver);
      } catch {
        return null;
      }
    }
  };

  // Write data to Postgres or fallback memory
  const writeData = async (key: string, value: any): Promise<void> => {
    const sanitizedKey = fixFileName(key);
    const serialized = JSON.stringify(value, BufferJSON.replacer);

    if (dbConnected && pool) {
      try {
        await pool.query(
          `INSERT INTO baileys_sessions (session_id, key_id, data, updated_at)
           VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (session_id, key_id)
           DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
          [sessionId, sanitizedKey, serialized]
        );
      } catch (error) {
        console.error(`[PostgreSQL] Error writing key ${sanitizedKey}:`, error);
      }
    } else {
      memoryStore.set(`${sessionId}:${sanitizedKey}`, serialized);
    }
  };

  // Remove data from Postgres or fallback memory
  const removeData = async (key: string): Promise<void> => {
    const sanitizedKey = fixFileName(key);
    if (dbConnected && pool) {
      try {
        await pool.query(
          'DELETE FROM baileys_sessions WHERE session_id = $1 AND key_id = $2',
          [sessionId, sanitizedKey]
        );
      } catch (error) {
        console.error(`[PostgreSQL] Error deleting key ${sanitizedKey}:`, error);
      }
    } else {
      memoryStore.delete(`${sessionId}:${sanitizedKey}`);
    }
  };

  // Load or initialize credentials
  const creds: AuthenticationCreds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}.json`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
        isInTransaction: () => false,
        transaction: async <T>(exec: () => Promise<T>, _key?: string): Promise<T> => {
          return await exec();
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds.json', creds);
    },
    clearSession: async () => {
      if (dbConnected && pool) {
        await pool.query('DELETE FROM baileys_sessions WHERE session_id = $1', [sessionId]);
      }
      for (const k of memoryStore.keys()) {
        if (k.startsWith(`${sessionId}:`)) {
          memoryStore.delete(k);
        }
      }
    },
    isDatabaseConnected: () => dbConnected,
    getStoredKeysCount: async () => {
      if (dbConnected && pool) {
        try {
          const res = await pool.query(
            'SELECT COUNT(*)::int as count FROM baileys_sessions WHERE session_id = $1',
            [sessionId]
          );
          return res.rows[0]?.count || 0;
        } catch {
          return 0;
        }
      } else {
        let count = 0;
        for (const k of memoryStore.keys()) {
          if (k.startsWith(`${sessionId}:`)) count++;
        }
        return count;
      }
    },
    pool,
  };
}
