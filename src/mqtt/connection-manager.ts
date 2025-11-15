import mqtt, { IClientOptions, MqttClient, QoS } from 'mqtt';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import logger from '../utils/logger';
import metrics from '../utils/metrics';
import circuitBreaker from '../utils/circuit-breaker';
import { MQTTConfig, ConnectionInfo, MQTTMessage } from '../types';

export interface ConnectionManagerOptions {
  clientId?: string;
  tenantId?: string;
  deviceId?: string;
}

export class ConnectionManager extends EventEmitter {
  private client: MqttClient | null = null;
  private mqttConfig: MQTTConfig;
  private connectionInfo: ConnectionInfo;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tenantId?: string;
  private deviceId?: string;
  private subscriptions: Map<string, QoS> = new Map();

  constructor(options: ConnectionManagerOptions = {}) {
    super();
    this.mqttConfig = config.getMQTTConfig();
    this.tenantId = options.tenantId;
    this.deviceId = options.deviceId;

    const clientId = options.clientId || `${this.mqttConfig.clientIdPrefix}-${uuidv4()}`;

    this.connectionInfo = {
      clientId,
      connected: false,
      reconnecting: false,
      reconnectAttempts: 0,
      messagesReceived: 0,
      messagesSent: 0,
    };
  }

  async connect(): Promise<void> {
    return circuitBreaker.execute('mqtt-connection', async () => {
      const options = this.buildConnectionOptions();

      logger.info('Attempting MQTT connection', {
        correlationId: logger.generateCorrelationId(),
        clientId: this.connectionInfo.clientId,
        broker: this.mqttConfig.brokerUrl,
        tenantId: this.tenantId,
      });

      return new Promise((resolve, reject) => {
        this.client = mqtt.connect(this.mqttConfig.brokerUrl, options);

        this.client.on('connect', () => {
          this.handleConnect();
          resolve();
        });

        this.client.on('error', (error) => {
          this.handleError(error);
          if (!this.connectionInfo.connected) {
            reject(error);
          }
        });

        this.client.on('message', (topic, payload, packet) => {
          this.handleMessage(topic, payload, packet);
        });

        this.client.on('close', () => {
          this.handleClose();
        });

        this.client.on('offline', () => {
          this.handleOffline();
        });

        this.client.on('reconnect', () => {
          this.handleReconnect();
        });

        this.client.on('disconnect', (packet) => {
          this.handleDisconnect(packet);
        });
      });
    });
  }

  private buildConnectionOptions(): IClientOptions {
    const options: IClientOptions = {
      clientId: this.connectionInfo.clientId,
      protocolVersion: this.mqttConfig.protocolVersion,
      keepalive: this.mqttConfig.keepalive,
      reconnectPeriod: this.mqttConfig.reconnectPeriod,
      connectTimeout: this.mqttConfig.connectTimeout,
      clean: this.mqttConfig.cleanSession,
      username: this.mqttConfig.username,
      password: this.mqttConfig.password,
    };

    // Add protocol version specific options
    if (this.mqttConfig.protocolVersion === 5) {
      options.properties = {
        sessionExpiryInterval: this.mqttConfig.sessionExpiryInterval,
      };
    }

    // Add TLS configuration
    if (this.mqttConfig.tlsEnabled && this.mqttConfig.tlsConfig) {
      options.ca = this.mqttConfig.tlsConfig.ca;
      options.cert = this.mqttConfig.tlsConfig.cert;
      options.key = this.mqttConfig.tlsConfig.key;
      options.rejectUnauthorized = this.mqttConfig.tlsConfig.rejectUnauthorized;
    }

    return options;
  }

  private handleConnect(): void {
    this.connectionInfo.connected = true;
    this.connectionInfo.reconnecting = false;
    this.connectionInfo.lastConnectedAt = new Date();
    this.reconnectAttempts = 0;

    metrics.incrementConnections('success');

    logger.info('MQTT connection established', {
      correlationId: logger.generateCorrelationId(),
      clientId: this.connectionInfo.clientId,
      tenantId: this.tenantId,
    });

    // Resubscribe to topics after reconnection
    this.resubscribe();

    this.emit('connected', this.connectionInfo);
  }

