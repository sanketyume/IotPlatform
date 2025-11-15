import dotenv from 'dotenv';
import Joi from 'joi';
import fs from 'fs';
import path from 'path';
import {
  MQTTConfig,
  TLSConfig,
  RateLimitConfig,
  CircuitBreakerConfig,
  StorageConfig,
  MQTTProtocolVersion,
} from '../types';

dotenv.config();

const configSchema = Joi.object({
  mqtt: Joi.object({
    brokerType: Joi.string().valid('mosquitto', 'emqx').required(),
    brokerUrl: Joi.string().uri().required(),
    brokerWsUrl: Joi.string().uri().optional(),
    protocolVersion: Joi.number().valid(4, 5).required(),
    clientIdPrefix: Joi.string().required(),
    username: Joi.string().optional(),
    password: Joi.string().optional(),
    keepalive: Joi.number().min(10).max(300).default(60),
    reconnectPeriod: Joi.number().min(1000).default(5000),
    connectTimeout: Joi.number().min(5000).default(30000),
    maxReconnectAttempts: Joi.number().min(0).default(10),
    cleanSession: Joi.boolean().default(false),
    sessionExpiryInterval: Joi.number().min(0).optional(),
    defaultQos: Joi.number().valid(0, 1, 2).default(1),
    maxQos: Joi.number().valid(0, 1, 2).default(2),
    tlsEnabled: Joi.boolean().default(false),
    tlsConfig: Joi.when('tlsEnabled', {
      is: true,
      then: Joi.object({
        caPath: Joi.string().required(),
        certPath: Joi.string().required(),
        keyPath: Joi.string().required(),
        rejectUnauthorized: Joi.boolean().default(true),
      }),
    }),
    clustering: Joi.object({
      enabled: Joi.boolean().default(false),
      nodes: Joi.array().items(Joi.string()).min(1),
    }).optional(),
  }).required(),
  rateLimit: Joi.object({
    enabled: Joi.boolean().default(true),
    messagesPerSecond: Joi.number().min(1).default(100),
    burstSize: Joi.number().min(1).default(200),
    payloadMaxSize: Joi.number().min(1024).default(1048576),
    connectionsPerTenant: Joi.number().min(1).default(1000),
  }).required(),
  circuitBreaker: Joi.object({
    enabled: Joi.boolean().default(true),
    failureThreshold: Joi.number().min(1).default(5),
    resetTimeout: Joi.number().min(1000).default(60000),
    halfOpenMaxCalls: Joi.number().min(1).default(3),
  }).required(),
  storage: Joi.object({
    hot: Joi.object({
      enabled: Joi.boolean().default(true),
      type: Joi.string().default('redis'),
      url: Joi.string().uri().required(),
    }),
    cold: Joi.object({
      enabled: Joi.boolean().default(true),
      type: Joi.string().default('mongodb'),
      url: Joi.string().uri().required(),
    }),
  }).required(),
  logging: Joi.object({
    level: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
    format: Joi.string().valid('json', 'simple').default('json'),
    correlationIdEnabled: Joi.boolean().default(true),
    outputDir: Joi.string().default('./logs'),
  }).required(),
  metrics: Joi.object({
    enabled: Joi.boolean().default(true),
    port: Joi.number().min(1024).max(65535).default(9090),
    collectionInterval: Joi.number().min(1000).default(10000),
  }).required(),
  backpressure: Joi.object({
    enabled: Joi.boolean().default(true),
    highWatermark: Joi.number().min(100).default(10000),
    lowWatermark: Joi.number().min(10).default(5000),
  }).required(),
});

function loadTLSConfig(tlsConfig: {
  caPath: string;
  certPath: string;
  keyPath: string;
  rejectUnauthorized: boolean;
}): TLSConfig {
  return {
    ca: fs.readFileSync(path.resolve(tlsConfig.caPath)),
    cert: fs.readFileSync(path.resolve(tlsConfig.certPath)),
    key: fs.readFileSync(path.resolve(tlsConfig.keyPath)),
    rejectUnauthorized: tlsConfig.rejectUnauthorized,
  };
}

export class ConfigLoader {
  private static instance: ConfigLoader;
  private config: any;

  private constructor() {
    this.loadConfig();
  }

