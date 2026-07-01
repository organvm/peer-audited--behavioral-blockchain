import { Pool } from 'pg';
import { B2BController } from './b2b.controller';
import { BillingService } from './billing.service';
import { WebhookService } from './webhook.service';
import { MetricsService } from './metrics.service';
import { AnonymizeService } from './anonymize.service';
import { DataLakeService } from './datalake.service';

describe('B2BController', () => {
  let controller: B2BController;

  // Caller is an ADMIN belonging to the enterprise they request, so the
  // tenant-membership check passes for these happy-path tests.
  const adminUser = { id: 'admin-1' };
  const mockPool = {
    query: jest.fn().mockResolvedValue({
      rows: [{ enterprise_id: 'ent-001', role: 'ADMIN' }],
    }),
  } as unknown as Pool;

  const mockBilling = {
    recordConsumptionEvent: jest.fn(),
    getEnterpriseSubscriptionStatus: jest.fn(),
    getUsageSummary: jest.fn(),
  } as unknown as BillingService;

  const mockWebhook = {
    dispatchEnterpriseMetricEvent: jest.fn(),
  } as unknown as WebhookService;

  const mockMetrics = {
    getEnterpriseMetrics: jest.fn(),
  } as unknown as MetricsService;

  const mockAnonymize = {
    anonymizeEmployeeData: jest.fn().mockReturnValue({
      enterpriseId: 'ent-001',
      generatedAt: '2026-01-01T00:00:00Z',
      employeeCount: 0,
      employees: [],
      aggregate: { avgIntegrityScore: 0, avgCompletionRate: 0, totalContracts: 0, completedContracts: 0 },
    }),
  } as unknown as AnonymizeService;

  const mockDataLake = {
    extractSnapshot: jest.fn().mockResolvedValue({
      extractedAt: '2026-01-01T00:00:00Z',
      enterpriseId: 'ent-001',
      period: { start: '2026-01-01', end: '2026-02-01' },
      contractMetrics: [],
      behavioralTrends: [],
      cohortAnalysis: [],
    }),
  } as unknown as DataLakeService;

  beforeEach(() => {
    controller = new B2BController(mockPool, mockBilling, mockWebhook, mockMetrics, mockAnonymize, mockDataLake);
    jest.clearAllMocks();
    (mockPool.query as jest.Mock).mockResolvedValue({
      rows: [{ enterprise_id: 'ent-001', role: 'ADMIN' }],
    });
    (mockBilling.getEnterpriseSubscriptionStatus as jest.Mock).mockResolvedValue({
      enterpriseId: 'ent-001',
      active: true,
      status: 'active',
      plan: 'SOLO',
      stripeCustomerId: 'cus_ent_001',
      subscriptionId: 'sub_ent_001',
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
    (mockBilling.getUsageSummary as jest.Mock).mockResolvedValue({
      totalUsage: 12,
      currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    });
  });

  describe('getMetrics', () => {
    it('should return enterprise metrics for a given enterpriseId', async () => {
      const expected = {
        enterpriseId: 'ent-001',
        totalContracts: 100,
        completedContracts: 80,
        failedContracts: 10,
        activeContracts: 10,
        completionRate: 80,
        avgIntegrityScore: 72,
        totalEmployees: 50,
      };
      (mockMetrics.getEnterpriseMetrics as jest.Mock).mockResolvedValueOnce(expected);

      const result = await controller.getMetrics(adminUser, 'ent-001');

      expect(result).toEqual(expected);
      expect(mockBilling.getEnterpriseSubscriptionStatus).toHaveBeenCalledWith('ent-001');
      expect(mockMetrics.getEnterpriseMetrics).toHaveBeenCalledWith('ent-001');
    });

    it('should reject analytics when the enterprise has no active subscription', async () => {
      (mockBilling.getEnterpriseSubscriptionStatus as jest.Mock).mockResolvedValueOnce({
        enterpriseId: 'ent-001',
        active: false,
        status: null,
        plan: null,
        stripeCustomerId: null,
        subscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      });

      let thrown: unknown;
      try {
        await controller.getMetrics(adminUser, 'ent-001');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect((thrown as { getStatus: () => number }).getStatus()).toBe(402);
      expect((thrown as { getResponse: () => unknown }).getResponse()).toEqual(
        expect.objectContaining({
          error_code: 'B2B_LICENSE_REQUIRED',
        }),
      );
      expect(mockMetrics.getEnterpriseMetrics).not.toHaveBeenCalled();
    });
  });

  describe('getLicense', () => {
    it('should return current enterprise license state', async () => {
      const result = await controller.getLicense(adminUser, 'ent-001');

      expect(result).toEqual(expect.objectContaining({
        enterpriseId: 'ent-001',
        active: true,
        plan: 'SOLO',
      }));
      expect(mockBilling.getEnterpriseSubscriptionStatus).toHaveBeenCalledWith('ent-001');
    });
  });

  describe('getBilling', () => {
    it('should return billing summary WITHOUT recording a consumption event', async () => {
      const result = await controller.getBilling(adminUser, 'ent-001');

      expect(result).toEqual(expect.objectContaining({
        enterpriseId: 'ent-001',
        plan: 'SOLO',
        license: expect.objectContaining({ active: true, plan: 'SOLO' }),
        usageSummary: expect.objectContaining({ totalUsage: 12 }),
        events: [],
        totalDue: 0,
        currency: 'USD',
      }));
      // Read-only fetch must not bill the customer.
      expect(mockBilling.recordConsumptionEvent).not.toHaveBeenCalled();
    });
  });

  describe('registerWebhook', () => {
    it('should register a webhook URL', async () => {
      const result = await controller.registerWebhook(adminUser, {
        enterpriseId: 'ent-001',
        url: 'https://example.com/webhook',
      });

      expect(result).toEqual({
        status: 'registered',
        enterpriseId: 'ent-001',
        url: 'https://example.com/webhook',
      });
      expect(mockBilling.getEnterpriseSubscriptionStatus).toHaveBeenCalledWith('ent-001');
    });
  });

  describe('testWebhook', () => {
    it('should dispatch a test payload and return sent status', async () => {
      (mockWebhook.dispatchEnterpriseMetricEvent as jest.Mock).mockResolvedValueOnce(true);

      const result = await controller.testWebhook(adminUser, {
        enterpriseId: 'ent-001',
        url: 'https://example.com/hook',
      });

      expect(result).toEqual({ status: 'sent' });
      expect(mockBilling.getEnterpriseSubscriptionStatus).toHaveBeenCalledWith('ent-001');
      expect(mockWebhook.dispatchEnterpriseMetricEvent).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({ type: 'TEST' }),
      );
    });

    it('should return failed status when dispatch fails', async () => {
      (mockWebhook.dispatchEnterpriseMetricEvent as jest.Mock).mockResolvedValueOnce(false);

      const result = await controller.testWebhook(adminUser, {
        enterpriseId: 'ent-001',
        url: 'https://bad.com/hook',
      });

      expect(result).toEqual({ status: 'failed' });
    });

    it('should reject when caller is not a member/admin of the enterprise (PRV6)', async () => {
      // Caller belongs to a different enterprise -> tenant check must block before
      // any outbound dispatch happens (SSRF probing surface).
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ enterprise_id: 'other-ent', role: 'ADMIN' }],
      });

      await expect(
        controller.testWebhook(adminUser, {
          enterpriseId: 'ent-001',
          url: 'http://169.254.169.254/latest/meta-data',
        }),
      ).rejects.toThrow();
      expect(mockWebhook.dispatchEnterpriseMetricEvent).not.toHaveBeenCalled();
    });
  });

  describe('exportHrData', () => {
    it('should return anonymized employee data', async () => {
      (mockMetrics.getEnterpriseMetrics as jest.Mock).mockResolvedValueOnce({});

      const result = await controller.exportHrData(adminUser, 'ent-001');

      expect(result.employeeCount).toBe(0);
      expect(mockBilling.getEnterpriseSubscriptionStatus).toHaveBeenCalledWith('ent-001');
      expect(mockAnonymize.anonymizeEmployeeData).toHaveBeenCalledWith('ent-001', []);
    });
  });

  describe('getDataLakeSnapshot', () => {
    it('should return a data lake snapshot for the given period', async () => {
      const result = await controller.getDataLakeSnapshot(adminUser, 'ent-001', '2026-01-01', '2026-02-01');

      expect(result.enterpriseId).toBe('ent-001');
      expect(mockBilling.getEnterpriseSubscriptionStatus).toHaveBeenCalledWith('ent-001');
      expect(mockDataLake.extractSnapshot).toHaveBeenCalledWith('ent-001', '2026-01-01', '2026-02-01');
    });
  });
});