  private handleError(error: Error): void {
    logger.error('MQTT connection error', {
      correlationId: logger.generateCorrelationId(),
      clientId: this.connectionInfo.clientId,
      tenantId: this.tenantId,
      error: error.message,
    });

    metrics.incrementErrors({
      type: 'connection',
      tenant_id: this.tenantId || 'unknown',
    });

    this.emit('error', error);
  }

  private handleMessage(topic: string, payload: Buffer, packet: any): void {
    this.connectionInfo.messagesReceived++;

    const message: MQTTMessage = {
      topic,
      payload,
      qos: packet.qos,
      retain: packet.retain,
      dup: packet.dup,
      timestamp: new Date(),
      correlationId: uuidv4(),
    };

    if (this.mqttConfig.protocolVersion === 5 && packet.properties) {
      message.properties = {
        messageExpiryInterval: packet.properties.messageExpiryInterval,
        contentType: packet.properties.contentType,
        responseTopic: packet.properties.responseTopic,
        correlationData: packet.properties.correlationData,
        userProperties: packet.properties.userProperties,
      };
    }

    logger.debug('Message received', {
      correlationId: message.correlationId,
      topic,
      qos: packet.qos,
      tenantId: this.tenantId,
      deviceId: this.deviceId,
      size: payload.length,
    });

    if (this.tenantId && this.deviceId) {
      metrics.incrementMessagesReceived({
        tenant_id: this.tenantId,
        device_id: this.deviceId,
        topic,
        qos: packet.qos,
      });
    }

    this.emit('message', message);
  }

  private handleClose(): void {
    this.connectionInfo.connected = false;
    this.connectionInfo.lastDisconnectedAt = new Date();

    logger.info('MQTT connection closed', {
      correlationId: logger.generateCorrelationId(),
      clientId: this.connectionInfo.clientId,
      tenantId: this.tenantId,
    });

    this.emit('close');
  }

  private handleOffline(): void {
    this.connectionInfo.connected = false;

    logger.warn('MQTT client offline', {
      correlationId: logger.generateCorrelationId(),
      clientId: this.connectionInfo.clientId,
      tenantId: this.tenantId,
    });

    this.emit('offline');
  }

  private handleReconnect(): void {
    this.connectionInfo.reconnecting = true;
    this.reconnectAttempts++;
    this.connectionInfo.reconnectAttempts = this.reconnectAttempts;

    logger.info('MQTT reconnection attempt', {
      correlationId: logger.generateCorrelationId(),
      clientId: this.connectionInfo.clientId,
      tenantId: this.tenantId,
      attempt: this.reconnectAttempts,
      maxAttempts: this.mqttConfig.maxReconnectAttempts,
    });

    if (
      this.mqttConfig.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.mqttConfig.maxReconnectAttempts
    ) {
      logger.error('Max reconnection attempts reached', {
        correlationId: logger.generateCorrelationId(),
        clientId: this.connectionInfo.clientId,
        tenantId: this.tenantId,
      });

      this.disconnect();
    }

    this.emit('reconnecting', this.reconnectAttempts);
  }

  private handleDisconnect(packet: any): void {
    logger.info('MQTT client disconnected', {
      correlationId: logger.generateCorrelationId(),
      clientId: this.connectionInfo.clientId,
      tenantId: this.tenantId,
      reasonCode: packet?.reasonCode,
    });

    this.emit('disconnect', packet);
  }

