import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { CameraScreen } from './CameraScreen';
import { flattenScreenText } from '../utils/test-render';

const mockCameraModule = jest.fn(({ contractId }: { contractId?: string }) => (
  <Text>{`camera-module:${contractId ?? 'none'}`}</Text>
));

jest.mock('../components/CameraModule', () => ({
  CameraModule: (props: { contractId?: string }) => mockCameraModule(props),
}));

describe('CameraScreen', () => {
  beforeEach(() => {
    mockCameraModule.mockClear();
  });

  it('prefills contract ID from route params', async () => {
    const { getByDisplayValue, getByText } = await render(
      <CameraScreen route={{ params: { contractId: 'contract-42' } }} />,
    );

    expect(getByDisplayValue('contract-42')).toBeTruthy();
    expect(getByText('camera-module:contract-42')).toBeTruthy();
  });

  it('passes trimmed contract ID into CameraModule', async () => {
    const { getByPlaceholderText, getByText } = await render(<CameraScreen />);

    const contractInput = getByPlaceholderText('Contract ID');
    await fireEvent.changeText(contractInput, '   contract-99   ');

    expect(getByText('camera-module:contract-99')).toBeTruthy();
  });

  it('passes undefined contract ID when the field is empty', async () => {
    const { getByText } = await render(<CameraScreen />);
    expect(getByText('camera-module:none')).toBeTruthy();
  });

  it('renders live-capture guidance text', async () => {
    await render(<CameraScreen />);
    const text = flattenScreenText();
    expect(text).toContain('Live Proof Capture');
    expect(text).toContain('Gallery uploads are disabled');
  });
});
