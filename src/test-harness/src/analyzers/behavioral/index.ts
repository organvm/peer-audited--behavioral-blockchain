import { SuiteResult, AnalyzerResult } from '../../types/index';
import { LossAversionEngine } from '../../../../shared/behavioral-physics/loss-aversion.engine.ts';
import { VolatilityEngine } from '../../../../shared/behavioral-physics/volatility.engine.ts';
import {
  ConsensusResolver,
  AuditorDecision,
} from '../../../../shared/fury-logic/consensus.resolver.ts';

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

/**
 * BehavioralAnalyzer
 *
 * The Economic Simulator of the Ergon Test Harness. It exercises the live
 * behavioral-physics and fury-logic engines via seeded Monte Carlo simulations
 * to prove the economic invariants the protocol depends on. Each check is
 * designed to FAIL if the property it guards regresses:
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

  public analyze(): SuiteResult {
    const results: AnalyzerResult[] = [];
    const rng = createRng(0x57595800); // "STYX"

    results.push(this.simulateLossAversionStability(rng));
    results.push(this.simulateCollusionResilience(rng));

    return { analyzer: 'behavioral', results };
  }

  /**
   * Check 1: Loss Aversion Coefficient Validation (Monte Carlo).
   *
   * Drives {@link LossAversionEngine} with randomized behavioral "heat" derived
   * from random volatility coupled to {@link VolatilityEngine} temporal windows.
   * A quarter of the samples are amplified stress inputs that push the raw
   * multiplier well past the upper clamp, so the bounds invariant is only
   * satisfied if the engine actually clamps. Asserts:
   *   - every sampled multiplier is finite and inside [SPEC_PENALTY_MIN, MAX];
   *   - the zero-volatility anchor equals the canonical λ (spec constant);
   *   - both clamps fire when directly probed (upper via a huge input, lower via
   *     an engine whose base coefficient sits below the floor).
   */
  private simulateLossAversionStability(rng: () => number): AnalyzerResult {
    const lae = new LossAversionEngine();
    const ve = new VolatilityEngine();

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

    const mean = nonFinite === LOSS_AVERSION_ITERATIONS ? NaN : sum / (LOSS_AVERSION_ITERATIONS - nonFinite);
    const anchor = lae.calculatePenaltyMultiplier(0);
    const anchorOk = Number.isFinite(anchor) && Math.abs(anchor - CANONICAL_LAMBDA) < 1e-9;

    // Directly probe both clamps so removing the clamping logic is detectable
    // even though the natural formula never reaches the lower bound.
    const upperClampFires = lae.calculatePenaltyMultiplier(1e6) === SPEC_PENALTY_MAX;
    const lowerClampFires =
      new LossAversionEngine({ baseCoefficient: 0 }).calculatePenaltyMultiplier(0) ===
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
   * panels can only resolve correctly if {@link ConsensusResolver} weights by
   * integrity, which is exactly the behaviour under test. A plain majority vote
   * would mis-resolve them. The integrity bands are chosen so the honest weight
   * dominates decisively, so the pass condition is the strongest possible: every
   * panel must resolve to its ground truth (no fraudulent breaches, no missed
   * breaches, and no escalations to UNCERTAIN).
   */
  private simulateCollusionResilience(rng: () => number): AnalyzerResult {
    const resolver = new ConsensusResolver();

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

      const decisions: AuditorDecision[] = [];
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
