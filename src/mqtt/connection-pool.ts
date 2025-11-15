import { EventEmitter } from 'events';
import { ConnectionManager, ConnectionManagerOptions } from './connection-manager';
import logger from '../utils/logger';
import metrics from '../utils/metrics';
import { HealthStatus } from '../types';

interface PoolConfig {
  minSize: number;
  maxSize: number;
  healthCheckInterval: number;
}

export class ConnectionPool extends EventEmitter {
  private static instance: ConnectionPool;
  private connections: Map<string, ConnectionManager> = new Map();
  private availableConnections: string[] = [];
  private busyConnections: Set<string> = new Set();
  private config: PoolConfig;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private nodeIndex = 0;
  private clusterNodes: string[];

  private constructor(config: Partial<PoolConfig> = {}) {
    super();
    this.config = {
      minSize: config.minSize || parseInt(process.env.CONNECTION_POOL_MIN_SIZE || '2'),
      maxSize: config.maxSize || parseInt(process.env.CONNECTION_POOL_SIZE || '10'),
      healthCheckInterval:
        config.healthCheckInterval ||
        parseInt(process.env.CONNECTION_POOL_HEALTH_CHECK_INTERVAL || '30000'),
    };

    // Get cluster nodes from config if clustering is enabled
    const clusterEnabled = process.env.MQTT_CLUSTER_ENABLED === 'true';
    this.clusterNodes = clusterEnabled
      ? (process.env.MQTT_CLUSTER_NODES?.split(',') || [])
      : [];

    this.initialize();
  }

