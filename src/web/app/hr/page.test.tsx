/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockGetEnterpriseMetrics = jest.fn();
const mockGetEnterpriseLicense = jest.fn();

jest.mock('../../services/api-client', () => ({
  api: {
    getEnterpriseLicense: (...args: unknown[]) => mockGetEnterpriseLicense(...args),
    getEnterpriseMetrics: (...args: unknown[]) => mockGetEnterpriseMetrics(...args),
  },
}));

import HRDashboard from './page';

describe('HR dashboard page', () => {
  const originalFlag = process.env.NEXT_PUBLIC_STYX_FEATURE_B2B_HR_UI;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_STYX_FEATURE_B2B_HR_UI = 'true';
    window.history.pushState({}, '', '/hr');
    mockGetEnterpriseLicense.mockResolvedValue({
      enterpriseId: 'e0000000-0000-0000-0000-000000000001',
      active: true,
      status: 'active',
      plan: 'SOLO',
      stripeCustomerId: 'cus_ent_001',
      subscriptionId: 'sub_ent_001',
      currentPeriodStart: '2026-06-01T00:00:00.000Z',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
    });
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_STYX_FEATURE_B2B_HR_UI = originalFlag;
  });

  it('renders internal-disabled gate and skips API calls when flag is off', () => {
    process.env.NEXT_PUBLIC_STYX_FEATURE_B2B_HR_UI = 'false';

    render(<HRDashboard />);

    expect(screen.getByText('Internal Feature Disabled')).toBeTruthy();
    expect(mockGetEnterpriseLicense).not.toHaveBeenCalled();
    expect(mockGetEnterpriseMetrics).not.toHaveBeenCalled();
  });

  it('loads default enterprise metrics and renders KPI cards', async () => {
    mockGetEnterpriseMetrics.mockResolvedValue({
      enterpriseId: 'e0000000-0000-0000-0000-000000000001',
      totalContracts: 25,
      completedContracts: 18,
      failedContracts: 4,
      activeContracts: 3,
      completionRate: 72,
      avgIntegrityScore: 87,
      totalEmployees: 40,
    });

    render(<HRDashboard />);

    await waitFor(() => {
      expect(mockGetEnterpriseLicense).toHaveBeenCalledWith('e0000000-0000-0000-0000-000000000001');
      expect(mockGetEnterpriseMetrics).toHaveBeenCalledWith('e0000000-0000-0000-0000-000000000001');
    });

    expect(await screen.findByText('Total Contracts')).toBeTruthy();
    expect(screen.getByText('Plan: SOLO')).toBeTruthy();
    expect(screen.getByText('25')).toBeTruthy();
    expect(screen.getByText('Open Risk Exposure')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('renders a subscription gate and skips metrics when the enterprise is unlicensed', async () => {
    mockGetEnterpriseLicense.mockResolvedValueOnce({
      enterpriseId: 'e0000000-0000-0000-0000-000000000001',
      active: false,
      status: null,
      plan: null,
      stripeCustomerId: null,
      subscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });

    render(<HRDashboard />);

    expect(await screen.findByText('Subscription Required')).toBeTruthy();
    expect(screen.getByText('Plan: Unlicensed')).toBeTruthy();
    expect(mockGetEnterpriseMetrics).not.toHaveBeenCalled();
  });

  it('renders support trace parsing for request_id formatted errors', async () => {
    mockGetEnterpriseMetrics.mockRejectedValue(
      new Error('Failed to load metrics [request_id: hr-load-001]'),
    );

    render(<HRDashboard />);

    expect(await screen.findByText('Failed to load metrics')).toBeTruthy();
    expect(screen.getByText(/Support trace ID/)).toBeTruthy();
    expect(screen.getByText(/hr-load-001/)).toBeTruthy();
  });

  it('loads metrics for a selected enterprise ID', async () => {
    mockGetEnterpriseMetrics.mockResolvedValue({
      enterpriseId: 'ent-alpha-01',
      totalContracts: 10,
      completedContracts: 8,
      failedContracts: 1,
      activeContracts: 1,
      completionRate: 80,
      avgIntegrityScore: 91,
      totalEmployees: 15,
    });

    render(<HRDashboard />);

    await waitFor(() => {
      expect(mockGetEnterpriseMetrics).toHaveBeenCalledWith('e0000000-0000-0000-0000-000000000001');
    });

    const input = await screen.findByLabelText('Enterprise ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ent-alpha-01' } });
    fireEvent.click(screen.getByText('Load Enterprise'));

    await waitFor(() => {
      expect(mockGetEnterpriseLicense).toHaveBeenCalledWith('ent-alpha-01');
      expect(mockGetEnterpriseMetrics).toHaveBeenCalledWith('ent-alpha-01');
    });
  });

  it('initializes enterprise selection from query parameter', async () => {
    window.history.pushState({}, '', '/hr?enterprise=ent-query-77');
    mockGetEnterpriseMetrics.mockResolvedValue({
      enterpriseId: 'ent-query-77',
      totalContracts: 5,
      completedContracts: 4,
      failedContracts: 0,
      activeContracts: 1,
      completionRate: 80,
      avgIntegrityScore: 95,
      totalEmployees: 7,
    });

    render(<HRDashboard />);

    await waitFor(() => {
      expect(mockGetEnterpriseLicense).toHaveBeenCalledWith('ent-query-77');
      expect(mockGetEnterpriseMetrics).toHaveBeenCalledWith('ent-query-77');
    });
  });
});
