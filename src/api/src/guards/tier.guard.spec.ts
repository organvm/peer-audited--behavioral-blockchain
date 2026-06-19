import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  AccessTier,
  EARLY_ACCESS_ACTIVE_CONTRACT_LIMIT,
  TierGuard,
} from "./tier.guard";

describe("TierGuard", () => {
  let guard: TierGuard;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    guard = new TierGuard(mockPool as any);
  });

  function createContext(input?: {
    user?: { id?: string };
    body?: Record<string, unknown>;
  }) {
    const hasUserKey =
      !!input && Object.prototype.hasOwnProperty.call(input, "user");

    return {
      switchToHttp: () => ({
        getRequest: () => ({
          user: hasUserKey ? input?.user : { id: "user-1" },
          body: input?.body ?? { stakeAmount: 0 },
        }),
      }),
    } as any;
  }

  function mockTier(
    accessTier: AccessTier | string,
    activeContractCount: number,
  ) {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          access_tier: accessTier,
          active_contract_count: activeContractCount,
        },
      ],
    });
  }

  it("denies when no authenticated user is present", async () => {
    await expect(
      guard.canActivate(createContext({ user: undefined })),
    ).rejects.toThrow(ForbiddenException);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("denies when user is not found", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(guard.canActivate(createContext())).rejects.toThrow(
      /not found/,
    );
  });

  it("allows pro users without contract or escrow caps", async () => {
    mockTier(AccessTier.PRO, 12);

    await expect(
      guard.canActivate(createContext({ body: { stakeAmount: 250 } })),
    ).resolves.toBe(true);
  });

  it("denies free users from contract creation", async () => {
    mockTier(AccessTier.FREE, 0);

    await expect(guard.canActivate(createContext())).rejects.toThrow(
      /requires early access or pro access/,
    );
  });

  it("allows early-access users below the active contract cap with zero escrow", async () => {
    mockTier(AccessTier.EARLY_ACCESS, EARLY_ACCESS_ACTIVE_CONTRACT_LIMIT - 1);

    await expect(
      guard.canActivate(createContext({ body: { stakeAmount: 0 } })),
    ).resolves.toBe(true);
  });

  it("denies early-access users at the active contract cap", async () => {
    mockTier(AccessTier.EARLY_ACCESS, EARLY_ACCESS_ACTIVE_CONTRACT_LIMIT);

    await expect(
      guard.canActivate(createContext({ body: { stakeAmount: 0 } })),
    ).rejects.toThrow(/limited to 3 active contracts/);
  });

  it("denies early-access users requesting escrow through stakeAmount", async () => {
    mockTier(AccessTier.EARLY_ACCESS, 0);

    await expect(
      guard.canActivate(createContext({ body: { stakeAmount: 0.01 } })),
    ).rejects.toThrow(/limited to \$0 escrow contracts/);
  });

  it("denies early-access users requesting paid pricing metadata", async () => {
    mockTier(AccessTier.EARLY_ACCESS, 0);

    await expect(
      guard.canActivate(
        createContext({
          body: { stakeAmount: 0, pricing: { plan: "MVP_39" } },
        }),
      ),
    ).rejects.toThrow(/limited to \$0 escrow contracts/);
  });

  it("rejects non-numeric stakeAmount before applying tier policy", async () => {
    mockTier(AccessTier.EARLY_ACCESS, 0);

    await expect(
      guard.canActivate(createContext({ body: { stakeAmount: {} } })),
    ).rejects.toThrow(BadRequestException);
  });

  it("fails closed for unsupported database tier values", async () => {
    mockTier("internal", 0);

    await expect(guard.canActivate(createContext())).rejects.toThrow(
      /Unsupported access tier/,
    );
  });
});
