import { EventEmitter } from 'events';
import { QoS } from 'mqtt';
import { ConnectionPool } from './connection-pool';
import { ConnectionManager } from './connection-manager';
import aclManager from './acl-manager';
import dataPipeline from '../pipeline/data-pipeline';
import logger from '../utils/logger';
import metrics from '../utils/metrics';
import rateLimiter from '../utils/rate-limiter';
import { MQTTMessage, DeviceProfile, HealthStatus } from '../types';

export interface BrokerClientOptions {
  tenantId: string;
  deviceId?: string;
  autoReconnect?: boolean;
  useConnectionPool?: boolean;
}

export class MQTTBrokerClient extends EventEmitter {
  private tenantId: string;
  private deviceId?: string;
  private connection?: ConnectionManager;
  private useConnectionPool: boolean;
  private connectionPool: ConnectionPool;
  private subscribedTopics: Set<string> = new Set();

  constructor(options: BrokerClientOptions) {
    super();
    this.tenantId = options.tenantId;
    this.deviceId = options.deviceId;
    this.useConnectionPool = options.useConnectionPool ?? true;
    this.connectionPool = ConnectionPool.getInstance();

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Set up data pipeline event handlers
    dataPipeline.on('message-processed', (message) => {
      this.emit('message-processed', message);
    });

    dataPipeline.on('validation-failed', (data) => {
      this.emit('validation-failed', data);
    });

    dataPipeline.on('error', (data) => {
      this.emit('pipeline-error', data);
    });
  }

