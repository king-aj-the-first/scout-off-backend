import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  listWebhookDeadLetters,
  countWebhookDeadLetters,
  getWebhookDeadLetterById,
  getWebhookSubscriptionById,
  setWebhookSubscriptionStatus,
  markWebhookDeadLetterReplayed,
  updateWebhookDeadLetterAttempt,
  deleteWebhookDeadLetter,
  purgeOldWebhookDeadLetters,
  type WebhookSubscriptionStatus,
} from '../db';
import { postWebhookWithRetry } from '../services/webhooks';
import { decryptWebhookSecret } from '../utils/webhookSecretCipher';
import { logger } from '../utils/logger';
import { incrementWebhookRetrySuccessTotal } from '../middleware/metrics';
import { logAuditEvent } from '../services/audit';

/** Exported so routes can apply validateQuery(listDeadLettersQuerySchema) */
export const listDeadLettersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /api/admin/webhooks/dead-letters
 *
 * Paginated list of dead letters. Each row exposes url, payload_preview
 * (first 200 chars of JSON), retry_count, last_error, and created_at.
 */
export async function listDeadLetters(req: Request, res: Response, next: NextFunction) {
  const parsed = listDeadLettersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
    });
    return;
  }
  const { page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

  const rows = listWebhookDeadLetters(pageSize, offset);
  const total = countWebhookDeadLetters();

  const data = rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscription_id,
    url: row.url,
    eventType: row.event_type,
    // payload_preview: first 200 chars — enough to identify the event
    // without sending the full body in a list response.
    payloadPreview: row.payload.slice(0, 200),
    retryCount: row.attempts,
    lastError: row.failure_reason,
    status: row.status,
    createdAt: row.created_at,
    replayedAt: row.replayed_at,
  }));

  res.json({ success: true, data, total, page, pageSize });
}

// ─── Param validation ─────────────────────────────────────────────────────────

const deadLetterIdSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

// ─── POST /api/admin/webhooks/dead-letters/:id/requeue ────────────────────────

/**
 * POST /api/admin/webhooks/dead-letters/:id/requeue
 *
 * Manually trigger a retry for a specific dead letter.
 * Re-signs the payload with the subscription's current secret.
 */
export async function requeueDeadLetter(req: Request, res: Response, next: NextFunction) {
try {
    const parsedParams = deadLetterIdSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        success: false,
        error: parsedParams.error.errors[0]?.message ?? 'Invalid id',
      });
      return;
    }
    const { id } = parsedParams.data;

    const deadLetter = getWebhookDeadLetterById(id);
    if (!deadLetter) {
      res.status(404).json({ success: false, error: 'Dead-lettered delivery not found' });
      return;
    }
    if (deadLetter.status === 'replayed') {
      res.status(409).json({ success: false, error: 'Delivery has already been replayed' });
      return;
    }

    const subscription = deadLetter.subscription_id != null
      ? getWebhookSubscriptionById(deadLetter.subscription_id)
      : undefined;
    const secret = subscription
      ? decryptWebhookSecret(subscription.secret)
      : undefined;

    try {
      await postWebhookWithRetry(deadLetter.url, JSON.parse(deadLetter.payload), {
        retries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        secret,
      });

      markWebhookDeadLetterReplayed(id);
      incrementWebhookRetrySuccessTotal();

      res.json({
        success: true,
        message: 'Webhook delivery requeued and delivered successfully',
        data: { id, status: 'replayed' },
      });
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      const attempts = deadLetter.attempts + 3;
      updateWebhookDeadLetterAttempt(id, attempts, failureReason);
      logger.warn(
        `[webhooks] manual requeue failed — id=${id} url=${deadLetter.url} reason=${failureReason}`,
      );
      res.status(502).json({
        success: false,
        message: 'Requeue attempt failed; delivery remains dead-lettered',
        error: failureReason,
        data: { id, status: 'pending', retryCount: attempts },
      });
    }
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /api/admin/webhooks/dead-letters/:id ──────────────────────────────

/**
 * DELETE /api/admin/webhooks/dead-letters/:id
 *
 * Purge a specific dead-letter row.
 */
export async function purgeDeadLetter(req: Request, res: Response, next: NextFunction) {
  const parsedParams = deadLetterIdSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      success: false,
      error: parsedParams.error.errors[0]?.message ?? 'Invalid id',
    });
    return;
  }
  const { id } = parsedParams.data;

  const deleted = deleteWebhookDeadLetter(id);
  if (!deleted) {
    res.status(404).json({ success: false, error: 'Dead-lettered delivery not found' });
    return;
  }

  res.json({ success: true, message: 'Dead letter purged', data: { id } });
}

// ─── DELETE /api/admin/webhooks/dead-letters ──────────────────────────────────

const purgeOldQuerySchema = z.object({
  olderThanDays: z.coerce.number().int().min(1).default(7),
});

/**
 * DELETE /api/admin/webhooks/dead-letters
 *
 * Purge all dead letters older than `olderThanDays` days (default: 7).
 */
export async function purgeOldDeadLetters(req: Request, res: Response, next: NextFunction) {
  const parsed = purgeOldQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
    });
    return;
  }
  const { olderThanDays } = parsed.data;

  const deleted = purgeOldWebhookDeadLetters(olderThanDays);
  res.json({
    success: true,
    message: `Purged ${deleted} dead letter(s) older than ${olderThanDays} day(s)`,
    data: { deleted, olderThanDays },
  });
}

// ─── PATCH /api/admin/webhooks/subscriptions/:id ─────────────────────────────

const patchSubscriptionSchema = z.object({
  status: z.enum(['active', 'paused']),
});

const subscriptionIdSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

/**
 * PATCH /api/admin/webhooks/subscriptions/:id
 *
 * Admin override to pause or resume any webhook subscription without rotating
 * its HMAC secret (#1122).
 *
 * @body { status: 'active' | 'paused' }
 * @response 200 { success: true, data: { id, url, status, scoutWallet, createdAt } }
 * @response 400 Invalid id or body
 * @response 404 Subscription not found
 * @auth Bearer (admin role required)
 */
export async function patchWebhookSubscription(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsedParams = subscriptionIdSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        success: false,
        error: parsedParams.error.errors[0]?.message ?? 'Invalid id',
      });
      return;
    }

    const parsedBody = patchSubscriptionSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        success: false,
        error: parsedBody.error.errors[0]?.message ?? 'Invalid request body',
      });
      return;
    }

    const { id } = parsedParams.data;
    const status = parsedBody.data.status as WebhookSubscriptionStatus;
    const updated = setWebhookSubscriptionStatus(id, status);
    if (!updated) {
      res.status(404).json({ success: false, error: 'Webhook subscription not found' });
      return;
    }

    await logAuditEvent({
      action: 'webhook_subscription_status_updated',
      timestamp: new Date().toISOString(),
      adminWallet: req.account,
      queryParams: { subscriptionId: id, status, url: updated.url },
    });

    res.json({
      success: true,
      data: {
        id: updated.id,
        url: updated.url,
        status: updated.status,
        scoutWallet: updated.scout_wallet,
        createdAt: updated.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Legacy replay alias (kept for backwards compatibility) ──────────────────

/**
 * POST /api/admin/webhooks/:id/replay
 *
 * Kept for backwards compatibility. Delegates to requeueDeadLetter.
 */
export { requeueDeadLetter as replayDeadLetter };