  static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  private loadConfig(): void {
    const rawConfig = {
      mqtt: {
        brokerType: process.env.MQTT_BROKER_TYPE || 'mosquitto',
        brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
        brokerWsUrl: process.env.MQTT_BROKER_WS_URL,
        protocolVersion: parseInt(process.env.MQTT_PROTOCOL_VERSION || '5'),
        clientIdPrefix: process.env.MQTT_CLIENT_ID_PREFIX || 'iot-platform',
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        keepalive: parseInt(process.env.MQTT_KEEPALIVE || '60'),
        reconnectPeriod: parseInt(process.env.MQTT_RECONNECT_PERIOD || '5000'),
        connectTimeout: parseInt(process.env.MQTT_CONNECT_TIMEOUT || '30000'),
        maxReconnectAttempts: parseInt(process.env.MQTT_MAX_RECONNECT_ATTEMPTS || '10'),
        cleanSession: process.env.MQTT_CLEAN_SESSION === 'true',
        sessionExpiryInterval: process.env.MQTT_SESSION_EXPIRY_INTERVAL
          ? parseInt(process.env.MQTT_SESSION_EXPIRY_INTERVAL)
          : undefined,
        defaultQos: parseInt(process.env.MQTT_DEFAULT_QOS || '1'),
        maxQos: parseInt(process.env.MQTT_MAX_QOS || '2'),
        tlsEnabled: process.env.MQTT_TLS_ENABLED === 'true',
        tlsConfig:
          process.env.MQTT_TLS_ENABLED === 'true'
            ? {
                caPath: process.env.MQTT_TLS_CA_PATH || './certs/ca.crt',
                certPath: process.env.MQTT_TLS_CERT_PATH || './certs/client.crt',
                keyPath: process.env.MQTT_TLS_KEY_PATH || './certs/client.key',
                rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
              }
            : undefined,
        clustering: {
          enabled: process.env.MQTT_CLUSTER_ENABLED === 'true',
          nodes: process.env.MQTT_CLUSTER_NODES?.split(',') || [],
        },
      },
      rateLimit: {
        enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
        messagesPerSecond: parseInt(process.env.RATE_LIMIT_MESSAGES_PER_SECOND || '100'),
        burstSize: parseInt(process.env.RATE_LIMIT_BURST_SIZE || '200'),
        payloadMaxSize: parseInt(process.env.RATE_LIMIT_PAYLOAD_MAX_SIZE || '1048576'),
        connectionsPerTenant: parseInt(process.env.RATE_LIMIT_CONNECTIONS_PER_TENANT || '1000'),
      },
      circuitBreaker: {
        enabled: process.env.CIRCUIT_BREAKER_ENABLED !== 'false',
        failureThreshold: parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5'),
        resetTimeout: parseInt(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT || '60000'),
        halfOpenMaxCalls: parseInt(process.env.CIRCUIT_BREAKER_HALF_OPEN_MAX_CALLS || '3'),
      },
      storage: {
        hot: {
          enabled: process.env.STORAGE_HOT_ENABLED !== 'false',
          type: process.env.STORAGE_HOT_TYPE || 'redis',
          url: process.env.STORAGE_HOT_URL || 'redis://localhost:6379',
        },
        cold: {
          enabled: process.env.STORAGE_COLD_ENABLED !== 'false',
          type: process.env.STORAGE_COLD_TYPE || 'mongodb',
          url: process.env.STORAGE_COLD_URL || 'mongodb://localhost:27017/iot-platform',
        },
      },
      logging: {
        level: process.env.LOG_LEVEL || 'info',
        format: process.env.LOG_FORMAT || 'json',
        correlationIdEnabled: process.env.LOG_CORRELATION_ID_ENABLED !== 'false',
        outputDir: process.env.LOG_OUTPUT_DIR || './logs',
      },
      metrics: {
        enabled: process.env.METRICS_ENABLED !== 'false',
        port: parseInt(process.env.METRICS_PORT || '9090'),
        collectionInterval: parseInt(process.env.METRICS_COLLECTION_INTERVAL || '10000'),
      },
      backpressure: {
        enabled: process.env.BACKPRESSURE_ENABLED !== 'false',
        highWatermark: parseInt(process.env.BACKPRESSURE_HIGH_WATERMARK || '10000'),
        lowWatermark: parseInt(process.env.BACKPRESSURE_LOW_WATERMARK || '5000'),
      },
    };

    const { error, value } = configSchema.validate(rawConfig, { abortEarly: false });

    if (error) {
      throw new Error(`Configuration validation error: ${error.message}`);
    }

    this.config = value;
  }

  getMQTTConfig(): MQTTConfig {
    const mqttConfig = { ...this.config.mqtt };

    if (mqttConfig.tlsEnabled && mqttConfig.tlsConfig) {
      mqttConfig.tlsConfig = loadTLSConfig(mqttConfig.tlsConfig);
    }

    return mqttConfig;
  }

  getRateLimitConfig(): RateLimitConfig {
    return this.config.rateLimit;
  }

  getCircuitBreakerConfig(): CircuitBreakerConfig {
    return this.config.circuitBreaker;
  }

  getStorageConfig(): StorageConfig {
    return this.config.storage;
  }

  getLoggingConfig() {
    return this.config.logging;
  }

  getMetricsConfig() {
    return this.config.metrics;
  }

  getBackpressureConfig() {
    return this.config.backpressure;
  }

  getAll() {
    return this.config;
  }
}

export default ConfigLoader.getInstance();
