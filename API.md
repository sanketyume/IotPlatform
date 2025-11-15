# API Documentation

## REST API Endpoints

### Base URL
```
http://localhost:3000/api
```

### Authentication
Currently, the API does not require authentication. In production, implement JWT or API key authentication.

---

## Endpoints

### Health Check

Check the health status of the application.

**Endpoint:** `GET /health`

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "uptime": 3600
}
```

---

### Create MQTT Client

Create and connect a new MQTT client for a tenant/device.

**Endpoint:** `POST /api/clients`

**Request Body:**
```json
{
  "tenantId": "tenant1",
  "deviceId": "device1"
}
```

**Response:**
```json
{
  "success": true,
  "clientId": "iot-platform-a1b2c3d4",
  "tenantId": "tenant1",
  "deviceId": "device1"
}
```

**Error Response:**
```json
{
  "error": "Failed to create MQTT client",
  "message": "Connection limit exceeded for tenant"
}
```

---

### Subscribe to Topic

Subscribe to MQTT topic(s) with specified QoS.

**Endpoint:** `POST /api/clients/:tenantId/subscribe`

**URL Parameters:**
- `tenantId` (required) - Tenant identifier

**Request Body:**
```json
{
  "deviceId": "device1",
  "topic": "tenant1/device1/telemetry",
  "qos": 1
}
```

**Multiple Topics:**
```json
{
  "deviceId": "device1",
  "topic": ["tenant1/device1/telemetry", "tenant1/device1/status"],
  "qos": 1
}
```

**Response:**
```json
{
  "success": true,
  "topic": "tenant1/device1/telemetry",
  "qos": 1
}
```

---

### Publish Message

Publish a message to an MQTT topic.

**Endpoint:** `POST /api/clients/:tenantId/publish`

**URL Parameters:**
- `tenantId` (required) - Tenant identifier

**Request Body:**
```json
{
  "deviceId": "device1",
  "topic": "tenant1/device1/commands",
  "payload": {
    "command": "setTemperature",
    "value": 22
  },
  "qos": 1,
  "retain": false
}
```

**Response:**
```json
{
  "success": true,
  "topic": "tenant1/device1/commands"
}
```

---

### Register Device Profile

Register a device profile with schema and transformation rules.

**Endpoint:** `POST /api/devices/profiles`

**Request Body:**
```json
{
  "deviceId": "temp-sensor-01",
  "tenantId": "tenant1",
  "deviceType": "temperature-sensor",
  "topics": ["tenant1/temp-sensor-01/telemetry"],
  "qos": 1,
  "schema": {
    "type": "object",
    "properties": {
      "temperature": { "type": "number", "minimum": -50, "maximum": 100 },
      "humidity": { "type": "number", "minimum": 0, "maximum": 100 },
      "timestamp": { "type": "string", "format": "date-time" }
    },
    "required": ["temperature", "timestamp"]
  },
  "transformTemplate": {
    "temp_celsius": "$.temperature",
    "temp_fahrenheit": {
      "transform": "multiply",
      "source": "temperature",
      "params": { "factor": 1.8 }
    },
    "temp_fahrenheit_adjusted": {
      "transform": "default",
      "source": "temp_fahrenheit",
      "params": { "offset": 32 }
    }
  },
  "rateLimits": {
    "messagesPerSecond": 10,
    "payloadMaxSize": 10240
  }
}
```

**Response:**
```json
{
  "success": true,
  "deviceId": "temp-sensor-01"
}
```

---

### Add ACL Rule

Add an access control rule for topic permissions.

**Endpoint:** `POST /api/acl/rules`

**Request Body:**
```json
{
  "topic": "tenant1/+/telemetry",
  "permission": "write",
  "tenantId": "tenant1",
  "deviceId": "device1"
}
```

**Permission Values:**
- `read` - Subscribe only
- `write` - Publish only
- `readwrite` - Both subscribe and publish

**Wildcard Support:**
- `+` - Single-level wildcard (e.g., `tenant1/+/telemetry` matches `tenant1/device1/telemetry`)
- `#` - Multi-level wildcard (e.g., `tenant1/#` matches `tenant1/device1/telemetry/temp`)

