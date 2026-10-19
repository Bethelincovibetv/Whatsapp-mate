/**
 * Command Handler and Message Parser for WhatsApp Bot
 * 
 * Parses incoming messages for bot commands like !tagall, !help, !broadcast, !admins, etc.
 * Enforces Administrator Role-Based Access Control (RBAC).
 */

import { WASocket, proto } from '@whiskeysockets/baileys';
import { adminManager } from './adminManager.ts';
import { broadcastQueue } from './broadcastQueue.ts';

export interface CommandContext {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  remoteJid: string;
  senderJid: string;
  isGroup: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  command: string;
  args: string[];
  fullArgString: string;
}

export class CommandHandler {
  private commandPrefixes = ['!', '/', '.'];

  /**
   * Parses text to determine if it is a command
   */
  public parseCommand(text: string): { isCommand: boolean; command: string; args: string[]; fullArgString: string } | null {
    if (!text || text.trim().length === 0) return null;

    const trimmed = text.trim();
    const firstChar = trimmed[0];

    if (!this.commandPrefixes.includes(firstChar)) {
      return null;
    }

    const withoutPrefix = trimmed.slice(1).trim();
    const parts = withoutPrefix.split(/\s+/);
    const command = parts[0]?.toLowerCase() || '';
    const args = parts.slice(1);
    const fullArgString = withoutPrefix.slice(command.length).trim();

    return {
      isCommand: true,
      command,
      args,
      fullArgString,
    };
  }

  /**
   * Executes a parsed command
   */
  public async handleCommand(ctx: CommandContext): Promise<boolean> {
    const { sock, remoteJid, command, args, fullArgString, isGroup, isAdmin, isOwner, senderJid, msg } = ctx;

    console.log(`[CommandHandler] Processing command '${command}' from ${senderJid} (isAdmin: ${isAdmin}, isOwner: ${isOwner})`);

    switch (command) {
      // 1. HELP COMMAND
      case 'help':
      case 'menu':
      case 'commands': {
        const helpText = 
`🤖 *WHATSAPP BOT COMMAND CENTER* 🤖

Available Commands:
• *!help* - Show this command directory & usage
• *!tagall [message]* - Tag all group members (Admin only)
• *!broadcast <groupJid> <msg>* - Queue a broadcast (Admin only)
• *!admins* - List all registered administrators
• *!addadmin <number> [name]* - Add an administrator (Superadmin)
• *!deladmin <number>* - Remove an administrator (Superadmin)
• *!status* - View bot status, queue metrics & uptime
• *!ping* - Test responsiveness & latency

👑 *Your Role:* ${isOwner ? 'Primary Owner' : isAdmin ? 'Administrator' : 'Standard Member'}`;

        await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg as any });
        return true;
      }

      // 2. TAG ALL COMMAND
      case 'tagall':
      case 'everyone':
      case 'all': {
        if (!isGroup) {
          await sock.sendMessage(remoteJid, { text: '⚠️ *!tagall* can only be executed inside a WhatsApp group.' }, { quoted: msg as any });
          return true;
        }

        // Check Admin Authorization
        if (!isAdmin && !isOwner) {
          await sock.sendMessage(
            remoteJid,
            { text: '❌ *Access Denied:* Only bot administrators can execute the *!tagall* command.' },
            { quoted: msg as any }
          );
          return true;
        }

        try {
          const groupMeta = await sock.groupMetadata(remoteJid);
          const participants = groupMeta.participants.map((p) => p.id);

          if (!participants || participants.length === 0) {
            await sock.sendMessage(remoteJid, { text: '⚠️ No participants found in this group.' }, { quoted: msg as any });
            return true;
          }

          const customNotice = fullArgString ? `\n\n💬 *Notice:*\n"${fullArgString}"` : '';
          const mentionsTags = participants.map((jid) => `@${jid.split('@')[0]}`).join(' ');

          const replyText = 
`🏷️ *ATTENTION EVERYONE* 🏷️
📍 *Group:* ${groupMeta.subject}
👥 *Tagged Members (${participants.length}):*${customNotice}

${mentionsTags}

⚡ _Triggered via !tagall command by @${senderJid.split('@')[0]}_ [AUTO_TAG_BOT]`;

          await sock.sendMessage(
            remoteJid,
            {
              text: replyText,
              mentions: [...participants, senderJid],
            },
            { quoted: msg as any }
          );
          return true;
        } catch (err: any) {
          await sock.sendMessage(
            remoteJid,
            { text: `❌ Failed to execute !tagall: ${err.message}` },
            { quoted: msg as any }
          );
          return true;
        }
      }

      // 3. BROADCAST COMMAND
      case 'broadcast': {
        if (!isAdmin && !isOwner) {
          await sock.sendMessage(
            remoteJid,
            { text: '❌ *Access Denied:* Only administrators can queue broadcasts.' },
            { quoted: msg as any }
          );
          return true;
        }

        if (args.length < 2) {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Usage: *!broadcast <groupJid> <message text>*\nExample: `!broadcast 120363024890123456@g.us Emergency meeting now`' },
            { quoted: msg as any }
          );
          return true;
        }

        const targetGroupJid = args[0];
        const broadcastMsg = args.slice(1).join(' ');

        if (!targetGroupJid.endsWith('@g.us')) {
          await sock.sendMessage(
            remoteJid,
            { text: '❌ Invalid group JID. Must end with `@g.us`.' },
            { quoted: msg as any }
          );
          return true;
        }

