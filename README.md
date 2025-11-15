# IoT Platform MQTT Broker Integration

A production-ready MQTT broker integration module with comprehensive features for IoT device management, message processing, and data storage.

## Features

### MQTT Broker Support
- **Mosquitto** and **EMQX** broker support
- MQTT 3.1.1 and 5.0 protocol versions
- Clustering support for high availability
- TLS/SSL encryption with certificate validation
- QoS levels 0, 1, and 2
- Persistent and clean sessions
- Last Will and Testament (LWT) messages
- Retained messages support

### Connection Management
- Connection pooling with health monitoring
- Auto-reconnection with exponential backoff
- Circuit breaker pattern for failover
- Load balancing across broker cluster
- Connection limits per tenant

### Data Pipeline
- Message parsing (JSON, Binary, Protobuf)
- Schema validation against device profiles
- Data transformation based on templates
- Message routing to hot/cold storage
- Backpressure handling with token bucket
- Message ordering per device

### Access Control
- Topic-based ACL with wildcard support (`+`, `#`)
- Multi-level permissions (read, write, readwrite)
- Tenant and device-level isolation

### Rate Limiting
- Messages per second throttling
- Payload size limits
- Connection limits per tenant
- Burst handling with token bucket algorithm

### Observability
- Comprehensive logging with correlation IDs
- Prometheus metrics collection
- Error tracking and alerting
- Health check endpoints

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MQTT Broker Client                       │
├─────────────────────────────────────────────────────────────┤
│  Connection Pool  │  ACL Manager  │  Rate Limiter           │
├─────────────────────────────────────────────────────────────┤
│                      Data Pipeline                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Parser  │→ │ Validator│→ │Transform │→ │  Router  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
├─────────────────────────────────────────────────────────────┤
│              Storage Layer (Hot/Cold)                        │
│         Redis (Hot)          MongoDB (Cold)                  │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites
- Node.js 18+
- Docker and Docker Compose (for running services)
- Redis (for hot storage)
- MongoDB (for cold storage)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd IotPlatform
```

2. Install dependencies:
```bash
npm install
```

3. Copy environment configuration:
```bash
cp .env.example .env
```

4. Configure environment variables in `.env`

### Running with Docker Compose

Start all services (MQTT broker, Redis, MongoDB, and the application):

```bash
# Start with Mosquitto (default)
docker-compose up -d

# Start with EMQX
docker-compose --profile emqx up -d

# Start with monitoring (Prometheus + Grafana)
docker-compose --profile monitoring up -d
```

### Running Locally

1. Start required services:
```bash
docker-compose up -d mosquitto redis mongodb
```

2. Start the application:
```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Configuration

All configuration is done through environment variables. See `.env.example` for all available options.

### Key Configuration Options

```env
# MQTT Broker
MQTT_BROKER_TYPE=mosquitto
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_PROTOCOL_VERSION=5

# TLS/SSL
MQTT_TLS_ENABLED=false
MQTT_TLS_CA_PATH=./certs/ca.crt
MQTT_TLS_CERT_PATH=./certs/client.crt
MQTT_TLS_KEY_PATH=./certs/client.key

# Rate Limiting
RATE_LIMIT_MESSAGES_PER_SECOND=100
RATE_LIMIT_BURST_SIZE=200
RATE_LIMIT_PAYLOAD_MAX_SIZE=1048576

# Storage
STORAGE_HOT_URL=redis://localhost:6379
STORAGE_COLD_URL=mongodb://localhost:27017/iot-platform
```

## Usage

### Creating an MQTT Client

```typescript
import { MQTTBrokerClient, DeviceProfile } from './src';

// Create client
const client = new MQTTBrokerClient({
  tenantId: 'tenant1',
  deviceId: 'device1',
  useConnectionPool: true,
});

// Connect
await client.connect();

// Subscribe to topics
await client.subscribe('tenant1/device1/telemetry', 1);

// Publish message
await client.publish('tenant1/device1/commands', JSON.stringify({
  command: 'setTemperature',
  value: 22
}), { qos: 1 });

// Handle messages
client.on('message', (message) => {
  console.log('Received:', message);
});
```

### Registering Device Profile

