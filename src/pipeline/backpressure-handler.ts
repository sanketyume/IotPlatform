import { EventEmitter } from 'events';
import logger from '../utils/logger';
import metrics from '../utils/metrics';
import config from '../config';
import { BackpressureStatus } from '../types';

interface BackpressureConfig {
  enabled: boolean;
  highWatermark: number;
  lowWatermark: number;
}

export class BackpressureHandler extends EventEmitter {
  private static instance: BackpressureHandler;
  private config: BackpressureConfig;
  private tenantQueues: Map<string, { queue: unknown[]; processing: boolean }> = new Map();
  private dropping: boolean = false;
  private droppedCount: number = 0;

  private constructor() {
    super();
    this.config = config.getBackpressureConfig();
  }

  static getInstance(): BackpressureHandler {
    if (!BackpressureHandler.instance) {
      BackpressureHandler.instance = new BackpressureHandler();
    }
    return BackpressureHandler.instance;
  }

  async enqueue<T>(tenantId: string, item: T, priority: number = 0): Promise<boolean> {
    if (!this.config.enabled) {
      return true;
    }

    const queue = this.getTenantQueue(tenantId);
    const currentLevel = queue.queue.length;

    // Check if we're at high watermark
    if (currentLevel >= this.config.highWatermark) {
      this.dropping = true;
      this.droppedCount++;

      logger.warn('Backpressure: High watermark reached, dropping message', {
        correlationId: logger.generateCorrelationId(),
        tenantId,
        currentLevel,
        highWatermark: this.config.highWatermark,
        droppedCount: this.droppedCount,
      });

      metrics.incrementMessagesDropped({
        tenant_id: tenantId,
        reason: 'backpressure',
      });

      metrics.setBackpressureLevel(tenantId, currentLevel);

      this.emit('backpressure', {
        tenantId,
        currentLevel,
        dropping: true,
      });

      return false;
    }

    // Add to queue
    queue.queue.push(item);

    // Check if we've dropped below low watermark
    if (this.dropping && currentLevel < this.config.lowWatermark) {
      this.dropping = false;

      logger.info('Backpressure: Below low watermark, resuming normal operation', {
        correlationId: logger.generateCorrelationId(),
        tenantId,
        currentLevel,
        lowWatermark: this.config.lowWatermark,
        totalDropped: this.droppedCount,
      });

      this.emit('backpressure-released', {
        tenantId,
        currentLevel,
        droppedCount: this.droppedCount,
      });

      this.droppedCount = 0;
    }

    metrics.setBackpressureLevel(tenantId, currentLevel);

    logger.debug('Item enqueued', {
      correlationId: logger.generateCorrelationId(),
      tenantId,
      queueSize: currentLevel,
      priority,
    });

    return true;
  }

  async dequeue<T>(tenantId: string): Promise<T | null> {
    const queue = this.getTenantQueue(tenantId);

    if (queue.queue.length === 0) {
      return null;
    }

    const item = queue.queue.shift() as T;
    const currentLevel = queue.queue.length;

    metrics.setBackpressureLevel(tenantId, currentLevel);

    logger.debug('Item dequeued', {
      correlationId: logger.generateCorrelationId(),
      tenantId,
      remainingItems: currentLevel,
    });

    return item;
  }

  getQueueSize(tenantId: string): number {
    const queue = this.getTenantQueue(tenantId);
    return queue.queue.length;
  }

  getStatus(tenantId: string): BackpressureStatus {
    const queue = this.getTenantQueue(tenantId);
    const currentLevel = queue.queue.length;

    return {
      enabled: this.config.enabled,
      currentLevel,
      highWatermark: this.config.highWatermark,
      lowWatermark: this.config.lowWatermark,
      dropping: this.dropping,
    };
  }

  private getTenantQueue(tenantId: string): { queue: unknown[]; processing: boolean } {
    if (!this.tenantQueues.has(tenantId)) {
      this.tenantQueues.set(tenantId, {
        queue: [],
        processing: false,
      });
    }

    return this.tenantQueues.get(tenantId)!;
  }

  async processQueue<T>(
    tenantId: string,
    processor: (item: T) => Promise<void>,
    maxBatchSize: number = 10,
  ): Promise<void> {
    const queue = this.getTenantQueue(tenantId);

    if (queue.processing) {
      logger.debug('Queue already being processed', {
        correlationId: logger.generateCorrelationId(),
        tenantId,
      });
      return;
    }

    queue.processing = true;

    try {
      while (queue.queue.length > 0) {
        const batchSize = Math.min(maxBatchSize, queue.queue.length);
        const batch: T[] = [];

        for (let i = 0; i < batchSize; i++) {
          const item = await this.dequeue<T>(tenantId);
          if (item) {
            batch.push(item);
          }
        }

        // Process batch in parallel
        await Promise.all(batch.map((item) => processor(item)));

        logger.debug('Batch processed', {
          correlationId: logger.generateCorrelationId(),
          tenantId,
          batchSize: batch.length,
          remainingItems: queue.queue.length,
        });
      }
    } catch (error) {
      logger.error('Queue processing error', {
        correlationId: logger.generateCorrelationId(),
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      queue.processing = false;
    }
  }

  clearQueue(tenantId: string): void {
    const queue = this.getTenantQueue(tenantId);
    const clearedCount = queue.queue.length;
    queue.queue = [];

    logger.info('Queue cleared', {
      correlationId: logger.generateCorrelationId(),
      tenantId,
      clearedCount,
    });

    metrics.setBackpressureLevel(tenantId, 0);
  }

  clearAllQueues(): void {
    for (const tenantId of this.tenantQueues.keys()) {
      this.clearQueue(tenantId);
    }

    logger.info('All queues cleared', {
      correlationId: logger.generateCorrelationId(),
    });
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  resetDroppedCount(): void {
    this.droppedCount = 0;
  }
}

export default BackpressureHandler.getInstance();
