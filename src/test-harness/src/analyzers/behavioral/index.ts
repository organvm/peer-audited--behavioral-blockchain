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

type EngineName = keyof EngineBundle;

/**
 * A known on-disk arrangement of the economic engines, keyed by the export name
 * each module must provide. Module paths are relative to a repo root and carry
 * no extension (resolved against .ts/.js/.mjs).
 *
 * `requireAll` marks a layout whose paths use generic, collision-prone names
 * (e.g. a bare `src/consensus`): it is only considered present when ALL three
 * files exist, so an unrelated repo that merely happens to have one such file
 * is treated as "no engine layout" (SKIP) rather than a broken one (FAIL).
 */
interface EngineLayout {
  name: string;
  files: Record<EngineName, readonly string[]>;
  requireAll?: boolean;
}

/**
 * Supported engine layouts. A repository can contain more than one (the Styx
 * monorepo ships both the `src/shared/...` copy and the extracted
 * `@styx/audit-engine` package), and every complete layout is audited
 * independently so a regression in one copy cannot hide behind a healthy other.
 */
const ENGINE_LAYOUTS: readonly EngineLayout[] = [
  {
    name: 'monorepo-shared',
    files: {
      LossAversionEngine: ['src', 'shared', 'behavioral-physics', 'loss-aversion.engine'],
      VolatilityEngine: ['src', 'shared', 'behavioral-physics', 'volatility.engine'],
      ConsensusResolver: ['src', 'shared', 'fury-logic', 'consensus.resolver'],
    },
  },
  {
    name: 'audit-engine-package',
    files: {
      LossAversionEngine: ['packages', 'audit-engine', 'src', 'loss-aversion'],
      VolatilityEngine: ['packages', 'audit-engine', 'src', 'volatility'],
      ConsensusResolver: ['packages', 'audit-engine', 'src', 'consensus'],
    },
  },
  {
    name: 'standalone',
    files: {
      LossAversionEngine: ['src', 'loss-aversion'],
      VolatilityEngine: ['src', 'volatility'],
      ConsensusResolver: ['src', 'consensus'],
    },
    requireAll: true,
  },
];

const ENGINE_NAMES = ['LossAversionEngine', 'VolatilityEngine', 'ConsensusResolver'] as const;

/**
 * Outcome of probing one layout in the audited repo:
 *  - `ok`: all engines present and usable → run the simulations.
 *  - `absent`: none of this layout's engine files exist → layout not present.
 *  - `broken`: some/all files exist but cannot be used (partial set, missing or
 *    renamed export, or a load error) → the economic core under audit is broken.
 */
