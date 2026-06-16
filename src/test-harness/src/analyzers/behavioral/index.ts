import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { SuiteResult, AnalyzerResult } from '../../types/index';

const LOSS_AVERSION_ITERATIONS = 10_000;
const COLLUSION_PANELS = 5_000;

/**
 * Canonical economic constants from the protocol specification. These are pinned
 * here independently of the engine implementation so the gate fails if the
 * engine's own defaults ever drift away from the documented spec (rather than
 * comparing the implementation against itself, which can never catch drift).
 */
const CANONICAL_LAMBDA = 1.955; // Base loss-aversion coefficient (λ).
const SPEC_PENALTY_MIN = 1.5; // Lower clamp on the penalty multiplier.
const SPEC_PENALTY_MAX = 5.0; // Upper clamp on the penalty multiplier.
const PANEL_SIZE = 5;

/** Structural decision shape consumed by a target repo's ConsensusResolver. */
interface AuditorDecisionLike {
  auditorId: string;
  integrityScore: number;
  decision: 'BREACH' | 'CLEAN';
}

/** Minimal structural contracts for the engines loaded from the target repo. */
interface PenaltyEngine {
  calculatePenaltyMultiplier(volatility: number): number;
}
type PenaltyEngineCtor = new (config?: { baseCoefficient?: number }) => PenaltyEngine;

interface HeatEngine {
  calculateBehavioralHeat(userVolatility: number, date?: Date): number;
}
type HeatEngineCtor = new () => HeatEngine;

interface Resolver {
  resolve(decisions: AuditorDecisionLike[]): 'BREACH' | 'CLEAN' | 'UNCERTAIN';
}
type ResolverCtor = new () => Resolver;

interface EngineBundle {
  LossAversionEngine: PenaltyEngineCtor;
  VolatilityEngine: HeatEngineCtor;
  ConsensusResolver: ResolverCtor;
}

/** Engine modules, relative to a repo root, that the behavioral suite exercises. */
const ENGINE_FILES = {
  lossAversion: ['src', 'shared', 'behavioral-physics', 'loss-aversion.engine'],
  volatility: ['src', 'shared', 'behavioral-physics', 'volatility.engine'],
  consensus: ['src', 'shared', 'fury-logic', 'consensus.resolver'],
} as const;

/**
 * Deterministic PRNG (mulberry32). A quality gate must be reproducible, so the
 * Monte Carlo simulations are seeded rather than using Math.random().
 */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve a module path (no extension) to the first existing source file. */
