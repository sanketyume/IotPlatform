import protobuf from 'protobufjs';
import logger from '../utils/logger';
import { MessageFormat, ParsedMessage, MessageMetadata, MQTTMessage } from '../types';

export class MessageParser {
  private static instance: MessageParser;
  private protobufRoot: protobuf.Root | null = null;

  private constructor() {
    // Initialize protobuf root if needed
  }

  static getInstance(): MessageParser {
    if (!MessageParser.instance) {
      MessageParser.instance = new MessageParser();
    }
    return MessageParser.instance;
  }

  async parse(
    message: MQTTMessage,
    format: MessageFormat = MessageFormat.JSON,
    metadata: MessageMetadata,
  ): Promise<ParsedMessage> {
    const correlationId = message.correlationId || logger.generateCorrelationId();

    try {
      let data: unknown;

      switch (format) {
        case MessageFormat.JSON:
          data = this.parseJSON(message.payload, correlationId);
          break;

        case MessageFormat.BINARY:
          data = this.parseBinary(message.payload);
          break;

        case MessageFormat.PROTOBUF:
          data = await this.parseProtobuf(message.payload, metadata.deviceType);
          break;

        default:
          throw new Error(`Unsupported message format: ${format}`);
      }

      logger.debug('Message parsed successfully', {
        correlationId,
        format,
        deviceId: metadata.deviceId,
        tenantId: metadata.tenantId,
        topic: metadata.topic,
      });

      return {
        format,
        data,
        metadata,
      };
    } catch (error) {
      logger.error('Message parsing failed', {
        correlationId,
        format,
        deviceId: metadata.deviceId,
        tenantId: metadata.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw new Error(`Failed to parse message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private parseJSON(payload: Buffer | string, correlationId: string): unknown {
    try {
      const payloadStr = Buffer.isBuffer(payload) ? payload.toString('utf-8') : payload;
      return JSON.parse(payloadStr);
    } catch (error) {
      logger.error('JSON parsing failed', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Invalid JSON format');
    }
  }

  private parseBinary(payload: Buffer | string): Buffer {
    if (Buffer.isBuffer(payload)) {
      return payload;
    }

    // If it's a string, try to convert to buffer
    try {
      return Buffer.from(payload, 'base64');
    } catch (error) {
      logger.error('Binary parsing failed', {
        correlationId: logger.generateCorrelationId(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Invalid binary format');
    }
  }

  private async parseProtobuf(payload: Buffer | string, messageType: string): Promise<unknown> {
    if (!this.protobufRoot) {
      throw new Error('Protobuf schema not loaded');
    }

    try {
      const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'base64');
      const MessageType = this.protobufRoot.lookupType(messageType);
      const message = MessageType.decode(buffer);
      return MessageType.toObject(message, {
        longs: String,
        enums: String,
        bytes: String,
      });
    } catch (error) {
      logger.error('Protobuf parsing failed', {
        correlationId: logger.generateCorrelationId(),
        messageType,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Invalid protobuf format');
    }
  }

  async loadProtobufSchema(schemaPath: string): Promise<void> {
    try {
      this.protobufRoot = await protobuf.load(schemaPath);
      logger.info('Protobuf schema loaded', {
        correlationId: logger.generateCorrelationId(),
        schemaPath,
      });
    } catch (error) {
      logger.error('Failed to load protobuf schema', {
        correlationId: logger.generateCorrelationId(),
        schemaPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  detectFormat(payload: Buffer | string): MessageFormat {
    // Try to detect format based on content
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

    // Try JSON first
    try {
      JSON.parse(buffer.toString('utf-8'));
      return MessageFormat.JSON;
    } catch {
      // Not JSON
    }

    // Check for protobuf markers (this is a simple heuristic)
    if (buffer.length > 0 && buffer[0] >= 0x08 && buffer[0] <= 0x0f) {
      return MessageFormat.PROTOBUF;
    }

    // Default to binary
    return MessageFormat.BINARY;
  }
}

export default MessageParser.getInstance();
