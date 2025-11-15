import { MQTTBrokerClient } from '../../src/mqtt/broker-client';
import { ConnectionPool } from '../../src/mqtt/connection-pool';
import rateLimiter from '../../src/utils/rate-limiter';
import dataPipeline from '../../src/pipeline/data-pipeline';
import backpressureHandler from '../../src/pipeline/backpressure-handler';
import { DeviceProfile } from '../../src/types';

describe('Performance Benchmark Tests', () => {
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Concurrent Connections', () => {
    it('should handle 100 concurrent connections', async () => {
      const numberOfConnections = 100;
      const clients: MQTTBrokerClient[] = [];
      const startTime = Date.now();

      console.log(`Creating ${numberOfConnections} concurrent connections...`);

      try {
        // Create connections in batches to avoid overwhelming the system
        const batchSize = 20;
        for (let i = 0; i < numberOfConnections; i += batchSize) {
          const batch = [];

          for (let j = 0; j < batchSize && (i + j) < numberOfConnections; j++) {
            const client = new MQTTBrokerClient({
              tenantId: `tenant-${Math.floor((i + j) / 10)}`,
              deviceId: `device-${i + j}`,
              useConnectionPool: true,
            });

            batch.push(client.connect());
            clients.push(client);
          }

          await Promise.all(batch);
          console.log(`  Connected: ${Math.min(i + batchSize, numberOfConnections)}/${numberOfConnections}`);
        }

        const connectTime = Date.now() - startTime;
        console.log(`All connections established in ${connectTime}ms`);

        // Verify all connections are active
        const connectedCount = clients.filter(c => c.isConnected()).length;
        expect(connectedCount).toBe(numberOfConnections);

        console.log(`Average connection time: ${(connectTime / numberOfConnections).toFixed(2)}ms`);

        // Cleanup
        console.log('Disconnecting all clients...');
        await Promise.all(clients.map(c => c.disconnect()));

      } catch (error) {
        console.error('Connection test failed:', error);
        throw error;
      }
    }, 120000); // 2 minute timeout

    it('should handle 1000 concurrent connections (stress test)', async () => {
      const numberOfConnections = 1000;
      const clients: MQTTBrokerClient[] = [];
      const startTime = Date.now();

      console.log(`STRESS TEST: Creating ${numberOfConnections} concurrent connections...`);

      try {
        const batchSize = 50;
        for (let i = 0; i < numberOfConnections; i += batchSize) {
          const batch = [];

          for (let j = 0; j < batchSize && (i + j) < numberOfConnections; j++) {
            const client = new MQTTBrokerClient({
              tenantId: `tenant-${Math.floor((i + j) / 100)}`,
              deviceId: `device-${i + j}`,
              useConnectionPool: true,
            });

            batch.push(client.connect().catch(err => {
              console.warn(`Connection ${i + j} failed:`, err.message);
              return null;
            }));
            clients.push(client);
          }

          await Promise.all(batch);

          if (i % 100 === 0) {
            console.log(`  Progress: ${i}/${numberOfConnections}`);
          }

          // Small delay between batches to prevent overwhelming
          await delay(100);
        }

        const connectTime = Date.now() - startTime;
        const connectedCount = clients.filter(c => c.isConnected()).length;

        console.log(`Stress test results:`);
        console.log(`  Total time: ${connectTime}ms`);
        console.log(`  Successful connections: ${connectedCount}/${numberOfConnections}`);
        console.log(`  Success rate: ${(connectedCount / numberOfConnections * 100).toFixed(2)}%`);
        console.log(`  Average connection time: ${(connectTime / numberOfConnections).toFixed(2)}ms`);

        // Accept 80% success rate for stress test
        expect(connectedCount).toBeGreaterThan(numberOfConnections * 0.8);

        // Cleanup
        await Promise.all(clients.map(c => {
          if (c.isConnected()) {
            return c.disconnect();
          }
          return Promise.resolve();
        }));

      } catch (error) {
        console.error('Stress test failed:', error);
        throw error;
      }
    }, 300000); // 5 minute timeout
  });

  describe('Message Throughput', () => {
    it('should handle 1000 messages/second', async () => {
      const messagesPerSecond = 1000;
      const durationSeconds = 10;
      const totalMessages = messagesPerSecond * durationSeconds;

      console.log(`Throughput test: ${messagesPerSecond} msg/s for ${durationSeconds}s`);

      const client = new MQTTBrokerClient({
        tenantId: 'perf-test',
        deviceId: 'throughput-device',
      });

      await client.connect();

      let messagesSent = 0;
      let messagesReceived = 0;

      client.on('message', () => {
        messagesReceived++;
      });

      await client.subscribe('perf-test/+/data', 1);

      const startTime = Date.now();

      // Send messages
      const sendInterval = setInterval(async () => {
        const batchSize = Math.floor(messagesPerSecond / 10); // 10 batches per second

        for (let i = 0; i < batchSize; i++) {
          try {
            await client.publish(
              `perf-test/device-${i % 10}/data`,
              JSON.stringify({ value: Math.random(), timestamp: Date.now() }),
              { qos: 0 } // QoS 0 for maximum throughput
            );
            messagesSent++;
          } catch (error) {
            console.warn('Publish failed:', error);
          }
        }
      }, 100);

      // Run for specified duration
      await delay(durationSeconds * 1000);
      clearInterval(sendInterval);

      const elapsed = Date.now() - startTime;
      const actualThroughput = messagesSent / (elapsed / 1000);

      console.log(`Throughput test results:`);
      console.log(`  Messages sent: ${messagesSent}`);
      console.log(`  Messages received: ${messagesReceived}`);
      console.log(`  Elapsed: ${elapsed}ms`);
      console.log(`  Actual throughput: ${actualThroughput.toFixed(2)} msg/s`);
      console.log(`  Target throughput: ${messagesPerSecond} msg/s`);

      await client.disconnect();

      // Allow some tolerance (90% of target)
      expect(actualThroughput).toBeGreaterThan(messagesPerSecond * 0.9);
    }, 120000);

    it('should handle 10000 messages/second (high throughput)', async () => {
      const messagesPerSecond = 10000;
      const durationSeconds = 5;

      console.log(`HIGH THROUGHPUT TEST: ${messagesPerSecond} msg/s`);

      const numClients = 10;
      const clients: MQTTBrokerClient[] = [];

      // Create multiple clients for parallel publishing
      for (let i = 0; i < numClients; i++) {
        const client = new MQTTBrokerClient({
          tenantId: 'perf-test',
          deviceId: `device-${i}`,
        });
        await client.connect();
        clients.push(client);
      }

      let totalMessagesSent = 0;
      const startTime = Date.now();

      const messagesPerClient = Math.floor(messagesPerSecond / numClients);

      const publishTasks = clients.map(async (client, clientIdx) => {
        const interval = setInterval(async () => {
          const batch = [];
          for (let i = 0; i < messagesPerClient / 10; i++) {
            batch.push(
              client.publish(
                `perf-test/device-${clientIdx}/data`,
                JSON.stringify({ value: Math.random() }),
                { qos: 0 }
              ).catch(err => null) // Ignore individual failures
            );
          }
          await Promise.all(batch);
          totalMessagesSent += batch.length;
        }, 100);

        await delay(durationSeconds * 1000);
        clearInterval(interval);
      });

      await Promise.all(publishTasks);

      const elapsed = Date.now() - startTime;
      const actualThroughput = totalMessagesSent / (elapsed / 1000);

      console.log(`High throughput results:`);
      console.log(`  Messages sent: ${totalMessagesSent}`);
      console.log(`  Elapsed: ${elapsed}ms`);
      console.log(`  Actual throughput: ${actualThroughput.toFixed(2)} msg/s`);

      // Cleanup
      await Promise.all(clients.map(c => c.disconnect()));

      // Allow 70% success rate for high throughput
      expect(actualThroughput).toBeGreaterThan(messagesPerSecond * 0.7);
    }, 120000);
  });

  describe('Message Processing Latency', () => {
    it('should process messages with <100ms latency', async () => {
      const deviceProfile: DeviceProfile = {
        deviceId: 'latency-test',
        tenantId: 'perf-test',
        deviceType: 'sensor',
        topics: ['perf-test/latency-test/data'],
        qos: 1,
        schema: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            timestamp: { type: 'number' },
          },
          required: ['value', 'timestamp'],
        },
      };

      dataPipeline.registerDeviceProfile(deviceProfile);

      const latencies: number[] = [];
      const numMessages = 100;

      dataPipeline.on('message-processed', (msg) => {
        const sendTime = msg.data.timestamp;
        const latency = Date.now() - sendTime;
        latencies.push(latency);
      });

      const client = new MQTTBrokerClient({
        tenantId: 'perf-test',
        deviceId: 'latency-test',
      });

      await client.connect();

      // Send test messages
      for (let i = 0; i < numMessages; i++) {
        const message = {
          topic: 'perf-test/latency-test/data',
          payload: Buffer.from(JSON.stringify({
            value: Math.random(),
            timestamp: Date.now(),
          })),
          qos: 1 as const,
          retain: false,
          timestamp: new Date(),
          correlationId: `latency-${i}`,
        };

        await dataPipeline.process(message, 'perf-test', 'latency-test');
        await delay(10); // Small delay between messages
      }

      await client.disconnect();

      // Calculate statistics
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const minLatency = Math.min(...latencies);
      const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

      console.log(`Latency statistics (${latencies.length} messages):`);
      console.log(`  Average: ${avgLatency.toFixed(2)}ms`);
      console.log(`  Min: ${minLatency}ms`);
      console.log(`  Max: ${maxLatency}ms`);
      console.log(`  P95: ${p95Latency}ms`);

      expect(avgLatency).toBeLessThan(100);
      expect(p95Latency).toBeLessThan(150);
    }, 60000);
  });

  describe('Rate Limiting', () => {
    beforeEach(() => {
      rateLimiter.resetLimits('rate-limit-test');
    });

    it('should enforce message rate limits correctly', async () => {
      const tenantId = 'rate-limit-test';
      const messagesPerSecond = 100;

      // Try to send more messages than limit
      let accepted = 0;
      let rejected = 0;

      for (let i = 0; i < messagesPerSecond * 2; i++) {
        if (rateLimiter.checkMessageRate(tenantId, 1)) {
          accepted++;
        } else {
          rejected++;
        }
      }

      console.log(`Rate limit test:`);
      console.log(`  Accepted: ${accepted}`);
      console.log(`  Rejected: ${rejected}`);
      console.log(`  Total: ${accepted + rejected}`);

      expect(rejected).toBeGreaterThan(0);
      expect(accepted).toBeLessThanOrEqual(messagesPerSecond * 2.5); // Allow burst
    });

    it('should handle burst traffic with token bucket', async () => {
      const tenantId = 'burst-test';

      // Wait for bucket to fill
      await delay(2000);

      const burstSize = 200;
      let burstAccepted = 0;

      // Send burst
      const startTime = Date.now();
      for (let i = 0; i < burstSize; i++) {
        if (rateLimiter.checkMessageRate(tenantId, 1)) {
          burstAccepted++;
        }
      }
      const burstTime = Date.now() - startTime;

      console.log(`Burst test:`);
      console.log(`  Burst size: ${burstSize}`);
      console.log(`  Accepted: ${burstAccepted}`);
      console.log(`  Time: ${burstTime}ms`);
      console.log(`  Rate: ${(burstAccepted / burstTime * 1000).toFixed(2)} msg/s`);

      // Should accept burst up to burst size
      expect(burstAccepted).toBeGreaterThan(100);
      expect(burstAccepted).toBeLessThanOrEqual(burstSize);
    });

    it('should enforce payload size limits', () => {
      const tenantId = 'size-limit-test';

      // Small payload should pass
      expect(rateLimiter.checkPayloadSize(tenantId, 1024)).toBe(true);

      // Large payload should be rejected
      expect(rateLimiter.checkPayloadSize(tenantId, 10 * 1024 * 1024)).toBe(false);
    });

    it('should enforce connection limits per tenant', () => {
      const tenantId = 'conn-limit-test';

      // First 1000 connections should succeed
      for (let i = 0; i < 1000; i++) {
        rateLimiter.incrementConnectionCount(tenantId);
      }

      // Next connection should fail
      expect(rateLimiter.checkConnectionLimit(tenantId)).toBe(false);

      // Cleanup
      rateLimiter.resetLimits(tenantId);
    });
  });

  describe('Backpressure Handling', () => {
    beforeEach(() => {
      backpressureHandler.clearAllQueues();
    });

    it('should handle backpressure correctly under load', async () => {
      const tenantId = 'backpressure-test';
      const messagesToEnqueue = 15000; // Exceed high watermark

      let enqueued = 0;
      let dropped = 0;

      console.log(`Backpressure test: Enqueuing ${messagesToEnqueue} messages...`);

      for (let i = 0; i < messagesToEnqueue; i++) {
        const success = await backpressureHandler.enqueue(tenantId, {
          id: i,
          data: `message-${i}`,
        });

        if (success) {
          enqueued++;
        } else {
          dropped++;
        }
      }

      const status = backpressureHandler.getStatus(tenantId);

      console.log(`Backpressure results:`);
      console.log(`  Enqueued: ${enqueued}`);
      console.log(`  Dropped: ${dropped}`);
      console.log(`  Current level: ${status.currentLevel}`);
      console.log(`  High watermark: ${status.highWatermark}`);
      console.log(`  Dropping: ${status.dropping}`);

      expect(dropped).toBeGreaterThan(0);
      expect(status.currentLevel).toBeLessThanOrEqual(status.highWatermark);
    });

    it('should resume normal operation after backpressure releases', async () => {
      const tenantId = 'backpressure-resume-test';

      // Fill queue to trigger backpressure
      for (let i = 0; i < 12000; i++) {
        await backpressureHandler.enqueue(tenantId, { id: i });
      }

      let status = backpressureHandler.getStatus(tenantId);
      expect(status.dropping).toBe(true);

      // Drain queue
      while (status.currentLevel > status.lowWatermark) {
        for (let i = 0; i < 100; i++) {
          await backpressureHandler.dequeue(tenantId);
        }
        status = backpressureHandler.getStatus(tenantId);
      }

      // Should resume normal operation
      expect(status.dropping).toBe(false);
      expect(status.currentLevel).toBeLessThan(status.lowWatermark);

      console.log(`Backpressure resumed at level: ${status.currentLevel}`);
    });
  });

  describe('Connection Pool Performance', () => {
    it('should efficiently reuse pooled connections', async () => {
      const pool = ConnectionPool.getInstance();
      const iterations = 100;

      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        const conn = await pool.acquire({ tenantId: 'pool-test', deviceId: `device-${i}` });
        pool.release(conn);
      }

      const elapsed = Date.now() - startTime;
      const avgTime = elapsed / iterations;

      console.log(`Connection pool performance:`);
      console.log(`  Iterations: ${iterations}`);
      console.log(`  Total time: ${elapsed}ms`);
      console.log(`  Average acquire/release: ${avgTime.toFixed(2)}ms`);

      // Should be very fast since connections are reused
      expect(avgTime).toBeLessThan(50);
    });
  });
});
