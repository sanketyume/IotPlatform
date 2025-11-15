import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import logger from '../utils/logger';
import metrics from '../utils/metrics';
import { ParsedMessage, DeviceProfile } from '../types';

export class MessageValidator {
  private static instance: MessageValidator;
  private ajv: Ajv;
  private validators: Map<string, ValidateFunction> = new Map();

  private constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      useDefaults: true,
      coerceTypes: true,
    });

    // Add format validators
    addFormats(this.ajv);

    // Add custom formats if needed
    this.ajv.addFormat('device-id', /^[a-zA-Z0-9_-]+$/);
    this.ajv.addFormat('tenant-id', /^[a-zA-Z0-9_-]+$/);
  }

  static getInstance(): MessageValidator {
    if (!MessageValidator.instance) {
      MessageValidator.instance = new MessageValidator();
    }
    return MessageValidator.instance;
  }

  async validate(
    message: ParsedMessage,
    deviceProfile: DeviceProfile,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const correlationId = message.metadata.correlationId;

    try {
      // Check if message format is JSON (schemas only apply to JSON)
      if (!deviceProfile.schema) {
        logger.debug('No schema defined for device profile, skipping validation', {
          correlationId,
          deviceId: deviceProfile.deviceId,
          tenantId: deviceProfile.tenantId,
        });
        return { valid: true };
      }

      // Get or compile validator
      const validator = this.getValidator(deviceProfile.deviceId, deviceProfile.schema);

      // Validate message data
      const valid = validator(message.data);

      if (!valid) {
        const errors = validator.errors?.map((error) => {
          return `${error.instancePath} ${error.message}`;
        });

        logger.warn('Message validation failed', {
          correlationId,
          deviceId: message.metadata.deviceId,
          tenantId: message.metadata.tenantId,
          errors,
        });

        metrics.incrementErrors({
          type: 'validation',
          tenant_id: message.metadata.tenantId,
        });

        return { valid: false, errors };
      }

      logger.debug('Message validated successfully', {
        correlationId,
        deviceId: message.metadata.deviceId,
        tenantId: message.metadata.tenantId,
      });

      return { valid: true };
    } catch (error) {
      logger.error('Message validation error', {
        correlationId,
        deviceId: message.metadata.deviceId,
        tenantId: message.metadata.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      metrics.incrementErrors({
        type: 'validation_error',
        tenant_id: message.metadata.tenantId,
      });

      return {
        valid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  private getValidator(deviceId: string, schema: Record<string, unknown>): ValidateFunction {
    const cacheKey = this.generateCacheKey(deviceId, schema);

    if (!this.validators.has(cacheKey)) {
      const validator = this.ajv.compile(schema);
      this.validators.set(cacheKey, validator);

      logger.debug('Schema compiled and cached', {
        correlationId: logger.generateCorrelationId(),
        deviceId,
        cacheKey,
      });
    }

    return this.validators.get(cacheKey)!;
  }

  private generateCacheKey(deviceId: string, schema: Record<string, unknown>): string {
    // Simple cache key based on device ID
    // In production, you might want to hash the schema as well
    return `${deviceId}:${JSON.stringify(schema).substring(0, 50)}`;
  }

  registerSchema(deviceId: string, schema: Record<string, unknown>): void {
    const cacheKey = this.generateCacheKey(deviceId, schema);
    const validator = this.ajv.compile(schema);
    this.validators.set(cacheKey, validator);

    logger.info('Schema registered', {
      correlationId: logger.generateCorrelationId(),
      deviceId,
    });
  }

  removeSchema(deviceId: string): void {
    // Remove all validators for this device
    const keysToRemove: string[] = [];

    for (const key of this.validators.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => this.validators.delete(key));

    logger.info('Schema removed', {
      correlationId: logger.generateCorrelationId(),
      deviceId,
      removed: keysToRemove.length,
    });
  }

  clearCache(): void {
    this.validators.clear();
    logger.info('Validator cache cleared', {
      correlationId: logger.generateCorrelationId(),
    });
  }
}

export default MessageValidator.getInstance();
