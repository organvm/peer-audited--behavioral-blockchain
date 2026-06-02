import { v4 as uuidv4 } from "uuid";
import { Test, TestingModule } from "@nestjs/testing";
import { CrmService } from "./crm.service";
import { SalesforceConnector } from "./connectors/salesforce.connector";
import { HubSpotConnector } from "./connectors/hubspot.connector";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { execSync } from "child_process";

describe("CrmService (Integration)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: CrmService;

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
        CrmService,
        { provide: Pool, useValue: pool },
        { provide: SalesforceConnector, useValue: { pushEmployeeEvent: jest.fn() } },
        { provide: HubSpotConnector, useValue: { pushEmployeeEvent: jest.fn() } }
      ],
    }).compile();

    service = module.get<CrmService>(CrmService);
  }, 60000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  describe("calculateCorporateIntegrityScore", () => {
    it("aggregates integrity metrics for an enterprise", async () => {
      const enterpriseId = uuidv4();
      const userId1 = uuidv4();
      const userId2 = uuidv4();
      const contractId = uuidv4();

      // Setup enterprise (via users table referencing it)
      // Note: enterprises table was added in previous session's migration 037b
      await pool.query(
        `INSERT INTO enterprises (id, name) VALUES ($1, $2)`,
        [enterpriseId, "Test Corp"]
      );

      // Add users
      await pool.query(
        `INSERT INTO users (id, email, integrity_score, enterprise_id, status) VALUES 
         ($1, $2, $3, $4, 'ACTIVE'),
         ($5, $6, $7, $8, 'ACTIVE')`,
        [userId1, "u1@test.com", 80, enterpriseId, userId2, "u2@test.com", 60, enterpriseId]
      );

      // Add active contract for one user
      await pool.query(
        `INSERT INTO contracts (id, user_id, status, oath_category, verification_method, stake_amount, duration_days, realm_id) 
         VALUES ($1, $2, 'ACTIVE', 'BIOLOGICAL_WEIGHT', 'WEIGHT', 100, 30, 'BIOLOGICAL_HARDWARE')`,
        [contractId, userId1]
      );

      // Add some events for velocity (not strictly needed for this test as velocity is a subquery on event_log)
      await pool.query(
        `INSERT INTO event_log (event_type, payload, previous_hash, current_hash) 
         VALUES ('CONTRACT_RESOLVED', $1, 'genesis', 'hash1')`,
        [JSON.stringify({ userId: userId1 })]
      );

      const score = await service.calculateCorporateIntegrityScore(enterpriseId);
      
      expect(score.averageIntegrity).toBe(70); // (80 + 60) / 2
      expect(score.activeContracts).toBe(1);
      expect(score.behavioralVelocity).toBe(1);
    });

    it("returns zero stats for non-existent enterprise", async () => {
      const score = await service.calculateCorporateIntegrityScore(uuidv4());
      expect(score.averageIntegrity).toBe(0);
      expect(score.activeContracts).toBe(0);
    });
  });
});
