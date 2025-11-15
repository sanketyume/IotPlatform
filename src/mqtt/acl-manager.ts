import logger from '../utils/logger';
import { ACLRule } from '../types';

export class ACLManager {
  private static instance: ACLManager;
  private rules: Map<string, ACLRule[]>;

  private constructor() {
    this.rules = new Map();
  }

  static getInstance(): ACLManager {
    if (!ACLManager.instance) {
      ACLManager.instance = new ACLManager();
    }
    return ACLManager.instance;
  }

  addRule(rule: ACLRule): void {
    const key = this.generateRuleKey(rule.tenantId, rule.deviceId);
    const existingRules = this.rules.get(key) || [];
    existingRules.push(rule);
    this.rules.set(key, existingRules);

    logger.debug('ACL rule added', {
      correlationId: logger.generateCorrelationId(),
      tenantId: rule.tenantId,
      deviceId: rule.deviceId,
      topic: rule.topic,
      permission: rule.permission,
    });
  }

  removeRule(tenantId?: string, deviceId?: string, topic?: string): void {
    const key = this.generateRuleKey(tenantId, deviceId);
    const existingRules = this.rules.get(key) || [];

    if (topic) {
      const filteredRules = existingRules.filter((rule) => rule.topic !== topic);
      this.rules.set(key, filteredRules);
    } else {
      this.rules.delete(key);
    }

    logger.debug('ACL rule removed', {
      correlationId: logger.generateCorrelationId(),
      tenantId,
      deviceId,
      topic,
    });
  }

  canPublish(topic: string, tenantId?: string, deviceId?: string): boolean {
    return this.checkPermission(topic, 'write', tenantId, deviceId);
  }

  canSubscribe(topic: string, tenantId?: string, deviceId?: string): boolean {
    return this.checkPermission(topic, 'read', tenantId, deviceId);
  }

  private checkPermission(
    topic: string,
    requiredPermission: 'read' | 'write',
    tenantId?: string,
    deviceId?: string,
  ): boolean {
    // Get rules for specific device
    const deviceKey = this.generateRuleKey(tenantId, deviceId);
    const deviceRules = this.rules.get(deviceKey) || [];

    // Get rules for all devices in tenant
    const tenantKey = this.generateRuleKey(tenantId);
    const tenantRules = this.rules.get(tenantKey) || [];

    // Get global rules
    const globalKey = this.generateRuleKey();
    const globalRules = this.rules.get(globalKey) || [];

    // Check rules in order of specificity: device -> tenant -> global
    const allRules = [...deviceRules, ...tenantRules, ...globalRules];

    for (const rule of allRules) {
      if (this.topicMatches(topic, rule.topic)) {
        if (
          rule.permission === 'readwrite' ||
          rule.permission === requiredPermission
        ) {
          logger.debug('ACL permission granted', {
            correlationId: logger.generateCorrelationId(),
            topic,
            tenantId,
            deviceId,
            permission: requiredPermission,
            matchedRule: rule.topic,
          });
          return true;
        }
      }
    }

    logger.warn('ACL permission denied', {
      correlationId: logger.generateCorrelationId(),
      topic,
      tenantId,
      deviceId,
      permission: requiredPermission,
    });

    return false;
  }

  private topicMatches(actualTopic: string, ruleTopic: string): boolean {
    // Split topics into parts
    const actualParts = actualTopic.split('/');
    const ruleParts = ruleTopic.split('/');

    // Handle multi-level wildcard (#)
    const hashIndex = ruleParts.indexOf('#');
    if (hashIndex !== -1) {
      // # must be the last character and must be the only character in that level
      if (hashIndex !== ruleParts.length - 1) {
        return false;
      }
      // Match all parts up to the #
      return this.matchTopicParts(actualParts.slice(0, hashIndex), ruleParts.slice(0, hashIndex));
    }

    // Topics must have same number of levels if no #
    if (actualParts.length !== ruleParts.length) {
      return false;
    }

    return this.matchTopicParts(actualParts, ruleParts);
  }

  private matchTopicParts(actualParts: string[], ruleParts: string[]): boolean {
    for (let i = 0; i < ruleParts.length; i++) {
      const rulePart = ruleParts[i];
      const actualPart = actualParts[i];

      // Single-level wildcard (+) matches any single level
      if (rulePart === '+') {
        continue;
      }

      // Exact match required
      if (rulePart !== actualPart) {
        return false;
      }
    }

    return true;
  }

  private generateRuleKey(tenantId?: string, deviceId?: string): string {
    if (deviceId && tenantId) {
      return `${tenantId}:${deviceId}`;
    }
    if (tenantId) {
      return `${tenantId}:*`;
    }
    return '*:*';
  }

  getRules(tenantId?: string, deviceId?: string): ACLRule[] {
    const key = this.generateRuleKey(tenantId, deviceId);
    return this.rules.get(key) || [];
  }

  clearRules(): void {
    this.rules.clear();
    logger.info('All ACL rules cleared', {
      correlationId: logger.generateCorrelationId(),
    });
  }
}

export default ACLManager.getInstance();