  async subscribe(topic: string | string[], qos: QoS = this.mqttConfig.defaultQos): Promise<void> {
    if (!this.client || !this.connectionInfo.connected) {
      throw new Error('MQTT client not connected');
    }

    const topics = Array.isArray(topic) ? topic : [topic];

    return new Promise((resolve, reject) => {
      this.client!.subscribe(topics, { qos }, (error, granted) => {
        if (error) {
          logger.error('Subscription failed', {
            correlationId: logger.generateCorrelationId(),
            topics,
            error: error.message,
            tenantId: this.tenantId,
          });
          reject(error);
          return;
        }

        granted.forEach((g) => {
          this.subscriptions.set(g.topic, g.qos);
        });

        logger.info('Subscribed to topics', {
          correlationId: logger.generateCorrelationId(),
          topics: granted.map((g) => ({ topic: g.topic, qos: g.qos })),
          tenantId: this.tenantId,
        });

        resolve();
      });
    });
  }

  async unsubscribe(topic: string | string[]): Promise<void> {
    if (!this.client || !this.connectionInfo.connected) {
      throw new Error('MQTT client not connected');
    }

    const topics = Array.isArray(topic) ? topic : [topic];

    return new Promise((resolve, reject) => {
      this.client!.unsubscribe(topics, (error) => {
        if (error) {
          logger.error('Unsubscribe failed', {
            correlationId: logger.generateCorrelationId(),
            topics,
            error: error.message,
            tenantId: this.tenantId,
          });
          reject(error);
          return;
        }

        topics.forEach((t) => {
          this.subscriptions.delete(t);
        });

        logger.info('Unsubscribed from topics', {
          correlationId: logger.generateCorrelationId(),
          topics,
          tenantId: this.tenantId,
        });

        resolve();
      });
    });
  }

  private async resubscribe(): Promise<void> {
    if (this.subscriptions.size === 0) {
      return;
    }

    const topicsArray = Array.from(this.subscriptions.entries()).map(([topic, qos]) => ({
      topic,
      qos,
    }));

    for (const { topic, qos } of topicsArray) {
      try {
        await this.subscribe(topic, qos);
      } catch (error) {
        logger.error('Resubscription failed', {
          correlationId: logger.generateCorrelationId(),
          topic,
          error: error instanceof Error ? error.message : String(error),
          tenantId: this.tenantId,
        });
      }
    }
  }

  async publish(
    topic: string,
    payload: string | Buffer,
    options: { qos?: QoS; retain?: boolean } = {},
  ): Promise<void> {
    if (!this.client || !this.connectionInfo.connected) {
      throw new Error('MQTT client not connected');
    }

    const qos = options.qos ?? this.mqttConfig.defaultQos;
    const retain = options.retain ?? false;

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, payload, { qos, retain }, (error) => {
        if (error) {
          logger.error('Publish failed', {
            correlationId: logger.generateCorrelationId(),
            topic,
            error: error.message,
            tenantId: this.tenantId,
          });

          metrics.incrementErrors({
            type: 'publish',
            tenant_id: this.tenantId || 'unknown',
          });

          reject(error);
          return;
        }

        this.connectionInfo.messagesSent++;

        logger.debug('Message published', {
          correlationId: logger.generateCorrelationId(),
          topic,
          qos,
          retain,
          tenantId: this.tenantId,
          deviceId: this.deviceId,
        });

        if (this.tenantId && this.deviceId) {
          metrics.incrementMessagesSent({
            tenant_id: this.tenantId,
            device_id: this.deviceId,
            topic,
            qos,
          });
        }

        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    return new Promise((resolve) => {
      this.client!.end(false, {}, () => {
        this.connectionInfo.connected = false;
        this.connectionInfo.reconnecting = false;

        logger.info('MQTT client disconnected gracefully', {
          correlationId: logger.generateCorrelationId(),
          clientId: this.connectionInfo.clientId,
          tenantId: this.tenantId,
        });

        resolve();
      });
    });
  }

  getConnectionInfo(): ConnectionInfo {
    return { ...this.connectionInfo };
  }

  isConnected(): boolean {
    return this.connectionInfo.connected;
  }
}