```typescript
const deviceProfile: DeviceProfile = {
  deviceId: 'device1',
  tenantId: 'tenant1',
  deviceType: 'temperature-sensor',
  topics: ['tenant1/device1/telemetry'],
  qos: 1,
  schema: {
    type: 'object',
    properties: {
      temperature: { type: 'number' },
      humidity: { type: 'number' },
      timestamp: { type: 'string', format: 'date-time' }
    },
    required: ['temperature', 'timestamp']
  },
  transformTemplate: {
    temp_celsius: '$.temperature',
    temp_fahrenheit: {
      transform: 'multiply',
      source: 'temperature',
      params: { factor: 1.8, offset: 32 }
    }
  }
};

client.registerDeviceProfile(deviceProfile);
```

### Adding ACL Rules

```typescript
import aclManager from './src/mqtt/acl-manager';

// Allow device to publish telemetry
aclManager.addRule({
  topic: 'tenant1/+/telemetry',
  permission: 'write',
  tenantId: 'tenant1'
});

// Allow device to subscribe to commands
aclManager.addRule({
  topic: 'tenant1/+/commands',
  permission: 'read',
  tenantId: 'tenant1'
});
```

## API Endpoints

### Health Check
```
GET /health
```

### Create MQTT Client
```
POST /api/clients
Body: { tenantId: string, deviceId?: string }
```

### Subscribe to Topic
```
POST /api/clients/:tenantId/subscribe
Body: { deviceId?: string, topic: string, qos?: number }
```

### Publish Message
```
POST /api/clients/:tenantId/publish
Body: { deviceId?: string, topic: string, payload: any, qos?: number, retain?: boolean }
```

### Register Device Profile
```
POST /api/devices/profiles
Body: DeviceProfile
```

### Add ACL Rule
```
POST /api/acl/rules
Body: ACLRule
```

### Get Metrics
```
GET /api/metrics/summary
GET /metrics (Prometheus format)
```

## Testing

Run tests:
```bash
# All tests
npm test

# With coverage
npm test -- --coverage

# Watch mode
npm run test:watch
```

## Monitoring

### Prometheus Metrics

Access Prometheus metrics at `http://localhost:9090/metrics`

Available metrics:
- `mqtt_messages_received_total` - Total messages received
- `mqtt_messages_sent_total` - Total messages sent
- `mqtt_messages_dropped_total` - Total messages dropped
- `mqtt_active_connections` - Active connections
- `mqtt_errors_total` - Total errors
- `mqtt_message_latency_ms` - Message processing latency
- `mqtt_backpressure_level` - Current backpressure level

### Grafana Dashboards

Access Grafana at `http://localhost:3001` (admin/admin)

Dashboards include:
- Connection monitoring
- Message throughput
- Error rates
- Latency percentiles

## Deployment

### Production Deployment

1. Build Docker image:
```bash
docker build -t iot-platform:latest .
```

2. Deploy with docker-compose:
```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Kubernetes Deployment

Helm charts and Kubernetes manifests are available in the `k8s/` directory.

```bash
helm install iot-platform ./k8s/helm/iot-platform
```

## Security Considerations

1. **TLS/SSL**: Always enable TLS in production
2. **Authentication**: Configure MQTT broker authentication
3. **ACL**: Implement strict ACL rules
4. **Rate Limiting**: Configure appropriate rate limits
5. **Network Security**: Use VPC/private networks
6. **Secrets Management**: Use secret managers (not .env files)

## Performance Tuning

### Connection Pool
```env
CONNECTION_POOL_SIZE=10
CONNECTION_POOL_MIN_SIZE=2
```

### Backpressure
```env
BACKPRESSURE_HIGH_WATERMARK=10000
BACKPRESSURE_LOW_WATERMARK=5000
```

### Rate Limiting
```env
RATE_LIMIT_MESSAGES_PER_SECOND=1000
RATE_LIMIT_BURST_SIZE=2000
```

## Troubleshooting

### Connection Issues
- Check broker is running: `docker-compose ps`
- Verify broker URL in `.env`
- Check firewall rules
- Review logs: `docker-compose logs iot-platform`

### High Latency
- Check backpressure metrics
- Increase connection pool size
- Review storage performance
- Check network latency to broker

### Memory Issues
- Adjust backpressure watermarks
- Reduce connection pool size
- Enable message cleanup in storage

## License

MIT

## Contributing

Contributions welcome! Please read CONTRIBUTING.md for guidelines.

## Support

For issues and questions, please open a GitHub issue.
