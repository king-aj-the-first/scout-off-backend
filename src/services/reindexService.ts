/**
 * reindexService.ts — DbDriver + multi-contract filters (#1119)
 */
import { server } from './stellar';
import { scValToNative } from '@stellar/stellar-sdk';
import config from '../config';
import { getDriver } from '../db';
import { normalizePayload, normalizeEventId } from './indexer';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';

export const MAX_REINDEX_RANGE = 10_000;
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 50;

const INSERT_EVENT_SQL =
  'INSERT INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tx_hash) DO NOTHING';
const UPSERT_LAST_LEDGER_SQL =
  "INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

export type ReindexStatus = 'idle' | 'running' | 'complete' | 'error';
export interface ReindexState {
  status: ReindexStatus;
  fromLedger: number;
  toLedger: number;
  ledgersProcessed: number;
  ledgersTotal: number;
  eventsInserted: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

const initialState = (): ReindexState => ({
  status: 'idle',
  fromLedger: 0,
  toLedger: 0,
  ledgersProcessed: 0,
  ledgersTotal: 0,
  eventsInserted: 0,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
});

let _state: ReindexState = initialState();

export function getReindexStatus(): Readonly<ReindexState> {
  return { ..._state };
}
export function _resetReindexState(): void {
  _state = initialState();
}

export function configuredReindexContractIds(): string[] {
  return [
    ...new Set(
      [
        config.registerContractId,
        config.progressContractId,
        config.subscriptionContractId,
        config.connectionContractId,
      ].filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
}

export function startReindex(fromLedger: number, toLedger: number, adminWallet: string): void {
  if (_state.status === 'running') {
    throw new ReindexAlreadyRunningError('A reindex job is already in progress.');
  }
  _state = {
    status: 'running',
    fromLedger,
    toLedger,
    ledgersProcessed: 0,
    ledgersTotal: toLedger - fromLedger + 1,
    eventsInserted: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
  };
  logAuditEvent({
    action: 'reindex_started',
    adminWallet,
    queryParams: { fromLedger, toLedger },
    timestamp: _state.startedAt!,
  }).catch(() => {});
  logger.info(`[reindex] started fromLedger=${fromLedger} toLedger=${toLedger} admin=${adminWallet}`);
  _runReindex(fromLedger, toLedger, adminWallet).catch((err: unknown) => {
    logger.error(`[reindex] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _runReindex(fromLedger: number, toLedger: number, adminWallet: string): Promise<void> {
  const driver = getDriver();
  const contractIds = configuredReindexContractIds();
  let eventsInserted = 0;
  let currentBatchStart = fromLedger;
  try {
    while (currentBatchStart <= toLedger) {
      const batchEnd = Math.min(currentBatchStart + BATCH_SIZE - 1, toLedger);
      type RpcEvent = Awaited<ReturnType<typeof server.getEvents>>['events'][number];
      const batchEvents: Array<RpcEvent & { _contractId: string }> = [];
      for (const contractId of contractIds) {
        try {
          const response = await server.getEvents({
            startLedger: currentBatchStart,
            filters: [{ type: 'contract', contractIds: [contractId] }],
          });
          for (const e of response.events) {
            if (e.ledger >= currentBatchStart && e.ledger <= batchEnd) {
              batchEvents.push(Object.assign(e, { _contractId: contractId }));
            }
          }
        } catch (rpcErr: unknown) {
          logger.warn(
            `[reindex] RPC error ${currentBatchStart}-${batchEnd} contract=${contractId}: ${
              rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
            }`,
          );
        }
      }
      const batchInserted = await driver.transaction(async (tx) => {
        let inserted = 0;
        for (const raw of batchEvents) {
          const type = raw.topic[0] ? (scValToNative(raw.topic[0]) as string) : '';
          const payload = normalizePayload(
            (raw.value ? (scValToNative(raw.value) as Record<string, unknown>) : {}) ?? {},
          );
          const eventId = normalizeEventId(raw._contractId, raw.ledger, raw.txHash);
          const createdAt = raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt).getTime() : Date.now();
          const result = await tx.run(INSERT_EVENT_SQL, [
            type,
            raw.ledger,
            raw.txHash,
            JSON.stringify(payload),
            createdAt,
          ]);
          if (result.changes === 1) {
            inserted++;
            logger.debug(`[reindex] inserted eventId=${eventId}`);
          }
        }
        return inserted;
      });
      eventsInserted += batchInserted;
      _state = { ..._state, ledgersProcessed: batchEnd - fromLedger + 1, eventsInserted };
      currentBatchStart = batchEnd + 1;
      if (currentBatchStart <= toLedger) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
    await driver.run(UPSERT_LAST_LEDGER_SQL, ['last_ledger', String(toLedger + 1)]);
    const completedAt = new Date().toISOString();
    _state = { ..._state, status: 'complete', ledgersProcessed: _state.ledgersTotal, completedAt, errorMessage: null };
    logAuditEvent({
      action: 'reindex_completed',
      adminWallet,
      queryParams: { fromLedger, toLedger, eventsInserted },
      timestamp: completedAt,
    }).catch(() => {});
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    _state = { ..._state, status: 'error', completedAt: new Date().toISOString(), errorMessage };
    logAuditEvent({
      action: 'reindex_error',
      adminWallet,
      queryParams: { fromLedger, toLedger, error: errorMessage },
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    logger.error(`[reindex] failed: ${errorMessage}`);
  }
}

export class ReindexAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReindexAlreadyRunningError';
  }
}
