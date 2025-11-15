import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import express from 'express';
import config from '../config';
import logger from './logger';
import { Metrics } from '../types';

class MetricsCollector {
  private static instance: MetricsCollector;
  private registry: Registry;
  private server?: express.Application;
  private metricsConfig: any;

  // Counters
  private messagesReceivedCounter: Counter;
  private messagesSentCounter: Counter;
  private messagesDroppedCounter: Counter;
  private errorsCounter: Counter;
  private connectionsCounter: Counter;

  // Gauges
  private activeConnectionsGauge: Gauge;
  private backpressureLevelGauge: Gauge;

  // Histograms
  private messageLatencyHistogram: Histogram;
  private messageSizeHistogram: Histogram;
  private processingDurationHistogram: Histogram;

  private constructor() {
    this.metricsConfig = config.getMetricsConfig();
    this.registry = new Registry();

    // Initialize counters
    this.messagesReceivedCounter = new Counter({
      name: 'mqtt_messages_received_total',
      help: 'Total number of MQTT messages received',
      labelNames: ['tenant_id', 'device_id', 'topic', 'qos'],
      registers: [this.registry],
    });

    this.messagesSentCounter = new Counter({
      name: 'mqtt_messages_sent_total',
      help: 'Total number of MQTT messages sent',
      labelNames: ['tenant_id', 'device_id', 'topic', 'qos'],
      registers: [this.registry],
    });

    this.messagesDroppedCounter = new Counter({
      name: 'mqtt_messages_dropped_total',
      help: 'Total number of MQTT messages dropped',
      labelNames: ['tenant_id', 'reason'],
      registers: [this.registry],
    });

    this.errorsCounter = new Counter({
      name: 'mqtt_errors_total',
      help: 'Total number of errors',
      labelNames: ['type', 'tenant_id'],
      registers: [this.registry],
    });

    this.connectionsCounter = new Counter({
      name: 'mqtt_connections_total',
      help: 'Total number of connection attempts',
      labelNames: ['status'],
      registers: [this.registry],
    });

    // Initialize gauges
    this.activeConnectionsGauge = new Gauge({
      name: 'mqtt_active_connections',
      help: 'Number of active MQTT connections',
      registers: [this.registry],
    });

    this.backpressureLevelGauge = new Gauge({
      name: 'mqtt_backpressure_level',
      help: 'Current backpressure level',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    // Initialize histograms
    this.messageLatencyHistogram = new Histogram({
      name: 'mqtt_message_latency_ms',
      help: 'Message processing latency in milliseconds',
      labelNames: ['tenant_id', 'device_id'],
      buckets: [1, 5, 10, 50, 100, 500, 1000, 5000],
      registers: [this.registry],
    });

    this.messageSizeHistogram = new Histogram({
      name: 'mqtt_message_size_bytes',
      help: 'Message payload size in bytes',
      labelNames: ['tenant_id', 'format'],
      buckets: [100, 1000, 10000, 100000, 1000000],
      registers: [this.registry],
    });

    this.processingDurationHistogram = new Histogram({
      name: 'mqtt_processing_duration_ms',
      help: 'Message processing duration in milliseconds',
      labelNames: ['stage', 'tenant_id'],
      buckets: [1, 5, 10, 50, 100, 500, 1000],
      registers: [this.registry],
    });

    if (this.metricsConfig.enabled) {
      this.startMetricsServer();
    }
  }

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  private startMetricsServer(): void {
    this.server = express();

    this.server.get('/metrics', async (req, res) => {
      res.set('Content-Type', this.registry.contentType);
      res.end(await this.registry.metrics());
    });

    this.server.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    this.server.listen(this.metricsConfig.port, () => {
      logger.info(`Metrics server started on port ${this.metricsConfig.port}`);
    });
  }

  incrementMessagesReceived(labels: {
    tenant_id: string;
    device_id: string;
    topic: string;
    qos: number;
  }): void {
    this.messagesReceivedCounter.inc(labels);
  }

  incrementMessagesSent(labels: {
    tenant_id: string;
    device_id: string;
    topic: string;
    qos: number;
  }): void {
    this.messagesSentCounter.inc(labels);
  }

  incrementMessagesDropped(labels: { tenant_id: string; reason: string }): void {
    this.messagesDroppedCounter.inc(labels);
  }

  incrementErrors(labels: { type: string; tenant_id: string }): void {
    this.errorsCounter.inc(labels);
  }

  incrementConnections(status: 'success' | 'failure'): void {
    this.connectionsCounter.inc({ status });
  }

  setActiveConnections(count: number): void {
    this.activeConnectionsGauge.set(count);
  }

  setBackpressureLevel(tenantId: string, level: number): void {
    this.backpressureLevelGauge.set({ tenant_id: tenantId }, level);
  }

  observeMessageLatency(
    labels: { tenant_id: string; device_id: string },
    latencyMs: number,
  ): void {
    this.messageLatencyHistogram.observe(labels, latencyMs);
  }

  observeMessageSize(labels: { tenant_id: string; format: string }, sizeBytes: number): void {
    this.messageSizeHistogram.observe(labels, sizeBytes);
  }

  observeProcessingDuration(
    labels: { stage: string; tenant_id: string },
    durationMs: number,
  ): void {
    this.processingDurationHistogram.observe(labels, durationMs);
  }

  async getMetrics(): Promise<Metrics> {
    const metrics = await this.registry.getMetricsAsJSON();

    const getMetricValue = (name: string): number => {
      const metric = metrics.find((m) => m.name === name);
      if (!metric || !metric.values || metric.values.length === 0) return 0;
      return metric.values[0].value as number;
    };

    return {
      messagesReceived: getMetricValue('mqtt_messages_received_total'),
      messagesSent: getMetricValue('mqtt_messages_sent_total'),
      messagesDropped: getMetricValue('mqtt_messages_dropped_total'),
      connectionsActive: getMetricValue('mqtt_active_connections'),
      connectionsTotal: getMetricValue('mqtt_connections_total'),
      errorsTotal: getMetricValue('mqtt_errors_total'),
      latencyMs: 0, // Average would require calculation
      throughputBytesPerSecond: 0, // Would require time-based calculation
    };
  }

  getRegistry(): Registry {
    return this.registry;
  }
}

export default MetricsCollector.getInstance();