        // Add to Message Queue
        const { jobId, mode } = await broadcastQueue.addBroadcastJob({
          groupJid: targetGroupJid,
          message: broadcastMsg,
          senderJid,
        });

        await sock.sendMessage(
          remoteJid,
          {
            text: `✅ *Broadcast Queued!*
🆔 *Job ID:* \`${jobId}\`
🎯 *Target:* \`${targetGroupJid}\`
⚙️ *Queue Engine:* \`${mode}\`

The worker is actively processing this job in the background with auto-retries.`,
          },
          { quoted: msg as any }
        );
        return true;
      }

      // 4. LIST ADMINS
      case 'admins':
      case 'adminlist': {
        const admins = await adminManager.getAdmins();
        let listText = `🛡️ *REGISTERED BOT ADMINISTRATORS (${admins.length})* 🛡️\n\n`;

        admins.forEach((admin, i) => {
          listText += `${i + 1}. *${admin.name}*\n   • JID: \`${admin.jid}\`\n   • Role: *${admin.role}*\n   • Permissions: ${admin.can_broadcast ? '📢 Broadcast ' : ''}${admin.can_tagall ? '🏷️ TagAll ' : ''}\n\n`;
        });

        listText += `_Admins have privileged access to !tagall, !broadcast, and group automation._`;
        await sock.sendMessage(remoteJid, { text: listText }, { quoted: msg as any });
        return true;
      }

      // 5. ADD ADMIN (Superadmin only)
      case 'addadmin': {
        const callerAdmin = await adminManager.getAdmin(senderJid);
        const isSuper = isOwner || callerAdmin?.role === 'superadmin';

        if (!isSuper) {
          await sock.sendMessage(
            remoteJid,
            { text: '❌ *Access Denied:* Only Superadministrators can add new administrators.' },
            { quoted: msg as any }
          );
          return true;
        }

        if (args.length < 1) {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Usage: *!addadmin <phoneNumber> [DisplayName]*\nExample: `!addadmin 14155552671 Sarah Ops`' },
            { quoted: msg as any }
          );
          return true;
        }

        const phone = args[0];
        const name = args.slice(1).join(' ') || `Admin (+${phone.replace(/[^0-9]/g, '')})`;
        const newAdmin = await adminManager.addAdmin({
          jid: phone,
          name,
          role: 'admin',
          addedBy: senderJid,
          canBroadcast: true,
          canTagall: true,
        });

        await sock.sendMessage(
          remoteJid,
          {
            text: `✅ *Administrator Added Successfully!*
👤 *Name:* ${newAdmin.name}
📱 *JID:* \`${newAdmin.jid}\`
🛡️ *Role:* ${newAdmin.role}
💾 Saved to PostgreSQL database \`bot_admins\`.`,
          },
          { quoted: msg as any }
        );
        return true;
      }

      // 6. DELETE ADMIN (Superadmin only)
      case 'deladmin':
      case 'removeadmin': {
        const callerAdmin = await adminManager.getAdmin(senderJid);
        const isSuper = isOwner || callerAdmin?.role === 'superadmin';

        if (!isSuper) {
          await sock.sendMessage(
            remoteJid,
            { text: '❌ *Access Denied:* Only Superadministrators can remove administrators.' },
            { quoted: msg as any }
          );
          return true;
        }

        if (args.length < 1) {
          await sock.sendMessage(
            remoteJid,
            { text: '⚠️ Usage: *!deladmin <phoneNumber or JID>*' },
            { quoted: msg as any }
          );
          return true;
        }

        const target = args[0];
        const removed = await adminManager.removeAdmin(target);

        if (removed) {
          await sock.sendMessage(
            remoteJid,
            { text: `✅ Administrator \`${target}\` has been removed from PostgreSQL records.` },
            { quoted: msg as any }
          );
        } else {
          await sock.sendMessage(
            remoteJid,
            { text: `⚠️ Administrator \`${target}\` was not found in the admin list.` },
            { quoted: msg as any }
          );
        }
        return true;
      }

      // 7. STATUS & METRICS
      case 'status': {
        const queueStats = broadcastQueue.getStats();
        const statusText = 
`⚡ *SYSTEM HEALTH & METRICS* ⚡

📡 *Connection:* Active (Baileys)
📬 *Queue Engine:* ${queueStats.mode}
📊 *Queue Length:* ${queueStats.queueLength} waiting
✅ *Completed Jobs:* ${queueStats.counts.completed}
❌ *Failed Jobs:* ${queueStats.counts.failed}
🛡️ *Database Storage:* PostgreSQL (Google Cloud SQL)
⏱️ *Timestamp:* ${new Date().toLocaleTimeString()}`;

        await sock.sendMessage(remoteJid, { text: statusText }, { quoted: msg as any });
        return true;
      }

      // 8. PING
      case 'ping': {
        const start = Date.now();
        await sock.sendMessage(remoteJid, { text: `🏓 Pong! ⚡ Latency: ${Date.now() - start}ms` }, { quoted: msg as any });
        return true;
      }

      default:
        // Unknown command - don't spam group, but can reply if in DM
        if (!isGroup) {
          await sock.sendMessage(
            remoteJid,
            { text: `⚠️ Unknown command \`!${command}\`. Type *!help* to see available commands.` },
            { quoted: msg as any }
          );
        }
        return false;
    }
  }
}

export const commandHandler = new CommandHandler();