function resolveEngineFile(repoPath: string, segments: readonly string[]): string | null {
  const base = path.join(repoPath, ...segments);
  for (const ext of ['.ts', '.js', '.mjs']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return null;
}

/**
 * BehavioralAnalyzer
 *
 * The Economic Simulator of the Ergon Test Harness. It exercises the live
 * behavioral-physics and fury-logic engines **of the audited repository**
 * (resolved from `--repo`, not the harness's own copy) via seeded Monte Carlo
 * simulations to prove the economic invariants the protocol depends on. If the
 * target repo does not ship these engines, the suite reports SKIP rather than a
 * misleading PASS. Each check is designed to FAIL if the property it guards
 * regresses:
 *
 *  1. Loss-aversion stability — penalty multipliers stay finite and inside the
 *     spec [min, max] clamps even under extreme stress inputs that cross both
 *     thresholds, the zero-volatility anchor equals the canonical λ, and the
 *     clamps are directly enforced.
 *  2. Collusion resilience — an integrity-weighted consensus produces the
 *     correct verdict for every panel, including panels where low-integrity
 *     colluders are a numerical majority and can only be defeated by weight.
 */
export class BehavioralAnalyzer {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  public async analyze(): Promise<SuiteResult> {
    const engines = await this.loadTargetEngines();
    if (!engines) {
      const missing = (Object.keys(ENGINE_FILES) as (keyof typeof ENGINE_FILES)[])
        .filter((k) => !resolveEngineFile(this.repoPath, ENGINE_FILES[k]))
        .join(', ');
      const message = `Target repo has no behavioral-physics/fury-logic engines (missing: ${missing}); economic simulation not applicable.`;
      return {
        analyzer: 'behavioral',
        results: [
          { check: 'loss-aversion-stability', status: 'SKIP', message },
          { check: 'collusion-resilience', status: 'SKIP', message },
        ],
      };
    }

    const rng = createRng(0x57595800); // "STYX"
    return {
      analyzer: 'behavioral',
      results: [
        this.simulateLossAversionStability(engines, rng),
        this.simulateCollusionResilience(engines, rng),
      ],
    };
  }

  /**
   * Dynamically import the economic engines from the audited repository so the
   * behavioral suite validates the target's code, not the harness's own copy.
   * Returns null when any engine module is absent.
   */
  private async loadTargetEngines(): Promise<EngineBundle | null> {
    const laFile = resolveEngineFile(this.repoPath, ENGINE_FILES.lossAversion);
    const veFile = resolveEngineFile(this.repoPath, ENGINE_FILES.volatility);
    const crFile = resolveEngineFile(this.repoPath, ENGINE_FILES.consensus);
    if (!laFile || !veFile || !crFile) return null;

    const [laMod, veMod, crMod] = await Promise.all([
      import(pathToFileURL(laFile).href),
      import(pathToFileURL(veFile).href),
      import(pathToFileURL(crFile).href),
    ]);

    const LossAversionEngine = laMod.LossAversionEngine as PenaltyEngineCtor | undefined;
    const VolatilityEngine = veMod.VolatilityEngine as HeatEngineCtor | undefined;
    const ConsensusResolver = crMod.ConsensusResolver as ResolverCtor | undefined;
    if (!LossAversionEngine || !VolatilityEngine || !ConsensusResolver) return null;

    return { LossAversionEngine, VolatilityEngine, ConsensusResolver };
  }

  /**
   * Check 1: Loss Aversion Coefficient Validation (Monte Carlo).
   *
   * Drives the target's LossAversionEngine with randomized behavioral "heat"
   * derived from random volatility coupled to the VolatilityEngine temporal
   * windows. A quarter of the samples are amplified stress inputs that push the
   * raw multiplier well past the upper clamp, so the bounds invariant is only
   * satisfied if the engine actually clamps. Asserts:
   *   - every sampled multiplier is finite and inside [SPEC_PENALTY_MIN, MAX];
   *   - the zero-volatility anchor equals the canonical λ (spec constant);
   *   - both clamps fire when directly probed (upper via a huge input, lower via
   *     an engine whose base coefficient sits below the floor).
   */
  private simulateLossAversionStability(engines: EngineBundle, rng: () => number): AnalyzerResult {
    const lae = new engines.LossAversionEngine();
    const ve = new engines.VolatilityEngine();

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let outOfBounds = 0;
    let nonFinite = 0;

    for (let i = 0; i < LOSS_AVERSION_ITERATIONS; i++) {
      // 25% stress samples drive the raw multiplier far past the upper clamp.
      const stress = rng() < 0.25;
      const volatility = stress ? rng() * 64 : rng();
      const sampledDate = new Date(
        Date.UTC(2026, 0, 1 + Math.floor(rng() * 7), Math.floor(rng() * 24)),
      );
      const heat = ve.calculateBehavioralHeat(volatility, sampledDate);
      const multiplier = lae.calculatePenaltyMultiplier(heat);

      if (!Number.isFinite(multiplier)) {
        nonFinite++;
        continue;
      }
      min = Math.min(min, multiplier);
      max = Math.max(max, multiplier);
      sum += multiplier;
      if (multiplier < SPEC_PENALTY_MIN - 1e-9 || multiplier > SPEC_PENALTY_MAX + 1e-9) {
        outOfBounds++;
      }
    }

    const finiteSamples = LOSS_AVERSION_ITERATIONS - nonFinite;
    const mean = finiteSamples === 0 ? NaN : sum / finiteSamples;
    const anchor = lae.calculatePenaltyMultiplier(0);
    const anchorOk = Number.isFinite(anchor) && Math.abs(anchor - CANONICAL_LAMBDA) < 1e-9;

    // Directly probe both clamps so removing the clamping logic is detectable
    // even though the natural formula never reaches the lower bound.
    const upperClampFires = lae.calculatePenaltyMultiplier(1e6) === SPEC_PENALTY_MAX;
    const lowerClampFires =
      new engines.LossAversionEngine({ baseCoefficient: 0 }).calculatePenaltyMultiplier(0) ===
      SPEC_PENALTY_MIN;

    const pass =
      anchorOk && outOfBounds === 0 && nonFinite === 0 && upperClampFires && lowerClampFires;

    return {
      check: 'loss-aversion-stability',
      status: pass ? 'PASS' : 'FAIL',
      message:
        `Monte Carlo (${LOSS_AVERSION_ITERATIONS} runs incl. stress): ` +
        `anchor=${anchor.toFixed(3)} (target ${CANONICAL_LAMBDA}), mean=${mean.toFixed(3)}, ` +
        `range=[${min.toFixed(3)}, ${max.toFixed(3)}], out-of-bounds=${outOfBounds}, ` +
        `non-finite=${nonFinite}, clamps=${upperClampFires && lowerClampFires ? 'enforced' : 'BROKEN'}.`,
    };
  }

  /**
   * Check 2: Collusion Resilience (Monte Carlo).
   *
   * For each panel a random ground truth is chosen. Honest auditors (high
   * integrity) vote the truth; colluders (deliberately low integrity) vote the
   * adversarial opposite. The colluder count ranges from 1 to 3 of 5, so a
   * sizeable fraction of panels give the colluders a NUMERICAL MAJORITY — those
   * panels can only resolve correctly if the target's ConsensusResolver weights
   * by integrity, which is exactly the behaviour under test. A plain majority
   * vote would mis-resolve them. The integrity bands are chosen so the honest
   * weight dominates decisively, so the pass condition is the strongest
   * possible: every panel must resolve to its ground truth (no fraudulent
   * breaches, no missed breaches, and no escalations to UNCERTAIN).
   */
  private simulateCollusionResilience(engines: EngineBundle, rng: () => number): AnalyzerResult {
    const resolver = new engines.ConsensusResolver();

    let fraudulentBreaches = 0;
    let missedBreaches = 0;
    let uncertainVerdicts = 0;
    let correctVerdicts = 0;
    let colluderMajorityPanels = 0;

    for (let i = 0; i < COLLUSION_PANELS; i++) {
      const groundTruth: 'BREACH' | 'CLEAN' = rng() < 0.5 ? 'BREACH' : 'CLEAN';
      const adversarial: 'BREACH' | 'CLEAN' = groundTruth === 'BREACH' ? 'CLEAN' : 'BREACH';
      const colluderCount = 1 + Math.floor(rng() * 3); // 1-3 colluders (can be a majority of 5)
      if (colluderCount > PANEL_SIZE - colluderCount) colluderMajorityPanels++;

      const decisions: AuditorDecisionLike[] = [];
      for (let j = 0; j < PANEL_SIZE; j++) {
        const isColluder = j < colluderCount;
        // Low-integrity colluders vs high-integrity honest auditors. Bands are
        // wide enough apart that the honest weight wins even at a 3:2 deficit.
        const integrityScore = isColluder ? 0.05 + rng() * 0.15 : 0.8 + rng() * 0.2;
        decisions.push({
          auditorId: `A${j}`,
          integrityScore,
          decision: isColluder ? adversarial : groundTruth,
        });
      }

      const verdict = resolver.resolve(decisions);
      if (verdict === groundTruth) correctVerdicts++;
      if (groundTruth === 'CLEAN' && verdict === 'BREACH') fraudulentBreaches++;
      if (groundTruth === 'BREACH' && verdict !== 'BREACH') missedBreaches++;
      if (verdict === 'UNCERTAIN') uncertainVerdicts++;
    }

    const pass = correctVerdicts === COLLUSION_PANELS;

    return {
      check: 'collusion-resilience',
      status: pass ? 'PASS' : 'FAIL',
      message:
        `Shatter-point simulation (${COLLUSION_PANELS} panels, integrity-weighted consensus, ` +
        `${colluderMajorityPanels} with a colluder majority): ${correctVerdicts} correct verdicts, ` +
        `${fraudulentBreaches} fraudulent breaches, ${missedBreaches} missed breaches, ` +
        `${uncertainVerdicts} escalated to UNCERTAIN.`,
    };
  }
}
