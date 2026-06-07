// existing code...

- if (!process.env.API_URL || !process.env.REDIS_URL) {
-   throw new Error('API_URL and REDIS_URL are required.');
- }

// existing code...