**Response:**
```json
{
  "success": true,
  "rule": {
    "topic": "tenant1/+/telemetry",
    "permission": "write",
    "tenantId": "tenant1",
    "deviceId": "device1"
  }
}
```

---

### Get Metrics Summary

Retrieve aggregated metrics for the platform.

**Endpoint:** `GET /api/metrics/summary`

**Response:**
```json
{
  "messagesReceived": 15234,
  "messagesSent": 8452,
  "messagesDropped": 12,
  "connectionsActive": 45,
  "connectionsTotal": 120,
  "errorsTotal": 8,
  "latencyMs": 23.5,
  "throughputBytesPerSecond": 125000
}
```

---

### Prometheus Metrics

Get detailed metrics in Prometheus format.

**Endpoint:** `GET /metrics`

**Response:** (Prometheus format)
```
# HELP mqtt_messages_received_total Total number of MQTT messages received
# TYPE mqtt_messages_received_total counter
mqtt_messages_received_total{tenant_id="tenant1",device_id="device1",topic="telemetry",qos="1"} 15234

# HELP mqtt_active_connections Number of active MQTT connections
# TYPE mqtt_active_connections gauge
mqtt_active_connections 45
```

---

## WebSocket API (MQTT over WebSocket)

Connect to MQTT broker via WebSocket for browser-based clients.

**Endpoint:** `ws://localhost:9001`

**Example (JavaScript):**
```javascript
const mqtt = require('mqtt');

const client = mqtt.connect('ws://localhost:9001', {
  clientId: 'web-client-' + Math.random().toString(16).substr(2, 8),
  username: 'your-username',
  password: 'your-password'
});

client.on('connect', () => {
  console.log('Connected to MQTT broker');

  // Subscribe
  client.subscribe('tenant1/+/telemetry', { qos: 1 });

  // Publish
  client.publish('tenant1/device1/commands', JSON.stringify({
    command: 'status'
  }), { qos: 1 });
});

client.on('message', (topic, message) => {
  console.log('Received:', topic, message.toString());
});
```

---

## Data Models

### Device Profile

```typescript
interface DeviceProfile {
  deviceId: string;           // Unique device identifier
  tenantId: string;           // Tenant identifier
  deviceType: string;         // Device type/model
  schema?: object;            // JSON Schema for validation
  transformTemplate?: object; // Transformation rules
  topics: string[];           // Allowed topics
  qos: 0 | 1 | 2;            // Default QoS level
  rateLimits?: {
    messagesPerSecond: number;
    payloadMaxSize: number;
  };
}
```

### ACL Rule

```typescript
interface ACLRule {
  topic: string;                      // Topic pattern (supports wildcards)
  permission: 'read' | 'write' | 'readwrite';
  tenantId?: string;                  // Optional tenant restriction
  deviceId?: string;                  // Optional device restriction
}
```

### MQTT Message

```typescript
interface MQTTMessage {
  topic: string;              // MQTT topic
  payload: Buffer | string;   // Message payload
  qos: 0 | 1 | 2;            // Quality of Service
  retain: boolean;            // Retain flag
  timestamp: Date;            // Message timestamp
  correlationId: string;      // Unique correlation ID
  properties?: {              // MQTT 5.0 properties
    messageExpiryInterval?: number;
    contentType?: string;
    responseTopic?: string;
    correlationData?: Buffer;
    userProperties?: Record<string, string>;
  };
}
```

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid request parameters |
| 404 | Not Found - Resource not found |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Broker not connected |

**Error Response Format:**
```json
{
  "error": "Error type",
  "message": "Detailed error message",
  "correlationId": "abc123"
}
```

---

## Rate Limiting

API endpoints are subject to rate limiting based on tenant configuration.

