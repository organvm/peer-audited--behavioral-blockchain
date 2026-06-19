import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { BillingService, MeteredEventType } from '../b2b/billing.service';

/**
 * MeteredUsageService
 *
 * The upstream, per-USER entry point for billable consumption (REV-styx-metered-billing).
 * Every billable action (e.g. a contract's proof being accepted on
 * POST /contracts/:id/complete) calls {@link recordMeteredUsage}. This service:
 *
 *   1. Persists a durable row to `usage_event` — the per-user source of truth, retained
 *      even when the user is not (yet) attached to an enterprise.
 *   2. If the user maps to an enterprise, forwards the event to {@link BillingService} so
 *      it is metered through Stripe Billing for B2B consumption invoicing.
 *
 * Persistence is the authoritative side effect; Stripe forwarding is best-effort and must
 * never make us drop the durable record (we can re-bill from usage_event if needed).
 */
@Injectable()
export class MeteredUsageService {
  private readonly logger = new Logger(MeteredUsageService.name);

  constructor(
    private readonly pool: Pool,
    private readonly billing: BillingService,
  ) {}

  /**
   * Record a billable metered usage event for a user.
   *
   * @param userId    the user who performed the billable action.
   * @param eventType the metered metric (see METERED_EVENT_TYPES), e.g. 'proof_accepted'.
   * @param eventId   optional STABLE de-duplication key (e.g. the contract id). When
   *                  supplied it makes the call idempotent end-to-end: the DB insert is a
   *                  no-op on retry and the Stripe meter event reuses it as the idempotency
   *                  key, so an at-least-once caller bills exactly once.
   * @param quantity  units consumed (defaults to 1).
   */
  async recordMeteredUsage(
    userId: string,
    eventType: MeteredEventType,
    eventId?: string,
    quantity: number = 1,
  ): Promise<void> {
    const enterpriseId = await this.resolveEnterpriseId(userId);

    // 1. Durable per-user record. ON CONFLICT keeps retries idempotent when a stable
    // idempotency_key is supplied. `inserted` is false when the row already existed,
    // which lets us skip a duplicate Stripe meter increment below.
    const { rowCount } = await this.pool.query(
      `INSERT INTO usage_event (user_id, enterprise_id, event_type, quantity, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [userId, enterpriseId, eventType, quantity, eventId ?? null],
    );
    const inserted = (rowCount ?? 0) > 0;

    if (!inserted && eventId) {
      this.logger.debug(
        `Duplicate metered usage [${eventType}] for user ${userId} (eventId=${eventId}); skipping re-bill.`,
      );
      return;
    }

    this.logger.log(
      `Recorded metered usage [${eventType}] x${quantity} for user ${userId}` +
        (enterpriseId ? ` (enterprise ${enterpriseId})` : ' (no enterprise; unattributed)'),
    );

    // 2. Forward to B2B metered billing only when the user belongs to an enterprise.
    if (!enterpriseId) return;

    try {
      await this.billing.recordUsage(enterpriseId, eventType, quantity, eventId);
    } catch (err) {
      // The durable usage_event row already landed; a Stripe hiccup must not fail the
      // caller's request. We can reconcile/re-bill from usage_event out of band.
      this.logger.error(
        `Failed to forward metered usage [${eventType}] for enterprise ${enterpriseId} to Stripe: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Resolve the enterprise a user is billed under, or null for individual users.
   */
  private async resolveEnterpriseId(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      'SELECT enterprise_id FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.enterprise_id ?? null;
  }
}
