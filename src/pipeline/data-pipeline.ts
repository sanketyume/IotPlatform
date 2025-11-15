import { EventEmitter } from 'events';
import logger from '../utils/logger';
import metrics from '../utils/metrics';
import rateLimiter from '../utils/rate-limiter';
import messageParser from './message-parser';
import messageValidator from './message-validator';
import messageTransformer from './message-transformer';
import messageRouter from './message-router';
import backpressureHandler from './backpressure-handler';
import {
  MQTTMessage,
  ParsedMessage,
  MessageMetadata,
  MessageFormat,
  DeviceProfile,
} from '../types';

export class DataPipeline extends EventEmitter {
  private static instance: DataPipeline;
  private deviceProfiles: Map<string, DeviceProfile> = new Map();
  private messageOrdering: Map<string, number> = new Map(); // Track message sequence per device

  private constructor() {
    super();
  }

  static getInstance(): DataPipeline {
    if (!DataPipeline.instance) {
      DataPipeline.instance = new DataPipeline();
    }
    return DataPipeline.instance;
  }

  async process(message: MQTTMessage, tenantId: string, deviceId: string): Promise<void> {
    const startTime = Date.now();
    const correlationId = message.correlationId || logger.generateCorrelationId();

    try {
      logger.info('Processing message', {
        correlationId,
        tenantId,
        deviceId,
        topic: message.topic,
        qos: message.qos,
      });

      // Stage 1: Rate Limiting
      const rateLimitStart = Date.now();
      if (!this.checkRateLimit(tenantId, deviceId, message, correlationId)) {
        return;
      }
      metrics.observeProcessingDuration(
        { stage: 'rate_limit', tenant_id: tenantId },
        Date.now() - rateLimitStart,
      );

      // Stage 2: Get Device Profile
      const deviceProfile = this.getDeviceProfile(tenantId, deviceId);
      if (!deviceProfile) {
        logger.warn('Device profile not found, using defaults', {
          correlationId,
          tenantId,
          deviceId,
        });
      }

      // Stage 3: Backpressure Check
      const backpressureStart = Date.now();
      const enqueued = await backpressureHandler.enqueue(tenantId, message);
      if (!enqueued) {
        logger.warn('Message dropped due to backpressure', {
          correlationId,
          tenantId,
          deviceId,
        });
        return;
      }
      metrics.observeProcessingDuration(
        { stage: 'backpressure', tenant_id: tenantId },
        Date.now() - backpressureStart,
      );

      // Stage 4: Parse Message
      const parseStart = Date.now();
      const metadata = this.createMetadata(message, tenantId, deviceId, correlationId);
      const format = this.detectMessageFormat(message, deviceProfile);
      const parsedMessage = await messageParser.parse(message, format, metadata);
      metrics.observeProcessingDuration(
        { stage: 'parse', tenant_id: tenantId },
        Date.now() - parseStart,
      );

      // Stage 5: Validate Message
      const validateStart = Date.now();
      if (deviceProfile) {
        const validation = await messageValidator.validate(parsedMessage, deviceProfile);
        if (!validation.valid) {
          logger.error('Message validation failed', {
            correlationId,
            tenantId,
            deviceId,
            errors: validation.errors,
          });

          this.emit('validation-failed', {
            message: parsedMessage,
            errors: validation.errors,
          });

          return;
        }
      }
      metrics.observeProcessingDuration(
        { stage: 'validate', tenant_id: tenantId },
        Date.now() - validateStart,
      );

      // Stage 6: Transform Message
      const transformStart = Date.now();
      const transformedMessage = deviceProfile
        ? await messageTransformer.transform(parsedMessage, deviceProfile)
        : parsedMessage;
      metrics.observeProcessingDuration(
        { stage: 'transform', tenant_id: tenantId },
        Date.now() - transformStart,
      );

      // Stage 7: Check Message Ordering
      if (!this.checkMessageOrdering(deviceId, message, correlationId)) {
        logger.warn('Message out of order, processing anyway', {
          correlationId,
          deviceId,
        });
      }

      // Stage 8: Route to Storage
      const routeStart = Date.now();
      await messageRouter.route(transformedMessage);
      metrics.observeProcessingDuration(
        { stage: 'route', tenant_id: tenantId },
        Date.now() - routeStart,
      );

      // Dequeue from backpressure handler
      await backpressureHandler.dequeue(tenantId);

      // Record metrics
      const processingTime = Date.now() - startTime;
      metrics.observeMessageLatency({ tenant_id: tenantId, device_id: deviceId }, processingTime);
      metrics.observeMessageSize(
        { tenant_id: tenantId, format },
        Buffer.byteLength(JSON.stringify(message.payload)),
      );

      logger.info('Message processed successfully', {
        correlationId,
        tenantId,
        deviceId,
        processingTimeMs: processingTime,
      });

      this.emit('message-processed', transformedMessage);
    } catch (error) {
      logger.error('Pipeline processing error', {
        correlationId,
        tenantId,
        deviceId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      metrics.incrementErrors({
        type: 'pipeline',
        tenant_id: tenantId,
      });

      this.emit('error', {
        message,
        tenantId,
        deviceId,
        error,
      });

      throw error;
    }
  }

  private checkRateLimit(
    tenantId: string,
    deviceId: string,
    message: MQTTMessage,
    correlationId: string,
  ): boolean {
    // Check message rate
    if (!rateLimiter.checkMessageRate(tenantId)) {
      logger.warn('Rate limit exceeded for tenant', {
        correlationId,
        tenantId,
      });
      return false;
    }

    // Check payload size
    const payloadSize = Buffer.isBuffer(message.payload)
      ? message.payload.length
      : Buffer.byteLength(message.payload);

    if (!rateLimiter.checkPayloadSize(tenantId, payloadSize)) {
      logger.warn('Payload size limit exceeded', {
        correlationId,
        tenantId,
        deviceId,
        payloadSize,
      });
      return false;
    }

    return true;
  }

  private createMetadata(
    message: MQTTMessage,
    tenantId: string,
    deviceId: string,
    correlationId: string,
  ): MessageMetadata {
    const payloadSize = Buffer.isBuffer(message.payload)
      ? message.payload.length
      : Buffer.byteLength(message.payload);

    return {
      deviceId,
      tenantId,
      topic: message.topic,
      qos: message.qos,
      timestamp: message.timestamp,
      correlationId,
      size: payloadSize,
    };
  }

  private detectMessageFormat(message: MQTTMessage, deviceProfile?: DeviceProfile): MessageFormat {
    // Use device profile format if available
    if (deviceProfile?.schema?.format) {
      return deviceProfile.schema.format as MessageFormat;
    }

    // Auto-detect format
    return messageParser.detectFormat(message.payload);
  }

  private checkMessageOrdering(
    deviceId: string,
    message: MQTTMessage,
    correlationId: string,
  ): boolean {
    // Simple sequence checking based on timestamp
    const lastTimestamp = this.messageOrdering.get(deviceId);
    const currentTimestamp = message.timestamp.getTime();

    if (lastTimestamp && currentTimestamp < lastTimestamp) {
      logger.warn('Out-of-order message detected', {
        correlationId,
        deviceId,
        lastTimestamp,
        currentTimestamp,
        difference: lastTimestamp - currentTimestamp,
      });
      return false;
    }

    this.messageOrdering.set(deviceId, currentTimestamp);
    return true;
  }

  private getDeviceProfile(tenantId: string, deviceId: string): DeviceProfile | undefined {
    const key = `${tenantId}:${deviceId}`;
    return this.deviceProfiles.get(key);
  }

  registerDeviceProfile(profile: DeviceProfile): void {
    const key = `${profile.tenantId}:${profile.deviceId}`;
    this.deviceProfiles.set(key, profile);

    logger.info('Device profile registered', {
      correlationId: logger.generateCorrelationId(),
      tenantId: profile.tenantId,
      deviceId: profile.deviceId,
      deviceType: profile.deviceType,
    });

    // Register schema and transform template
    if (profile.schema) {
      messageValidator.registerSchema(profile.deviceId, profile.schema);
    }
  }

  unregisterDeviceProfile(tenantId: string, deviceId: string): void {
    const key = `${tenantId}:${deviceId}`;
    this.deviceProfiles.delete(key);

    logger.info('Device profile unregistered', {
      correlationId: logger.generateCorrelationId(),
      tenantId,
      deviceId,
    });

    messageValidator.removeSchema(deviceId);
    messageTransformer.removeTemplate(deviceId);
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down data pipeline', {
      correlationId: logger.generateCorrelationId(),
    });

    await messageRouter.close();
    backpressureHandler.clearAllQueues();

    logger.info('Data pipeline shutdown complete', {
      correlationId: logger.generateCorrelationId(),
    });
  }
}

export default DataPipeline.getInstance();
