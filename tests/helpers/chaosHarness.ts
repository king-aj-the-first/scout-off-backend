/**
 * Dependency-failure chaos harness (#1116).
 *
 * Injects faults through existing store/service seams so tests can assert the
 * graceful-degradation contracts in docs/degradation-contracts.md without a
 * real Redis, Pinata, or Soroban RPC.
 */

import express, { Request, Response } from 'express';
import type Redis from 'ioredis';
import {
  FakeRedisClient,
  FakeRedisStore,
  RedisConnectionError,
  withTimeout,
} from './redisFailureHarness';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore';
import { RedisCacheStore } from '../../src/services/redisCacheStore';
import { rateLimit } from '../../src/middleware/rateLimit';
import { CircuitBreaker, CircuitBreakerError } from '../../src/utils/circuitBreaker';
import type { RateLimitStore } from '../../src/middleware/rateLimitStore';

export type ChaosDependency = 'redis' | 'db' | 'rpc' | 'ipfs';

export const CHAOS_HANG_BUDGET_MS = 5_000;

export class ChaosFaultError extends Error {
  constructor(
    public readonly dependency: ChaosDependency,
    message: string,
  ) {
    super(message);
    this.name = 'ChaosFaultError';
  }
}

export interface ChaosController {
  disable(dep: ChaosDependency): void;
  enable(dep?: ChaosDependency): void;
  reset(): void;
  disabled(): ReadonlySet<ChaosDependency>;
  redisClient: FakeRedisClient;
  redisStore: FakeRedisStore;
  rateLimitStore: RateLimitStore;
  cacheStore: RedisCacheStore;
  dbDriver: {
    get: (sql: string, params?: unknown[]) => Promise<unknown>;
    run: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
    all: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  };
  rpcBreaker: CircuitBreaker;
  rpcCall<T>(fn?: () => Promise<T>): Promise<T>;
  ipfs: {
    checkHealth: () => Promise<void>;
    pinJson: (payload: unknown) => Promise<string>;
  };
}

export function createChaosController(): ChaosController {
  const disabled = new Set<ChaosDependency>();
  const redisClient = new FakeRedisClient();
  const redisStore = new FakeRedisStore();
  const rateLimitStore = new RedisRateLimitStore(redisClient as unknown as Redis);
  const cacheStore = new RedisCacheStore(redisStore);
  const rpcBreaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 60_000,
    maxRetries: 0,
    baseBackoffMs: 1,
  });

  const syncRedisState = () => {
    const state = disabled.has('redis') ? 'unavailable' : 'healthy';
    redisClient.setState(state);
    redisStore.setState(state);
  };

  const assertDb = async <T>(op: () => Promise<T>): Promise<T> => {
    if (disabled.has('db')) {
      throw new ChaosFaultError('db', 'database unavailable (chaos)');
    }
    return op();
  };

  const dbDriver = {
    get: (sql: string, _params?: unknown[]) =>
      assertDb(async () => {
        if (sql.includes('SELECT 1')) return { ok: 1 };
        return null;
      }),
    run: (_sql: string, _params?: unknown[]) =>
      assertDb(async () => ({ changes: 1 })),
    all: (_sql: string, _params?: unknown[]) => assertDb(async () => []),
  };

  const ipfs = {
    checkHealth: async () => {
      if (disabled.has('ipfs')) {
        const err = new ChaosFaultError('ipfs', 'IPFS 500 (chaos)');
        (err as Error & { status?: number }).status = 500;
        throw err;
      }
    },
    pinJson: async (_payload: unknown) => {
      if (disabled.has('ipfs')) {
        const err = new ChaosFaultError('ipfs', 'IPFS pin failed with 500 (chaos)');
        (err as Error & { status?: number }).status = 500;
        throw err;
      }
      return 'bafychaoshealthy';
    },
  };

  async function rpcCall<T>(fn?: () => Promise<T>): Promise<T> {
    if (disabled.has('rpc')) {
      const fail = async (): Promise<never> => {
        throw new ChaosFaultError('rpc', 'Soroban RPC black hole (chaos)');
      };
      try {
        await rpcBreaker.execute(fail);
      } catch (err) {
        if (err instanceof CircuitBreakerError || err instanceof ChaosFaultError) {
          throw err;
        }
        throw err;
      }
      throw new ChaosFaultError('rpc', 'Soroban RPC black hole (chaos)');
    }
    if (fn) return rpcBreaker.execute(fn);
    return rpcBreaker.execute(async () => undefined as T);
  }

  return {
    redisClient,
    redisStore,
    rateLimitStore,
    cacheStore,
    dbDriver,
    rpcBreaker,
    ipfs,
    rpcCall,

    disable(dep: ChaosDependency) {
      disabled.add(dep);
      if (dep === 'redis') syncRedisState();
      if (dep === 'rpc') {
        rpcBreaker.state = 'OPEN';
      }
    },

    enable(dep?: ChaosDependency) {
      if (dep === undefined) {
        disabled.clear();
      } else {
        disabled.delete(dep);
      }
      syncRedisState();
      if (!disabled.has('rpc')) {
        rpcBreaker.state = 'CLOSED';
      }
    },

    reset() {
      disabled.clear();
      redisClient.flush();
      redisStore.flush();
      syncRedisState();
      rpcBreaker.state = 'CLOSED';
    },

    disabled() {
      return disabled;
    },
  };
}

export function makeRateLimitedApp(store: RateLimitStore): express.Application {
  const app = express();
  app.set('trust proxy', 1);
  app.use(rateLimit({ windowMs: 60_000, max: 100, store, name: 'chaos' }));
  app.get('/probe', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  return app;
}

export async function expectWithinBudget<T>(
  promise: Promise<T>,
  ms: number = CHAOS_HANG_BUDGET_MS,
): Promise<T> {
  const result = await withTimeout(promise, ms);
  if (result.timedOut) {
    throw new Error(`Chaos probe exceeded hang budget of ${ms}ms`);
  }
  return result.value;
}

export function expectGracefulStatus(status: number, allowed: number[]): void {
  if (!allowed.includes(status)) {
    throw new Error(`Expected status in [${allowed.join(', ')}], got ${status}`);
  }
}

export { RedisConnectionError, CircuitBreakerError };
