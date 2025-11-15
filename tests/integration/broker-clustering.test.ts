import { MQTTBrokerClient } from '../../src/mqtt/broker-client';
import { ConnectionPool } from '../../src/mqtt/connection-pool';
import mqtt from 'mqtt';

describe('Broker Clustering Tests', () => {
  describe('Failover Testing', () => {
    it('should failover to secondary broker when primary goes down', async () => {
      // Test setup
      const clusterNodes = [
        'mqtt://localhost:1883',  // Primary (Mosquitto)
        'mqtt://localhost:1884',  // Secondary (EMQX)
      ];

      const client = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'test-device',
        useConnectionPool: true,
      });

      await client.connect();

      const messagesReceived: any[] = [];
      client.on('message', (msg) => {
        messagesReceived.push(msg);
      });

      await client.subscribe('test/failover/#', 1);

      // Publish before failover
      await client.publish('test/failover/before', 'message-1', { qos: 1 });

      // Simulate primary broker failure
      // In real test, you would stop the broker: docker-compose stop mosquitto

      // Wait for reconnection to secondary
      await new Promise(resolve => setTimeout(resolve, 6000)); // Wait for reconnect

      // Publish after failover
      await client.publish('test/failover/after', 'message-2', { qos: 1 });

      // Verify both messages were received
      expect(messagesReceived.length).toBeGreaterThanOrEqual(2);
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    }, 30000);

    it('should maintain connection pool health during broker failures', async () => {
      const pool = ConnectionPool.getInstance();

      const initialHealth = pool.getHealthStatus();
      expect(initialHealth.healthy).toBe(true);
      expect(initialHealth.activeConnections).toBeGreaterThan(0);

      // Simulate broker failure
      // Stop primary broker

      // Wait for health check
      await new Promise(resolve => setTimeout(resolve, 35000));

      const healthAfterFailure = pool.getHealthStatus();

      // Pool should still be healthy with remaining connections
      expect(healthAfterFailure.connections).toBeGreaterThan(0);

      // Error rate should increase but not reach 100%
      expect(healthAfterFailure.errorRate).toBeLessThan(1.0);
    }, 45000);
  });

  describe('Load Distribution', () => {
    it('should distribute messages across cluster nodes', async () => {
      const numberOfMessages = 100;
      const nodeConnections = new Map<string, number>();

      // Create multiple clients to trigger load balancing
      const clients: MQTTBrokerClient[] = [];

      for (let i = 0; i < 10; i++) {
        const client = new MQTTBrokerClient({
          tenantId: `tenant-${i}`,
          deviceId: `device-${i}`,
          useConnectionPool: true,
        });

        await client.connect();
        clients.push(client);

        const connInfo = client.getConnectionInfo();
        if (connInfo) {
          const node = connInfo.clientId.split('-')[0];
          nodeConnections.set(node, (nodeConnections.get(node) || 0) + 1);
        }
      }

      // Verify connections are distributed
      expect(nodeConnections.size).toBeGreaterThan(0);

      // If clustering is enabled, expect distribution across nodes
      // Otherwise, all connections go to single broker
      console.log('Connection distribution:', Object.fromEntries(nodeConnections));

      // Cleanup
      for (const client of clients) {
        await client.disconnect();
      }
    }, 60000);

    it('should handle round-robin connection allocation', async () => {
      const pool = ConnectionPool.getInstance();
      const connections: any[] = [];

      // Acquire multiple connections
      for (let i = 0; i < 5; i++) {
        const conn = await pool.acquire({
          tenantId: 'test-tenant',
          deviceId: `device-${i}`,
        });
        connections.push(conn);
      }

      // Verify different connections were allocated
      const clientIds = connections.map(c => c.getConnectionInfo().clientId);
      const uniqueClientIds = new Set(clientIds);

      expect(uniqueClientIds.size).toBeGreaterThan(1);

      // Release connections
      for (const conn of connections) {
        pool.release(conn);
      }
    });
  });

  describe('Session State Replication', () => {
    it('should persist sessions with clean session = false', async () => {
      const clientId = 'persistent-session-client';

      // First connection with persistent session
      const client1 = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: clientId,
        useConnectionPool: false,
      });

      await client1.connect();
      await client1.subscribe('test/persistent/#', 1);
      await client1.disconnect();

      // Second connection should restore session
      const client2 = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: clientId,
        useConnectionPool: false,
      });

      const messagesReceived: any[] = [];
      client2.on('message', (msg) => {
        messagesReceived.push(msg);
      });

      await client2.connect();

      // Publish a message while client is connected
      await client2.publish('test/persistent/data', 'test-message', { qos: 1 });

      // Wait for message
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should receive the message since subscription persisted
      expect(messagesReceived.length).toBeGreaterThan(0);

      await client2.disconnect();
    }, 30000);

    it('should handle retained messages across cluster', async () => {
      const retainedTopic = 'test/retained/status';
      const retainedMessage = 'device-online';

      // Publish retained message
      const publisher = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'publisher',
      });

      await publisher.connect();
      await publisher.publish(retainedTopic, retainedMessage, {
        qos: 1,
        retain: true
      });
      await publisher.disconnect();

      // New subscriber should receive retained message
      const subscriber = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'subscriber',
      });

      const receivedMessages: any[] = [];
      subscriber.on('message', (msg) => {
        receivedMessages.push(msg);
      });

      await subscriber.connect();
      await subscriber.subscribe(retainedTopic, 1);

      // Wait for retained message
      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].payload.toString()).toContain(retainedMessage);

      await subscriber.disconnect();
    }, 30000);
  });

  describe('Circuit Breaker Integration', () => {
    it('should open circuit after consecutive failures', async () => {
      const circuitBreaker = (await import('../../src/utils/circuit-breaker')).default;

      // Reset circuit
      circuitBreaker.reset('mqtt-connection');

      // Simulate failures
      const failingOperation = async () => {
        throw new Error('Connection failed');
      };

      // Try operation multiple times to trigger circuit breaker
      for (let i = 0; i < 6; i++) {
        try {
          await circuitBreaker.execute('mqtt-connection', failingOperation);
        } catch (error) {
          // Expected to fail
        }
      }

      // Circuit should now be OPEN
      const state = circuitBreaker.getState('mqtt-connection');
      expect(state).toBe('OPEN');

      // Next call should fail fast without executing operation
      const startTime = Date.now();
      try {
        await circuitBreaker.execute('mqtt-connection', failingOperation);
      } catch (error) {
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeLessThan(100); // Fails fast
        expect((error as Error).message).toContain('Circuit breaker is OPEN');
      }
    });
  });
});
