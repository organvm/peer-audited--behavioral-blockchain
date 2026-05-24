import { SettlementWorker } from './settlement.worker';
import { Pool } from 'pg';
import { StripePayoutProvider } from './stripe-payout.provider';
import { LedgerService } from '../../../services/ledger/ledger.service';
import { TruthLogService } from '../../../services/ledger/truth-log.service';
import { PayoutStatus } from '../../common/interfaces/payout-provider.interface';
import { Job } from 'bullmq';

jest.mock('bullmq');

describe('SettlementWorker', () => {
  let worker: SettlementWorker;
  let mockPool: { query: jest.Mock; connect: jest.Mock };
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let mockStripeProvider: jest.Mocked<Pick<StripePayoutProvider, 'releaseFunds' | 'captureFunds'>>;
  let mockLedger: jest.Mocked<Pick<LedgerService, 'recordTransaction'>>;
  let mockTruthLog: jest.Mocked<Pick<TruthLogService, 'appendEvent'>>;

  const makeJob = (data: Record<string, any>): Job => ({ data } as Job);

  const successResult = {
    status: PayoutStatus.SUCCESS,
    providerTransactionId: 'tx_provider_001',
  };

  const makeContractRow = () => ({
    rows: [{
      user_id: 'user-1',
      account_id: 'acct-user-1',
      escrow_account_id: 'acct-escrow',
      revenue_account_id: 'acct-revenue',
      bounty_pool_account_id: 'acct-bounty',
    }],
  });

  // Helper to drive the client.query mock by SQL keyword, since the worker now runs two
  // separate short transactions (claim + finalize) on a pooled client.
  const setupClientQueries = (opts: {
    existingRun?: { id: string; status: string } | null;
    captureExists?: boolean;
    topupExists?: boolean;
    releaseExists?: boolean;
  }) => {
    const insertedRunId = 'run-claimed';
    mockClient.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (text.includes('FROM contracts WHERE id') && text.includes('FOR UPDATE')) {
        return { rows: [{ id: 'c-x' }] };
      }
      if (text.includes('FROM settlement_runs') && text.includes('ORDER BY started_at DESC')) {
        return { rows: opts.existingRun ? [opts.existingRun] : [] };
      }
      if (text.includes('INSERT INTO settlement_runs')) {
        return { rows: [{ id: insertedRunId }] };
      }
      if (text.includes('UPDATE settlement_runs') && text.includes("'PROCESSING'")) {
        return { rows: [] };
      }
      // finalizeLedger: contract + system accounts lookup
      if (text.includes('a_escrow') && text.includes('FROM contracts c')) {
        return makeContractRow();
      }
      // entryExists checks, keyed by type embedded in params is not visible here; use call order
      if (text.includes('FROM entries WHERE contract_id')) {
        return { rows: [] };
      }
      if (text.includes('UPDATE settlement_runs') && text.includes("'SUCCESS'")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    return insertedRunId;
  };

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    mockStripeProvider = {
      releaseFunds: jest.fn(),
      captureFunds: jest.fn(),
    };
    mockLedger = {
      recordTransaction: jest.fn().mockResolvedValue('entry-id-1'),
    };
    mockTruthLog = {
      appendEvent: jest.fn().mockResolvedValue(undefined),
    };

    worker = new SettlementWorker(
      mockPool as unknown as Pool,
      mockStripeProvider as unknown as StripePayoutProvider,
      mockLedger as unknown as LedgerService,
      mockTruthLog as unknown as TruthLogService,
    );

    jest.clearAllMocks();
  });

  const callProcess = (w: SettlementWorker, job: Job) => (w as any).process(job);

  it('should calculate deterministic quote and top up bounty pool on capture', async () => {
    setupClientQueries({ existingRun: null });
    mockStripeProvider.captureFunds.mockResolvedValue(successResult);

    const job = makeJob({
      contractId: 'c-1',
      outcome: 'FAIL',
      paymentIntentId: 'pi_1',
      amountCents: 10000,
    });

    await callProcess(worker, job);

    // captureFunds receives the settlement amount (partial-capture support).
    expect(mockStripeProvider.captureFunds).toHaveBeenCalledWith('pi_1', 10000, expect.any(Object));

    // Ledger capture entry to revenue.
    expect(mockLedger.recordTransaction).toHaveBeenCalledWith(
      'acct-escrow',
      'acct-revenue',
      10000,
      'c-1',
      expect.objectContaining({ type: 'REAL_MONEY_SETTLEMENT_CAPTURE' }),
      mockClient,
    );

    // Bounty pool top-up (20% of 10000).
    expect(mockLedger.recordTransaction).toHaveBeenCalledWith(
      'acct-revenue',
      'acct-bounty',
      2000,
      'c-1',
      expect.objectContaining({ type: 'BOUNTY_POOL_TOPUP' }),
      mockClient,
    );
  });

  it('should override actual action to RELEASE if dispositionMode is REFUND', async () => {
    setupClientQueries({ existingRun: null });
    mockStripeProvider.releaseFunds.mockResolvedValue(successResult);

    const job = makeJob({
      contractId: 'c-2',
      outcome: 'FAIL',
      paymentIntentId: 'pi_2',
      amountCents: 5000,
      dispositionMode: 'REFUND',
    });

    await callProcess(worker, job);

    expect(mockStripeProvider.releaseFunds).toHaveBeenCalled();
    expect(mockStripeProvider.captureFunds).not.toHaveBeenCalled();

    expect(mockLedger.recordTransaction).toHaveBeenCalledWith(
      'acct-escrow',
      'acct-user-1',
      5000,
      'c-2',
      expect.objectContaining({ type: 'REAL_MONEY_SETTLEMENT_RELEASE', reason: 'REFUND_ONLY_JURISDICTION' }),
      mockClient,
    );
  });

  it('should skip when a SUCCESS run already exists for the (contract, outcome)', async () => {
    setupClientQueries({ existingRun: { id: 'run-done', status: 'SUCCESS' } });

    const job = makeJob({
      contractId: 'c-3',
      outcome: 'FAIL',
      paymentIntentId: 'pi_3',
      amountCents: 5000,
    });

    await callProcess(worker, job);

    expect(mockStripeProvider.captureFunds).not.toHaveBeenCalled();
    expect(mockStripeProvider.releaseFunds).not.toHaveBeenCalled();
    expect(mockLedger.recordTransaction).not.toHaveBeenCalled();
  });
});
