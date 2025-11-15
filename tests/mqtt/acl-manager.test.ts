import { ACLManager } from '../../src/mqtt/acl-manager';
import { ACLRule } from '../../src/types';

describe('ACLManager', () => {
  let aclManager: ACLManager;

  beforeEach(() => {
    aclManager = ACLManager.getInstance();
    aclManager.clearRules();
  });

  describe('addRule', () => {
    it('should add ACL rule', () => {
      const rule: ACLRule = {
        topic: 'test/topic',
        permission: 'readwrite',
        tenantId: 'tenant1',
      };

      aclManager.addRule(rule);
      const rules = aclManager.getRules('tenant1');

      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual(rule);
    });
  });

  describe('canPublish', () => {
    it('should allow publish with write permission', () => {
      aclManager.addRule({
        topic: 'test/topic',
        permission: 'write',
        tenantId: 'tenant1',
      });

      const result = aclManager.canPublish('test/topic', 'tenant1');
      expect(result).toBe(true);
    });

    it('should allow publish with readwrite permission', () => {
      aclManager.addRule({
        topic: 'test/topic',
        permission: 'readwrite',
        tenantId: 'tenant1',
      });

      const result = aclManager.canPublish('test/topic', 'tenant1');
      expect(result).toBe(true);
    });

    it('should deny publish with only read permission', () => {
      aclManager.addRule({
        topic: 'test/topic',
        permission: 'read',
        tenantId: 'tenant1',
      });

      const result = aclManager.canPublish('test/topic', 'tenant1');
      expect(result).toBe(false);
    });
  });

  describe('canSubscribe', () => {
    it('should allow subscribe with read permission', () => {
      aclManager.addRule({
        topic: 'test/topic',
        permission: 'read',
        tenantId: 'tenant1',
      });

      const result = aclManager.canSubscribe('test/topic', 'tenant1');
      expect(result).toBe(true);
    });
  });

  describe('wildcard matching', () => {
    it('should match single-level wildcard (+)', () => {
      aclManager.addRule({
        topic: 'test/+/data',
        permission: 'read',
        tenantId: 'tenant1',
      });

      expect(aclManager.canSubscribe('test/device1/data', 'tenant1')).toBe(true);
      expect(aclManager.canSubscribe('test/device2/data', 'tenant1')).toBe(true);
      expect(aclManager.canSubscribe('test/device1/status', 'tenant1')).toBe(false);
    });

    it('should match multi-level wildcard (#)', () => {
      aclManager.addRule({
        topic: 'test/#',
        permission: 'read',
        tenantId: 'tenant1',
      });

      expect(aclManager.canSubscribe('test/device1/data', 'tenant1')).toBe(true);
      expect(aclManager.canSubscribe('test/device1/data/temp', 'tenant1')).toBe(true);
      expect(aclManager.canSubscribe('other/topic', 'tenant1')).toBe(false);
    });
  });

  describe('removeRule', () => {
    it('should remove specific rule', () => {
      aclManager.addRule({
        topic: 'test/topic',
        permission: 'read',
        tenantId: 'tenant1',
      });

      aclManager.removeRule('tenant1', undefined, 'test/topic');
      const rules = aclManager.getRules('tenant1');

      expect(rules).toHaveLength(0);
    });

    it('should remove all rules for tenant', () => {
      aclManager.addRule({
        topic: 'test/topic1',
        permission: 'read',
        tenantId: 'tenant1',
      });

      aclManager.addRule({
        topic: 'test/topic2',
        permission: 'write',
        tenantId: 'tenant1',
      });

      aclManager.removeRule('tenant1');
      const rules = aclManager.getRules('tenant1');

      expect(rules).toHaveLength(0);
    });
  });
});
