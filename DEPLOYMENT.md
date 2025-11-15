# Deployment Guide

## Production Deployment Checklist

### Pre-Deployment

- [ ] Configure TLS/SSL certificates
- [ ] Set up authentication for MQTT broker
- [ ] Configure production environment variables
- [ ] Set up monitoring and alerting
- [ ] Configure backup strategy for MongoDB
- [ ] Set up log aggregation
- [ ] Review and configure rate limits
- [ ] Set up ACL rules
- [ ] Configure firewall rules
- [ ] Set up load balancer (if clustering)

### Environment Variables

Create a production `.env` file:

```env
NODE_ENV=production

# MQTT Broker
MQTT_BROKER_TYPE=emqx
MQTT_BROKER_URL=mqtts://mqtt.example.com:8883
MQTT_PROTOCOL_VERSION=5
MQTT_TLS_ENABLED=true
MQTT_TLS_CA_PATH=/app/certs/ca.crt
MQTT_TLS_CERT_PATH=/app/certs/client.crt
MQTT_TLS_KEY_PATH=/app/certs/client.key
MQTT_USERNAME=production-client
MQTT_PASSWORD=<secure-password>

# Clustering
MQTT_CLUSTER_ENABLED=true
MQTT_CLUSTER_NODES=mqtt1.example.com:8883,mqtt2.example.com:8883,mqtt3.example.com:8883

# Rate Limiting
RATE_LIMIT_MESSAGES_PER_SECOND=1000
RATE_LIMIT_BURST_SIZE=2000
RATE_LIMIT_PAYLOAD_MAX_SIZE=2097152
RATE_LIMIT_CONNECTIONS_PER_TENANT=5000

# Storage
STORAGE_HOT_URL=redis://redis-cluster.example.com:6379
STORAGE_COLD_URL=mongodb://mongo-cluster.example.com:27017/iot-platform?replicaSet=rs0

# Logging
LOG_LEVEL=info
LOG_OUTPUT_DIR=/var/log/iot-platform

# Metrics
METRICS_ENABLED=true
METRICS_PORT=9090
```

## Docker Deployment

### 1. Build Image

```bash
docker build -t iot-platform:1.0.0 .
docker tag iot-platform:1.0.0 your-registry.com/iot-platform:1.0.0
docker push your-registry.com/iot-platform:1.0.0
```

### 2. Deploy with Docker Compose

```bash
# Pull images
docker-compose pull

# Start services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f iot-platform
```

### 3. Scale Services

```bash
# Scale application instances
docker-compose up -d --scale iot-platform=3
```

## Kubernetes Deployment

### Prerequisites
- Kubernetes cluster (1.25+)
- kubectl configured
- Helm 3.x

### 1. Create Namespace

```bash
kubectl create namespace iot-platform
```

### 2. Create Secrets

```bash
# TLS certificates
kubectl create secret tls mqtt-tls \
  --cert=certs/client.crt \
  --key=certs/client.key \
  -n iot-platform

# MQTT credentials
kubectl create secret generic mqtt-credentials \
  --from-literal=username=production-client \
  --from-literal=password=<secure-password> \
  -n iot-platform

# MongoDB credentials
kubectl create secret generic mongodb-credentials \
  --from-literal=username=iot-platform \
  --from-literal=password=<secure-password> \
  -n iot-platform
```

### 3. Deploy with Helm

```bash
helm install iot-platform ./k8s/helm/iot-platform \
  --namespace iot-platform \
  --values values.production.yaml
```

### 4. Verify Deployment

```bash
# Check pods
kubectl get pods -n iot-platform

# Check services
kubectl get svc -n iot-platform

# Check logs
kubectl logs -f deployment/iot-platform -n iot-platform
```

## High Availability Setup

### EMQX Cluster

1. Deploy EMQX cluster with 3+ nodes
2. Configure static node discovery
3. Set up load balancer for MQTT connections

```yaml
# emqx-cluster.yaml
cluster:
  discovery: static
  static:
    seeds:
      - emqx@emqx-0.emqx-headless.iot-platform.svc.cluster.local
      - emqx@emqx-1.emqx-headless.iot-platform.svc.cluster.local
      - emqx@emqx-2.emqx-headless.iot-platform.svc.cluster.local
```

### Redis Cluster

Deploy Redis in cluster mode or use Redis Sentinel:

