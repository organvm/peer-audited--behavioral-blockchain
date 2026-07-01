// Mobile (Expo / React Native) Jest config.
//
// Screen and component specs render real React Native components through
// @testing-library/react-native (v14), which runs on React's universal
// `test-renderer` and the official @react-native/jest-preset. This replaces the
// previous jsdom + @testing-library/react (web DOM) setup and removes the
// deprecated react-test-renderer toolchain entirely (issues #35, #42).
//
// The preset is resolved by file path because this workspace's dependencies are
// hoisted to the monorepo root, where Jest's bare "preset" name resolution does
// not look.
const reactNativePreset = require(
  require.resolve('@react-native/jest-preset/jest-preset.js'),
);

/** @type {import("jest").Config} **/
module.exports = {
  ...reactNativePreset,
  rootDir: __dirname,
  moduleNameMapper: {
    ...reactNativePreset.moduleNameMapper,
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/__mocks__/async-storage.ts',
  },
  setupFiles: [
    ...(reactNativePreset.setupFiles ?? []),
    '<rootDir>/jest.setup.js',
  ],
  testPathIgnorePatterns: ['/node_modules/'],
  coverageThreshold: {
    global: {
      lines: 50,
      branches: 40,
      functions: 40,
      statements: 50,
    },
  },
};
