import express from 'express';
import { MQTTBrokerClient } from './mqtt/broker-client';
import logger from './utils/logger';
import config from './config';
import aclManager from './mqtt/acl-manager';
import dataPipeline from './pipeline/data-pipeline';
import { DeviceProfile, ACLRule } from './types';

// Export main components
export { MQTTBrokerClient } from './mqtt/broker-client';
export { ConnectionManager } from './mqtt/connection-manager';
export { ConnectionPool } from './mqtt/connection-pool';
export { DataPipeline } from './pipeline/data-pipeline';
export { ACLManager } from './mqtt/acl-manager';
export * from './types';

// Main application class
export class MQTTPlatform {
  private app: express.Application;
  private clients: Map<string, MQTTBrokerClient> = new Map();

  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging middleware
    this.app.use((req, res, next) => {
      const correlationId = logger.generateCorrelationId();
      req.headers['x-correlation-id'] = correlationId;

      logger.info('Incoming request', {
        correlationId,
        method: req.method,
        path: req.path,
        ip: req.ip,
      });

      next();
    });
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // Create MQTT client
    this.app.post('/api/clients', async (req, res) => {
      try {
        const { tenantId, deviceId } = req.body;

        if (!tenantId) {
          return res.status(400).json({ error: 'tenantId is required' });
        }

        const client = new MQTTBrokerClient({ tenantId, deviceId });
        await client.connect();

        const clientKey = `${tenantId}:${deviceId || 'default'}`;
        this.clients.set(clientKey, client);

        res.json({
          success: true,
          clientId: client.getConnectionInfo()?.clientId,
          tenantId,
          deviceId,
        });
      } catch (error) {
        logger.error('Failed to create client', {
          correlationId: req.headers['x-correlation-id'] as string,
          error: error instanceof Error ? error.message : String(error),
        });

        res.status(500).json({
          error: 'Failed to create MQTT client',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Subscribe to topic
    this.app.post('/api/clients/:tenantId/subscribe', async (req, res) => {
      try {
        const { tenantId } = req.params;
        const { deviceId, topic, qos } = req.body;

        const clientKey = `${tenantId}:${deviceId || 'default'}`;
        const client = this.clients.get(clientKey);

        if (!client) {
          return res.status(404).json({ error: 'Client not found' });
        }

        await client.subscribe(topic, qos || 1);

        res.json({ success: true, topic, qos });
      } catch (error) {
        res.status(500).json({
          error: 'Failed to subscribe',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Publish message
    this.app.post('/api/clients/:tenantId/publish', async (req, res) => {
      try {
        const { tenantId } = req.params;
        const { deviceId, topic, payload, qos, retain } = req.body;

        const clientKey = `${tenantId}:${deviceId || 'default'}`;
        const client = this.clients.get(clientKey);

        if (!client) {
          return res.status(404).json({ error: 'Client not found' });
        }

        await client.publish(topic, payload, { qos, retain });

        res.json({ success: true, topic });
      } catch (error) {
        res.status(500).json({
          error: 'Failed to publish',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Register device profile
    this.app.post('/api/devices/profiles', (req, res) => {
      try {
        const profile: DeviceProfile = req.body;

        if (!profile.tenantId || !profile.deviceId) {
          return res.status(400).json({ error: 'tenantId and deviceId are required' });
        }

        const clientKey = `${profile.tenantId}:${profile.deviceId}`;
        const client = this.clients.get(clientKey);

        if (client) {
          client.registerDeviceProfile(profile);
        } else {
          dataPipeline.registerDeviceProfile(profile);
        }

        res.json({ success: true, deviceId: profile.deviceId });
      } catch (error) {
        res.status(500).json({
          error: 'Failed to register device profile',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Add ACL rule
    this.app.post('/api/acl/rules', (req, res) => {
      try {
        const rule: ACLRule = req.body;

        if (!rule.topic || !rule.permission) {
          return res.status(400).json({ error: 'topic and permission are required' });
        }

        aclManager.addRule(rule);

        res.json({ success: true, rule });
      } catch (error) {
        res.status(500).json({
          error: 'Failed to add ACL rule',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Get metrics
    this.app.get('/api/metrics/summary', async (req, res) => {
      try {
        const metricsCollector = (await import('./utils/metrics')).default;
        const metrics = await metricsCollector.getMetrics();

        res.json(metrics);
      } catch (error) {
        res.status(500).json({
          error: 'Failed to get metrics',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async start(port: number = 3000): Promise<void> {
    const apiPort = port || parseInt(process.env.API_PORT || '3000');

    this.app.listen(apiPort, () => {
      logger.info(`IoT Platform API started on port ${apiPort}`, {
        correlationId: logger.generateCorrelationId(),
        port: apiPort,
      });
    });
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down IoT Platform', {
      correlationId: logger.generateCorrelationId(),
    });

    // Disconnect all clients
    const disconnectPromises: Promise<void>[] = [];

    for (const client of this.clients.values()) {
      disconnectPromises.push(client.disconnect());
    }

    await Promise.all(disconnectPromises);

    // Shutdown data pipeline
    await dataPipeline.shutdown();

    logger.info('IoT Platform shutdown complete', {
      correlationId: logger.generateCorrelationId(),
    });
  }
}

// CLI entry point
if (require.main === module) {
  const platform = new MQTTPlatform();

  platform.start().catch((error) => {
    logger.error('Failed to start platform', {
      correlationId: logger.generateCorrelationId(),
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully', {
      correlationId: logger.generateCorrelationId(),
    });
    await platform.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully', {
      correlationId: logger.generateCorrelationId(),
    });
    await platform.shutdown();
    process.exit(0);
  });
}
