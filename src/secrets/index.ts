/** Pluggable secrets provider (#1115) — env / vault / kms. */
export type SecretsProviderKind = 'env' | 'vault' | 'kms';
export type SecretRotationClass = 'hot' | 'dual-window' | 'migration-required';

export const SECRET_ROTATION_CLASS: Record<string, SecretRotationClass> = {
  JWT_SECRET: 'dual-window',
  SEP10_SERVER_SECRET: 'dual-window',
  API_KEY_LOOKUP_SECRET: 'dual-window',
  WEBHOOK_SECRET_ENCRYPTION_KEY: 'migration-required',
  PLATFORM_SECRET_KEY: 'hot',
  PLATFORM_SECRET: 'hot',
  PINATA_API_KEY: 'hot',
  PINATA_SECRET: 'hot',
};

export function auditSecretAccess(event: {
  action: string;
  name?: string;
  provider: string;
  found?: boolean;
  detail?: string;
}): void {
  console.info('[secrets-audit]', JSON.stringify({ ...event, at: new Date().toISOString() }));
}

export interface SecretsProvider {
  readonly kind: SecretsProviderKind;
  get(name: string): string | undefined;
  refresh(): Promise<void>;
  watch?(cb: (name: string, value: string | undefined) => void): void;
}

export class EnvSecretsProvider implements SecretsProvider {
  readonly kind = 'env' as const;
  get(name: string): string | undefined {
    const value = process.env[name];
    auditSecretAccess({ action: 'get', name, provider: this.kind, found: !!value });
    return value || undefined;
  }
  async refresh(): Promise<void> {
    auditSecretAccess({ action: 'refresh', provider: this.kind, detail: 'noop-env' });
  }
}

export function buildSecretsFetchUrl(opts: { kind: 'vault' | 'kms'; endpoint: string; path: string }): string {
  const base = opts.endpoint.replace(/\/+$/, '');
  const path = opts.path.replace(/^\/+/, '');
  return opts.kind === 'vault' ? `${base}/v1/${path}` : `${base}/${path}`;
}

export function normalizeSecretsBundle(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const nested =
    obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>).data : undefined;
  const source = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : obj;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

