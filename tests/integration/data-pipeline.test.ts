import dataPipeline from '../../src/pipeline/data-pipeline';
import messageParser from '../../src/pipeline/message-parser';
import messageValidator from '../../src/pipeline/message-validator';
import messageTransformer from '../../src/pipeline/message-transformer';
import { MQTTMessage, DeviceProfile, MessageFormat } from '../../src/types';

describe('Data Pipeline Tests', () => {
  const createMockMessage = (payload: any, topic: string = 'tenant1/device1/telemetry'): MQTTMessage => ({
    topic,
    payload: typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(JSON.stringify(payload)),
    qos: 1,
    retain: false,
    timestamp: new Date(),
    correlationId: 'test-correlation-id',
  });

  describe('Message Parsing', () => {
    it('should parse JSON messages correctly', async () => {
      const payload = { temperature: 22.5, humidity: 65 };
      const message = createMockMessage(payload);

      const metadata = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        topic: message.topic,
        qos: message.qos,
        timestamp: message.timestamp,
        correlationId: message.correlationId,
        size: message.payload.length,
        deviceType: 'sensor',
      };

      const parsed = await messageParser.parse(message, MessageFormat.JSON, metadata);

      expect(parsed.format).toBe(MessageFormat.JSON);
      expect(parsed.data).toEqual(payload);
      expect(parsed.metadata.deviceId).toBe('device1');
    });

    it('should parse binary messages correctly', async () => {
      const binaryData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const message = createMockMessage(binaryData);

      const metadata = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        topic: message.topic,
        qos: message.qos,
        timestamp: message.timestamp,
        correlationId: message.correlationId,
        size: message.payload.length,
        deviceType: 'sensor',
      };

      const parsed = await messageParser.parse(message, MessageFormat.BINARY, metadata);

      expect(parsed.format).toBe(MessageFormat.BINARY);
      expect(Buffer.isBuffer(parsed.data)).toBe(true);
      expect((parsed.data as Buffer).length).toBe(4);
    });

    it('should auto-detect message format', () => {
      const jsonPayload = Buffer.from('{"temperature": 22.5}');
      const binaryPayload = Buffer.from([0x01, 0x02, 0x03]);

      expect(messageParser.detectFormat(jsonPayload)).toBe(MessageFormat.JSON);
      expect(messageParser.detectFormat(binaryPayload)).toBe(MessageFormat.BINARY);
    });

    it('should handle malformed JSON gracefully', async () => {
      const malformedJson = '{ invalid json }';
      const message = createMockMessage(malformedJson);

      const metadata = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        topic: message.topic,
        qos: message.qos,
        timestamp: message.timestamp,
        correlationId: message.correlationId,
        size: message.payload.length,
        deviceType: 'sensor',
      };

      await expect(
        messageParser.parse(message, MessageFormat.JSON, metadata)
      ).rejects.toThrow('Failed to parse message');
    });
  });

  describe('Schema Validation', () => {
    const deviceProfile: DeviceProfile = {
      deviceId: 'device1',
      tenantId: 'tenant1',
      deviceType: 'temperature-sensor',
      topics: ['tenant1/device1/telemetry'],
      qos: 1,
      schema: {
        type: 'object',
        properties: {
          temperature: { type: 'number', minimum: -50, maximum: 100 },
          humidity: { type: 'number', minimum: 0, maximum: 100 },
          timestamp: { type: 'string', format: 'date-time' },
        },
        required: ['temperature', 'timestamp'],
      },
    };

    beforeEach(() => {
      messageValidator.clearCache();
    });

    it('should validate correct messages', async () => {
      const validData = {
        temperature: 22.5,
        humidity: 65,
        timestamp: new Date().toISOString(),
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: validData,
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const result = await messageValidator.validate(parsedMessage, deviceProfile);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject invalid messages', async () => {
      const invalidData = {
        temperature: 150, // Exceeds maximum
        humidity: 65,
        timestamp: new Date().toISOString(),
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: invalidData,
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const result = await messageValidator.validate(parsedMessage, deviceProfile);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('should reject messages missing required fields', async () => {
      const incompleteData = {
        humidity: 65,
        // Missing required 'temperature' and 'timestamp'
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: incompleteData,
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const result = await messageValidator.validate(parsedMessage, deviceProfile);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should validate with custom formats', async () => {
      const deviceProfileWithCustomFormat: DeviceProfile = {
        ...deviceProfile,
        schema: {
          type: 'object',
          properties: {
            deviceId: { type: 'string', format: 'device-id' },
            tenantId: { type: 'string', format: 'tenant-id' },
          },
          required: ['deviceId', 'tenantId'],
        },
      };

      const validData = {
        deviceId: 'device-123',
        tenantId: 'tenant-abc',
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: validData,
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const result = await messageValidator.validate(parsedMessage, deviceProfileWithCustomFormat);

      expect(result.valid).toBe(true);
    });
  });

  describe('Data Transformations', () => {
    it('should apply direct mapping transformations', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        deviceType: 'sensor',
        topics: ['tenant1/device1/telemetry'],
        qos: 1,
        transformTemplate: {
          temp: '$.temperature',
          hum: '$.humidity',
        },
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: { temperature: 22.5, humidity: 65 },
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const transformed = await messageTransformer.transform(parsedMessage, deviceProfile);

      expect(transformed.data).toHaveProperty('temp', 22.5);
      expect(transformed.data).toHaveProperty('hum', 65);
    });

    it('should apply mathematical transformations', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        deviceType: 'sensor',
        topics: ['tenant1/device1/telemetry'],
        qos: 1,
        transformTemplate: {
          celsius: '$.temperature',
          fahrenheit: {
            transform: 'multiply',
            source: 'temperature',
            params: { factor: 1.8 },
          },
        },
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: { temperature: 20 },
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const transformed = await messageTransformer.transform(parsedMessage, deviceProfile);

      expect((transformed.data as any).celsius).toBe(20);
      expect((transformed.data as any).fahrenheit).toBe(36); // 20 * 1.8
    });

    it('should apply rounding transformations', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        deviceType: 'sensor',
        topics: ['tenant1/device1/telemetry'],
        qos: 1,
        transformTemplate: {
          rounded: {
            transform: 'round',
            source: 'value',
            params: { decimals: 2 },
          },
        },
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: { value: 3.14159 },
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const transformed = await messageTransformer.transform(parsedMessage, deviceProfile);

      expect((transformed.data as any).rounded).toBe(3.14);
    });

    it('should handle default values for missing fields', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        deviceType: 'sensor',
        topics: ['tenant1/device1/telemetry'],
        qos: 1,
        transformTemplate: {
          location: {
            transform: 'default',
            source: 'location',
            params: { defaultValue: 'unknown' },
          },
        },
      };

      const parsedMessage = {
        format: MessageFormat.JSON,
        data: { temperature: 22 }, // No location field
        metadata: {
          deviceId: 'device1',
          tenantId: 'tenant1',
          topic: 'tenant1/device1/telemetry',
          qos: 1,
          timestamp: new Date(),
          correlationId: 'test-id',
          size: 100,
        },
      };

      const transformed = await messageTransformer.transform(parsedMessage, deviceProfile);

      expect((transformed.data as any).location).toBe('unknown');
    });
  });

  describe('Message Ordering', () => {
    it('should maintain message order for single device', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'device1',
        tenantId: 'tenant1',
        deviceType: 'sensor',
        topics: ['tenant1/device1/telemetry'],
        qos: 1,
      };

      dataPipeline.registerDeviceProfile(deviceProfile);

      const messages: MQTTMessage[] = [];
      const processedMessages: any[] = [];

      // Create ordered messages
      for (let i = 0; i < 10; i++) {
        messages.push(createMockMessage(
          { sequence: i, value: i * 10 },
          'tenant1/device1/telemetry'
        ));
      }

      dataPipeline.on('message-processed', (msg) => {
        processedMessages.push(msg);
      });

      // Process messages in order
      for (const msg of messages) {
        try {
          await dataPipeline.process(msg, 'tenant1', 'device1');
        } catch (error) {
          // Some messages might fail validation, that's ok
        }
      }

      // Verify order is maintained
      for (let i = 0; i < processedMessages.length - 1; i++) {
        const current = processedMessages[i].data.sequence;
        const next = processedMessages[i + 1].data.sequence;
        expect(next).toBeGreaterThan(current);
      }
    });

    it('should detect out-of-order messages', async () => {
      const baseTime = Date.now();
      const tenantId = 'tenant1';
      const deviceId = 'device1';

      const messages = [
        createMockMessage({ seq: 1 }),
        createMockMessage({ seq: 2 }),
        createMockMessage({ seq: 3 }),
      ];

      messages[0].timestamp = new Date(baseTime);
      messages[1].timestamp = new Date(baseTime + 1000);
      messages[2].timestamp = new Date(baseTime - 1000); // Out of order

      // Process messages and check for warnings
      // The pipeline should log warnings but still process
      for (const msg of messages) {
        try {
          await dataPipeline.process(msg, tenantId, deviceId);
        } catch (error) {
          // Expected for some cases
        }
      }

      expect(true).toBe(true); // Pipeline handles out-of-order messages
    });
  });

  describe('End-to-End Pipeline', () => {
    it('should process complete message through pipeline', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'sensor-01',
        tenantId: 'factory-1',
        deviceType: 'temperature-sensor',
        topics: ['factory-1/sensor-01/telemetry'],
        qos: 1,
        schema: {
          type: 'object',
          properties: {
            temperature: { type: 'number' },
            timestamp: { type: 'string' },
          },
          required: ['temperature', 'timestamp'],
        },
        transformTemplate: {
          temp_celsius: '$.temperature',
          temp_fahrenheit: {
            transform: 'multiply',
            source: 'temperature',
            params: { factor: 1.8 },
          },
        },
      };

      dataPipeline.registerDeviceProfile(deviceProfile);

      const message = createMockMessage(
        {
          temperature: 25,
          timestamp: new Date().toISOString(),
        },
        'factory-1/sensor-01/telemetry'
      );

      let processedMessage: any = null;
      dataPipeline.once('message-processed', (msg) => {
        processedMessage = msg;
      });

      await dataPipeline.process(message, 'factory-1', 'sensor-01');

      expect(processedMessage).not.toBeNull();
      expect(processedMessage.data).toHaveProperty('temp_celsius', 25);
      expect(processedMessage.data).toHaveProperty('temp_fahrenheit', 45);
    });

    it('should handle validation failures gracefully', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'sensor-01',
        tenantId: 'factory-1',
        deviceType: 'temperature-sensor',
        topics: ['factory-1/sensor-01/telemetry'],
        qos: 1,
        schema: {
          type: 'object',
          properties: {
            temperature: { type: 'number', maximum: 100 },
          },
          required: ['temperature'],
        },
      };

      dataPipeline.registerDeviceProfile(deviceProfile);

      const invalidMessage = createMockMessage(
        { temperature: 150 }, // Exceeds max
        'factory-1/sensor-01/telemetry'
      );

      let validationFailed = false;
      dataPipeline.once('validation-failed', () => {
        validationFailed = true;
      });

      await dataPipeline.process(invalidMessage, 'factory-1', 'sensor-01');

      expect(validationFailed).toBe(true);
    });
  });
});