**Headers:**
- `X-RateLimit-Limit` - Maximum requests allowed
- `X-RateLimit-Remaining` - Remaining requests in current window
- `X-RateLimit-Reset` - Time when the rate limit resets

**Rate Limit Response:**
```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests, please try again later",
  "retryAfter": 60
}
```

---

## Topic Naming Convention

Recommended topic structure:

```
{tenantId}/{deviceId}/{messageType}
```

**Examples:**
- `tenant1/device1/telemetry` - Device telemetry data
- `tenant1/device1/commands` - Commands to device
- `tenant1/device1/status` - Device status updates
- `tenant1/device1/events` - Device events

**Wildcard Subscriptions:**
- `tenant1/+/telemetry` - All devices' telemetry in tenant1
- `tenant1/device1/#` - All topics for device1
- `+/+/telemetry` - All telemetry from all tenants (admin only)

---

## Message Formats

### JSON Format (Default)

```json
{
  "temperature": 22.5,
  "humidity": 65,
  "timestamp": "2025-01-15T10:30:00Z"
}
```

### Binary Format

Binary payload encoded as base64:
```
AQIDBAUGBwgJCg==
```

### Protobuf Format

Define your protobuf schema and encode messages accordingly.

**Example Schema:**
```protobuf
syntax = "proto3";

message Telemetry {
  float temperature = 1;
  float humidity = 2;
  int64 timestamp = 3;
}
```

---

## Transformation Templates

Transform incoming data using templates:

```json
{
  "transformTemplate": {
    // Direct mapping
    "temp": "$.temperature",

    // Mathematical transformation
    "temp_fahrenheit": {
      "transform": "multiply",
      "source": "temperature",
      "params": { "factor": 1.8 }
    },

    // Rounding
    "humidity_rounded": {
      "transform": "round",
      "source": "humidity",
      "params": { "decimals": 1 }
    },

    // Default value
    "location": {
      "transform": "default",
      "source": "location",
      "params": { "defaultValue": "unknown" }
    }
  }
}
```

**Available Transformations:**
- `multiply`, `divide` - Mathematical operations
- `round` - Round to specified decimals
- `uppercase`, `lowercase` - String transformations
- `timestamp` - Convert to Unix timestamp
- `boolean` - Convert to boolean
- `default` - Provide default value if missing

---

## Examples

### Complete Device Setup

1. **Register device profile:**
```bash
curl -X POST http://localhost:3000/api/devices/profiles \
  -H 'Content-Type: application/json' \
  -d '{
    "deviceId": "sensor-01",
    "tenantId": "factory-1",
    "deviceType": "temperature-sensor",
    "topics": ["factory-1/sensor-01/telemetry"],
    "qos": 1,
    "schema": {
      "type": "object",
      "properties": {
        "temperature": { "type": "number" }
      }
    }
  }'
```

2. **Add ACL rules:**
```bash
curl -X POST http://localhost:3000/api/acl/rules \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "factory-1/sensor-01/telemetry",
    "permission": "write",
    "tenantId": "factory-1",
    "deviceId": "sensor-01"
  }'
```

3. **Create client and subscribe:**
```bash
curl -X POST http://localhost:3000/api/clients \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId": "factory-1",
    "deviceId": "sensor-01"
  }'

curl -X POST http://localhost:3000/api/clients/factory-1/subscribe \
  -H 'Content-Type: application/json' \
  -d '{
    "deviceId": "sensor-01",
    "topic": "factory-1/sensor-01/commands",
    "qos": 1
  }'
```

4. **Publish telemetry data:**
```bash
curl -X POST http://localhost:3000/api/clients/factory-1/publish \
  -H 'Content-Type: application/json' \
  -d '{
    "deviceId": "sensor-01",
    "topic": "factory-1/sensor-01/telemetry",
    "payload": {"temperature": 22.5, "timestamp": "2025-01-15T10:30:00Z"},
    "qos": 1
  }'
```
