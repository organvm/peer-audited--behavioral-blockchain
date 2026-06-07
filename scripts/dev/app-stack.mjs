// existing code...

const devEnv = require('./env.mjs');
const testEnv = require('./test-env.mjs');

+ if (!devEnv || !testEnv) {
+   throw new Error('Both dev and test environments are required.');
+ }

// existing code...