  static getInstance(config?: Partial<PoolConfig>): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool(config);
    }
    return ConnectionPool.instance;
  }

  private async initialize(): Promise<void> {
    logger.info('Initializing connection pool', {
      correlationId: logger.generateCorrelationId(),
      minSize: this.config.minSize,
      maxSize: this.config.maxSize,
      clusterNodes: this.clusterNodes.length,
    });

    // Create minimum number of connections
    for (let i = 0; i < this.config.minSize; i++) {
      await this.createConnection();
    }

    // Start health check timer
    this.startHealthCheck();

    metrics.setActiveConnections(this.availableConnections.length);
  }

  private async createConnection(
    options: ConnectionManagerOptions = {},
  ): Promise<ConnectionManager> {
    if (this.connections.size >= this.config.maxSize) {
      throw new Error('Connection pool maximum size reached');
    }

    const connection = new ConnectionManager(options);

    // Set up event handlers
    connection.on('error', (error) => {
      logger.error('Connection error in pool', {
        correlationId: logger.generateCorrelationId(),
        clientId: connection.getConnectionInfo().clientId,
        error: error.message,
      });
      this.handleConnectionError(connection);
    });

    connection.on('close', () => {
      this.handleConnectionClose(connection);
    });

    connection.on('offline', () => {
      this.handleConnectionOffline(connection);
    });

    try {
      await connection.connect();
      const clientId = connection.getConnectionInfo().clientId;
      this.connections.set(clientId, connection);
      this.availableConnections.push(clientId);

      logger.info('Connection added to pool', {
        correlationId: logger.generateCorrelationId(),
        clientId,
        poolSize: this.connections.size,
      });

      metrics.setActiveConnections(this.availableConnections.length);

      return connection;
    } catch (error) {
      logger.error('Failed to create connection', {
        correlationId: logger.generateCorrelationId(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async acquire(options: ConnectionManagerOptions = {}): Promise<ConnectionManager> {
    // Try to get an available connection
    if (this.availableConnections.length > 0) {
      // Load balancing: round-robin through cluster nodes
      const clientId = this.getNextAvailableConnection();
      const connection = this.connections.get(clientId);

      if (connection && connection.isConnected()) {
        this.availableConnections = this.availableConnections.filter((id) => id !== clientId);
        this.busyConnections.add(clientId);

        logger.debug('Connection acquired from pool', {
          correlationId: logger.generateCorrelationId(),
          clientId,
          available: this.availableConnections.length,
          busy: this.busyConnections.size,
        });

        metrics.setActiveConnections(this.availableConnections.length);

        return connection;
      }
    }

    // If no available connections and pool not at max, create new connection
    if (this.connections.size < this.config.maxSize) {
      const connection = await this.createConnection(options);
      const clientId = connection.getConnectionInfo().clientId;
      this.availableConnections = this.availableConnections.filter((id) => id !== clientId);
      this.busyConnections.add(clientId);

      metrics.setActiveConnections(this.availableConnections.length);

      return connection;
    }

    // Wait for a connection to become available
    return this.waitForConnection();
  }

  private getNextAvailableConnection(): string {
    if (this.clusterNodes.length > 0) {
      // Round-robin across cluster nodes
      this.nodeIndex = (this.nodeIndex + 1) % this.availableConnections.length;
      return this.availableConnections[this.nodeIndex];
    }

    // Simple FIFO
    return this.availableConnections[0];
  }

  private async waitForConnection(): Promise<ConnectionManager> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for available connection'));
      }, 30000);

      const checkAvailability = setInterval(() => {
        if (this.availableConnections.length > 0) {
          clearInterval(checkAvailability);
          clearTimeout(timeout);

          this.acquire()
            .then(resolve)
            .catch(reject);
        }
      }, 100);
    });
  }

  release(connection: ConnectionManager): void {
    const clientId = connection.getConnectionInfo().clientId;

    if (this.busyConnections.has(clientId)) {
      this.busyConnections.delete(clientId);
      this.availableConnections.push(clientId);

      logger.debug('Connection released to pool', {
        correlationId: logger.generateCorrelationId(),
        clientId,
        available: this.availableConnections.length,
        busy: this.busyConnections.size,
      });

      metrics.setActiveConnections(this.availableConnections.length);

      this.emit('connection-released', clientId);
    }
  }

  private handleConnectionError(connection: ConnectionManager): void {
    const clientId = connection.getConnectionInfo().clientId;

    logger.warn('Handling connection error', {
      correlationId: logger.generateCorrelationId(),
      clientId,
    });

    // Remove from available connections
    this.availableConnections = this.availableConnections.filter((id) => id !== clientId);
    this.busyConnections.delete(clientId);

    metrics.setActiveConnections(this.availableConnections.length);
  }

  private handleConnectionClose(connection: ConnectionManager): void {
    const clientId = connection.getConnectionInfo().clientId;

    logger.info('Connection closed in pool', {
      correlationId: logger.generateCorrelationId(),
      clientId,
    });

    this.connections.delete(clientId);
    this.availableConnections = this.availableConnections.filter((id) => id !== clientId);
    this.busyConnections.delete(clientId);

    metrics.setActiveConnections(this.availableConnections.length);

    // Maintain minimum pool size
    if (this.connections.size < this.config.minSize) {
      this.createConnection().catch((error) => {
        logger.error('Failed to maintain minimum pool size', {
          correlationId: logger.generateCorrelationId(),
          error: error.message,
        });
      });
    }
  }

  private handleConnectionOffline(connection: ConnectionManager): void {
    const clientId = connection.getConnectionInfo().clientId;

    logger.warn('Connection offline in pool', {
      correlationId: logger.generateCorrelationId(),
      clientId,
    });

    // Remove from available but keep in pool for reconnection
    this.availableConnections = this.availableConnections.filter((id) => id !== clientId);

    metrics.setActiveConnections(this.availableConnections.length);
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);
  }

  private async performHealthCheck(): Promise<void> {
    logger.debug('Performing connection pool health check', {
      correlationId: logger.generateCorrelationId(),
      totalConnections: this.connections.size,
      available: this.availableConnections.length,
      busy: this.busyConnections.size,
    });

    const healthyConnections: string[] = [];
    const unhealthyConnections: string[] = [];

    for (const [clientId, connection] of this.connections.entries()) {
      if (connection.isConnected()) {
        healthyConnections.push(clientId);
      } else {
        unhealthyConnections.push(clientId);
      }
    }

    // Remove unhealthy connections
    for (const clientId of unhealthyConnections) {
      const connection = this.connections.get(clientId);
      if (connection) {
        await connection.disconnect();
        this.connections.delete(clientId);
      }
    }

    // Maintain minimum pool size
    const deficit = this.config.minSize - this.connections.size;
    if (deficit > 0) {
      logger.info('Replenishing connection pool', {
        correlationId: logger.generateCorrelationId(),
        deficit,
      });

      for (let i = 0; i < deficit; i++) {
        try {
          await this.createConnection();
        } catch (error) {
          logger.error('Failed to replenish connection pool', {
            correlationId: logger.generateCorrelationId(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    this.emit('health-check-complete', this.getHealthStatus());
  }

  getHealthStatus(): HealthStatus {
    const totalConnections = this.connections.size;
    const activeConnections = this.availableConnections.length;
    const errorRate =
      totalConnections > 0 ? (totalConnections - activeConnections) / totalConnections : 0;

    return {
      healthy: activeConnections >= this.config.minSize && errorRate < 0.5,
      connections: totalConnections,
      activeConnections,
      messagesPerSecond: 0, // Would need to track over time
      errorRate,
      lastHealthCheck: new Date(),
    };
  }

  async drain(): Promise<void> {
    logger.info('Draining connection pool', {
      correlationId: logger.generateCorrelationId(),
      connections: this.connections.size,
    });

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    const disconnectPromises: Promise<void>[] = [];

    for (const connection of this.connections.values()) {
      disconnectPromises.push(connection.disconnect());
    }

    await Promise.all(disconnectPromises);

    this.connections.clear();
    this.availableConnections = [];
    this.busyConnections.clear();

    metrics.setActiveConnections(0);

    logger.info('Connection pool drained', {
      correlationId: logger.generateCorrelationId(),
    });
  }

  getPoolSize(): number {
    return this.connections.size;
  }

  getAvailableCount(): number {
    return this.availableConnections.length;
  }

  getBusyCount(): number {
    return this.busyConnections.size;
  }
}

export default ConnectionPool.getInstance();
