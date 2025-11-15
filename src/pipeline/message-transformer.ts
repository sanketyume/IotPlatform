import _ from 'lodash';
import logger from '../utils/logger';
import { ParsedMessage, DeviceProfile } from '../types';

interface TransformRule {
  path: string;
  operation: 'map' | 'filter' | 'aggregate' | 'convert' | 'rename';
  params?: Record<string, unknown>;
}

export class MessageTransformer {
  private static instance: MessageTransformer;
  private transformTemplates: Map<string, TransformRule[]> = new Map();

  private constructor() {}

  static getInstance(): MessageTransformer {
    if (!MessageTransformer.instance) {
      MessageTransformer.instance = new MessageTransformer();
    }
    return MessageTransformer.instance;
  }

  async transform(
    message: ParsedMessage,
    deviceProfile: DeviceProfile,
  ): Promise<ParsedMessage> {
    const correlationId = message.metadata.correlationId;

    try {
      if (!deviceProfile.transformTemplate) {
        logger.debug('No transform template defined, returning original message', {
          correlationId,
          deviceId: deviceProfile.deviceId,
        });
        return message;
      }

      // Apply transformation template
      const transformedData = this.applyTemplate(
        message.data,
        deviceProfile.transformTemplate,
        correlationId,
      );

      logger.debug('Message transformed successfully', {
        correlationId,
        deviceId: message.metadata.deviceId,
        tenantId: message.metadata.tenantId,
      });

      return {
        ...message,
        data: transformedData,
      };
    } catch (error) {
      logger.error('Message transformation failed', {
        correlationId,
        deviceId: message.metadata.deviceId,
        tenantId: message.metadata.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return original message on transformation failure
      return message;
    }
  }

  private applyTemplate(
    data: unknown,
    template: Record<string, unknown>,
    correlationId: string,
  ): unknown {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(template)) {
      if (typeof value === 'string' && value.startsWith('$.')) {
        // JSONPath-like reference
        const path = value.substring(2);
        result[key] = _.get(data, path);
      } else if (typeof value === 'object' && value !== null && 'transform' in value) {
        // Complex transformation
        const transformConfig = value as {
          transform: string;
          source: string;
          params?: Record<string, unknown>;
        };
        result[key] = this.applyTransformation(data, transformConfig, correlationId);
      } else if (typeof value === 'object' && value !== null) {
        // Nested template
        result[key] = this.applyTemplate(data, value as Record<string, unknown>, correlationId);
      } else {
        // Static value
        result[key] = value;
      }
    }

    return result;
  }

  private applyTransformation(
    data: unknown,
    config: { transform: string; source: string; params?: Record<string, unknown> },
    correlationId: string,
  ): unknown {
    const sourceValue = _.get(data, config.source);

    switch (config.transform) {
      case 'multiply':
        return this.multiply(sourceValue, config.params?.factor as number);

      case 'divide':
        return this.divide(sourceValue, config.params?.divisor as number);

      case 'round':
        return this.round(sourceValue, config.params?.decimals as number);

      case 'uppercase':
        return this.uppercase(sourceValue);

      case 'lowercase':
        return this.lowercase(sourceValue);

      case 'timestamp':
        return this.toTimestamp(sourceValue);

      case 'boolean':
        return this.toBoolean(sourceValue);

      case 'array':
        return this.toArray(sourceValue);

      case 'concat':
        return this.concat(sourceValue, config.params?.values as unknown[]);

      case 'default':
        return sourceValue ?? config.params?.defaultValue;

      default:
        logger.warn('Unknown transformation type', {
          correlationId,
          transform: config.transform,
        });
        return sourceValue;
    }
  }

  private multiply(value: unknown, factor: number): number {
    const num = Number(value);
    return isNaN(num) ? 0 : num * (factor || 1);
  }

  private divide(value: unknown, divisor: number): number {
    const num = Number(value);
    return isNaN(num) || divisor === 0 ? 0 : num / divisor;
  }

  private round(value: unknown, decimals: number = 2): number {
    const num = Number(value);
    if (isNaN(num)) return 0;
    const multiplier = Math.pow(10, decimals);
    return Math.round(num * multiplier) / multiplier;
  }

  private uppercase(value: unknown): string {
    return String(value).toUpperCase();
  }

  private lowercase(value: unknown): string {
    return String(value).toLowerCase();
  }

  private toTimestamp(value: unknown): number {
    if (value instanceof Date) {
      return value.getTime();
    }
    const date = new Date(value as string | number);
    return isNaN(date.getTime()) ? Date.now() : date.getTime();
  }

  private toBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1';
    }
    return Boolean(value);
  }

  private toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    return [value];
  }

  private concat(value: unknown, values: unknown[]): string {
    const arr = [value, ...(values || [])];
    return arr.map((v) => String(v)).join('');
  }

  registerTemplate(deviceId: string, template: TransformRule[]): void {
    this.transformTemplates.set(deviceId, template);

    logger.info('Transform template registered', {
      correlationId: logger.generateCorrelationId(),
      deviceId,
      rules: template.length,
    });
  }

  removeTemplate(deviceId: string): void {
    this.transformTemplates.delete(deviceId);

    logger.info('Transform template removed', {
      correlationId: logger.generateCorrelationId(),
      deviceId,
    });
  }

  clearTemplates(): void {
    this.transformTemplates.clear();
    logger.info('All transform templates cleared', {
      correlationId: logger.generateCorrelationId(),
    });
  }
}

export default MessageTransformer.getInstance();
