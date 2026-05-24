import { Injectable, Logger } from '@nestjs/common';
import { PayoutProvider, PayoutResult, PayoutStatus } from '../../common/interfaces/payout-provider.interface';
import { StripeFboService } from '../../../services/escrow/stripe.service';

@Injectable()
export class StripePayoutProvider implements PayoutProvider {
  private readonly logger = new Logger(StripePayoutProvider.name);

  constructor(private readonly stripeService: StripeFboService) {}

  async releaseFunds(paymentIntentId: string, _amountCents: number, _metadata?: Record<string, any>): Promise<PayoutResult> {
    try {
      // In our FBO model, releasing funds means canceling the manual hold.
      const intent = await this.stripeService.cancelHold(paymentIntentId);
      return {
        status: PayoutStatus.SUCCESS,
        providerTransactionId: intent.id,
        rawResponse: intent,
      };
    } catch (err: any) {
      this.logger.error(`Stripe release failed: ${err.message}`);
      return {
        status: PayoutStatus.FAILED,
        error: err.message,
      };
    }
  }

  async captureFunds(paymentIntentId: string, amountCents: number, _metadata?: Record<string, any>): Promise<PayoutResult> {
    try {
      // Pass the settlement amount so partial captures take only `amountCents`, not the full
      // authorized hold. (Previously amountCents was ignored, so partial settlement captured
      // the entire stake.)
      //
      // Fury bounties: the `_metadata.furies` array is NOT paid out here. In the canonical
      // architecture the slashed stake is captured to platform revenue and the bounty share is
      // moved to the FURY_BOUNTY_POOL *ledger* account by SettlementWorker.finalizeLedger
      // (BOUNTY_POOL_TOPUP). Individual auditors are then paid from that pool internally by the
      // fury worker — there is no Stripe transfer to per-fury connected accounts on this path.
      // The array is therefore intentionally not wired to a Stripe payout here.
      const intent = await this.stripeService.captureStake(paymentIntentId, amountCents);
      return {
        status: PayoutStatus.SUCCESS,
        providerTransactionId: intent.id,
        rawResponse: intent,
      };
    } catch (err: any) {
      this.logger.error(`Stripe capture failed: ${err.message}`);
      return {
        status: PayoutStatus.FAILED,
        error: err.message,
      };
    }
  }

  async getTransactionStatus(providerTransactionId: string): Promise<PayoutStatus> {
    try {
      const intent = await this.stripeService.retrieveIntent(providerTransactionId);
      switch (intent.status) {
        case 'succeeded':
          return PayoutStatus.SUCCESS;
        case 'canceled': {
          // In the FBO model a deliberate release cancels the manual hold, so a
          // requested/manual cancellation is a successful release. But an abandoned or
          // auto-expired authorization also lands in `canceled` and must NOT be reported as a
          // successful settlement. Distinguish by cancellation_reason.
          const reason = (intent as any).cancellation_reason as string | null | undefined;
          const abandoned = reason === 'abandoned' || reason === 'automatic' || reason === 'failed_invoice';
          return abandoned ? PayoutStatus.FAILED : PayoutStatus.SUCCESS;
        }
        case 'requires_capture':
        case 'processing':
        case 'requires_payment_method':
        case 'requires_confirmation':
        case 'requires_action':
          return PayoutStatus.PENDING;
        default:
          return PayoutStatus.FAILED;
      }
    } catch (err: any) {
      this.logger.error(`Failed to check transaction status: ${err.message}`);
      return PayoutStatus.FAILED;
    }
  }
}
