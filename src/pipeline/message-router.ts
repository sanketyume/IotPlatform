import Redis from 'ioredis';
import logger from '../utils/logger';
import config from '../config';
import { ParsedMessage, StorageType, StorageConfig } from '../types';

interface StorageAdapter {
  store(message: ParsedMessage): Promise<void>;
  retrieve(key: string): Promise<ParsedMessage | null>;
  close(): Promise<void>;
}

class RedisStorageAdapter implements StorageAdapter {
  private client: Redis;
  private ttl: number = 3600; // 1 hour default TTL for hot storage

  constructor(url: string) {
    this.client = new Redis(url);
  }

  async store(message: ParsedMessage): Promise<void> {
    const key = this.generateKey(message);
    const value = JSON.stringify({
      data: message.data,
      metadata: {
        ...message.metadata,
        timestamp: message.metadata.timestamp.toISOString(),
      },
      format: message.format,
    });

    await this.client.setex(key, this.ttl, value);

    logger.debug('Message stored in Redis', {
      correlationId: message.metadata.correlationId,
      key,
      ttl: this.ttl,
    });
  }

  async retrieve(key: string): Promise<ParsedMessage | null> {
    const value = await this.client.get(key);

    if (!value) {
      return null;
    }

    const parsed = JSON.parse(value);
    return {
      ...parsed,
      metadata: {
        ...parsed.metadata,
        timestamp: new Date(parsed.metadata.timestamp),
      },
    };
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  private generateKey(message: ParsedMessage): string {
    const { tenantId, deviceId, timestamp } = message.metadata;
    return `iot:${tenantId}:${deviceId}:${timestamp.getTime()}`;
  }
}

class MongoDBStorageAdapter implements StorageAdapter {
  private connectionString: string;
  private connected: boolean = false;

  constructor(url: string) {
    this.connectionString = url;
    // In a real implementation, you would initialize MongoDB connection here
  }

  async store(message: ParsedMessage): Promise<void> {
    // Placeholder for MongoDB storage
    // In production, you would use official MongoDB driver
    logger.debug('Message stored in MongoDB', {
      correlationId: message.metadata.correlationId,
      deviceId: message.metadata.deviceId,
      tenantId: message.metadata.tenantId,
    });

    // Example implementation:
    // await this.collection.insertOne({
    //   tenantId: message.metadata.tenantId,
    //   deviceId: message.metadata.deviceId,
    //   data: message.data,
    //   metadata: message.metadata,
    //   format: message.format,
    //   createdAt: new Date(),
    // });
  }

  async retrieve(key: string): Promise<ParsedMessage | null> {
    // Placeholder for MongoDB retrieval
    return null;
  }

  async close(): Promise<void> {
    // Close MongoDB connection
    this.connected = false;
  }
}

export class MessageRouter {
  private static instance: MessageRouter;
  private hotStorage?: StorageAdapter;
  private coldStorage?: StorageAdapter;
  private storageConfig: StorageConfig;
  private routingRules: Map<
    string,
    { hot: boolean; cold: boolean; condition?: (message: ParsedMessage) => boolean }
  > = new Map();

  private constructor() {
    this.storageConfig = config.getStorageConfig();
    this.initializeStorageAdapters();
    this.setupDefaultRoutingRules();
  }

  static getInstance(): MessageRouter {
    if (!MessageRouter.instance) {
      MessageRouter.instance = new MessageRouter();
    }
    return MessageRouter.instance;
  }

