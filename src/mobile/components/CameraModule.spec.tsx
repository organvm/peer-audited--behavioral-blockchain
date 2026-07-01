import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { CameraModule } from './CameraModule';
import { flattenScreenText } from '../utils/test-render';
import { UploadService } from '../services/UploadService';
import { ApiClient } from '../services/ApiClient';

jest.mock('../services/UploadService', () => ({
  UploadService: {
    requestPreSignedUrl: jest.fn(),
    uploadVideoBuffer: jest.fn(),
    confirmUpload: jest.fn(),
  },
}));

jest.mock('../services/ApiClient', () => ({
  ApiClient: {
    submitProof: jest.fn(),
  },
}));

describe('CameraModule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (UploadService.requestPreSignedUrl as jest.Mock).mockResolvedValue({
      uploadUrl: 'https://r2.example.com/upload',
      proofId: 'proof_123',
      storageKey: 'proofs/proof_123/video.mp4',
    });
    (UploadService.uploadVideoBuffer as jest.Mock).mockResolvedValue(true);
    (UploadService.confirmUpload as jest.Mock).mockResolvedValue(true);
    (ApiClient.submitProof as jest.Mock).mockResolvedValue({
      proofId: 'proof_123',
      jobId: 'job_123',
    });
  });

  it('renders initial camera ready state', async () => {
    await render(<CameraModule contractId="contract-1" />);
    const text = flattenScreenText();
    expect(text).toContain('NON-PRODUCTION CAPTURE PREVIEW');
    expect(text).toContain('Camera Ready (Gallery Disabled)');
  });

  it('records, uploads, and submits proof to contracts endpoint', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const { getByTestId, getByText } = await render(<CameraModule contractId="contract-1" />);

    await fireEvent.press(getByTestId('record-button')); // start recording
    expect(flattenScreenText()).toContain('LIVE');
    expect(flattenScreenText()).toContain('STYX//contract-1::');

    await fireEvent.press(getByTestId('record-button')); // stop recording
    expect(flattenScreenText()).toContain('Exhaust Captured. Ready for Upload.');

    await fireEvent.press(getByText('SUBMIT TO FURY'));

    await waitFor(() => {
      expect(UploadService.requestPreSignedUrl).toHaveBeenCalledWith(
        'contract-1',
        'video/mp4',
        expect.stringContaining('capture-hash:'),
      );
      expect(UploadService.uploadVideoBuffer).toHaveBeenCalledWith(
        expect.stringContaining('data:video/mp4;base64,'),
        'https://r2.example.com/upload',
      );
      expect(UploadService.confirmUpload).toHaveBeenCalledWith(
        'proof_123',
        'proofs/proof_123/video.mp4',
      );
      expect(ApiClient.submitProof).toHaveBeenCalledWith('contract-1', {
        mediaUri: 'proofs/proof_123/video.mp4',
      });
      expect(alertSpy).toHaveBeenCalledWith(
        'Beta Proof Secured',
        'Your recording has been sent to the Fury Router for validation. NOTE: This is a synthetic capture path for the Phase 1 Beta pilot.',
      );
    });
  });

  it('blocks submission when contract id is missing', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const { getByTestId, getByText } = await render(<CameraModule />);

    await fireEvent.press(getByTestId('record-button')); // start
    await fireEvent.press(getByTestId('record-button')); // stop
    await fireEvent.press(getByText('SUBMIT TO FURY'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Upload Failed',
        'A contract ID is required to submit proof.',
      );
      expect(UploadService.requestPreSignedUrl).not.toHaveBeenCalled();
    });
  });
});
