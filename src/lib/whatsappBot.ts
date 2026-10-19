/**
 * WhatsApp Bot Manager powered by @whiskeysockets/baileys
 * 
 * Features:
 * - Phone number pairing code authentication
 * - PostgreSQL session persistence (Google Cloud SQL)
 * - Auto-tag all group participants when owner sends a message (msg.key.fromMe === true)
 * - Broadcast API endpoint with mass mentions
 * - Robust reconnection handling without session loss
 */

import makeWASocket, {
  DisconnectReason,
  Browsers,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { usePostgresAuthState, PostgresAuthStateResult } from './postgresAuthAdapter.ts';
import { adminManager } from './adminManager.ts';
import { broadcastQueue, BroadcastJobResult } from './broadcastQueue.ts';
import { commandHandler } from './commandHandler.ts';

export interface BotConfig {
  sessionId?: string;
  autoTagEnabled?: boolean;
  autoTagTrigger?: 'all' | 'keyword'; // 'all' = any fromMe message, 'keyword' = only when message contains keyword
  autoTagKeyword?: string;
  cooldownSeconds?: number;
  mentionFormat?: 'standard' | 'compact' | 'announcement';
}

export interface ActivityLog {
  id: string;
  timestamp: string;
  type: 'info' | 'tag' | 'broadcast' | 'connection' | 'error';
  message: string;
  details?: Record<string, any>;
}

export interface GroupSummary {
  id: string;
  subject: string;
  participantCount: number;
  creation?: number;
  desc?: string;
}

export class WhatsAppBotManager {
  private sock: WASocket | null = null;
  private authResult: PostgresAuthStateResult | null = null;
  private isConnecting: boolean = false;
  private pairingCode: string | null = null;
  private pairingPhone: string | null = null;
  private pairingCodeGeneratedAt: number | null = null;
  private connectionStatus: 'disconnected' | 'connecting' | 'awaiting_code' | 'connected' | 'logged_out' = 'disconnected';
  private userJid: string | null = null;
  private userName: string | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 15;
  private reconnectTimeout: any = null;

  // Anti-loop protection & Rate limiting
  private sentTagMessageIds = new Set<string>();
  private lastGroupTagTime = new Map<string, number>();

  // Activity logs & metrics
  private logs: ActivityLog[] = [];
  private totalMessagesTagged: number = 0;
  private totalBroadcastsSent: number = 0;
  private startTime: number = Date.now();

  // Settings
  public config: BotConfig = {
    sessionId: process.env.SESSION_ID || 'cloudsql_baileys_session',
    autoTagEnabled: process.env.AUTO_TAG_ENABLED !== 'false',
    autoTagTrigger: (process.env.AUTO_TAG_TRIGGER as 'all' | 'keyword') || 'all',
    autoTagKeyword: process.env.AUTO_TAG_KEYWORD || '!everyone',
    cooldownSeconds: Number(process.env.TAG_COOLDOWN_SECONDS) || 3,
    mentionFormat: (process.env.MENTION_FORMAT as 'standard' | 'compact' | 'announcement') || 'announcement',
  };

  constructor() {
    this.addLog('info', 'WhatsApp Bot Manager initialized with PostgreSQL Cloud SQL storage support');

    // Register this Baileys instance with the BullMQ / worker message queue
    broadcastQueue.registerWorkerHandler(async (jobData) => {
      return await this.executeBroadcastJob(jobData.groupJid, jobData.message);
    });
  }

  public addLog(type: ActivityLog['type'], message: string, details?: Record<string, any>) {
    const entry: ActivityLog = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toISOString(),
      type,
      message,
      details,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
    console.log(`[Bot Log - ${type.toUpperCase()}] ${message}`, details ? JSON.stringify(details) : '');
  }

  public getLogs(): ActivityLog[] {
    return this.logs;
  }

  public getStatus() {
    return {
      status: this.connectionStatus,
      isConnecting: this.isConnecting,
      pairingCode: this.pairingCode,
      pairingPhone: this.pairingPhone,
      pairingCodeAgeSeconds: this.pairingCodeGeneratedAt ? Math.floor((Date.now() - this.pairingCodeGeneratedAt) / 1000) : null,
      userJid: this.userJid,
      userName: this.userName,
      isDatabaseConnected: this.authResult ? this.authResult.isDatabaseConnected() : false,
      reconnectAttempts: this.reconnectAttempts,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      stats: {
        totalMessagesTagged: this.totalMessagesTagged,
        totalBroadcastsSent: this.totalBroadcastsSent,
      },
      config: this.config,
    };
  }

  /**
   * Initializes Baileys socket and connects
   */
  public async initialize(targetPhone?: string): Promise<void> {
    if (this.isConnecting) {
      console.log('[Bot] Socket initialization already in progress...');
      return;
    }

    this.isConnecting = true;
    this.connectionStatus = 'connecting';
    this.addLog('connection', 'Initializing WhatsApp socket and loading credentials from Cloud SQL...');

    try {
      // 1. Load auth state from PostgreSQL
      this.authResult = await usePostgresAuthState(this.config.sessionId);
      const { state, saveCreds } = this.authResult;

      // 2. Setup Pino logger
      const logger = pino({ level: process.env.DEBUG_BAILEYS === 'true' ? 'debug' : 'silent' });

      // 3. Create Baileys WASocket
      this.sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 60000,
      });

      // 4. Bind credential updates to PostgreSQL
      this.sock.ev.on('creds.update', async () => {
        try {
          await saveCreds();
        } catch (err: any) {
          this.addLog('error', `Failed to save credentials to database: ${err.message}`);
        }
      });



      // 6. Listen to connection updates
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
          this.connectionStatus = 'connecting';
        } else if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.pairingCode = null;

          const user = this.sock?.user;
          this.userJid = user?.id || null;
          this.userName = user?.name || 'WhatsApp User';

          this.addLog('connection', `Connected successfully to WhatsApp as ${this.userName} (${this.userJid})`);
        } else if (connection === 'close') {
          this.connectionStatus = 'disconnected';
          this.isConnecting = false;

          const errObj = lastDisconnect?.error as any;
          const statusCode = errObj?.output?.statusCode;
          const reasonMessage = errObj?.message || 'Transient network reconnect';

          // Treat non-logged-out disconnects as normal reconnects
          if (statusCode === DisconnectReason.loggedOut) {
            this.connectionStatus = 'logged_out';
            this.addLog('error', 'Session was logged out by WhatsApp. Please re-pair your phone number.');
            if (this.authResult) {
              await this.authResult.clearSession();
            }
          } else {
            this.addLog('info', `WhatsApp connection closed (${statusCode || 'Reconnect'}). Reconnecting automatically...`);
            this.scheduleReconnect();
          }
        }
      });

      // 7. Core Feature: Listen to incoming message upserts
      this.sock.ev.on('messages.upsert', async (m) => {
        await this.handleIncomingMessages(m);
      });

    } catch (error: any) {
      this.isConnecting = false;
      this.connectionStatus = 'disconnected';
      this.addLog('error', `Socket initialization error: ${error.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Request pairing code for a given phone number
   */
  public async requestPairingCode(phoneNumber: string): Promise<string> {
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 8) {
      throw new Error('Please provide a valid phone number with country code (e.g., 2348012345678)');
    }

    this.pairingPhone = cleanPhone;

    // If socket exists but is closed or needs reset, clean up first
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {}
      this.sock = null;
    }

    await this.initialize(cleanPhone);

    // Wait for socket to establish connection handshake (up to 5 seconds)
    let attempts = 0;
    while ((!this.sock || !(this.sock as any).requestPairingCode) && attempts < 15) {
      await new Promise((r) => setTimeout(r, 400));
      attempts++;
    }

    if (!this.sock) {
      throw new Error('WhatsApp socket could not be established to request pairing code');
    }

    // Give socket 1.5 seconds to open WebSocket connection before calling requestPairingCode
    await new Promise((r) => setTimeout(r, 1500));

    let lastError: any = null;
    for (let retry = 1; retry <= 3; retry++) {
      try {
        this.addLog('info', `Requesting WhatsApp pairing code for +${cleanPhone} (Attempt ${retry}/3)...`);
        const code = await (this.sock as any).requestPairingCode(cleanPhone);
        const formatted = code?.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        this.pairingCode = formatted;
        this.pairingCodeGeneratedAt = Date.now();
        this.connectionStatus = 'awaiting_code';

        this.addLog('connection', `Pairing code generated: ${formatted}. Enter this in WhatsApp Linked Devices.`);
        return formatted;
      } catch (err: any) {
        lastError = err;
        this.addLog('error', `Pairing code attempt ${retry} failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    throw new Error(`Failed to request pairing code after 3 attempts: ${lastError?.message || 'Connection closed'}`);
  }

  /**
   * Automatic Reconnection Scheduler
   */
  private scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.addLog('error', `Max reconnection attempts (${this.maxReconnectAttempts}) reached. Pausing auto-reconnect.`);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(3000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    this.addLog('connection', `Scheduling reconnection attempt #${this.reconnectAttempts} in ${Math.round(delay / 1000)}s...`);

    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.initialize();
      } catch (err: any) {
        console.error('Reconnection failed:', err);
      }
    }, delay);
  }

  /**
   * Core Automation Handler: Auto-Tag Everyone in Groups
   * 
   * Triggers when owner (msg.key.fromMe === true) sends any message in any group
   */
  private async handleIncomingMessages(upsert: { messages: proto.IWebMessageInfo[]; type: string }) {
    if (!this.sock) {
      return;
    }

    for (const msg of upsert.messages) {
      try {
        if (!msg.key) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const msgId = msg.key.id;
        if (!msgId) continue;

        // Anti-Infinite Recursion Protection:
        if (this.sentTagMessageIds.has(msgId)) {
          continue;
        }

        // Extract message text (conversation, extended, image/video/doc/sticker caption)
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          '';

        const senderJid = msg.key.participant || msg.key.remoteJid || (msg.key.fromMe ? (this.userJid || 'owner') : '');
        const isGroup = remoteJid.endsWith('@g.us');

        // Robust Owner Identification (fromMe === true, or matches paired phone/JID)
        const isOwner: boolean = Boolean(
          msg.key.fromMe ||
          (this.userJid && senderJid.split('@')[0] === this.userJid.split('@')[0]) ||
          (this.pairingPhone && senderJid.replace(/[^0-9]/g, '').includes(this.pairingPhone)) ||
          (process.env.PHONE_NUMBER && senderJid.replace(/[^0-9]/g, '').includes(process.env.PHONE_NUMBER.replace(/[^0-9]/g, '')))
        );

        const isAdmin = isOwner || (await adminManager.isAdmin(senderJid));

        // Ignore messages sent by our own tagger announcement to prevent infinite loops
        if (text.includes('🏷️ *ATTENTION EVERYONE*') || text.includes('[AUTO_TAG_BOT]')) {
          continue;
        }

        // ====================================================================
        // 1. COMMAND PARSER (!tagall, !help, !broadcast, !admins, etc.)
        // ====================================================================
        if (text && text.trim().length > 0) {
          const parsedCommand = commandHandler.parseCommand(text);
          if (parsedCommand?.isCommand) {
            const handled = await commandHandler.handleCommand({
              sock: this.sock,
              msg,
              remoteJid,
              senderJid,
              isGroup,
              isOwner,
              isAdmin,
              command: parsedCommand.command,
              args: parsedCommand.args,
              fullArgString: parsedCommand.fullArgString,
            });

            if (handled) {
              this.addLog('info', `Command '!${parsedCommand.command}' executed by ${senderJid}`);
              continue;
            }
          }
        }

        // ====================================================================
        // 2. AUTOMATIC TAG EVERYONE (Every message sent by owner in any group)
        // No !tagall command or keywords needed!
        // ====================================================================
        if (!this.config.autoTagEnabled || !isOwner || !isGroup) {
          continue;
        }

        // If trigger is set to 'keyword' (optional setting), verify keyword;
        // By default, trigger is 'all' which triggers on EVERY single message!
        if (this.config.autoTagTrigger === 'keyword') {
          const keyword = (this.config.autoTagKeyword || '!everyone').toLowerCase();
          if (!text.toLowerCase().includes(keyword)) {
            continue;
          }
        }

        // Group Cooldown check to prevent rapid spamming (default: 1 second)
        const now = Date.now();
        const lastTag = this.lastGroupTagTime.get(remoteJid) || 0;
        const cooldownMs = (this.config.cooldownSeconds || 1) * 1000;
        if (now - lastTag < cooldownMs) {
          this.addLog('info', `Cooldown active in ${remoteJid} (${Math.round((cooldownMs - (now - lastTag)) / 1000)}s)`);
          continue;
        }
        this.lastGroupTagTime.set(remoteJid, now);

        const logPreview = text ? text.slice(0, 100) : '[Media/Attachment]';
        this.addLog('tag', `Owner sent a message in ${remoteJid}. Auto-tagging everyone immediately...`, {
          originalText: logPreview,
          msgId,
        });

        // Fetch group metadata & all participants
        const groupMeta = await this.sock.groupMetadata(remoteJid);
        const participants = groupMeta.participants.map((p) => p.id);

        if (!participants || participants.length === 0) {
          this.addLog('info', `No participants found in group ${remoteJid}`);
          continue;
        }

        // Format mention message quoting the owner's message
        const mentionPayload = this.buildTagMessagePayload(text || 'New message from group owner', participants, groupMeta.subject);

        // Send mention reply tagging every single participant
        const sentMsg = await this.sock.sendMessage(
          remoteJid,
          {
            text: mentionPayload.text,
            mentions: participants,
          },
          { quoted: msg as any }
        );

        if (sentMsg?.key.id) {
          this.sentTagMessageIds.add(sentMsg.key.id);
          if (this.sentTagMessageIds.size > 1000) {
            const first = this.sentTagMessageIds.values().next().value;
            if (first) this.sentTagMessageIds.delete(first);
          }
        }

        this.totalMessagesTagged++;
        this.addLog('tag', `Automatically tagged all ${participants.length} members in "${groupMeta.subject}"`);
        this.addLog('tag', `Successfully tagged all ${participants.length} members in "${groupMeta.subject}"`, {
          groupJid: remoteJid,
          participantCount: participants.length,
        });

      } catch (err: any) {
        this.addLog('error', `Failed to auto-tag group participants: ${err.message}`, {
          error: err.toString(),
        });
      }
    }
  }

  /**
   * Builds the formatted message tagging all participants
   */
  private buildTagMessagePayload(
    originalText: string,
    participants: string[],
    groupSubject: string
  ): { text: string } {
    const mentionTags = participants.map((jid) => `@${jid.split('@')[0]}`).join(' ');

    if (this.config.mentionFormat === 'compact') {
      return {
        text: `👥 *All Members (${participants.length}):*\n${mentionTags}\n\n[AUTO_TAG_BOT]`,
      };
    }

    if (this.config.mentionFormat === 'standard') {
      const displayOriginal = originalText ? `\n> ${originalText.replace(/\n/g, '\n> ')}\n` : '';
      return {
        text: `📢 *Tagged Everyone in ${groupSubject}* (${participants.length} members)${displayOriginal}\n${mentionTags}\n\n[AUTO_TAG_BOT]`,
      };
    }

    // Default 'announcement'
    const quotedSnippet = originalText ? `\n\n💬 *Message:*\n"${originalText}"` : '';
    return {
      text: `🏷️ *ATTENTION EVERYONE* 🏷️\n📍 *Group:* ${groupSubject}\n👥 *Members Notified:* ${participants.length}${quotedSnippet}\n\n${mentionTags}\n\n⚡ _Sent via WhatsApp Auto-Tag Engine_ [AUTO_TAG_BOT]`,
    };
  }

  /**
   * Worker Execution: Consumes broadcast job from BullMQ / Queue
   */
  public async executeBroadcastJob(targetGroupJid: string, messageText: string): Promise<BroadcastJobResult> {
    const startTime = Date.now();
    if (!this.sock || this.connectionStatus !== 'connected') {
      throw new Error('WhatsApp bot is not currently connected. Cannot deliver broadcast job.');
    }

    if (!targetGroupJid || !targetGroupJid.endsWith('@g.us')) {
      throw new Error(`Invalid group JID '${targetGroupJid}'. Must end with '@g.us'.`);
    }

    this.addLog('broadcast', `Queue Worker processing broadcast to group ${targetGroupJid}...`, {
      messagePreview: messageText.slice(0, 100),
    });

    // 1. Fetch group metadata & participants
    const groupMeta = await this.sock.groupMetadata(targetGroupJid);
    const participants = groupMeta.participants.map((p) => p.id);

    if (participants.length === 0) {
      throw new Error(`Group '${groupMeta.subject}' (${targetGroupJid}) has no participants.`);
    }

    // 2. Format broadcast with all mentions
    const mentionTags = participants.map((jid) => `@${jid.split('@')[0]}`).join(' ');
    const fullText = `📢 *BROADCAST ANNOUNCEMENT* 📢\n\n${messageText}\n\n👥 *Tagged (${participants.length}):*\n${mentionTags}\n\n⚡ _Sent via Cloud Run Auto-Tag Queue Worker_ [AUTO_TAG_BOT]`;

    // 3. Send message with mentions array
    const sentMsg = await this.sock.sendMessage(targetGroupJid, {
      text: fullText,
      mentions: participants,
    });

    if (sentMsg?.key.id) {
      this.sentTagMessageIds.add(sentMsg.key.id);
    }

    this.totalBroadcastsSent++;
    this.addLog('broadcast', `Broadcast job successfully delivered to ${participants.length} members in "${groupMeta.subject}"`, {
      groupJid: targetGroupJid,
      participantsCount: participants.length,
      messageId: sentMsg?.key.id,
    });

    return {
      success: true,
      groupSubject: groupMeta.subject,
      recipientCount: participants.length,
      messageId: sentMsg?.key.id || undefined,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Broadcast API Handler: Queues job in BullMQ / Message Queue
   * Used by POST /send-broadcast
   */
  public async sendBroadcast(targetGroupJid: string, messageText: string, senderJid?: string): Promise<{
    success: boolean;
    jobId: string;
    mode: string;
    groupJid: string;
    status: string;
  }> {
    if (!targetGroupJid || !targetGroupJid.endsWith('@g.us')) {
      throw new Error(`Invalid group JID '${targetGroupJid}'. Must end with '@g.us'.`);
    }

    if (!messageText || messageText.trim().length === 0) {
      throw new Error('Broadcast message text cannot be empty.');
    }

    // Add job to BullMQ queue
    const { jobId, mode } = await broadcastQueue.addBroadcastJob({
      groupJid: targetGroupJid,
      message: messageText.trim(),
      senderJid,
    });

    this.addLog('info', `Broadcast job ${jobId} placed in ${mode} queue for group ${targetGroupJid}`);

    return {
      success: true,
      jobId,
      mode,
      groupJid: targetGroupJid,
      status: 'queued',
    };
  }

  /**
   * Fetches list of joined groups
   */
  public async getGroups(): Promise<GroupSummary[]> {
    if (!this.sock || this.connectionStatus !== 'connected') {
      return [];
    }

    try {
      const chats = await this.sock.groupFetchAllParticipating();
      const list: GroupSummary[] = Object.values(chats).map((g) => ({
        id: g.id,
        subject: g.subject,
        participantCount: g.participants?.length || 0,
        creation: g.creation,
        desc: g.desc,
      }));
      return list;
    } catch (err: any) {
      this.addLog('error', `Failed to fetch groups: ${err.message}`);
      return [];
    }
  }

  /**
   * Disconnects and optionally clears session from PostgreSQL
   */
  public async logoutAndReset(): Promise<void> {
    this.addLog('connection', 'Disconnecting and clearing session from Cloud SQL database...');
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {}
      try {
        this.sock.end(undefined);
      } catch {}
      this.sock = null;
    }
    if (this.authResult) {
      await this.authResult.clearSession();
    }
    this.connectionStatus = 'disconnected';
    this.pairingCode = null;
    this.pairingPhone = null;
    this.userJid = null;
    this.userName = null;
  }
}

// Singleton instance for the application
export const botManager = new WhatsAppBotManager();
