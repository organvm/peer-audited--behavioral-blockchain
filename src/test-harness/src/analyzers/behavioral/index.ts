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
  getTemporalMultiplier(date?: Date): number;
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

/**
 * Outcome of trying to load the audited repo's engines:
 *  - `ok`: all engines present and usable → run the simulations.
 *  - `absent`: the repo ships none of these engines → not applicable (SKIP).
 *  - `broken`: the repo ships some/all engine files but they cannot be used
 *    (missing/renamed exports, partial set, or a load error) → the economic
 *    core under audit is broken (FAIL), never a silent skip.
 */
type EngineLoad =
  | { kind: 'ok'; engines: EngineBundle }
  | { kind: 'absent' }
  | { kind: 'broken'; reason: string };

/**
 * Candidate module locations (relative to a repo root, no extension) for each
 * engine the behavioral suite exercises, keyed by its expected export name. The
 * first existing candidate wins, so the suite finds the engines across known
 * layouts: the Styx monorepo `src/shared/...`, the extracted `@styx/audit-engine`
 * package under `packages/audit-engine/src/...`, and a standalone package whose
 * engines sit directly under `src/...`.
 */
const ENGINE_FILES = {
  LossAversionEngine: [
    ['src', 'shared', 'behavioral-physics', 'loss-aversion.engine'],
    ['packages', 'audit-engine', 'src', 'loss-aversion'],
    ['src', 'loss-aversion'],
  ],
  VolatilityEngine: [
    ['src', 'shared', 'behavioral-physics', 'volatility.engine'],
    ['packages', 'audit-engine', 'src', 'volatility'],
    ['src', 'volatility'],
  ],
  ConsensusResolver: [
    ['src', 'shared', 'fury-logic', 'consensus.resolver'],
    ['packages', 'audit-engine', 'src', 'consensus'],
    ['src', 'consensus'],
  ],
} as const;

type EngineName = keyof typeof ENGINE_FILES;

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

/** Resolve the first existing source file among an engine's candidate layouts. */
function resolveEngineFile(
  repoPath: string,
  candidates: readonly (readonly string[])[],
): string | null {
  for (const segments of candidates) {
    const base = path.join(repoPath, ...segments);
    for (const ext of ['.ts', '.js', '.mjs']) {
      if (fs.existsSync(base + ext)) return base + ext;
    }
  }
  return null;
}