type LayoutLoad =
  | { kind: 'ok'; engines: EngineBundle }
  | { kind: 'absent' }
  | { kind: 'broken'; reason: string };

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
 * simulations to prove the economic invariants the protocol depends on. Every
 * complete engine layout found in the repo is audited independently; a repo
 * with no engine layout at all reports SKIP (not applicable), and a layout
 * whose engines are present but unusable reports FAIL — never a misleading PASS.
 * Each check is designed to FAIL if the property it guards regresses:
 *
 *  1. Loss-aversion stability — the temporal multiplier matches the canonical
 *     risk windows at fixed timestamps; sampled heat is finite, non-negative and
 *     equals volatility × temporal; penalty multipliers stay finite and inside
 *     the spec [min, max] clamps even under extreme stress inputs that cross
 *     both thresholds; the zero-volatility anchor equals the canonical λ; and
 *     both clamps fire when directly probed.
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
    const probed = await Promise.all(
      ENGINE_LAYOUTS.map(async (layout) => ({ layout, load: await this.loadLayout(layout) })),
    );
    const auditable = probed.filter((p) => p.load.kind !== 'absent');

    if (auditable.length === 0) {
      return {
        analyzer: 'behavioral',
        results: [
          {
            check: 'loss-aversion-stability',
            status: 'SKIP',
            message:
              'Target repo ships no behavioral-physics/fury-logic engine layout; economic simulation not applicable.',
          },
          {
            check: 'collusion-resilience',
            status: 'SKIP',
            message:
              'Target repo ships no behavioral-physics/fury-logic engine layout; economic simulation not applicable.',
          },
        ],
      };
    }

    // Qualify check ids with the layout name only when more than one layout is
    // audited, so single-layout repos keep the stable bare check ids.
    const qualify = auditable.length > 1;
    const results: AnalyzerResult[] = [];

    for (const { layout, load } of auditable) {
      const tag = qualify ? ` [${layout.name}]` : '';
      if (load.kind === 'broken') {
        const message = `Engines present but unusable (${load.reason}); the economic core under audit is broken.`;
        results.push({ check: `loss-aversion-stability${tag}`, status: 'FAIL', message });
        results.push({ check: `collusion-resilience${tag}`, status: 'FAIL', message });
        continue;
      }
      if (load.kind !== 'ok') continue; // 'absent' is already filtered out; this narrows the type.
      // Fresh, identically-seeded RNG per layout so each layout's audit is
      // deterministic and independent of how many layouts precede it.
      const rng = createRng(0x57595800); // "STYX"
      results.push(this.simulateLossAversionStability(load.engines, rng, tag));
      results.push(this.simulateCollusionResilience(load.engines, rng, tag));
    }

    return { analyzer: 'behavioral', results };
  }

  /**
   * Probe and dynamically import one engine layout from the audited repository.
   *
   * Distinguishes three outcomes (see {@link LayoutLoad}): a layout with no
   * engine files is `absent`; a layout that ships any engine file but cannot
   * provide a usable, constructable export for all three is `broken` (a failure,
   * not a skip) — so a renamed/removed export or a load-time error surfaces as a
   * CI failure rather than a false pass.
   */
  private async loadLayout(layout: EngineLayout): Promise<LayoutLoad> {
    const files = Object.fromEntries(
      ENGINE_NAMES.map((n) => [n, resolveEngineFile(this.repoPath, layout.files[n])]),
    ) as Record<EngineName, string | null>;
    const present = ENGINE_NAMES.filter((n) => files[n]);

    if (present.length === 0) return { kind: 'absent' };
    // Generic, collision-prone layouts only count when complete, so an unrelated
    // repo with one same-named file isn't mistaken for a broken engine set.
    if (layout.requireAll && present.length < ENGINE_NAMES.length) return { kind: 'absent' };

    const missingFiles = ENGINE_NAMES.filter((n) => !files[n]);
    if (missingFiles.length > 0) {
      return { kind: 'broken', reason: `missing engine file(s): ${missingFiles.join(', ')}` };
    }

    let modules: Record<EngineName, Record<string, unknown>>;
    try {
      const loaded = await Promise.all(
        ENGINE_NAMES.map((n) => import(pathToFileURL(files[n]!).href)),
      );
      modules = Object.fromEntries(ENGINE_NAMES.map((n, i) => [n, loaded[i]])) as Record<
        EngineName,
        Record<string, unknown>
      >;
    } catch (err) {
      return { kind: 'broken', reason: `engine module failed to load: ${(err as Error).message}` };
    }

    const badExports = ENGINE_NAMES.filter((n) => typeof modules[n]?.[n] !== 'function');
    if (badExports.length > 0) {
      return {
        kind: 'broken',
        reason: `missing or non-constructable export(s): ${badExports.join(', ')}`,
      };
    }

    return {
      kind: 'ok',
      engines: {
        LossAversionEngine: modules.LossAversionEngine.LossAversionEngine as PenaltyEngineCtor,
        VolatilityEngine: modules.VolatilityEngine.VolatilityEngine as HeatEngineCtor,
        ConsensusResolver: modules.ConsensusResolver.ConsensusResolver as ResolverCtor,
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
   *   - the temporal multiplier matches the canonical risk windows across the
   *     full Friday 18:00–Monday 06:00 vigil (plus a weekend late-night
   *     precedence case) at fixed timestamps — an independent spec anchor, so a
   *     VolatilityEngine regression is caught *before* the loss-aversion clamp
   *     can mask it, and even when the Monte Carlo heat stays self-consistent;
   *   - each sampled heat equals volatility × temporal and is finite/non-negative;
   *   - every sampled multiplier is finite and inside [SPEC_PENALTY_MIN, MAX];
   *   - the zero-volatility anchor equals the canonical λ (spec constant);
   *   - both clamps fire when directly probed (upper via a huge input, lower via
   *     an engine whose base coefficient sits below the floor).
   */
  private simulateLossAversionStability(
    engines: EngineBundle,
    rng: () => number,
    tag: string,
  ): AnalyzerResult {
    const lae = new engines.LossAversionEngine();
    const ve = new engines.VolatilityEngine();

    // Independent spec anchors for the temporal multiplier: fixed timestamps
    // whose canonical risk window is known, validated directly against the
    // engine. Covers the full weekend vigil (Fri 18:00 → Mon 06:00), late-night
    // peak, weekend/late-night precedence, and the standard-window boundaries.
    const temporalSpec: Array<[Date, number]> = [
      [new Date('2026-03-11T12:00:00Z'), 1.0], // Wed midday — STANDARD
      [new Date('2026-03-13T12:00:00Z'), 1.0], // Fri midday (before 18:00) — STANDARD
      [new Date('2026-03-13T20:00:00Z'), 1.25], // Fri night — WEEKEND_VIGIL
      [new Date('2026-03-14T12:00:00Z'), 1.25], // Sat midday — WEEKEND_VIGIL
      [new Date('2026-03-15T12:00:00Z'), 1.25], // Sun midday — WEEKEND_VIGIL
      [new Date('2026-03-16T05:00:00Z'), 1.25], // Mon 05:00 (before 06:00) — WEEKEND_VIGIL
      [new Date('2026-03-16T08:00:00Z'), 1.0], // Mon 08:00 (after vigil) — STANDARD
      [new Date('2026-03-11T02:00:00Z'), 1.5], // Wed late night — PEAK_VULNERABILITY
      [new Date('2026-03-14T02:00:00Z'), 1.5], // Sat late night — PEAK over WEEKEND
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
      check: `loss-aversion-stability${tag}`,
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
  private simulateCollusionResilience(
    engines: EngineBundle,
    rng: () => number,
    tag: string,
  ): AnalyzerResult {
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

      // Deterministic Fisher-Yates shuffle so colluders aren't always the first
      // entries — an order-biased resolver that privileges a fixed position
      // cannot pass by accident; only true integrity weighting survives.
      for (let k = decisions.length - 1; k > 0; k--) {
        const m = Math.floor(rng() * (k + 1));
        [decisions[k], decisions[m]] = [decisions[m], decisions[k]];
      }

      const verdict = resolver.resolve(decisions);
      if (verdict === groundTruth) correctVerdicts++;
      if (groundTruth === 'CLEAN' && verdict === 'BREACH') fraudulentBreaches++;
      if (groundTruth === 'BREACH' && verdict !== 'BREACH') missedBreaches++;
      if (verdict === 'UNCERTAIN') uncertainVerdicts++;
    }

    const pass = correctVerdicts === COLLUSION_PANELS;

    return {
      check: `collusion-resilience${tag}`,
      status: pass ? 'PASS' : 'FAIL',
      message:
        `Shatter-point simulation (${COLLUSION_PANELS} panels, integrity-weighted consensus, ` +
        `${colluderMajorityPanels} with a colluder majority): ${correctVerdicts} correct verdicts, ` +
        `${fraudulentBreaches} fraudulent breaches, ${missedBreaches} missed breaches, ` +
        `${uncertainVerdicts} escalated to UNCERTAIN.`,
    };
  }
}
