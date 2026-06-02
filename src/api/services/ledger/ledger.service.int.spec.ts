import { v4 as uuidv4 } from "uuid";
import { Test, TestingModule } from "@nestjs/testing";
import { LedgerService } from "./ledger.service";
import { QuarantineService } from "../../src/modules/ledger/quarantine.service";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { execSync } from "child_process";

describe("LedgerService (Integration)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: LedgerService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:15-alpine").start();
    const dbUri = container.getConnectionUri();

    pool = new Pool({
      connectionString: dbUri,
    });

    // Run migrations
    execSync("npm run migrate", {
      env: { ...process.env, DATABASE_URL: dbUri },
      stdio: "inherit",
      cwd: process.cwd() // Jest runs from src/api
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: Pool, useValue: pool },
        { provide: QuarantineService, useValue: { quarantineAccount: jest.fn() } }
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
  }, 60000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  describe("recordTransaction", () => {
    it("successfully records a double-entry transaction and updates balances", async () => {
      const debitId = uuidv4();
      const creditId = uuidv4();

      // Create accounts
      await pool.query(
        `INSERT INTO accounts (id, balance, currency, status) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
        [debitId, 1000, "USD", "ACTIVE", creditId, 0, "USD", "ACTIVE"]
      );

      const entryId = await service.recordTransaction(debitId, creditId, 500);
      expect(entryId).toBeDefined();

      // Check entry
      const entryRes = await pool.query(`SELECT * FROM ledger_entries WHERE id = $1`, [entryId]);
      expect(entryRes.rows[0].debit_account_id).toBe(debitId);
      expect(entryRes.rows[0].credit_account_id).toBe(creditId);
      expect(Number(entryRes.rows[0].amount)).toBe(500);

      // Check balances
      const debitRes = await pool.query(`SELECT balance FROM accounts WHERE id = $1`, [debitId]);
      const creditRes = await pool.query(`SELECT balance FROM accounts WHERE id = $1`, [creditId]);
      
      expect(Number(debitRes.rows[0].balance)).toBe(500);
      expect(Number(creditRes.rows[0].balance)).toBe(500);
    });

    it("enforces idempotency using partial unique index from migration 030", async () => {
      const debitId = uuidv4();
      const creditId = uuidv4();
      const ikey = "idempotency-test-123";

      await pool.query(
        `INSERT INTO accounts (id, balance, currency, status) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
        [debitId, 1000, "USD", "ACTIVE", creditId, 0, "USD", "ACTIVE"]
      );

      const entryId1 = await service.recordTransaction(debitId, creditId, 100, undefined, {}, undefined, ikey);
      const entryId2 = await service.recordTransaction(debitId, creditId, 100, undefined, {}, undefined, ikey);

      expect(entryId1).toBe(entryId2);

      // Balance should only have been deducted ONCE
      const debitRes = await pool.query(`SELECT balance FROM accounts WHERE id = $1`, [debitId]);
      expect(Number(debitRes.rows[0].balance)).toBe(900);
    });
  });
});