```bash
# Redis Sentinel
helm install redis bitnami/redis \
  --set architecture=replication \
  --set sentinel.enabled=true \
  --namespace iot-platform
```

### MongoDB Replica Set

Deploy MongoDB as a replica set:

```bash
helm install mongodb bitnami/mongodb \
  --set architecture=replicaset \
  --set replicaCount=3 \
  --namespace iot-platform
```

## Monitoring Setup

### Prometheus

```bash
# Install Prometheus operator
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace
```

### Configure ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: iot-platform
  namespace: iot-platform
spec:
  selector:
    matchLabels:
      app: iot-platform
  endpoints:
  - port: metrics
    interval: 30s
```

### Grafana Dashboards

Import dashboards from `docker/grafana/dashboards/`

## Backup Strategy

### MongoDB Backups

```bash
# Daily backup cron job
0 2 * * * mongodump --uri="mongodb://..." --out=/backups/$(date +%Y%m%d)

# Backup retention (keep 30 days)
find /backups -type d -mtime +30 -exec rm -rf {} \;
```

### Redis Backups

Configure AOF and RDB persistence:

```conf
# redis.conf
save 900 1
save 300 10
save 60 10000
appendonly yes
```

## Security Hardening

### 1. Network Security

```bash
# Firewall rules
# Allow only necessary ports
ufw allow 8883/tcp  # MQTT TLS
ufw allow 443/tcp   # HTTPS API
ufw deny 1883/tcp   # Block non-TLS MQTT
```

### 2. TLS Configuration

Generate certificates:

```bash
# CA certificate
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt

# Server certificate
openssl genrsa -out server.key 4096
openssl req -new -key server.key -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 3650
```

### 3. MQTT Broker Authentication

Configure EMQX authentication:

```bash
# Add users via EMQX dashboard or API
curl -X POST http://localhost:18083/api/v5/authentication/password_based:built_in_database/users \
  -u admin:public \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"device1","password":"securepass123"}'
```

## Performance Tuning

### Node.js Settings

```bash
# Increase memory limit
NODE_OPTIONS="--max-old-space-size=4096"

# Enable cluster mode
PM2_INSTANCES=4
```

### Connection Pool

```env
CONNECTION_POOL_SIZE=50
CONNECTION_POOL_MIN_SIZE=10
CONNECTION_POOL_HEALTH_CHECK_INTERVAL=30000
```

### Backpressure

```env
BACKPRESSURE_HIGH_WATERMARK=50000
BACKPRESSURE_LOW_WATERMARK=25000
```

## Health Checks

### Application Health

```bash
# HTTP health check
curl http://localhost:3000/health

# MQTT connection check
mosquitto_pub -h localhost -p 1883 -t "test" -m "health-check"
```

### Kubernetes Liveness/Readiness

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
```

## Troubleshooting

### Check Logs

```bash
# Docker
docker-compose logs -f iot-platform

# Kubernetes
kubectl logs -f deployment/iot-platform -n iot-platform

# Application logs
tail -f /var/log/iot-platform/mqtt-broker-*.log
```

### Common Issues

1. **Connection timeouts**
   - Check network connectivity
   - Verify firewall rules
   - Check MQTT broker status

2. **High memory usage**
   - Check backpressure metrics
   - Review connection pool size
   - Monitor message queue depth

3. **Message loss**
   - Verify QoS settings
   - Check storage availability
   - Review rate limiting settings

## Rollback Procedure

### Docker Compose

```bash
# Rollback to previous version
docker-compose pull iot-platform:1.0.0
docker-compose up -d
```

### Kubernetes

```bash
# Rollback deployment
kubectl rollout undo deployment/iot-platform -n iot-platform

# Rollback to specific revision
kubectl rollout undo deployment/iot-platform --to-revision=2 -n iot-platform
```

## Maintenance

### Regular Tasks

- [ ] Review and rotate logs weekly
- [ ] Check disk space daily
- [ ] Review metrics and alerts weekly
- [ ] Update dependencies monthly
- [ ] Test backup restore quarterly
- [ ] Review and update ACL rules monthly
- [ ] Performance testing quarterly

### Upgrade Procedure

1. Test upgrade in staging environment
2. Backup all data
3. Schedule maintenance window
4. Deploy new version
5. Run smoke tests
6. Monitor metrics for 24 hours
7. Keep previous version ready for rollback
