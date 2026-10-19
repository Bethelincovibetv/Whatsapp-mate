/**
 * Express Backend Server for Baileys WhatsApp Auto-Tag & Cloud SQL Integration
 * 
 * Provides:
 * - POST /send-broadcast: Accepts groupJid and message text, fetches participants, sends mentions.
 * - WhatsApp pairing code generation & socket lifecycle management.
 * - Cloud SQL PostgreSQL session state endpoints.
 * - Vite dev middleware in development; static file serving in production.
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { botManager } from './src/lib/whatsappBot.ts';
import { adminManager } from './src/lib/adminManager.ts';
import { broadcastQueue } from './src/lib/broadcastQueue.ts';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

// ============================================================================
// Core Automation Endpoint: POST /send-broadcast (Queue-Backed)
// ============================================================================
app.post('/send-broadcast', async (req: Request, res: Response): Promise<void> => {
  try {
    const { groupJid, message, senderJid } = req.body;

    if (!groupJid) {
      res.status(400).json({
        success: false,
        error: "Missing required parameter 'groupJid'. Must be a WhatsApp group JID ending with '@g.us'.",
      });
      return;
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: "Missing or invalid parameter 'message'. Must be non-empty text.",
      });
      return;
    }

    // Role-based authorization check: if sender is specified, verify admin privilege
    if (senderJid) {
      const canBroadcast = await adminManager.canPerformAction(senderJid, 'broadcast');
      if (!canBroadcast) {
        res.status(403).json({
          success: false,
          error: `Sender '${senderJid}' is not an authorized administrator. Access denied.`,
        });
        return;
      }
    }

    // Add to message queue instead of sending directly
    const queueResult = await botManager.sendBroadcast(groupJid, message.trim(), senderJid);

    // Return 202 Accepted
    res.status(202).json({
      success: true,
      message: 'Broadcast job successfully queued for asynchronous delivery.',
      jobId: queueResult.jobId,
      queueEngine: queueResult.mode,
      groupJid: queueResult.groupJid,
      status: 'queued',
      checkStatusUrl: `/api/queue/jobs`,
    });
  } catch (error: any) {
    console.error('[API Error /send-broadcast]', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to enqueue broadcast job',
    });
  }
});

// Also alias under /api/send-broadcast for frontend SPA convenience
app.post('/api/send-broadcast', async (req: Request, res: Response): Promise<void> => {
  try {
    const { groupJid, message, senderJid } = req.body;
    if (!groupJid || !message) {
      res.status(400).json({ success: false, error: 'Both groupJid and message are required.' });
      return;
    }
    const queueResult = await botManager.sendBroadcast(groupJid, message.trim(), senderJid);
    res.status(202).json({
      success: true,
      jobId: queueResult.jobId,
      queueEngine: queueResult.mode,
      groupJid: queueResult.groupJid,
      status: 'queued',
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// Message Queue Endpoints (BullMQ / In-Memory Worker)
// ============================================================================
app.get('/api/queue/stats', (_req: Request, res: Response) => {
  const stats = broadcastQueue.getStats();
  res.json({ success: true, stats });
});

app.get('/api/queue/jobs', (_req: Request, res: Response) => {
  const jobs = broadcastQueue.getJobs();
  res.json({ success: true, count: jobs.length, jobs });
});

app.post('/api/queue/retry/:id', (req: Request, res: Response) => {
  const retried = broadcastQueue.retryJob(req.params.id);
  if (retried) {
    res.json({ success: true, message: `Job ${req.params.id} re-enqueued for delivery.` });
  } else {
    res.status(404).json({ success: false, error: 'Job not found or not in failed state.' });
  }
});

// ============================================================================
// Administrator Role Management Endpoints (PostgreSQL)
// ============================================================================
app.get('/api/admins', async (_req: Request, res: Response) => {
  try {
    const admins = await adminManager.getAdmins();
    res.json({ success: true, count: admins.length, admins });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admins', async (req: Request, res: Response) => {
  try {
    const { jid, name, role, addedBy, canBroadcast, canTagall, canManageAdmins } = req.body;
    if (!jid) {
      res.status(400).json({ success: false, error: "Missing required parameter 'jid' or phone number." });
      return;
    }
    const admin = await adminManager.addAdmin({
      jid,
      name,
      role,
      addedBy,
      canBroadcast,
      canTagall,
      canManageAdmins,
    });
    res.status(201).json({ success: true, admin });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admins/:jid', async (req: Request, res: Response) => {
  try {
    const removed = await adminManager.removeAdmin(req.params.jid);
    if (removed) {
      res.json({ success: true, message: `Admin ${req.params.jid} successfully removed.` });
    } else {
      res.status(404).json({ success: false, error: `Admin ${req.params.jid} not found.` });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admins/check/:jid', async (req: Request, res: Response) => {
  try {
    const isAdmin = await adminManager.isAdmin(req.params.jid);
    const admin = await adminManager.getAdmin(req.params.jid);
    res.json({ success: true, jid: req.params.jid, isAdmin, admin });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Status & Health Check
// ============================================================================
app.get('/api/status', (req: Request, res: Response) => {
  const status = botManager.getStatus();
  res.json(status);
});

// ============================================================================
// Request Pairing Code
// ============================================================================
app.post('/api/pairing-code', async (req: Request, res: Response): Promise<void> => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      res.status(400).json({
        success: false,
        error: 'Please provide a valid phoneNumber with country code (e.g., 14155552671).',
      });
      return;
    }

    const code = await botManager.requestPairingCode(phoneNumber);
    res.json({
      success: true,
      phoneNumber,
      pairingCode: code,
      instructions: 'Open WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead, and enter this 8-digit code.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to generate pairing code.',
    });
  }
});

// ============================================================================
// Groups Explorer
// ============================================================================
app.get('/api/groups', async (req: Request, res: Response) => {
  try {
    const groups = await botManager.getGroups();
    res.json({ success: true, count: groups.length, groups });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Activity Logs
// ============================================================================
app.get('/api/logs', (req: Request, res: Response) => {
  const logs = botManager.getLogs();
  res.json({ success: true, count: logs.length, logs });
});

// ============================================================================
// Automation Settings Update
// ============================================================================
app.post('/api/settings', (req: Request, res: Response) => {
  try {
    const { autoTagEnabled, autoTagTrigger, autoTagKeyword, cooldownSeconds, mentionFormat } = req.body;

    if (typeof autoTagEnabled === 'boolean') {
      botManager.config.autoTagEnabled = autoTagEnabled;
    }
    if (autoTagTrigger === 'all' || autoTagTrigger === 'keyword') {
      botManager.config.autoTagTrigger = autoTagTrigger;
    }
    if (typeof autoTagKeyword === 'string') {
      botManager.config.autoTagKeyword = autoTagKeyword;
    }
    if (typeof cooldownSeconds === 'number' && cooldownSeconds >= 1) {
      botManager.config.cooldownSeconds = cooldownSeconds;
    }
    if (mentionFormat === 'standard' || mentionFormat === 'compact' || mentionFormat === 'announcement') {
      botManager.config.mentionFormat = mentionFormat;
    }

    botManager.addLog('info', 'Automation settings updated', botManager.config);
    res.json({ success: true, config: botManager.config });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Disconnect / Clear Session
// ============================================================================
app.post('/api/session/clear', async (req: Request, res: Response) => {
  try {
    await botManager.logoutAndReset();
    res.json({ success: true, message: 'WhatsApp session cleared and disconnected.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Schema & DDL Delivery
// ============================================================================
app.get('/api/schema', (req: Request, res: Response) => {
  try {
    const schemaPath = path.resolve('schema.sql');
    if (fs.existsSync(schemaPath)) {
      const ddl = fs.readFileSync(schemaPath, 'utf-8');
      res.type('text/plain').send(ddl);
    } else {
      res.status(404).send('schema.sql not found');
    }
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// ============================================================================
// Start Server with Vite or Static Middleware
// ============================================================================
export async function startServer() {
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL;

  if (!isProd) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.warn('Vite middleware skipped in serverless mode');
    }
  } else {
    const distPath = path.resolve('dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  // Auto-initialize bot in the background
  botManager.initialize().catch((err) => {
    console.warn('[Server] Initial bot startup note:', err.message);
  });
}

// Start if run directly
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startServer().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`====================================================`);
      console.log(`🚀 Baileys WhatsApp Server running on port ${PORT}`);
      console.log(`📡 Broadcast API: POST http://localhost:${PORT}/send-broadcast`);
      console.log(`====================================================`);
    });
  });
}

export default app;
