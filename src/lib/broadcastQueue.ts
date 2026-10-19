/**
 * Message Queue System for WhatsApp Broadcasts (BullMQ + Redis with In-Memory Worker Fallback)
 * 
 * Provides:
 * - Asynchronous background job processing for POST /send-broadcast
 * - Configurable retry policies (3 attempts with exponential backoff)
 * - Concurrency control to avoid WhatsApp rate-limits
 * - Real-time queue metrics and job history
 */

import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';

export interface BroadcastJobData {
  id: string;
  groupJid: string;
  message: string;
  senderJid?: string;
  priority?: number;
  requestedAt: string;
}

export interface BroadcastJobResult {
  success: boolean;
  messageId?: string;
  recipientCount: number;
  groupSubject: string;
  durationMs: number;
}

export interface JobRecord {
  id: string;
  data: BroadcastJobData;
  status: 'waiting' | 'active' | 'completed' | 'failed';
  attemptsMade: number;
  maxAttempts: number;
  result?: BroadcastJobResult;
  failedReason?: string;
  createdAt: string;
  processedAt?: string;
  finishedAt?: string;
}

export type BroadcastWorkerHandler = (jobData: BroadcastJobData) => Promise<BroadcastJobResult>;

export class BroadcastQueueManager {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private redisClient: Redis | null = null;
  private isRedisConnected: boolean = false;
  private workerHandler: BroadcastWorkerHandler | null = null;

  // In-process fallback queue and job store
  private inMemoryQueue: BroadcastJobData[] = [];
  private jobHistory = new Map<string, JobRecord>();
  private isProcessingInMemory = false;

  constructor() {
    this.setupRedisOrFallback();
  }

  private setupRedisOrFallback() {
    const redisUrl = process.env.REDIS_URL;
    const redisHost = process.env.REDIS_HOST;
    const redisPort = Number(process.env.REDIS_PORT) || 6379;
    const redisPassword = process.env.REDIS_PASSWORD;

    if (redisUrl || redisHost) {
      try {
        console.log('[MessageQueue] Connecting to Redis for BullMQ...');
        const connection = redisUrl
          ? new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
          : new Redis({
              host: redisHost,
              port: redisPort,
              password: redisPassword,
              maxRetriesPerRequest: null,
              enableReadyCheck: false,
            });

        connection.on('connect', () => {
          this.isRedisConnected = true;
          console.log('[MessageQueue] Connected to Redis. BullMQ initialized.');
          this.initBullMQ(connection);
        });

        connection.on('error', (err) => {
          console.warn('[MessageQueue] Redis connection warning:', err.message);
          this.isRedisConnected = false;
        });

        this.redisClient = connection;
      } catch (err: any) {
        console.warn('[MessageQueue] Failed to init Redis client, using in-memory worker:', err.message);
        this.isRedisConnected = false;
      }
    } else {
      console.log('[MessageQueue] No REDIS_URL provided. Operating with built-in asynchronous Worker Queue.');
      this.isRedisConnected = false;
    }
  }

  private initBullMQ(redisConnection: Redis) {
    try {
      this.queue = new Queue('whatsapp-broadcasts', {
        connection: redisConnection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      });

      if (this.workerHandler) {
        this.startBullWorker(redisConnection);
      }
    } catch (e: any) {
      console.error('[MessageQueue] Error initializing BullMQ Queue:', e.message);
    }
  }

  private startBullWorker(redisConnection: Redis) {
    if (this.worker) {
      this.worker.close();
    }

    this.worker = new Worker(
      'whatsapp-broadcasts',
      async (job: Job<BroadcastJobData>) => {
        if (!this.workerHandler) {
          throw new Error('No broadcast worker handler registered');
        }
        return await this.workerHandler(job.data);
      },
      {
        connection: redisConnection,
        concurrency: 1, // Process one broadcast at a time to prevent socket collisions
      }
    );

    this.worker.on('completed', (job: Job, result: BroadcastJobResult) => {
      console.log(`[BullMQ Worker] Job ${job.id} completed successfully for group ${job.data.groupJid}`);
      this.jobHistory.set(job.id || String(Math.random()), {
        id: job.id || String(Math.random()),
        data: job.data,
        status: 'completed',
        attemptsMade: job.attemptsMade,
        maxAttempts: 3,
        result,
        createdAt: job.data.requestedAt,
        finishedAt: new Date().toISOString(),
      });
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      console.error(`[BullMQ Worker] Job ${job?.id} failed on attempt ${job?.attemptsMade}:`, err.message);
      if (job) {
        this.jobHistory.set(job.id || String(Math.random()), {
          id: job.id || String(Math.random()),
          data: job.data,
          status: 'failed',
          attemptsMade: job.attemptsMade,
          maxAttempts: 3,
          failedReason: err.message,
          createdAt: job.data.requestedAt,
          finishedAt: new Date().toISOString(),
        });
      }
    });
  }

