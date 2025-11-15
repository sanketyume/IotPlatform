import config from '../config';
import logger from './logger';
import { CircuitBreakerConfig } from '../types';

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitStats {
  failures: number;
  successes: number;
  lastFailureTime?: number;
  halfOpenCalls: number;
}

export class CircuitBreaker {
  private static instance: CircuitBreaker;
  private config: CircuitBreakerConfig;
  private circuits: Map<string, { state: CircuitState; stats: CircuitStats }>;

  private constructor() {
    this.config = config.getCircuitBreakerConfig();
    this.circuits = new Map();
  }

  static getInstance(): CircuitBreaker {
    if (!CircuitBreaker.instance) {
      CircuitBreaker.instance = new CircuitBreaker();
    }
    return CircuitBreaker.instance;
  }

  private getCircuit(name: string) {
    if (!this.circuits.has(name)) {
      this.circuits.set(name, {
        state: CircuitState.CLOSED,
        stats: {
          failures: 0,
          successes: 0,
          halfOpenCalls: 0,
        },
      });
    }
    return this.circuits.get(name)!;
  }

  private shouldTransitionToHalfOpen(circuit: {
    state: CircuitState;
    stats: CircuitStats;
  }): boolean {
    if (circuit.state !== CircuitState.OPEN) {
      return false;
    }

    if (!circuit.stats.lastFailureTime) {
      return false;
    }

    const timeElapsed = Date.now() - circuit.stats.lastFailureTime;
    return timeElapsed >= this.config.resetTimeout;
  }

  private transitionToOpen(name: string, circuit: { state: CircuitState; stats: CircuitStats }) {
    circuit.state = CircuitState.OPEN;
    circuit.stats.lastFailureTime = Date.now();

    logger.error('Circuit breaker opened', {
      correlationId: logger.generateCorrelationId(),
      circuit: name,
      failures: circuit.stats.failures,
      threshold: this.config.failureThreshold,
    });
  }

  private transitionToHalfOpen(circuit: { state: CircuitState; stats: CircuitStats }) {
    circuit.state = CircuitState.HALF_OPEN;
    circuit.stats.halfOpenCalls = 0;

    logger.info('Circuit breaker half-open', {
      correlationId: logger.generateCorrelationId(),
    });
  }

  private transitionToClosed(circuit: { state: CircuitState; stats: CircuitStats }) {
    circuit.state = CircuitState.CLOSED;
    circuit.stats.failures = 0;
    circuit.stats.successes = 0;
    circuit.stats.halfOpenCalls = 0;

    logger.info('Circuit breaker closed', {
      correlationId: logger.generateCorrelationId(),
    });
  }

  async execute<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return fn();
    }

    const circuit = this.getCircuit(name);

    // Check if we should transition to half-open
    if (this.shouldTransitionToHalfOpen(circuit)) {
      this.transitionToHalfOpen(circuit);
    }

    // If circuit is open, reject immediately
    if (circuit.state === CircuitState.OPEN) {
      throw new Error(`Circuit breaker is OPEN for ${name}`);
    }

    // If half-open, check if we've exceeded max calls
    if (circuit.state === CircuitState.HALF_OPEN) {
      if (circuit.stats.halfOpenCalls >= this.config.halfOpenMaxCalls) {
        throw new Error(`Circuit breaker HALF_OPEN max calls exceeded for ${name}`);
      }
      circuit.stats.halfOpenCalls++;
    }

    try {
      const result = await fn();

      // On success
      circuit.stats.successes++;

      if (circuit.state === CircuitState.HALF_OPEN) {
        // If we've succeeded enough times in half-open, close the circuit
        if (circuit.stats.halfOpenCalls >= this.config.halfOpenMaxCalls) {
          this.transitionToClosed(circuit);
        }
      } else {
        // Reset failures on success in closed state
        circuit.stats.failures = 0;
      }

      return result;
    } catch (error) {
      // On failure
      circuit.stats.failures++;

      if (circuit.state === CircuitState.HALF_OPEN) {
        // If we fail in half-open, go back to open
        this.transitionToOpen(name, circuit);
      } else if (circuit.stats.failures >= this.config.failureThreshold) {
        // If we've exceeded threshold in closed state, open the circuit
        this.transitionToOpen(name, circuit);
      }

      throw error;
    }
  }

  getState(name: string): CircuitState {
    const circuit = this.getCircuit(name);
    return circuit.state;
  }

  getStats(name: string): CircuitStats {
    const circuit = this.getCircuit(name);
    return { ...circuit.stats };
  }

  reset(name: string): void {
    const circuit = this.getCircuit(name);
    this.transitionToClosed(circuit);
  }

  forceOpen(name: string): void {
    const circuit = this.getCircuit(name);
    this.transitionToOpen(name, circuit);
  }
}

export default CircuitBreaker.getInstance();
