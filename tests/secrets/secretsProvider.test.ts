import {
  EnvSecretsProvider,
  createSecretsProvider,
  resetSecretsProviderForTests,
  applySecretsToConfig,
  SECRET_ROTATION_CLASS,
  buildSecretsFetchUrl,
  normalizeSecretsBundle,
  VaultKmsSecretsProvider,
  auditSecretAccess,
} from '../../src/secrets';

describe('SecretsProvider (#1115)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    resetSecretsProviderForTests(null);
    jest.restoreAllMocks();
  });

  it('env get + audit', () => {
    process.env.JWT_SECRET = 'super-secret-value-do-not-leak';
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const provider = new EnvSecretsProvider();
    expect(provider.get('JWT_SECRET')).toBe('super-secret-value-do-not-leak');
    const audited = info.mock.calls.filter((c) => c[0] === '[secrets-audit]').map((c) => JSON.parse(String(c[1])));
    expect(audited.some((e) => e.name === 'JWT_SECRET' && e.found === true)).toBe(true);
    for (const e of audited) expect(JSON.stringify(e)).not.toContain('super-secret-value-do-not-leak');
  });

  it('defaults to env', () => {
    delete process.env.SECRETS_PROVIDER;
    expect(createSecretsProvider(process.env).kind).toBe('env');
  });

  it('vault url + normalize', () => {
    expect(buildSecretsFetchUrl({ kind: 'vault', endpoint: 'https://vault.example.com/', path: 'secret/data/scout-off' })).toBe(
      'https://vault.example.com/v1/secret/data/scout-off',
    );
    expect(normalizeSecretsBundle({ data: { data: { JWT_SECRET: 'abc', EMPTY: '' } } })).toEqual({ JWT_SECRET: 'abc' });
  });

  it('vault refresh caches', async () => {
    process.env.PINATA_SECRET = 'from-env-fallback';
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { data: { JWT_SECRET: 'from-vault' } } }),
    })) as unknown as typeof fetch;
    const provider = new VaultKmsSecretsProvider({
      kind: 'vault',
      endpoint: 'https://vault.example.com',
      token: 't',
      path: 'secret/data/scout-off',
      fetchImpl,
    });
    await provider.refresh();
    expect(provider.get('JWT_SECRET')).toBe('from-vault');
    expect(provider.get('PINATA_SECRET')).toBe('from-env-fallback');
  });

  it('applySecretsToConfig', () => {
    process.env.JWT_SECRET = 'new-jwt';
    process.env.PINATA_API_KEY = 'pk';
    process.env.PINATA_SECRET = 'ps';
    const target = {
      jwtSecret: 'stale',
      jwtSecretPrevious: '',
      jwtSecretPreviousUntil: null as number | null,
      sep10ServerSecret: '',
      apiKeyLookupSecret: '',
      webhookSecretEncryptionKey: '',
      platformSecretKey: '',
      platformSecret: '',
      pinata: { apiKey: '', secret: '', gateway: '', gateways: [] as string[] },
    };
    applySecretsToConfig(target, new EnvSecretsProvider());
    expect(target.jwtSecret).toBe('new-jwt');
    expect(target.pinata.apiKey).toBe('pk');
  });

  it('rotation classes', () => {
    expect(SECRET_ROTATION_CLASS.JWT_SECRET).toBe('dual-window');
    expect(SECRET_ROTATION_CLASS.WEBHOOK_SECRET_ENCRYPTION_KEY).toBe('migration-required');
  });

  it('auditSecretAccess', () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    auditSecretAccess({ action: 'get', name: 'JWT_SECRET', provider: 'env', found: true });
    expect(info).toHaveBeenCalledWith('[secrets-audit]', expect.stringContaining('"action":"get"'));
  });
});
