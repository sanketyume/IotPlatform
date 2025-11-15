import { IClientOptions, QoS } from 'mqtt';

export enum MessageFormat {
  JSON = 'json',
  BINARY = 'binary',
  PROTOBUF = 'protobuf',
}

export enum StorageType {
  HOT = 'hot',
  COLD = 'cold',
}

export enum MQTTProtocolVersion {
  V3_1_1 = 4,
  V5 = 5,
}

export interface MQTTConfig {
  brokerType: 'mosquitto' | 'emqx';
  brokerUrl: string;
  brokerWsUrl?: string;
  protocolVersion: MQTTProtocolVersion;
  clientIdPrefix: string;
  username?: string;
  password?: string;
  keepalive: number;
  reconnectPeriod: number;
  connectTimeout: number;
  maxReconnectAttempts: number;
  cleanSession: boolean;
  sessionExpiryInterval?: number;
  defaultQos: QoS;
  maxQos: QoS;
  tlsEnabled: boolean;
  tlsConfig?: TLSConfig;
  clustering?: ClusterConfig;
}

export interface TLSConfig {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  rejectUnauthorized: boolean;
}

export interface ClusterConfig {
  enabled: boolean;
  nodes: string[];
}

export interface RateLimitConfig {
  enabled: boolean;
  messagesPerSecond: number;
  burstSize: number;
  payloadMaxSize: number;
  connectionsPerTenant: number;
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number;
  resetTimeout: number;
  halfOpenMaxCalls: number;
}

export interface StorageConfig {
  hot: {
    enabled: boolean;
    type: string;
    url: string;
  };
  cold: {
    enabled: boolean;
    type: string;
    url: string;
  };
}

export interface MQTTMessage {
  topic: string;
  payload: Buffer | string;
  qos: QoS;
  retain: boolean;
  dup?: boolean;
  properties?: MessageProperties;
  timestamp: Date;
  correlationId: string;
}

export interface MessageProperties {
  messageExpiryInterval?: number;
  contentType?: string;
  responseTopic?: string;
  correlationData?: Buffer;
  userProperties?: Record<string, string>;
}

export interface ParsedMessage<T = unknown> {
  format: MessageFormat;
  data: T;
  metadata: MessageMetadata;
}

export interface MessageMetadata {
  deviceId: string;
  tenantId: string;
  topic: string;
  qos: QoS;
  timestamp: Date;
  correlationId: string;
  size: number;
}

export interface DeviceProfile {
  deviceId: string;
  tenantId: string;
  deviceType: string;
  schema?: Record<string, unknown>;
  transformTemplate?: Record<string, unknown>;
  topics: string[];
  qos: QoS;
  rateLimits?: {
    messagesPerSecond: number;
    payloadMaxSize: number;
  };
}

export interface ConnectionInfo {
  clientId: string;
  connected: boolean;
  reconnecting: boolean;
  lastConnectedAt?: Date;
  lastDisconnectedAt?: Date;
  reconnectAttempts: number;
  messagesReceived: number;
  messagesSent: number;
}

export interface HealthStatus {
  healthy: boolean;
  connections: number;
  activeConnections: number;
  messagesPerSecond: number;
  errorRate: number;
  lastHealthCheck: Date;
}

export interface ACLRule {
  topic: string;
  permission: 'read' | 'write' | 'readwrite';
  tenantId?: string;
  deviceId?: string;
}

export interface Metrics {
  messagesReceived: number;
  messagesSent: number;
  messagesDropped: number;
  connectionsActive: number;
  connectionsTotal: number;
  errorsTotal: number;
  latencyMs: number;
  throughputBytesPerSecond: number;
}

export interface BackpressureStatus {
  enabled: boolean;
  currentLevel: number;
  highWatermark: number;
  lowWatermark: number;
  dropping: boolean;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogContext {
  correlationId: string;
  tenantId?: string;
  deviceId?: string;
  topic?: string;
  [key: string]: unknown;
}
