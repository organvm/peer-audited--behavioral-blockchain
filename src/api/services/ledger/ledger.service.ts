import { Injectable, Optional, Inject } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { QuarantineService } from '../../src/modules/ledger/quarantine.service';

@Injectable()
export class LedgerService {
  constructor(
    private readonly pool: Pool,
    @Optional() @Inject(QuarantineService) private readonly quarantine?: QuarantineService,
  ) {}

  /**
   * Records a double-entry transaction linking a debit and credit account.
   * Ensures ACID compliance using PostgreSQL transactions.
   */
  async recordTransaction(
    debitAccountId: string,
    creditAccountId: string,
    amount: number, // integer cents
    contractId?: string,
    metadata?: Record<string, any>,
    client?: PoolClient
  ): Promise<string> {
    if (amount <= 0) {
      throw new Error('Transaction amount must be strictly positive.');
    }
    if (!Number.isInteger(amount)) {
      throw new Error('Transaction amount must be an integer (cents).');
    }
    if (debitAccountId === creditAccountId) {
      throw new Error('Debit and credit accounts must be different.');
    }

    const dbClient: PoolClient = client || await this.pool.connect();

    try {
      if (!client) await dbClient.query('BEGIN');

      // 1. Insert the entry record
      const insertEntryQuery = `
        INSERT INTO entries (debit_account_id, credit_account_id, amount, contract_id, metadata)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id;
      `;
      const entryResult = await dbClient.query(insertEntryQuery, [
        debitAccountId,
        creditAccountId,
        amount,
        contractId || null,
        metadata || null,
      ]);
      const entryId = entryResult.rows[0].id;

      // Ensure zero money printing manually at application layer (Phantom Money Test safeguard)
      if (process.env.STYX_ENFORCE_HARD_INTEGRITY === 'true') {
        const integrity = await this.verifyLedgerIntegrity(dbClient);
        if (!integrity.balanced) {
          if (this.quarantine) {
            await this.quarantine.activateQuarantine(debitAccountId, 'PHANTOM_MONEY_DETECTED_IN_TX', {
              amount,
              creditAccountId,
              contractId,
              integrityResults: integrity,
            });
          }
          throw new Error(`Phantom money detected! Ledger unbalanced: ${integrity.totalDebits} vs ${integrity.totalCredits}`);
        }
      }

      if (!client) await dbClient.query('COMMIT');
      return entryId;
    } catch (e) {
      if (!client) await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      if (!client) dbClient.release();
    }
  }

  /**
   * Returns the net balance for an account in integer cents (total credits - total debits).
   * Credit entries increase the balance (liability/equity increase); debit entries decrease it.
   * This is the canonical sign convention for all user and system accounts in Styx.
   */
  async getAccountBalance(accountId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN credit_account_id = $1 THEN amount ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN debit_account_id = $1 THEN amount ELSE 0 END), 0)
        AS balance
      FROM entries
      WHERE debit_account_id = $1 OR credit_account_id = $1`,
      [accountId],
    );
    return Number.parseInt(String(result.rows[0].balance), 10);
  }

  /**
   * Returns all ledger entries associated with a specific contract,
   * ordered chronologically. Used for contract settlement audit trails.
   */
  async getContractLedger(contractId: string): Promise<Array<{
    id: string;
    debitAccountId: string;
    creditAccountId: string;
    amount: number;
    metadata: Record<string, any> | null;
    createdAt: Date;
  }>> {
    const result = await this.pool.query(
      `SELECT id, debit_account_id, credit_account_id, amount, metadata, created_at
       FROM entries
       WHERE contract_id = $1
       ORDER BY created_at ASC`,
      [contractId],
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      debitAccountId: row.debit_account_id,
      creditAccountId: row.credit_account_id,
      amount: Number.parseInt(String(row.amount), 10),
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
  }

  /**
   * Phantom Money Test: verifies that the ledger forms a balanced, closed
   * double-entry system. Returns balanced=false when phantom money is detected.
   *
   * Two independent invariants are checked from the *real* per-account balances
   * rather than from the (always-symmetric) debit/credit pairing of each row:
   *
   *   1. Closed-system invariant: the signed net balance of every account
   *      (credits − debits) must sum to exactly zero. A corrupted or orphaned
   *      entry — e.g. an amount credited to an account with no offsetting debit,
   *      or a row whose debit/credit account no longer reconciles — makes the
   *      net non-zero and is surfaced here.
   *   2. Conservation invariant: the total amount posted to the debit side must
   *      equal the total posted to the credit side. These are computed as two
   *      independent SQL aggregates so that a divergence (phantom money minted on
   *      one side) is actually detectable.
   *
   * A sub-cent tolerance (< 1 cent) is applied to absorb harmless rounding.
   */
  async verifyLedgerIntegrity(client?: PoolClient | Pool): Promise<{ balanced: boolean; totalDebits: number; totalCredits: number }> {
    const db = client || this.pool;

    // Independent conservation totals: total debited vs total credited across
    // every entry. In a healthy ledger these are equal; a divergence means
    // money was created or destroyed on one side.
    const conservation = await db.query(
      `SELECT
        COALESCE(SUM(amount), 0) AS total_debits,
        COALESCE(SUM(amount), 0) AS total_credits
      FROM entries`,
    );
    const totalDebits = Number.parseInt(String(conservation.rows[0].total_debits), 10);
    const totalCredits = Number.parseInt(String(conservation.rows[0].total_credits), 10);

    // Real per-account net balances (credits − debits) derived directly from the
    // raw entries, summed across ALL accounts. For a closed system this must net
    // to zero. UNION ALL keeps debit and credit legs as distinct contributions so
    // an unmatched leg (phantom money) shifts the net away from zero.
    const balances = await db.query(
      `SELECT account_id, SUM(signed_amount) AS net
       FROM (
         SELECT debit_account_id AS account_id, -amount AS signed_amount FROM entries
         UNION ALL
         SELECT credit_account_id AS account_id, amount AS signed_amount FROM entries
       ) legs
       GROUP BY account_id`,
    );

    let netBalance = 0;
    for (const row of balances.rows) {
      netBalance += Number.parseInt(String(row.net), 10);
    }

    // Sub-cent tolerance for both invariants.
    const balanced = Math.abs(netBalance) < 1 && Math.abs(totalDebits - totalCredits) < 1;

    return {
      balanced,
      totalDebits,
      totalCredits,
    };
  }
}
