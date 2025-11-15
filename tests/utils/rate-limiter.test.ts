import { RateLimiter } from '../../src/utils/rate-limiter';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = RateLimiter.getInstance();
  });

  afterEach(() => {
    rateLimiter.shutdown();
  });

  describe('checkMessageRate', () => {
    it('should allow messages within rate limit', () => {
      const result = rateLimiter.checkMessageRate('tenant1', 1);
      expect(result).toBe(true);
    });

    it('should block messages exceeding rate limit', () => {
      const tenantId = 'tenant-test';

      // Exhaust the token bucket
      for (let i = 0; i < 300; i++) {
        rateLimiter.checkMessageRate(tenantId);
      }

      // Next message should be blocked
      const result = rateLimiter.checkMessageRate(tenantId);
      expect(result).toBe(false);
    });

    it('should track tokens correctly', () => {
      const tenantId = 'tenant-tokens';

      rateLimiter.checkMessageRate(tenantId, 5);
      const remaining = rateLimiter.getRemainingTokens(tenantId);

      expect(remaining).toBeLessThan(200); // Assuming burst size is 200
    });
  });

  describe('checkPayloadSize', () => {
    it('should allow payloads within size limit', () => {
      const result = rateLimiter.checkPayloadSize('tenant1', 1024);
      expect(result).toBe(true);
    });

    it('should block payloads exceeding size limit', () => {
      const result = rateLimiter.checkPayloadSize('tenant1', 10 * 1024 * 1024); // 10MB
      expect(result).toBe(false);
    });
  });

  describe('checkConnectionLimit', () => {
    it('should allow connections within limit', () => {
      const result = rateLimiter.checkConnectionLimit('tenant1');
      expect(result).toBe(true);
    });

    it('should track connection count', () => {
      const tenantId = 'tenant-conn';

      rateLimiter.incrementConnectionCount(tenantId);
      rateLimiter.incrementConnectionCount(tenantId);

      const count = rateLimiter.getConnectionCount(tenantId);
      expect(count).toBe(2);

      rateLimiter.decrementConnectionCount(tenantId);
      const newCount = rateLimiter.getConnectionCount(tenantId);
      expect(newCount).toBe(1);
    });
  });

  describe('resetLimits', () => {
    it('should reset limits for tenant', () => {
      const tenantId = 'tenant-reset';

      rateLimiter.checkMessageRate(tenantId, 10);
      rateLimiter.resetLimits(tenantId);

      const remaining = rateLimiter.getRemainingTokens(tenantId);
      expect(remaining).toBeGreaterThan(100);
    });
  });
});