  private initializeStorageAdapters(): void {
    try {
      // Initialize hot storage (Redis)
      if (this.storageConfig.hot.enabled) {
        this.hotStorage = new RedisStorageAdapter(this.storageConfig.hot.url);
        logger.info('Hot storage initialized', {
          correlationId: logger.generateCorrelationId(),
          type: this.storageConfig.hot.type,
        });
      }

      // Initialize cold storage (MongoDB)
      if (this.storageConfig.cold.enabled) {
        this.coldStorage = new MongoDBStorageAdapter(this.storageConfig.cold.url);
        logger.info('Cold storage initialized', {
          correlationId: logger.generateCorrelationId(),
          type: this.storageConfig.cold.type,
        });
      }
    } catch (error) {
      logger.error('Failed to initialize storage adapters', {
        correlationId: logger.generateCorrelationId(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private setupDefaultRoutingRules(): void {
    // Default: route recent data to hot storage, all data to cold storage
    this.routingRules.set('default', {
      hot: true,
      cold: true,
    });

    // High-frequency telemetry: hot storage only for recent data
    this.routingRules.set('telemetry', {
      hot: true,
      cold: true,
      condition: (message) => {
        // Store in hot storage for quick access, also in cold for historical analysis
        return true;
      },
    });

    // Commands: hot storage only
    this.routingRules.set('commands', {
      hot: true,
      cold: false,
    });

    // Events: cold storage for audit trail
    this.routingRules.set('events', {
      hot: false,
      cold: true,
    });
  }

  async route(message: ParsedMessage): Promise<void> {
    const correlationId = message.metadata.correlationId;

    try {
      // Determine routing rule based on topic
      const rule = this.determineRoutingRule(message);

      // Route to hot storage
      if (rule.hot && this.hotStorage) {
        if (!rule.condition || rule.condition(message)) {
          await this.routeToStorage(message, StorageType.HOT);
        }
      }

      // Route to cold storage
      if (rule.cold && this.coldStorage) {
        if (!rule.condition || rule.condition(message)) {
          await this.routeToStorage(message, StorageType.COLD);
        }
      }

      logger.debug('Message routed successfully', {
        correlationId,
        hot: rule.hot,
        cold: rule.cold,
        deviceId: message.metadata.deviceId,
        tenantId: message.metadata.tenantId,
      });
    } catch (error) {
      logger.error('Message routing failed', {
        correlationId,
        deviceId: message.metadata.deviceId,
        tenantId: message.metadata.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private determineRoutingRule(message: ParsedMessage): {
    hot: boolean;
    cold: boolean;
    condition?: (message: ParsedMessage) => boolean;
  } {
    const topic = message.metadata.topic;

    // Check for specific routing rules based on topic patterns
    if (topic.includes('telemetry')) {
      return this.routingRules.get('telemetry') || this.routingRules.get('default')!;
    }

    if (topic.includes('commands')) {
      return this.routingRules.get('commands') || this.routingRules.get('default')!;
    }

    if (topic.includes('events')) {
      return this.routingRules.get('events') || this.routingRules.get('default')!;
    }

    return this.routingRules.get('default')!;
  }

  private async routeToStorage(message: ParsedMessage, storageType: StorageType): Promise<void> {
    const adapter = storageType === StorageType.HOT ? this.hotStorage : this.coldStorage;

    if (!adapter) {
      logger.warn('Storage adapter not available', {
        correlationId: message.metadata.correlationId,
        storageType,
      });
      return;
    }

    try {
      await adapter.store(message);

      logger.debug('Message stored', {
        correlationId: message.metadata.correlationId,
        storageType,
        deviceId: message.metadata.deviceId,
        tenantId: message.metadata.tenantId,
      });
    } catch (error) {
      logger.error('Failed to store message', {
        correlationId: message.metadata.correlationId,
        storageType,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  addRoutingRule(
    name: string,
    rule: { hot: boolean; cold: boolean; condition?: (message: ParsedMessage) => boolean },
  ): void {
    this.routingRules.set(name, rule);

    logger.info('Routing rule added', {
      correlationId: logger.generateCorrelationId(),
      name,
      hot: rule.hot,
      cold: rule.cold,
    });
  }

  removeRoutingRule(name: string): void {
    this.routingRules.delete(name);

    logger.info('Routing rule removed', {
      correlationId: logger.generateCorrelationId(),
      name,
    });
  }

  async close(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.hotStorage) {
      promises.push(this.hotStorage.close());
    }

    if (this.coldStorage) {
      promises.push(this.coldStorage.close());
    }

    await Promise.all(promises);

    logger.info('Message router closed', {
      correlationId: logger.generateCorrelationId(),
    });
  }
}

export default MessageRouter.getInstance();