/**
 * BehavioralAnalyzer
 *
 * The Economic Simulator of the Ergon Test Harness. It exercises the live
 * behavioral-physics and fury-logic engines **of the audited repository**
 * (resolved from `--repo`, not the harness's own copy) via seeded Monte Carlo
 * simulations to prove the economic invariants the protocol depends on. A repo
 * that ships none of these engines reports SKIP (not applicable); a repo whose
 * engines are present but unusable reports FAIL — never a misleading PASS. Each
 * check is designed to FAIL if the property it guards regresses:
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
    const load = await this.loadTargetEngines();

    if (load.kind === 'absent') {
      return this.uniformSuite(
        'SKIP',
        'Target repo ships no behavioral-physics/fury-logic engines; economic simulation not applicable.',
      );
    }
    if (load.kind === 'broken') {
      return this.uniformSuite(
        'FAIL',
        `Behavioral engines present but unusable (${load.reason}); the economic core under audit is broken.`,
      );
    }

    const rng = createRng(0x57595800); // "STYX"
    return {
      analyzer: 'behavioral',
      results: [
        this.simulateLossAversionStability(load.engines, rng),
        this.simulateCollusionResilience(load.engines, rng),
      ],
    };
  }

  /** Build a behavioral suite where both checks share one status/message. */
  private uniformSuite(status: 'SKIP' | 'FAIL', message: string): SuiteResult {
    return {
      analyzer: 'behavioral',
      results: [
        { check: 'loss-aversion-stability', status, message },
        { check: 'collusion-resilience', status, message },
      ],
    };
  }

  /**
   * Dynamically import the economic engines from the audited repository so the
   * behavioral suite validates the target's code, not the harness's own copy.
   *
   * Distinguishes three outcomes (see {@link EngineLoad}): a repo with no engine
   * files at all is `absent` (not applicable); a repo that ships any engine file
   * but cannot provide a usable, constructable export for all three is `broken`
   * (a failure, not a skip) — so a renamed/removed export or a load-time error
   * surfaces as a CI failure rather than a false pass.
   */
  private async loadTargetEngines(): Promise<EngineLoad> {
    const names = Object.keys(ENGINE_FILES) as EngineName[];
    const files = Object.fromEntries(
      names.map((n) => [n, resolveEngineFile(this.repoPath, ENGINE_FILES[n])]),
    ) as Record<EngineName, string | null>;
    const present = names.filter((n) => files[n]);

    // No engine files whatsoever → the repo simply doesn't implement these.
    if (present.length === 0) return { kind: 'absent' };

    // Some engine files exist, so the repo purports to implement the economic
    // core; any gap from here on is a broken core, not a non-applicable one.
    const missingFiles = names.filter((n) => !files[n]);
    if (missingFiles.length > 0) {
      return { kind: 'broken', reason: `missing engine file(s): ${missingFiles.join(', ')}` };
    }

    let modules: Record<keyof typeof files, unknown>;
    try {
      const [laMod, veMod, crMod] = await Promise.all([
        import(pathToFileURL(files.LossAversionEngine!).href),
        import(pathToFileURL(files.VolatilityEngine!).href),
        import(pathToFileURL(files.ConsensusResolver!).href),
      ]);
      modules = { LossAversionEngine: laMod, VolatilityEngine: veMod, ConsensusResolver: crMod };
    } catch (err) {
      return { kind: 'broken', reason: `engine module failed to load: ${(err as Error).message}` };
    }

    // Every engine must expose a constructable class export of the right name.
    const badExports = names.filter(
      (n) => typeof (modules[n] as Record<string, unknown>)?.[n] !== 'function',
    );
    if (badExports.length > 0) {
      return { kind: 'broken', reason: `missing or non-constructable export(s): ${badExports.join(', ')}` };
    }

    return {
      kind: 'ok',
      engines: {
        LossAversionEngine: (modules.LossAversionEngine as Record<string, unknown>)
          .LossAversionEngine as PenaltyEngineCtor,
        VolatilityEngine: (modules.VolatilityEngine as Record<string, unknown>)
          .VolatilityEngine as HeatEngineCtor,
        ConsensusResolver: (modules.ConsensusResolver as Record<string, unknown>)
          .ConsensusResolver as ResolverCtor,
      },
    };
  }

  /**
   * Check 1: Loss Aversion Coefficient Validation (Monte Carlo).
   *
   * Drives the target's LossAversionEngine with randomized behavioral "heat"
   * derived from random volatility coupled to the VolatilityEngine temporal
   * windows. A quarter of the samples are amplified stress inputs that push the
   * raw multiplier well past the upper clamp, so the bounds invariant is only
   * satisfied if the engine actually clamps. Asserts:
   *   - the temporal multiplier matches the canonical risk windows at fixed
   *     timestamps, and each sampled heat equals volatility × temporal and is
   *     finite/non-negative — so a VolatilityEngine regression (constant, sign,
   *     or non-finite heat) is caught *before* the loss-aversion clamp can mask
   *     it inside [min, max];
   *   - every sampled multiplier is finite and inside [SPEC_PENALTY_MIN, MAX];
   *   - the zero-volatility anchor equals the canonical λ (spec constant);
   *   - both clamps fire when directly probed (upper via a huge input, lower via
   *     an engine whose base coefficient sits below the floor).
   */
  private simulateLossAversionStability(engines: EngineBundle, rng: () => number): AnalyzerResult {
    const lae = new engines.LossAversionEngine();
    const ve = new engines.VolatilityEngine();

    // Independent spec anchor for the temporal multiplier: fixed timestamps whose
    // canonical risk window is known, validated directly against the engine so a
    // regression in getTemporalMultiplier cannot hide behind self-consistency.
    const temporalSpec: Array<[Date, number]> = [
      [new Date('2026-03-11T12:00:00Z'), 1.0], // Wed midday — STANDARD
      [new Date('2026-03-13T20:00:00Z'), 1.25], // Fri night — WEEKEND_VIGIL
      [new Date('2026-03-11T02:00:00Z'), 1.5], // Wed late night — PEAK_VULNERABILITY
    ];
    const temporalSpecOk = temporalSpec.every(
      ([date, expected]) => ve.getTemporalMultiplier(date) === expected,
    );

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let outOfBounds = 0;
    let nonFinite = 0;
    let heatAnomalies = 0;

    for (let i = 0; i < LOSS_AVERSION_ITERATIONS; i++) {
      // 25% stress samples drive the raw multiplier far past the upper clamp.
      const stress = rng() < 0.25;
      const volatility = stress ? rng() * 64 : rng();
      const sampledDate = new Date(
        Date.UTC(2026, 0, 1 + Math.floor(rng() * 7), Math.floor(rng() * 24)),
      );

      // Validate heat independently of the penalty clamp: it must be finite,
      // non-negative, and exactly volatility × the temporal multiplier.
      const temporal = ve.getTemporalMultiplier(sampledDate);
      const heat = ve.calculateBehavioralHeat(volatility, sampledDate);
      const expectedHeat = volatility * temporal;
      if (
        !Number.isFinite(heat) ||
        heat < 0 ||
        Math.abs(heat - expectedHeat) > 1e-9 * Math.max(1, Math.abs(expectedHeat))
      ) {
        heatAnomalies++;
      }

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
      anchorOk &&
      outOfBounds === 0 &&
      nonFinite === 0 &&
      heatAnomalies === 0 &&
      temporalSpecOk &&
      upperClampFires &&
      lowerClampFires;

    return {
      check: 'loss-aversion-stability',
      status: pass ? 'PASS' : 'FAIL',
      message:
        `Monte Carlo (${LOSS_AVERSION_ITERATIONS} runs incl. stress): ` +
        `anchor=${anchor.toFixed(3)} (target ${CANONICAL_LAMBDA}), mean=${mean.toFixed(3)}, ` +
        `range=[${min.toFixed(3)}, ${max.toFixed(3)}], out-of-bounds=${outOfBounds}, ` +
        `non-finite=${nonFinite}, heat-anomalies=${heatAnomalies}, ` +
        `temporal-spec=${temporalSpecOk ? 'ok' : 'BROKEN'}, ` +
        `clamps=${upperClampFires && lowerClampFires ? 'enforced' : 'BROKEN'}.`,
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
