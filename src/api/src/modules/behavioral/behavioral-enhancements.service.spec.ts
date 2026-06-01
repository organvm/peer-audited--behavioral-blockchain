import { Test, TestingModule } from "@nestjs/testing";
import { BehavioralEnhancementsService } from "./behavioral-enhancements.service";
import { Pool } from "pg";
import {
  CrabBucketSeverity,
  HabituationStatus,
} from "@styx/shared/libs/behavioral-enhancements";

describe("BehavioralEnhancementsService", () => {
  let service: BehavioralEnhancementsService;
  let pool: Pool;
  const mockQuery = jest.fn();

  beforeEach(async () => {
    mockQuery.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BehavioralEnhancementsService,
        { provide: Pool, useValue: { query: mockQuery } },
      ],
    }).compile();

    service = module.get<BehavioralEnhancementsService>(
      BehavioralEnhancementsService,
    );
    pool = module.get<Pool>(Pool);
  });

  describe("Crab Bucket Risk", () => {
    it("analyzes risk from signal counts", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { pattern: "SABOTAGE_OFFER", count: "2" },
          { pattern: "DIRECT_TEMPTATION", count: "1" },
        ],
      });
      const result = await service.analyzeCrabBucketRisk("u1");
      expect(result.signalCount).toBe(3);
      expect(result.severity).toBe(CrabBucketSeverity.MEDIUM);
    });
  });

  describe("Commitment Device Catalog", () => {
    it("returns device catalog", () => {
      const catalog = service.getCommitmentDeviceCatalog();
      expect(catalog.length).toBeGreaterThan(0);
    });
  });

  describe("Identity Reframing", () => {
    it("returns domain-specific reframing", () => {
      const msg = service.getReframingForContract(
        "BIOLOGICAL_WEIGHT",
        30,
        "streak",
      );
      expect(msg).toContain("30");
    });
  });

  describe("Save More Tomorrow", () => {
    it("enables escalation schedule", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const schedule = await service.enableSaveMoreTomorrow("c1", 100);
      expect(schedule.enabled).toBe(true);
    });
  });

  describe("Professional Mode", () => {
    it("returns default config", () => {
      const config = service.getProfessionalModeConfig();
      expect(config.selfDistancingEnabled).toBe(false);
    });

    it("applies professional copy with distancing", () => {
      const config = {
        ...service.getProfessionalModeConfig(),
        selfDistancingEnabled: true,
      };
      const result = service.applyProfessionalCopy(
        "You completed your task",
        config,
      );
      expect(result).toContain("the participant");
    });
  });

  describe("Habituation Detection", () => {
    it("detects habituation for aged contracts", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ age_days: 60 }] })
        .mockResolvedValueOnce({
          rows: Array.from({ length: 28 }, (_, i) => ({
            attestation_date: new Date(Date.now() - i * 86400000)
              .toISOString()
              .split("T")[0],
            status: "ATTESTED",
            hour: 9,
          })),
        });
      const result = await service.detectContractHabituation("c1");
      expect(result.status).toBe(HabituationStatus.PLATEAU);
    });
  });

  describe("Behavior Swap", () => {
    it("proposes a behavior swap", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ age_days: 30, status: "ACTIVE", stake_amount: "100.00" }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "swap-1",
              source_contract_id: "c1",
              target_oath_category: "BIOLOGICAL_WEIGHT",
              carry_over_stake_pct: 50,
              status: "PROPOSED",
              created_at: new Date(),
            },
          ],
        });
      const result = await service.proposeBehaviorSwap(
        "u1",
        "c1",
        "BIOLOGICAL_WEIGHT",
        50,
      );
      expect(result.carryOverStakePct).toBe(50);
    });
  });
});
