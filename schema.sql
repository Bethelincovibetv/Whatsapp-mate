-- ============================================================================
-- Baileys WhatsApp Session Persistence & Admin Management Schema (PostgreSQL)
-- ============================================================================
-- 
-- Description:
-- 1. baileys_sessions: Stores Baileys cryptographic keys and credentials
-- 2. bot_admins: Stores authorized administrator JIDs and roles for RBAC
-- 3. broadcast_jobs: Audit and job history for BullMQ message queue workers
--
-- Supported Databases:
-- - Google Cloud SQL for PostgreSQL (v13, v14, v15, v16+)
-- - Standard PostgreSQL instances
-- - Supabase / Neon / Amazon RDS Postgres

-- ============================================================================
-- 1. Table: baileys_sessions (Baileys Session Persistence)
-- ============================================================================
CREATE TABLE IF NOT EXISTS baileys_sessions (
    session_id VARCHAR(128) NOT NULL,
    key_id VARCHAR(255) NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_baileys_sessions_session_id 
    ON baileys_sessions (session_id);

CREATE INDEX IF NOT EXISTS idx_baileys_sessions_lookup 
    ON baileys_sessions (session_id, key_id);

CREATE INDEX IF NOT EXISTS idx_baileys_sessions_updated_at 
    ON baileys_sessions (updated_at);

-- ============================================================================
-- 2. Table: bot_admins (Administrator Role Management System)
-- ============================================================================
CREATE TABLE IF NOT EXISTS bot_admins (
    -- Unique WhatsApp JID (e.g. '14155552671@s.whatsapp.net')
    jid VARCHAR(255) PRIMARY KEY,

    -- Friendly display name or label
    name VARCHAR(255) NOT NULL DEFAULT 'Admin',

    -- Role hierarchy: 'superadmin' | 'admin' | 'moderator'
    role VARCHAR(50) NOT NULL DEFAULT 'admin',

    -- Who granted this admin role (owner or another admin JID)
    added_by VARCHAR(255) DEFAULT 'system',

    -- Permissions flags: allow broadcasts, allow tagall, allow admin management
    can_broadcast BOOLEAN NOT NULL DEFAULT true,
    can_tagall BOOLEAN NOT NULL DEFAULT true,
    can_manage_admins BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_admins_role 
    ON bot_admins (role);

-- ============================================================================
-- 3. Table: broadcast_jobs (Message Queue Audit & History)
-- ============================================================================
CREATE TABLE IF NOT EXISTS broadcast_jobs (
    id VARCHAR(128) PRIMARY KEY,
    group_jid VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    sender_jid VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'queued', -- 'queued' | 'active' | 'completed' | 'failed'
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    error_message TEXT,
    recipients_count INT DEFAULT 0,
    message_id VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_status 
    ON broadcast_jobs (status);

CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_created_at 
    ON broadcast_jobs (created_at DESC);

-- ============================================================================
-- 4. Triggers for Automatic Timestamp Updates
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_baileys_sessions_timestamp ON baileys_sessions;
CREATE TRIGGER trigger_baileys_sessions_timestamp
BEFORE UPDATE ON baileys_sessions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_bot_admins_timestamp ON bot_admins;
CREATE TRIGGER trigger_bot_admins_timestamp
BEFORE UPDATE ON bot_admins
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
