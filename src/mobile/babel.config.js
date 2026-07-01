module.exports = function babelConfig(api) {
  // Jest (NODE_ENV=test) transforms specs and React Native sources with the
  // official @react-native/babel-preset, which the @react-native/jest-preset
  // expects. The Expo runtime build continues to use babel-preset-expo.
  const isTest = api.env('test');
  api.cache.using(() => process.env.NODE_ENV);

  return {
    presets: [isTest ? '@react-native/babel-preset' : 'babel-preset-expo'],
  };
};
