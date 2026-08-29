/** Chaos harness (#1116) — independent redis/db/rpc/ipfs faults. */
import request from 'supertest';
import app from '../../src/app';
import * as ipfs from '../../src/services/ipfs';
import * as stellar from '../../src/services/stellar';

type FaultSet = Partial<Record<'redis' | 'db' | 'rpc' | 'ipfs', boolean>>;

function applyFaults(f: FaultSet): void {
  for (const k of ['redis', 'db', 'rpc', 'ipfs'] as const) {
    const env = `CHAOS_${k.toUpperCase()}_DOWN`;
    if (f[k]) process.env[env] = '1';
    else delete process.env[env];
  }
}

describe('chaos degradation harness (#1116)', () => {
  let ipfsSpy: jest.SpyInstance;
  let stellarSpy: jest.SpyInstance;

  beforeEach(() => {
    ipfsSpy = jest.spyOn(ipfs, 'checkHealth').mockImplementation(async () => {
      if (process.env.CHAOS_IPFS_DOWN === '1') throw new Error('ipfs down');
    });
    stellarSpy = jest.spyOn(stellar, 'stellarHealth').mockImplementation(async () => {
      return process.env.CHAOS_RPC_DOWN !== '1';
    });
  });

  afterEach(() => {
    applyFaults({});
    ipfsSpy.mockRestore();
    stellarSpy.mockRestore();
  });

  const cases: Array<{ name: string; faults: FaultSet; ready: number[] }> = [
    { name: 'redis', faults: { redis: true }, ready: [200, 503] },
    { name: 'db', faults: { db: true }, ready: [200, 503] },
    { name: 'rpc', faults: { rpc: true }, ready: [200, 503] },
    { name: 'ipfs', faults: { ipfs: true }, ready: [200, 503] },
    { name: 'redis+rpc', faults: { redis: true, rpc: true }, ready: [200, 503] },
    { name: 'db+ipfs', faults: { db: true, ipfs: true }, ready: [200, 503] },
  ];

  for (const c of cases) {
    it(`${c.name}: liveness 200; ready per contract; no hang`, async () => {
      applyFaults(c.faults);
      const t0 = Date.now();
      expect((await request(app).get('/health/liveness')).status).toBe(200);
      expect((await request(app).get('/version')).status).toBe(200);
      expect(c.ready).toContain((await request(app).get('/ready')).status);
      expect(Date.now() - t0).toBeLessThan(10000);
    });
  }
});
