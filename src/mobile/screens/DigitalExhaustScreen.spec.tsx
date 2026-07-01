import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import DigitalExhaustScreen from './DigitalExhaustScreen';
import { flattenScreenText } from '../utils/test-render';
import { ZKPrivacyEngine } from '../services/ZKPrivacyEngine';
import { ApiClient } from '../services/ApiClient';

jest.mock('../services/ZKPrivacyEngine', () => ({
  ZKPrivacyEngine: {
    generateLocalProof: jest.fn(),
  },
}));

jest.mock('../services/ApiClient', () => ({
  ApiClient: {
    submitProof: jest.fn(),
  },
}));

describe('DigitalExhaustScreen', () => {
  const mockNavigation = {
    goBack: jest.fn(),
    navigate: jest.fn(),
    setOptions: jest.fn(),
  } as any;

  const mockRoute = {
    params: {
      contractId: 'contract-1',
      targetPhoneNumber: '+15551234567',
    },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    (ZKPrivacyEngine.generateLocalProof as jest.Mock).mockResolvedValue({
      contractId: 'contract-1',
      timestamp: '2026-03-04T00:00:00.000Z',
      breachDetected: false,
      proofHash: 'proofhash123',
      signature: 'sig123',
    });
    (ApiClient.submitProof as jest.Mock).mockResolvedValue({
      proofId: 'proof_123',
      jobId: 'job_123',
    });
  });

  it('renders scan header and privacy explanation', async () => {
    await render(
      React.createElement(DigitalExhaustScreen, { route: mockRoute, navigation: mockNavigation }),
    );
    const text = flattenScreenText();
    expect(text).toContain('Digital Exhaust Scan');
    expect(text).toContain('Zero-Knowledge Scan');
  });

  it('runs local scan and submits zk proof marker', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const { getByText } = await render(
      React.createElement(DigitalExhaustScreen, { route: mockRoute, navigation: mockNavigation }),
    );

    await fireEvent.press(getByText('START SECURE SCAN'));

    await waitFor(() => {
      expect(ZKPrivacyEngine.generateLocalProof).toHaveBeenCalledWith(
        'contract-1',
        '+15551234567',
        expect.any(Date),
        expect.any(Date),
      );
      expect(flattenScreenText()).toContain('No Contact Maintained');
    });

    await fireEvent.press(getByText('TRANSMIT PROOF'));

    await waitFor(() => {
      expect(ApiClient.submitProof).toHaveBeenCalledWith(
        'contract-1',
        expect.objectContaining({
          mediaUri: expect.stringContaining('zk://proof/contract-1/proofhash123?'),
        }),
      );
      expect(alertSpy).toHaveBeenCalledWith(
        'Verification Complete',
        expect.stringContaining('Proof proof_123 has been routed while preserving private logs.'),
        expect.any(Array),
      );
    });
  });
});
