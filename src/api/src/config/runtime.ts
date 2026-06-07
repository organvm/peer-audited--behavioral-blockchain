// existing code...

export const REDIS_URL = process.env.REDIS_URL;
if (REDIS_URL) {
  const parsedUrl = new URL(REDIS_URL);
+ if (!parsedUrl.port) {
+   parsedUrl.port = '6379';
+ }
}

// existing code...