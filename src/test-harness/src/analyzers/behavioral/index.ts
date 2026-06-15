import { SuiteResult, AnalyzerResult } from '../../types/index';
import {
  LossAversionEngine,
  DEFAULT_CONFIG,
} from '../../../../shared/behavioral-physics/loss-aversion.engine.ts';
import { VolatilityEngine } from '../../../../shared/behavioral-physics/volatility.engine.ts';
import {
  ConsensusResolver,
  AuditorDecision,
} from '../../../../shared/fury-logic/consensus.resolver.ts';

const LOSS_AVERSION_ITERATIONS = 10_000;
const COLLUSION_PANELS = 5_000;

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
 * to prove the economic invariants the protocol depends on:
 *
 *  1. Loss-aversion stability — the penalty multiplier always stays within its
 *     documented bounds and the zero-volatility anchor equals the base
 *     coefficient, across randomized volatility and temporal risk windows.
 *  2. Collusion resilience — an integrity-weighted consensus resists a colluding
 *     minority of low-integrity auditors in both directions (no fraudulent
 *     BREACH verdicts, no missed real breaches).
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
   * from random volatility coupled to {@link VolatilityEngine} temporal windows,
   * then asserts the two invariants the economic model guarantees:
   *   - every sampled multiplier lands inside [min, max] penalty bounds;
   *   - the zero-volatility anchor equals the configured base coefficient.
   */
  private simulateLossAversionStability(rng: () => number): AnalyzerResult {
    const lae = new LossAversionEngine();
    const ve = new VolatilityEngine();
    const { baseCoefficient, minPenaltyMultiplier, maxPenaltyMultiplier } = DEFAULT_CONFIG;

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let outOfBounds = 0;

    for (let i = 0; i < LOSS_AVERSION_ITERATIONS; i++) {
      const volatility = rng(); // [0, 1)
      const sampledDate = new Date(
        Date.UTC(2026, 0, 1 + Math.floor(rng() * 7), Math.floor(rng() * 24)),
      );
      const heat = ve.calculateBehavioralHeat(volatility, sampledDate);
      const multiplier = lae.calculatePenaltyMultiplier(heat);

      min = Math.min(min, multiplier);
      max = Math.max(max, multiplier);
      sum += multiplier;
      if (multiplier < minPenaltyMultiplier - 1e-9 || multiplier > maxPenaltyMultiplier + 1e-9) {
        outOfBounds++;
      }
    }

    const mean = sum / LOSS_AVERSION_ITERATIONS;
    const anchor = lae.calculatePenaltyMultiplier(0);
    const anchorOk = Math.abs(anchor - baseCoefficient) < 1e-9;
    const boundsOk = outOfBounds === 0;
    const pass = anchorOk && boundsOk;

    return {
      check: 'loss-aversion-stability',
      status: pass ? 'PASS' : 'FAIL',
      message:
        `Monte Carlo (${LOSS_AVERSION_ITERATIONS} runs): anchor=${anchor.toFixed(3)} ` +
        `(target ${baseCoefficient}), mean=${mean.toFixed(3)}, ` +
        `range=[${min.toFixed(3)}, ${max.toFixed(3)}], out-of-bounds=${outOfBounds}.`,
    };
  }

  /**
   * Check 2: Collusion Resilience (Monte Carlo).
   *
   * For each panel a random ground truth is chosen. Honest auditors (high
   * integrity) vote the truth; a colluding minority (low integrity) votes the
   * adversarial opposite. {@link ConsensusResolver} weights by integrity, so the
   * honest majority's weight should dominate — yielding zero fraudulent BREACH
   * verdicts and zero missed real breaches.
   */
  private simulateCollusionResilience(rng: () => number): AnalyzerResult {
    const resolver = new ConsensusResolver();
    const panelSize = 5;

    let fraudulentBreaches = 0;
    let missedBreaches = 0;
    let correctVerdicts = 0;

    for (let i = 0; i < COLLUSION_PANELS; i++) {
      const groundTruth: 'BREACH' | 'CLEAN' = rng() < 0.5 ? 'BREACH' : 'CLEAN';
      const adversarial: 'BREACH' | 'CLEAN' = groundTruth === 'BREACH' ? 'CLEAN' : 'BREACH';
      const colluderCount = 1 + Math.floor(rng() * 2); // 1-2 colluders: a minority

      const decisions: AuditorDecision[] = [];
      for (let j = 0; j < panelSize; j++) {
        const isColluder = j < colluderCount;
        const integrityScore = isColluder ? 0.1 + rng() * 0.3 : 0.7 + rng() * 0.3;
        decisions.push({
          auditorId: `A${j}`,
          integrityScore,
          decision: isColluder ? adversarial : groundTruth,
        });
      }

      const verdict = resolver.resolve(decisions);
      if (groundTruth === 'CLEAN' && verdict === 'BREACH') fraudulentBreaches++;
      if (groundTruth === 'BREACH' && verdict !== 'BREACH') missedBreaches++;
      if (verdict === groundTruth) correctVerdicts++;
    }

    const pass = fraudulentBreaches === 0 && missedBreaches === 0;

    return {
      check: 'collusion-resilience',
      status: pass ? 'PASS' : 'FAIL',
      message:
        `Shatter-point simulation (${COLLUSION_PANELS} panels, integrity-weighted ` +
        `consensus): ${fraudulentBreaches} fraudulent breaches, ${missedBreaches} missed ` +
        `breaches, ${correctVerdicts} correct verdicts.`,
    };
  }
}
