import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Pool } from "pg";

export enum AccessTier {
  FREE = "free",
  EARLY_ACCESS = "early_access",
  PRO = "pro",
}

export const EARLY_ACCESS_ACTIVE_CONTRACT_LIMIT = 3;
export const EARLY_ACCESS_ESCROW_LIMIT_CENTS = 0;

@Injectable()
export class TierGuard implements CanActivate {
  constructor(private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id;

    if (!userId) {
      throw new ForbiddenException("Authentication required");
    }

    const result = await this.pool.query(
      `SELECT
         u.access_tier::text AS access_tier,
         COUNT(c.id)::int AS active_contract_count
       FROM users u
       LEFT JOIN contracts c
         ON c.user_id = u.id
        AND c.status = 'ACTIVE'
       WHERE u.id = $1
       GROUP BY u.id, u.access_tier`,
      [userId],
    );

    if (result.rows.length === 0) {
      throw new ForbiddenException("User account not found.");
    }

    const accessTier = String(result.rows[0].access_tier || "").toLowerCase();
    if (accessTier === AccessTier.PRO) {
      return true;
    }

    if (accessTier === AccessTier.FREE) {
      throw new ForbiddenException(
        "Contract creation requires early access or pro access.",
      );
    }

    if (accessTier !== AccessTier.EARLY_ACCESS) {
      throw new ForbiddenException("Unsupported access tier.");
    }

    const activeContractCount = Number(result.rows[0].active_contract_count);
    if (activeContractCount >= EARLY_ACCESS_ACTIVE_CONTRACT_LIMIT) {
      throw new ForbiddenException(
        `Early access is limited to ${EARLY_ACCESS_ACTIVE_CONTRACT_LIMIT} active contracts.`,
      );
    }

    const requestedEscrowCents = this.getRequestedEscrowCents(request.body);
    if (requestedEscrowCents > EARLY_ACCESS_ESCROW_LIMIT_CENTS) {
      throw new ForbiddenException(
        "Early access is limited to $0 escrow contracts.",
      );
    }

    return true;
  }

  private getRequestedEscrowCents(body: unknown): number {
    if (!body || typeof body !== "object") {
      return 0;
    }

    const payload = body as {
      stakeAmount?: unknown;
      pricing?: { plan?: unknown };
    };

    const pricingPlan =
      typeof payload.pricing?.plan === "string"
        ? payload.pricing.plan.toUpperCase()
        : undefined;
    if (pricingPlan && pricingPlan !== "CUSTOM") {
      return 1;
    }

    const rawStakeAmount = payload.stakeAmount ?? 0;
    if (
      typeof rawStakeAmount !== "number" &&
      typeof rawStakeAmount !== "string"
    ) {
      throw new BadRequestException("stakeAmount must be numeric.");
    }

    const stakeAmount = Number(rawStakeAmount);
    if (!Number.isFinite(stakeAmount)) {
      throw new BadRequestException("stakeAmount must be numeric.");
    }
    if (stakeAmount < 0) {
      throw new BadRequestException("stakeAmount must be non-negative.");
    }

    return stakeAmount > 0 ? Math.max(1, Math.round(stakeAmount * 100)) : 0;
  }
}