  /**
   * Registers the Baileys sender function to consume jobs
   */
  public registerWorkerHandler(handler: BroadcastWorkerHandler) {
    this.workerHandler = handler;
    if (this.isRedisConnected && this.redisClient) {
      this.startBullWorker(this.redisClient);
    }
  }

  /**
   * Adds a broadcast job to the queue
   */
  public async addBroadcastJob(params: {
    groupJid: string;
    message: string;
    senderJid?: string;
  }): Promise<{ jobId: string; mode: string }> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const jobData: BroadcastJobData = {
      id: jobId,
      groupJid: params.groupJid,
      message: params.message,
      senderJid: params.senderJid,
      requestedAt: new Date().toISOString(),
    };

    // Store in history
    const record: JobRecord = {
      id: jobId,
      data: jobData,
      status: 'waiting',
      attemptsMade: 0,
      maxAttempts: 3,
      createdAt: jobData.requestedAt,
    };
    this.jobHistory.set(jobId, record);

    if (this.queue && this.isRedisConnected) {
      await this.queue.add('broadcast-message', jobData, { jobId });
      return { jobId, mode: 'bullmq-redis' };
    } else {
      // In-memory worker queue
      this.inMemoryQueue.push(jobData);
      this.processInMemoryQueue();
      return { jobId, mode: 'in-memory-worker' };
    }
  }

  /**
   * In-Memory Async Worker loop with retry policy
   */
  private async processInMemoryQueue() {
    if (this.isProcessingInMemory || this.inMemoryQueue.length === 0) {
      return;
    }

    this.isProcessingInMemory = true;

    while (this.inMemoryQueue.length > 0) {
      const jobData = this.inMemoryQueue.shift()!;
      const record = this.jobHistory.get(jobData.id);

      if (!record) continue;

      record.status = 'active';
      record.processedAt = new Date().toISOString();

      let success = false;
      const maxAttempts = 3;

      while (record.attemptsMade < maxAttempts && !success) {
        record.attemptsMade++;
        try {
          if (!this.workerHandler) {
            throw new Error('Broadcast worker handler is not registered');
          }

          console.log(`[Queue Worker] Processing broadcast job ${jobData.id} (Attempt ${record.attemptsMade}/${maxAttempts})`);
          const result = await this.workerHandler(jobData);

          record.status = 'completed';
          record.result = result;
          record.finishedAt = new Date().toISOString();
          success = true;
          console.log(`[Queue Worker] Broadcast job ${jobData.id} delivered to ${result.recipientCount} participants!`);
        } catch (err: any) {
          console.error(`[Queue Worker] Broadcast job ${jobData.id} attempt ${record.attemptsMade} failed:`, err.message);
          record.failedReason = err.message;

          if (record.attemptsMade < maxAttempts) {
            // Exponential backoff delay
            const backoffDelay = Math.pow(2, record.attemptsMade) * 1000;
            console.log(`[Queue Worker] Retrying job ${jobData.id} in ${backoffDelay / 1000}s...`);
            await new Promise((r) => setTimeout(r, backoffDelay));
          } else {
            record.status = 'failed';
            record.finishedAt = new Date().toISOString();
          }
        }
      }

      // Small delay between jobs to respect WhatsApp connection pacing
      await new Promise((r) => setTimeout(r, 1000));
    }

    this.isProcessingInMemory = false;
  }

  public getStats() {
    let waiting = 0;
    let active = 0;
    let completed = 0;
    let failed = 0;

    for (const record of this.jobHistory.values()) {
      if (record.status === 'waiting') waiting++;
      else if (record.status === 'active') active++;
      else if (record.status === 'completed') completed++;
      else if (record.status === 'failed') failed++;
    }

    return {
      mode: this.isRedisConnected ? 'bullmq-redis' : 'in-memory-worker',
      isRedisConnected: this.isRedisConnected,
      queueLength: this.inMemoryQueue.length,
      counts: {
        waiting,
        active,
        completed,
        failed,
        total: this.jobHistory.size,
      },
    };
  }

  public getJobs(): JobRecord[] {
    return Array.from(this.jobHistory.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);
  }

  public retryJob(id: string): boolean {
    const record = this.jobHistory.get(id);
    if (!record || record.status !== 'failed') return false;

    record.status = 'waiting';
    record.attemptsMade = 0;
    record.failedReason = undefined;

    if (this.queue && this.isRedisConnected) {
      this.queue.add('broadcast-message', record.data, { jobId: record.id });
    } else {
      this.inMemoryQueue.push(record.data);
      this.processInMemoryQueue();
    }
    return true;
  }
}

export const broadcastQueue = new BroadcastQueueManager();
