import React from 'react';
import { render } from '@testing-library/react-native';

const mockNativeScreenRegistry: Array<{
  name: string;
  component?: unknown;
  options?: { title?: string };
}> = [];

jest.mock('@react-navigation/native', () => {
  const ReactModule = require('react');
  return {
    NavigationContainer: ({ children }: any) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

jest.mock('@react-navigation/native-stack', () => {
  const ReactModule = require('react');
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children }: any) =>
        ReactModule.createElement(ReactModule.Fragment, null, children),
      Screen: ({ name, component, options }: any) => {
        mockNativeScreenRegistry.push({ name, component, options });
        return null;
      },
    }),
  };
});

jest.mock('@react-navigation/bottom-tabs', () => {
  const ReactModule = require('react');
  return {
    createBottomTabNavigator: () => ({
      Navigator: ({ children }: any) =>
        ReactModule.createElement(ReactModule.Fragment, null, children),
      Screen: () => null,
    }),
  };
});

jest.mock('./screens/DigitalExhaustScreen', () => ({
  __esModule: true,
  default: () => null,
}));

const { ContractsNavigator } = require('./App');
const { CameraScreen } = require('./screens/CameraScreen');

describe('App navigation wiring', () => {
  beforeEach(() => {
    mockNativeScreenRegistry.length = 0;
  });

  it('registers SubmitProof route in Contracts navigator with CameraScreen component', async () => {
    await render(React.createElement(ContractsNavigator));

    const routeNames = mockNativeScreenRegistry.map((route) => route.name);
    expect(routeNames).toContain('SubmitProof');

    const submitProofRoute = mockNativeScreenRegistry.find((route) => route.name === 'SubmitProof');
    expect(submitProofRoute?.component).toBe(CameraScreen);
    expect(submitProofRoute?.options?.title).toBe('Submit Proof');
  });
});
