## MQTT Module Implementation Verification Guide

This document describes how to verify all aspects of the MQTT broker integration module.

## Quick Start

Run the automated verification suite:

```bash
./scripts/verify-implementation.sh
```

This will:
1. Check prerequisites
2. Start required services
3. Run all test suites
4. Generate a comprehensive report

## Manual Verification

### 1. Broker Clustering Tests

#### Failover Testing

**Setup:**
```bash
# Start broker cluster
docker-compose up -d mosquitto emqx redis mongodb
```

**Test Failover:**
```bash
# Run clustering tests
npm test -- tests/integration/broker-clustering.test.ts -t "failover"

# Or manually:
# 1. Connect clients to primary broker
# 2. Stop primary: docker-compose stop mosquitto
# 3. Verify clients reconnect to secondary
# 4. Check no messages lost
```

**Expected Results:**
- ✅ Clients automatically reconnect to secondary broker
- ✅ Subscriptions are restored
- ✅ Messages continue to flow
- ✅ Reconnection time < 10 seconds

#### Load Distribution

**Test:**
```bash
npm test -- tests/integration/broker-clustering.test.ts -t "distribution"
```

**Verification:**
- Check connection logs show round-robin allocation
- Verify messages distributed across cluster nodes
- Monitor node CPU/memory usage is balanced

#### Session Replication

**Test:**
```bash
npm test -- tests/integration/broker-clustering.test.ts -t "session"
```

**Expected:**
- ✅ Persistent sessions survive client reconnection
- ✅ Subscriptions persist across connections
- ✅ Retained messages available on new subscriptions

---

### 2. Security Tests

#### TLS/SSL Enforcement

**Prerequisites:**
```bash
# Generate test certificates
mkdir -p certs
cd certs

# CA certificate
openssl genrsa -out ca.key 2048
openssl req -new -x509 -days 365 -key ca.key -out ca.crt -subj "/CN=Test CA"

# Server certificate
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=localhost"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365

# Client certificate
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -subj "/CN=Test Client"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt -days 365

cd ..
```

**Enable TLS:**
```bash
# Update .env
echo "MQTT_TLS_ENABLED=true" >> .env
echo "MQTT_TLS_CA_PATH=./certs/ca.crt" >> .env
echo "MQTT_TLS_CERT_PATH=./certs/client.crt" >> .env
echo "MQTT_TLS_KEY_PATH=./certs/client.key" >> .env
```

**Test:**
```bash
npm test -- tests/integration/security.test.ts -t "TLS"
```

**Verification Checklist:**
- ✅ Non-TLS connections rejected when TLS enforced
- ✅ Valid certificates accepted
- ✅ Invalid certificates rejected
- ✅ Expired certificates rejected
- ✅ Certificate chain validated

#### ACL Topic Access

**Test:**
```bash
npm test -- tests/integration/security.test.ts -t "ACL"
```

**Manual Verification:**
```typescript
import aclManager from './src/mqtt/acl-manager';

// Test single-level wildcard
aclManager.addRule({
  topic: 'tenant1/+/telemetry',
  permission: 'write',
  tenantId: 'tenant1'
});

// Should allow
aclManager.canPublish('tenant1/device1/telemetry', 'tenant1'); // true
aclManager.canPublish('tenant1/device2/telemetry', 'tenant1'); // true

// Should deny
aclManager.canPublish('tenant1/device1/commands', 'tenant1'); // false
aclManager.canPublish('tenant2/device1/telemetry', 'tenant1'); // false

// Test multi-level wildcard
aclManager.addRule({
  topic: 'tenant1/#',
  permission: 'readwrite',
  tenantId: 'tenant1'
});

// Should allow all under tenant1
aclManager.canPublish('tenant1/any/path/here', 'tenant1'); // true
```