export class VaultKmsSecretsProvider implements SecretsProvider {
  readonly kind: 'vault' | 'kms';
  private cache: Record<string, string> = {};
  private watchers: Array<(n: string, v: string | undefined) => void> = [];
  constructor(
    private opts: {
      kind: 'vault' | 'kms';
      endpoint: string;
      token: string;
      path: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.kind = opts.kind;
  }
  get(name: string): string | undefined {
    if (this.cache[name] !== undefined) {
      auditSecretAccess({ action: 'get', name, provider: this.kind, found: true });
      return this.cache[name];
    }
    const fallback = process.env[name];
    auditSecretAccess({ action: 'get', name, provider: this.kind, found: !!fallback });
    return fallback || undefined;
  }
  watch(cb: (name: string, value: string | undefined) => void): void {
    this.watchers.push(cb);
  }
  async refresh(): Promise<void> {
    const url = buildSecretsFetchUrl(this.opts);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.opts.token}`, 'X-Vault-Token': this.opts.token },
    });
    if (!res.ok) throw new Error(`SecretsProvider fetch failed: HTTP ${res.status}`);
    const next = normalizeSecretsBundle(await res.json());
    const prev = this.cache;
    this.cache = next;
    for (const [name, value] of Object.entries(next)) {
      if (prev[name] !== value) for (const cb of this.watchers) cb(name, value);
    }
    auditSecretAccess({ action: 'refresh', provider: this.kind, detail: `keys=${Object.keys(next).length}` });
  }
}

let singleton: SecretsProvider | null = null;

export function createSecretsProvider(env: NodeJS.ProcessEnv = process.env): SecretsProvider {
  const raw = (env.SECRETS_PROVIDER ?? 'env').toLowerCase();
  if (raw === 'env') return new EnvSecretsProvider();
  if (raw !== 'vault' && raw !== 'kms') throw new Error(`Invalid SECRETS_PROVIDER="${raw}"`);
  if (raw === 'vault') {
    if (!env.VAULT_ADDR || !env.VAULT_TOKEN) throw new Error('VAULT_ADDR and VAULT_TOKEN required');
    return new VaultKmsSecretsProvider({
      kind: 'vault',
      endpoint: env.VAULT_ADDR,
      token: env.VAULT_TOKEN,
      path: env.VAULT_SECRET_PATH ?? 'secret/data/scout-off',
    });
  }
  if (!env.KMS_SECRET_BUNDLE_URL || !env.KMS_BEARER_TOKEN) {
    throw new Error('KMS_SECRET_BUNDLE_URL and KMS_BEARER_TOKEN required');
  }
  return new VaultKmsSecretsProvider({
    kind: 'kms',
    endpoint: env.KMS_SECRET_BUNDLE_URL.replace(/\/[^/]*$/, '') || env.KMS_SECRET_BUNDLE_URL,
    token: env.KMS_BEARER_TOKEN,
    path: env.KMS_SECRET_PATH ?? env.KMS_SECRET_BUNDLE_URL.replace(/^https?:\/\/[^/]+\//, ''),
  });
}

export function getSecretsProvider(): SecretsProvider {
  if (!singleton) singleton = createSecretsProvider();
  return singleton;
}

export function resetSecretsProviderForTests(p: SecretsProvider | null): void {
  singleton = p;
}

export type SecretsConfigTarget = {
  jwtSecret: string;
  jwtSecretPrevious: string;
  jwtSecretPreviousUntil: number | null;
  sep10ServerSecret: string;
  sep10ServerSecretPrevious?: string;
  sep10ServerSecretPreviousUntil?: number | null;
  apiKeyLookupSecret: string;
  apiKeyLookupSecretPrevious?: string;
  apiKeyLookupSecretPreviousUntil?: number | null;
  webhookSecretEncryptionKey: string;
  webhookSecretEncryptionKeyPrevious?: string;
  platformSecretKey: string;
  platformSecret: string;
  pinata: { apiKey: string; secret: string; gateway: string; gateways: string[] };
};

function parseUntil(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const v = raw.trim();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}

export function applySecretsToConfig(target: SecretsConfigTarget, provider: SecretsProvider = getSecretsProvider()): void {
  const g = (n: string) => provider.get(n);
  if (g('JWT_SECRET')) target.jwtSecret = g('JWT_SECRET')!;
  const jp = g('JWT_SECRET_PREVIOUS');
  if (jp !== undefined) target.jwtSecretPrevious = jp ?? '';
  const ju = g('JWT_SECRET_PREVIOUS_UNTIL');
  if (ju !== undefined) target.jwtSecretPreviousUntil = parseUntil(ju);
  if (g('SEP10_SERVER_SECRET')) target.sep10ServerSecret = g('SEP10_SERVER_SECRET')!;
  if (g('API_KEY_LOOKUP_SECRET')) target.apiKeyLookupSecret = g('API_KEY_LOOKUP_SECRET')!;
  if (g('WEBHOOK_SECRET_ENCRYPTION_KEY')) target.webhookSecretEncryptionKey = g('WEBHOOK_SECRET_ENCRYPTION_KEY')!;
  if (g('PLATFORM_SECRET_KEY')) target.platformSecretKey = g('PLATFORM_SECRET_KEY')!;
  if (g('PLATFORM_SECRET')) target.platformSecret = g('PLATFORM_SECRET')!;
  if (g('PINATA_API_KEY')) target.pinata.apiKey = g('PINATA_API_KEY')!;
  if (g('PINATA_SECRET')) target.pinata.secret = g('PINATA_SECRET')!;
  auditSecretAccess({ action: 'apply', provider: provider.kind, detail: 'config' });
}

export async function refreshSecrets(
  target: SecretsConfigTarget,
  provider: SecretsProvider = getSecretsProvider(),
): Promise<void> {
  await provider.refresh();
  applySecretsToConfig(target, provider);
}
