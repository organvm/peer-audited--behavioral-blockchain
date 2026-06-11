import { describe, it, expect } from "vitest";
import { generatePlan } from "./plan.js";
import { renderMarkdown } from "./markdown.js";
import type { InstanceConfig } from "../types/index.js";

/** Minimal valid config for testing. */
const testConfig: InstanceConfig = {
  systemName: "test-system",
  parameters: {
    p1Host: {
      archetype: "personal_creator",
      statement: "Test host",
    },
    p2Wedge: {
      statement: "Test wedge",
    },
    p3Product: {
      statement: "Test product",
      kind: "app",
      conversionCta: "Test CTA",
    },
    p4OwnedAsset: {
      statement: "Test asset",
      kind: "email_list",
    },
    p5ProofLoop: {
      statement: "Test proof",
      cadence: "weekly",
      format: "card",
    },
  },
  channels: {
    host: {
      role: "host",
      name: "Test Host Channel",
      voice: "Test voice",
      does: ["Test does"],
      doesNot: ["Test does not"],
      ratio: {
        value: 60,
        trust: 25,
        proof: 0,
        conversion: 15,
      },
      cadence: {
        shortForm: 3,
        longForm: 1,
        story: 1,
        conversion: 1,
        conversationPrompts: 1,
      },
    },
    product: {
      role: "product",
      name: "Test Product Channel",
      voice: "Test product voice",
      does: ["Test product does"],
      doesNot: ["Test product does not"],
      ratio: {
        value: 40,
        trust: 25,
        proof: 20,
        conversion: 15,
      },
      cadence: {
        shortForm: 1,
        longForm: 0,
        story: 0,
        conversion: 1,
        proofPosts: 1,
        scopeExplainers: 1,
      },
    },
  },
  ladder: {
    admissionRule: "Test",
    cohortSize: 20,
    weeklyRitual: "Test ritual",
    sourceMix: { own: 50, partner: 30, intermediary: 20 },
  },
  attack: {
    l1DemandCapture: { phrases: ["test phrase"], capturePageRoute: "/test" },
    l2BorrowedAudience: { targets: ["test target"], voice: "consumer_creator" },
    l3Intermediaries: { hook: "Test hook", referralAsset: "Test asset" },
    l4CommunityLoop: { shareCardMoment: "Test", referralMechanic: "Test" },
    l5Authority: { cornerstoneEssays: ["Test essay"] },
    doNotSayYet: ["Test"],
  },
  audienceAsProduct: {
    rungs: [{ name: "free" }, { name: "email" }],
    coexistenceRule: "Test",
  },
  kpis: [{ name: "Test KPI", weeklyTarget: 100, unit: "followers" }],
  healthBands: { green: "G", yellow: "Y", red: "R" },
  guardrails: {
    inheritedFrom: "Test",
    nicheRule: "Test rule",
  },
};

describe("generatePlan", () => {
  it("generates 4 weeks", () => {
    const plan = generatePlan(testConfig, new Date("2026-06-15"));
    expect(plan.weeks).toHaveLength(4);
  });

  it("starts on a Monday", () => {
    const plan = generatePlan(testConfig, new Date("2026-06-15"));
    expect(plan.startDate).toBe("2026-06-15");
    // 2026-06-15 is a Monday
  });

  it("produces 28 days total (4 weeks × 7 days)", () => {
    const plan = generatePlan(testConfig, new Date("2026-06-15"));
    const totalDays = plan.weeks.reduce((n, w) => n + w.days.length, 0);
    expect(totalDays).toBeGreaterThanOrEqual(28);
  });

  it("derives pillars from channel ratios", () => {
    const plan = generatePlan(testConfig, new Date("2026-06-15"));
    expect(plan.pillars.length).toBeGreaterThan(0);
    const totalHostRatio = plan.pillars
      .filter((p) => p.channel === "host")
      .reduce((sum, p) => sum + p.ratio, 0);
    const totalProductRatio = plan.pillars
      .filter((p) => p.channel === "product")
      .reduce((sum, p) => sum + p.ratio, 0);
    expect(totalHostRatio).toBe(100);
    expect(totalProductRatio).toBe(100);
  });
});

describe("renderMarkdown", () => {
  it("includes the system name in the title", () => {
    const plan = generatePlan(testConfig, new Date("2026-06-15"));
    const md = renderMarkdown(plan);
    expect(md).toContain("# test-system — 30-Day Content Calendar");
  });

  it("includes the pillars table", () => {
    const plan = generatePlan(testConfig, new Date("2026-06-15"));
    const md = renderMarkdown(plan);
    expect(md).toContain("## Pillars");
    expect(md).toContain("| # | Pillar | Channel | Ratio | Goal |");
  });

  it("includes production notes", () => {
    const plan = generatePlan(testConfig, new Date("2026-06-15"));
    const md = renderMarkdown(plan);
    expect(md).toContain("## Production notes");
    expect(md).toContain("engine-generated");
  });
});