**Checklist:**
- ✅ Single-level wildcard (+) matches correctly
- ✅ Multi-level wildcard (#) matches correctly
- ✅ Cross-tenant access denied
- ✅ Device-level isolation enforced
- ✅ Read/write permissions enforced separately

#### Authentication

**Test Username/Password:**
```bash
# Set credentials
export MQTT_USERNAME=testuser
export MQTT_PASSWORD=testpass

npm test -- tests/integration/security.test.ts -t "authentication"
```

**Test Certificate Auth:**
```bash
export MQTT_TLS_ENABLED=true
npm test -- tests/integration/security.test.ts -t "certificate"
```

**Checklist:**
- ✅ Valid credentials accepted
- ✅ Invalid credentials rejected
- ✅ Certificate-based auth working
- ✅ Anonymous connections blocked when auth enabled

---

### 3. Data Pipeline Tests

#### Message Parsing

**Test All Formats:**
```bash
npm test -- tests/integration/data-pipeline.test.ts -t "parsing"
```

**Manual Test:**
```typescript
import messageParser from './src/pipeline/message-parser';

// JSON
const jsonMsg = await messageParser.parse(
  { payload: Buffer.from('{"temp":22.5}'), ... },
  'json',
  metadata
);

// Binary
const binaryMsg = await messageParser.parse(
  { payload: Buffer.from([0x01, 0x02, 0x03]), ... },
  'binary',
  metadata
);

// Auto-detect
const format = messageParser.detectFormat(payload);
```

**Checklist:**
- ✅ JSON parsing correct
- ✅ Binary parsing preserves data
- ✅ Protobuf parsing (if schema loaded)
- ✅ Format auto-detection working
- ✅ Malformed messages handled gracefully

#### Schema Validation

**Test:**
```bash
npm test -- tests/integration/data-pipeline.test.ts -t "validation"
```

**Example Schema Test:**
```typescript
const deviceProfile = {
  schema: {
    type: 'object',
    properties: {
      temperature: { type: 'number', min: -50, max: 100 },
      humidity: { type: 'number', min: 0, max: 100 }
    },
    required: ['temperature']
  }
};

// Valid message
validator.validate(
  { data: { temperature: 22.5, humidity: 65 } },
  deviceProfile
); // { valid: true }

// Invalid message
validator.validate(
  { data: { temperature: 150 } }, // exceeds max
  deviceProfile
); // { valid: false, errors: [...] }
```

**Checklist:**
- ✅ Valid messages pass
- ✅ Invalid messages rejected with clear errors
- ✅ Required fields enforced
- ✅ Type validation working
- ✅ Range validation working
- ✅ Custom formats supported

#### Data Transformation

**Test:**
```bash
npm test -- tests/integration/data-pipeline.test.ts -t "transformation"
```

**Example Transforms:**
```typescript
const template = {
  // Direct mapping
  celsius: '$.temperature',

  // Math operations
  fahrenheit: {
    transform: 'multiply',
    source: 'temperature',
    params: { factor: 1.8 }
  },

  // Rounding
  rounded: {
    transform: 'round',
    source: 'value',
    params: { decimals: 2 }
  },

  // Default values
  location: {
    transform: 'default',
    source: 'location',
    params: { defaultValue: 'unknown' }
  }
};
```

**Checklist:**
- ✅ Direct field mapping
- ✅ Mathematical transformations (multiply, divide)
- ✅ Rounding to decimals
- ✅ String transformations (uppercase, lowercase)
- ✅ Type conversions (boolean, timestamp)
- ✅ Default values for missing fields
- ✅ Nested transformations

#### Message Ordering

**Test:**
```bash
npm test -- tests/integration/data-pipeline.test.ts -t "ordering"
```

**Load Test:**
```typescript
// Send 1000 messages rapidly
for (let i = 0; i < 1000; i++) {
  await dataPipeline.process({
    payload: { sequence: i },
    timestamp: new Date(Date.now() + i)
  }, 'tenant1', 'device1');
}

// Verify order maintained
```

**Checklist:**
- ✅ Messages processed in timestamp order
- ✅ Out-of-order messages detected and logged
- ✅ Per-device ordering maintained
- ✅ Ordering preserved under load

---

### 4. Performance Tests

#### Concurrent Connections

**Test:**
```bash
npm test -- tests/performance/benchmark.test.ts -t "concurrent"
```

**Manual Load Test:**
```bash
# Use mqtt-benchmark tool
npm install -g mqtt-benchmark

mqtt-benchmark --broker tcp://localhost:1883 \
  --clients 1000 \
  --rate 100
```

**Benchmarks:**
- ✅ 100 connections: Should establish in < 5 seconds
- ✅ 1,000 connections: Should establish in < 30 seconds
- ✅ 10,000 connections: Should achieve >80% success rate

**Monitor:**
```bash
# Watch connection pool
docker-compose logs -f iot-platform | grep "connection"

# Check metrics
curl http://localhost:9090/metrics | grep mqtt_active_connections
```

#### Throughput

**Test:**
```bash
npm test -- tests/performance/benchmark.test.ts -t "throughput"
```

**Benchmark:**
```bash
mqtt-benchmark --broker tcp://localhost:1883 \
  --clients 50 \
  --rate 2000 \
  --duration 60
```

**Targets:**
- ✅ 1,000 msg/s: Baseline
- ✅ 10,000 msg/s: Target throughput
- ✅ 100,000 msg/s: Maximum (with optimizations)

**Monitor:**
```bash
# Watch metrics
watch -n 1 'curl -s http://localhost:9090/metrics | grep mqtt_messages_received_total'
```

#### Latency

**Test:**
```bash
npm test -- tests/performance/benchmark.test.ts -t "latency"
```

**Measure End-to-End:**
```typescript
const startTime = Date.now();

await client.publish('test/topic', JSON.stringify({
  timestamp: startTime,
  data: 'test'
}));

client.on('message', (msg) => {
  const latency = Date.now() - JSON.parse(msg.payload).timestamp;
  console.log(`Latency: ${latency}ms`);
});
```

**Targets:**
- ✅ Average latency: < 100ms
- ✅ P95 latency: < 150ms
- ✅ P99 latency: < 200ms

#### Rate Limiting

**Test:**
```bash
npm test -- tests/performance/benchmark.test.ts -t "rate"
```

**Verify Limits:**
```typescript
const tenantId = 'test-tenant';

// Should accept burst
for (let i = 0; i < 200; i++) {
  rateLimiter.checkMessageRate(tenantId); // Most should pass
}

// Should reject sustained over-limit
for (let i = 0; i < 500; i++) {
  rateLimiter.checkMessageRate(tenantId); // Some should fail
}
```

**Checklist:**
- ✅ Token bucket algorithm working
- ✅ Burst traffic handled
- ✅ Sustained over-limit rejected
- ✅ Per-tenant isolation
- ✅ Payload size limits enforced
- ✅ Connection limits enforced

---

### 5. Monitoring Verification

#### Metrics Collection

**Test:**
```bash
npm test -- tests/integration/monitoring.test.ts
```

**Check Prometheus Endpoint:**
```bash
curl http://localhost:9090/metrics
```

**Verify Metrics Present:**
```bash
# Message metrics
curl -s http://localhost:9090/metrics | grep mqtt_messages_received_total
curl -s http://localhost:9090/metrics | grep mqtt_messages_sent_total
curl -s http://localhost:9090/metrics | grep mqtt_messages_dropped_total

# Connection metrics
curl -s http://localhost:9090/metrics | grep mqtt_active_connections
curl -s http://localhost:9090/metrics | grep mqtt_connections_total

# Error metrics
curl -s http://localhost:9090/metrics | grep mqtt_errors_total

# Latency metrics
curl -s http://localhost:9090/metrics | grep mqtt_message_latency_ms

# Backpressure metrics
curl -s http://localhost:9090/metrics | grep mqtt_backpressure_level
```

**Checklist:**
- ✅ All metrics endpoints accessible
- ✅ Metrics include proper labels (tenant_id, device_id, topic, qos)
- ✅ Counters incrementing correctly
- ✅ Gauges updating in real-time
- ✅ Histograms collecting distribution data

#### Logging

**Check Correlation IDs:**
```bash
# Tail logs
tail -f logs/mqtt-broker-*.log | grep correlationId
```

**Verify Log Structure:**
```bash
# Check JSON format
cat logs/mqtt-broker-*.log | head -1 | jq .

# Should contain:
# - timestamp
# - level
# - message
# - correlationId
# - tenantId (if applicable)
# - deviceId (if applicable)
```

**Checklist:**
- ✅ Logs in JSON format
- ✅ Correlation IDs present
- ✅ Proper log levels (error, warn, info, debug)
- ✅ Structured metadata
- ✅ Stack traces for errors
- ✅ Daily log rotation working

#### Health Checks

**API Health:**
```bash
curl http://localhost:3000/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "uptime": 3600
}
```

**Connection Pool Health:**
```typescript
import { ConnectionPool } from './src/mqtt/connection-pool';

const pool = ConnectionPool.getInstance();
const health = pool.getHealthStatus();

console.log(health);
// {
//   healthy: true,
//   connections: 10,
//   activeConnections: 8,
//   messagesPerSecond: 0,
//   errorRate: 0.0,
//   lastHealthCheck: Date
// }
```

**Checklist:**
- ✅ Health endpoints responding
- ✅ Health status accurate
- ✅ Connection pool reporting correctly
- ✅ Error rates tracked
- ✅ Uptime reported

---

## Verification Checklist

### Broker Clustering
- [ ] Failover to secondary broker working
- [ ] Load distribution across cluster nodes
- [ ] Session state persisted and restored
- [ ] Retained messages replicated
- [ ] Circuit breaker preventing cascading failures

### Security
- [ ] TLS/SSL connections enforced
- [ ] Certificate validation working
- [ ] ACL rules properly restricting access
- [ ] Wildcard patterns (+, #) working correctly
- [ ] Cross-tenant isolation enforced
- [ ] Authentication working (username/password and certificates)

### Data Pipeline
- [ ] JSON messages parsed correctly
- [ ] Binary messages handled properly
- [ ] Protobuf parsing (if used)
- [ ] Schema validation rejecting invalid messages
- [ ] Transformations applying correctly
- [ ] Message ordering maintained per device
- [ ] Backpressure preventing overload

### Performance
- [ ] 100+ concurrent connections supported
- [ ] 1,000+ messages/second throughput
- [ ] <100ms average latency
- [ ] Rate limits enforcing correctly
- [ ] Token bucket handling bursts
- [ ] Connection pool efficient

### Monitoring
- [ ] All metrics being collected
- [ ] Prometheus endpoint accessible
- [ ] Logs structured with correlation IDs
- [ ] Health checks responding
- [ ] Error tracking working
- [ ] Alert conditions detectable

---

## Automated Verification

Run the complete verification suite:

```bash
# Full verification with report
./scripts/verify-implementation.sh

# Individual test suites
./scripts/run-tests.sh clustering
./scripts/run-tests.sh security
./scripts/run-tests.sh pipeline
./scripts/run-tests.sh performance
./scripts/run-tests.sh monitoring
```

The verification script will generate a detailed report: `verification-report.md`

---

## Troubleshooting

### Services Not Starting

```bash
# Check Docker
docker-compose ps

# View logs
docker-compose logs mosquitto
docker-compose logs redis
docker-compose logs mongodb

# Restart services
docker-compose restart
```

### Tests Failing

```bash
# Run with verbose output
npm test -- --verbose

# Run specific test
npm test -- tests/integration/security.test.ts -t "ACL"

# Check service connectivity
curl http://localhost:1883  # Mosquitto
curl http://localhost:6379  # Redis
curl http://localhost:27017 # MongoDB
```

### Performance Issues

```bash
# Monitor resources
docker stats

# Check connection pool
curl http://localhost:9090/metrics | grep mqtt_active_connections

# Review backpressure
curl http://localhost:9090/metrics | grep mqtt_backpressure_level
```

---

## Next Steps

After verification:

1. Review the generated `verification-report.md`
2. Address any failed tests
3. Tune configuration based on performance results
4. Deploy to staging environment
5. Run production readiness checklist (see DEPLOYMENT.md)
