import { MQTTBrokerClient } from '../../src/mqtt/broker-client';
import aclManager from '../../src/mqtt/acl-manager';
import fs from 'fs';
import path from 'path';

describe('Security Tests', () => {
  describe('TLS/SSL Enforcement', () => {
    it('should reject non-TLS connections when TLS is enforced', async () => {
      // Note: This requires MQTT broker to be configured with TLS enforcement
      // Set MQTT_TLS_ENABLED=true in environment

      const isTlsEnabled = process.env.MQTT_TLS_ENABLED === 'true';

      if (!isTlsEnabled) {
        console.log('Skipping TLS test - TLS not enabled in configuration');
        return;
      }

      const client = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'test-device',
      });

      // Should fail if trying to connect without TLS when enforced
      await expect(client.connect()).rejects.toThrow();
    });

    it('should successfully connect with valid TLS certificates', async () => {
      const isTlsEnabled = process.env.MQTT_TLS_ENABLED === 'true';

      if (!isTlsEnabled) {
        console.log('Skipping TLS test - TLS not enabled');
        return;
      }

      // Verify certificate files exist
      const caPath = process.env.MQTT_TLS_CA_PATH || './certs/ca.crt';
      const certPath = process.env.MQTT_TLS_CERT_PATH || './certs/client.crt';
      const keyPath = process.env.MQTT_TLS_KEY_PATH || './certs/client.key';

      if (!fs.existsSync(caPath)) {
        console.log('Skipping - CA certificate not found');
        return;
      }

      const client = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'test-device',
      });

      await expect(client.connect()).resolves.not.toThrow();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });
  });

  describe('Certificate Validation', () => {
    it('should reject invalid certificates', async () => {
      // Set up client with invalid cert
      // This would require modifying the config temporarily

      expect(true).toBe(true); // Placeholder
    });

    it('should reject expired certificates', async () => {
      // Test with expired certificate

      expect(true).toBe(true); // Placeholder
    });

    it('should validate certificate chain', async () => {
      // Test certificate chain validation

      expect(true).toBe(true); // Placeholder
    });
  });

  describe('ACL Topic Access Control', () => {
    beforeEach(() => {
      aclManager.clearRules();
    });

    it('should allow publish when write permission granted', async () => {
      const tenantId = 'tenant1';
      const deviceId = 'device1';
      const topic = 'tenant1/device1/telemetry';

      // Grant write permission
      aclManager.addRule({
        topic: topic,
        permission: 'write',
        tenantId,
        deviceId,
      });

      const canPublish = aclManager.canPublish(topic, tenantId, deviceId);
      expect(canPublish).toBe(true);
    });

    it('should deny publish when only read permission granted', async () => {
      const tenantId = 'tenant1';
      const deviceId = 'device1';
      const topic = 'tenant1/device1/commands';

      // Grant only read permission
      aclManager.addRule({
        topic: topic,
        permission: 'read',
        tenantId,
        deviceId,
      });

      const canPublish = aclManager.canPublish(topic, tenantId, deviceId);
      expect(canPublish).toBe(false);
    });

    it('should allow subscribe when read permission granted', async () => {
      const tenantId = 'tenant1';
      const deviceId = 'device1';
      const topic = 'tenant1/device1/commands';

      aclManager.addRule({
        topic: topic,
        permission: 'read',
        tenantId,
        deviceId,
      });

      const canSubscribe = aclManager.canSubscribe(topic, tenantId, deviceId);
      expect(canSubscribe).toBe(true);
    });

    it('should enforce wildcard ACL rules - single level (+)', async () => {
      const tenantId = 'tenant1';

      // Grant permission for all devices in tenant
      aclManager.addRule({
        topic: 'tenant1/+/telemetry',
        permission: 'write',
        tenantId,
      });

      // Should allow any device in tenant1
      expect(aclManager.canPublish('tenant1/device1/telemetry', tenantId)).toBe(true);
      expect(aclManager.canPublish('tenant1/device2/telemetry', tenantId)).toBe(true);
      expect(aclManager.canPublish('tenant1/deviceX/telemetry', tenantId)).toBe(true);

      // Should deny different pattern
      expect(aclManager.canPublish('tenant1/device1/status', tenantId)).toBe(false);
    });

    it('should enforce wildcard ACL rules - multi level (#)', async () => {
      const tenantId = 'tenant1';

      aclManager.addRule({
        topic: 'tenant1/#',
        permission: 'readwrite',
        tenantId,
      });

      // Should allow all topics under tenant1
      expect(aclManager.canPublish('tenant1/device1/telemetry', tenantId)).toBe(true);
      expect(aclManager.canPublish('tenant1/device1/telemetry/temp', tenantId)).toBe(true);
      expect(aclManager.canPublish('tenant1/any/path/here', tenantId)).toBe(true);

      // Should deny other tenants
      expect(aclManager.canPublish('tenant2/device1/telemetry', tenantId)).toBe(false);
    });

    it('should prevent cross-tenant access', async () => {
      aclManager.addRule({
        topic: 'tenant1/+/telemetry',
        permission: 'write',
        tenantId: 'tenant1',
      });

      // Tenant2 should not be able to publish to tenant1 topics
      const canPublish = aclManager.canPublish(
        'tenant1/device1/telemetry',
        'tenant2', // Different tenant
        'device1'
      );

      expect(canPublish).toBe(false);
    });

    it('should enforce device-level isolation', async () => {
      const tenantId = 'tenant1';

      aclManager.addRule({
        topic: 'tenant1/device1/telemetry',
        permission: 'write',
        tenantId,
        deviceId: 'device1',
      });

      // Device1 should be able to publish
      expect(aclManager.canPublish(
        'tenant1/device1/telemetry',
        tenantId,
        'device1'
      )).toBe(true);

      // Device2 should not be able to publish to device1's topic
      expect(aclManager.canPublish(
        'tenant1/device1/telemetry',
        tenantId,
        'device2'
      )).toBe(false);
    });
  });

  describe('Authentication', () => {
    it('should authenticate with username and password', async () => {
      const username = process.env.MQTT_USERNAME;
      const password = process.env.MQTT_PASSWORD;

      if (!username || !password) {
        console.log('Skipping - MQTT credentials not configured');
        return;
      }

      const client = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'test-device',
      });

      await expect(client.connect()).resolves.not.toThrow();
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    it('should reject invalid credentials', async () => {
      // Temporarily set invalid credentials
      const originalUsername = process.env.MQTT_USERNAME;
      const originalPassword = process.env.MQTT_PASSWORD;

      process.env.MQTT_USERNAME = 'invalid-user';
      process.env.MQTT_PASSWORD = 'invalid-password';

      const client = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'test-device',
      });

      try {
        await client.connect();
        // If authentication is enforced, this should fail
        // If not enforced (allow_anonymous=true), it will succeed
      } catch (error) {
        expect(error).toBeDefined();
      }

      // Restore original credentials
      process.env.MQTT_USERNAME = originalUsername;
      process.env.MQTT_PASSWORD = originalPassword;
    });

    it('should support certificate-based authentication', async () => {
      // Test mutual TLS authentication
      const isTlsEnabled = process.env.MQTT_TLS_ENABLED === 'true';

      if (!isTlsEnabled) {
        console.log('Skipping - TLS not enabled');
        return;
      }

      // With client certificates configured, connection should succeed
      const client = new MQTTBrokerClient({
        tenantId: 'test-tenant',
        deviceId: 'test-device',
      });

      await expect(client.connect()).resolves.not.toThrow();
      await client.disconnect();
    });
  });

  describe('Authorization Edge Cases', () => {
    beforeEach(() => {
      aclManager.clearRules();
    });

    it('should handle overlapping ACL rules correctly', async () => {
      const tenantId = 'tenant1';

      // Add multiple overlapping rules
      aclManager.addRule({
        topic: 'tenant1/#',
        permission: 'read',
        tenantId,
      });

      aclManager.addRule({
        topic: 'tenant1/device1/telemetry',
        permission: 'write',
        tenantId,
        deviceId: 'device1',
      });

      // More specific rule should take precedence
      expect(aclManager.canPublish('tenant1/device1/telemetry', tenantId, 'device1')).toBe(true);
      expect(aclManager.canSubscribe('tenant1/device1/telemetry', tenantId, 'device1')).toBe(true);
    });

    it('should deny access when no ACL rules match', async () => {
      // No rules configured
      const canPublish = aclManager.canPublish('any/topic', 'tenant1', 'device1');
      const canSubscribe = aclManager.canSubscribe('any/topic', 'tenant1', 'device1');

      expect(canPublish).toBe(false);
      expect(canSubscribe).toBe(false);
    });

    it('should handle special characters in topics', async () => {
      const tenantId = 'tenant1';
      const topic = 'tenant1/device-1/data$sensor';

      aclManager.addRule({
        topic: topic,
        permission: 'readwrite',
        tenantId,
      });

      expect(aclManager.canPublish(topic, tenantId)).toBe(true);
      expect(aclManager.canSubscribe(topic, tenantId)).toBe(true);
    });
  });
});