  async connect(): Promise<void> {
    const correlationId = logger.generateCorrelationId();

    try {
      // Check connection limit
      if (!rateLimiter.checkConnectionLimit(this.tenantId)) {
        throw new Error('Connection limit exceeded for tenant');
      }

      if (this.useConnectionPool) {
        logger.info('Using connection pool', {
          correlationId,
          tenantId: this.tenantId,
        });

        this.connection = await this.connectionPool.acquire({
          tenantId: this.tenantId,
          deviceId: this.deviceId,
        });
      } else {
        logger.info('Creating dedicated connection', {
          correlationId,
          tenantId: this.tenantId,
        });

        this.connection = new ConnectionManager({
          tenantId: this.tenantId,
          deviceId: this.deviceId,
        });

        await this.connection.connect();
      }

      // Set up connection event handlers
      this.connection.on('message', (message: MQTTMessage) => {
        this.handleMessage(message);
      });

      this.connection.on('error', (error: Error) => {
        this.emit('error', error);
      });

      this.connection.on('close', () => {
        this.emit('disconnected');
      });

      rateLimiter.incrementConnectionCount(this.tenantId);

      logger.info('MQTT broker client connected', {
        correlationId,
        tenantId: this.tenantId,
        deviceId: this.deviceId,
        clientId: this.connection.getConnectionInfo().clientId,
      });

      this.emit('connected', this.connection.getConnectionInfo());
    } catch (error) {
      logger.error('Failed to connect MQTT broker client', {
        correlationId,
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      metrics.incrementErrors({
        type: 'connection',
        tenant_id: this.tenantId,
      });

      throw error;
    }
  }

  private async handleMessage(message: MQTTMessage): Promise<void> {
    const correlationId = message.correlationId || logger.generateCorrelationId();

    try {
      // Check ACL permissions
      if (!aclManager.canSubscribe(message.topic, this.tenantId, this.deviceId)) {
        logger.warn('ACL permission denied for subscription', {
          correlationId,
          topic: message.topic,
          tenantId: this.tenantId,
          deviceId: this.deviceId,
        });
        return;
      }

      // Extract tenant and device from topic if not set
      const { tenantId, deviceId } = this.extractIdsFromTopic(message.topic);

      // Process message through pipeline
      await dataPipeline.process(
        message,
        tenantId || this.tenantId,
        deviceId || this.deviceId || 'unknown',
      );

      this.emit('message', message);
    } catch (error) {
      logger.error('Error handling message', {
        correlationId,
        topic: message.topic,
        error: error instanceof Error ? error.message : String(error),
      });

      this.emit('message-error', { message, error });
    }
  }

  private extractIdsFromTopic(topic: string): { tenantId?: string; deviceId?: string } {
    // Assuming topic format: {tenantId}/{deviceId}/telemetry
    const parts = topic.split('/');

    if (parts.length >= 2) {
      return {
        tenantId: parts[0],
        deviceId: parts[1],
      };
    }

    return {};
  }

  async subscribe(topic: string | string[], qos: QoS = 1): Promise<void> {
    if (!this.connection) {
      throw new Error('Not connected');
    }

    const topics = Array.isArray(topic) ? topic : [topic];

    // Check ACL permissions for each topic
    for (const t of topics) {
      if (!aclManager.canSubscribe(t, this.tenantId, this.deviceId)) {
        throw new Error(`ACL permission denied for topic: ${t}`);
      }
    }

    await this.connection.subscribe(topics, qos);

    topics.forEach((t) => this.subscribedTopics.add(t));

    logger.info('Subscribed to topics', {
      correlationId: logger.generateCorrelationId(),
      topics,
      tenantId: this.tenantId,
      deviceId: this.deviceId,
    });

    this.emit('subscribed', topics);
  }

  async unsubscribe(topic: string | string[]): Promise<void> {
    if (!this.connection) {
      throw new Error('Not connected');
    }

    const topics = Array.isArray(topic) ? topic : [topic];

    await this.connection.unsubscribe(topics);

    topics.forEach((t) => this.subscribedTopics.delete(t));

    logger.info('Unsubscribed from topics', {
      correlationId: logger.generateCorrelationId(),
      topics,
      tenantId: this.tenantId,
    });

    this.emit('unsubscribed', topics);
  }

  async publish(
    topic: string,
    payload: string | Buffer,
    options: { qos?: QoS; retain?: boolean } = {},
  ): Promise<void> {
    if (!this.connection) {
      throw new Error('Not connected');
    }

    // Check ACL permissions
    if (!aclManager.canPublish(topic, this.tenantId, this.deviceId)) {
      throw new Error(`ACL permission denied for publishing to topic: ${topic}`);
    }

    await this.connection.publish(topic, payload, options);

    logger.info('Message published', {
      correlationId: logger.generateCorrelationId(),
      topic,
      tenantId: this.tenantId,
      deviceId: this.deviceId,
      qos: options.qos,
      retain: options.retain,
    });

    this.emit('published', { topic, payload, options });
  }

  registerDeviceProfile(profile: DeviceProfile): void {
    dataPipeline.registerDeviceProfile(profile);

    logger.info('Device profile registered', {
      correlationId: logger.generateCorrelationId(),
      tenantId: profile.tenantId,
      deviceId: profile.deviceId,
    });
  }

  unregisterDeviceProfile(deviceId: string): void {
    dataPipeline.unregisterDeviceProfile(this.tenantId, deviceId);

    logger.info('Device profile unregistered', {
      correlationId: logger.generateCorrelationId(),
      tenantId: this.tenantId,
      deviceId,
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connection) {
      return;
    }

    const correlationId = logger.generateCorrelationId();

    try {
      if (this.useConnectionPool) {
        this.connectionPool.release(this.connection);
        logger.info('Connection released to pool', {
          correlationId,
          tenantId: this.tenantId,
        });
      } else {
        await this.connection.disconnect();
        logger.info('Connection disconnected', {
          correlationId,
          tenantId: this.tenantId,
        });
      }

      rateLimiter.decrementConnectionCount(this.tenantId);

      this.connection = undefined;
      this.subscribedTopics.clear();

      this.emit('disconnected');
    } catch (error) {
      logger.error('Error disconnecting', {
        correlationId,
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  isConnected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  getConnectionInfo() {
    return this.connection?.getConnectionInfo();
  }

  getSubscribedTopics(): string[] {
    return Array.from(this.subscribedTopics);
  }

  getHealthStatus(): HealthStatus {
    return this.connectionPool.getHealthStatus();
  }
}
