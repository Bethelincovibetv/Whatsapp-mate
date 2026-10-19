/**
 * Administrator Role Management System for WhatsApp Bot
 * 
 * Manages authorized administrator JIDs in PostgreSQL (Google Cloud SQL)
 * with role-based access control (RBAC):
 * - superadmin: Full control (add/remove admins, system commands, broadcast)
 * - admin: Send broadcasts, trigger !tagall, group moderation
 * - moderator: Trigger !tagall
 */

import pg from 'pg';

export interface AdminRecord {
  jid: string;
  name: string;
  role: 'superadmin' | 'admin' | 'moderator';
  added_by: string;
  can_broadcast: boolean;
  can_tagall: boolean;
  can_manage_admins: boolean;
  created_at: string;
  updated_at: string;
}

// In-memory fallback if PostgreSQL is not connected during local preview
const memoryAdmins = new Map<string, AdminRecord>();

export class AdminManager {
  private pool: pg.Pool | null = null;
  private isInitialized = false;

  constructor() {
    // Seed initial default admin for sandbox preview
    const defaultOwnerPhone = process.env.PHONE_NUMBER?.replace(/[^0-9]/g, '') || '14155552671';
    const defaultOwnerJid = `${defaultOwnerPhone}@s.whatsapp.net`;
    
    memoryAdmins.set(defaultOwnerJid, {
      jid: defaultOwnerJid,
      name: 'Primary Owner (Superadmin)',
      role: 'superadmin',
      added_by: 'system',
      can_broadcast: true,
      can_tagall: true,
      can_manage_admins: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  public setPool(pool: pg.Pool | null) {
    this.pool = pool;
  }

  public normalizeJid(raw: string): string {
    if (!raw) return '';
    let cleaned = raw.trim();
    if (cleaned.endsWith('@g.us')) return cleaned;
    if (cleaned.endsWith('@s.whatsapp.net')) return cleaned;
    if (cleaned.endsWith('@lid')) return cleaned;
    // Strip non-digits
    const digits = cleaned.replace(/[^0-9]/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  public async initSchema(pool: pg.Pool): Promise<void> {
    this.pool = pool;
    const ddl = `
      CREATE TABLE IF NOT EXISTS bot_admins (
        jid VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT 'Admin',
        role VARCHAR(50) NOT NULL DEFAULT 'admin',
        added_by VARCHAR(255) DEFAULT 'system',
        can_broadcast BOOLEAN NOT NULL DEFAULT true,
        can_tagall BOOLEAN NOT NULL DEFAULT true,
        can_manage_admins BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_bot_admins_role ON bot_admins(role);
    `;
    try {
      await pool.query(ddl);
      this.isInitialized = true;
      console.log('[AdminManager] Initialized bot_admins schema successfully');

      // Seed owner if configured
      if (process.env.PHONE_NUMBER) {
        const ownerJid = this.normalizeJid(process.env.PHONE_NUMBER);
        await this.addAdmin({
          jid: ownerJid,
          name: 'Primary Owner',
          role: 'superadmin',
          addedBy: 'system',
          canBroadcast: true,
          canTagall: true,
          canManageAdmins: true,
        });
      }
    } catch (err: any) {
      console.warn('[AdminManager] Could not initialize bot_admins in database:', err.message);
    }
  }

  public async getAdmins(): Promise<AdminRecord[]> {
    if (this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM bot_admins ORDER BY created_at ASC');
        if (res.rows.length > 0) {
          return res.rows;
        }
      } catch (err) {
        console.warn('[AdminManager] Fallback to memory on getAdmins:', err);
      }
    }
    return Array.from(memoryAdmins.values());
  }

  public async getAdmin(rawJid: string): Promise<AdminRecord | null> {
    const jid = this.normalizeJid(rawJid);
    if (this.pool) {
      try {
        const res = await this.pool.query('SELECT * FROM bot_admins WHERE jid = $1 LIMIT 1', [jid]);
        if (res.rows.length > 0) {
          return res.rows[0];
        }
      } catch (err) {
        console.warn('[AdminManager] Fallback to memory on getAdmin:', err);
      }
    }
    return memoryAdmins.get(jid) || null;
  }

  public async isAdmin(rawJid: string): Promise<boolean> {
    const admin = await this.getAdmin(rawJid);
    return admin !== null;
  }

  public async canPerformAction(
    rawJid: string,
    action: 'broadcast' | 'tagall' | 'manage_admins'
  ): Promise<boolean> {
    const admin = await this.getAdmin(rawJid);
    if (!admin) return false;
    if (admin.role === 'superadmin') return true;

    if (action === 'broadcast') return admin.can_broadcast;
    if (action === 'tagall') return admin.can_tagall;
    if (action === 'manage_admins') return admin.can_manage_admins;
    return false;
  }

  public async addAdmin(params: {
    jid: string;
    name?: string;
    role?: 'superadmin' | 'admin' | 'moderator';
    addedBy?: string;
    canBroadcast?: boolean;
    canTagall?: boolean;
    canManageAdmins?: boolean;
  }): Promise<AdminRecord> {
    const jid = this.normalizeJid(params.jid);
    const name = params.name || `Admin (${jid.split('@')[0]})`;
    const role = params.role || 'admin';
    const addedBy = params.addedBy || 'system';
    const canBroadcast = params.canBroadcast ?? true;
    const canTagall = params.canTagall ?? true;
    const canManageAdmins = params.canManageAdmins ?? (role === 'superadmin');

    const record: AdminRecord = {
      jid,
      name,
      role,
      added_by: addedBy,
      can_broadcast: canBroadcast,
      can_tagall: canTagall,
      can_manage_admins: canManageAdmins,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO bot_admins (jid, name, role, added_by, can_broadcast, can_tagall, can_manage_admins, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
           ON CONFLICT (jid) DO UPDATE SET
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             can_broadcast = EXCLUDED.can_broadcast,
             can_tagall = EXCLUDED.can_tagall,
             can_manage_admins = EXCLUDED.can_manage_admins,
             updated_at = CURRENT_TIMESTAMP`,
          [jid, name, role, addedBy, canBroadcast, canTagall, canManageAdmins]
        );
      } catch (err: any) {
        console.error('[AdminManager] Database error saving admin:', err.message);
      }
    }

    memoryAdmins.set(jid, record);
    return record;
  }

  public async removeAdmin(rawJid: string): Promise<boolean> {
    const jid = this.normalizeJid(rawJid);
    if (this.pool) {
      try {
        await this.pool.query('DELETE FROM bot_admins WHERE jid = $1', [jid]);
      } catch (err: any) {
        console.error('[AdminManager] Database error removing admin:', err.message);
      }
    }
    const existed = memoryAdmins.has(jid);
    memoryAdmins.delete(jid);
    return existed;
  }
}

export const adminManager = new AdminManager();
