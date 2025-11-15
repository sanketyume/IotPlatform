import config from '../config';
import logger from './logger';
import metrics from './metrics';
import { RateLimitConfig } from '../types';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number;
}

interface TenantLimits {
  messageBucket: TokenBucket;
  connectionCount: number;
}

export class RateLimiter {
  private static instance: RateLimiter;
  private config: RateLimitConfig;
  private tenantLimits: Map<string, TenantLimits>;
  private refillInterval: NodeJS.Timeout | null = null;

  private constructor() {
    this.config = config.getRateLimitConfig();
    this.tenantLimits = new Map();

    if (this.config.enabled) {
      this.startRefillInterval();
    }
  }

  static getInstance(): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter();
    }
    return RateLimiter.instance;
  }

  private getTenantLimits(tenantId: string): TenantLimits {
    if (!this.tenantLimits.has(tenantId)) {
      this.tenantLimits.set(tenantId, {
        messageBucket: {
          tokens: this.config.burstSize,
          lastRefill: Date.now(),
          capacity: this.config.burstSize,
          refillRate: this.config.messagesPerSecond,
        },
        connectionCount: 0,
      });
    }
    return this.tenantLimits.get(tenantId)!;
  }

  private refillBucket(bucket: TokenBucket): void {
    const now = Date.now();
    const timePassed = (now - bucket.lastRefill) / 1000; // in seconds
    const tokensToAdd = timePassed * bucket.refillRate;

    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  private startRefillInterval(): void {
    this.refillInterval = setInterval(() => {
      for (const [tenantId, limits] of this.tenantLimits.entries()) {
        this.refillBucket(limits.messageBucket);
      }
    }, 1000); // Refill every second
  }

  checkMessageRate(tenantId: string, messageCount: number = 1): boolean {
    if (!this.config.enabled) {
      return true;
    }

    const limits = this.getTenantLimits(tenantId);
    this.refillBucket(limits.messageBucket);

    if (limits.messageBucket.tokens >= messageCount) {
      limits.messageBucket.tokens -= messageCount;
      return true;
    }

    logger.warn('Message rate limit exceeded', {
      correlationId: logger.generateCorrelationId(),
      tenantId,
      availableTokens: limits.messageBucket.tokens,
      requestedTokens: messageCount,
    });

    metrics.incrementMessagesDropped({ tenant_id: tenantId, reason: 'rate_limit' });

    return false;
  }

  checkPayloadSize(tenantId: string, payloadSize: number): boolean {
    if (!this.config.enabled) {
      return true;
    }

    if (payloadSize > this.config.payloadMaxSize) {
      logger.warn('Payload size limit exceeded', {
        correlationId: logger.generateCorrelationId(),
        tenantId,
        payloadSize,
        maxSize: this.config.payloadMaxSize,
      });

      metrics.incrementMessagesDropped({ tenant_id: tenantId, reason: 'payload_size' });

      return false;
    }

    return true;
  }

  checkConnectionLimit(tenantId: string): boolean {
    if (!this.config.enabled) {
      return true;
    }

    const limits = this.getTenantLimits(tenantId);

    if (limits.connectionCount >= this.config.connectionsPerTenant) {
      logger.warn('Connection limit exceeded', {
        correlationId: logger.generateCorrelationId(),
        tenantId,
        currentConnections: limits.connectionCount,
        maxConnections: this.config.connectionsPerTenant,
      });

      return false;
    }

    return true;
  }

  incrementConnectionCount(tenantId: string): void {
    if (!this.config.enabled) {
      return;
    }

    const limits = this.getTenantLimits(tenantId);
    limits.connectionCount++;
  }

  decrementConnectionCount(tenantId: string): void {
    if (!this.config.enabled) {
      return;
    }

    const limits = this.getTenantLimits(tenantId);
    limits.connectionCount = Math.max(0, limits.connectionCount - 1);
  }

  getRemainingTokens(tenantId: string): number {
    const limits = this.getTenantLimits(tenantId);
    this.refillBucket(limits.messageBucket);
    return limits.messageBucket.tokens;
  }

  getConnectionCount(tenantId: string): number {
    const limits = this.getTenantLimits(tenantId);
    return limits.connectionCount;
  }

  resetLimits(tenantId: string): void {
    this.tenantLimits.delete(tenantId);
  }

  shutdown(): void {
    if (this.refillInterval) {
      clearInterval(this.refillInterval);
      this.refillInterval = null;
    }
  }
}

export default RateLimiter.getInstance();
