import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the STYX_KNOWLEDGE import used in worker
vi.mock('../../web/lib/styx-knowledge', () => ({
  STYX_KNOWLEDGE: 'mock-knowledge-base',
}));

import worker, {
  RateLimiter,
  evaluateWindow,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from '../worker/index';

/**
 * In-memory Durable Object harness.
 *
 * The whole point of the fix is that a single object instance is shared
 * across every isolate/POP for a given IP. We model that by keeping ONE
 * `RateLimiter` instance per object id in a registry, so repeated
 * `idFromName(ip)` lookups resolve to the same shared, strongly-consistent
 * state — exactly the property an in-memory `Map` or KV limiter lacks.
 */
function makeDurableObjectNamespace(): DurableObjectNamespace {
  const instances = new Map<string, RateLimiter>();

  function makeState(): DurableObjectState {
    const storage = new Map<string, unknown>();
    return {
      // Serialize the callback — Durable Objects run single-threaded.
      blockConcurrencyWhile: async <T>(cb: () => Promise<T>): Promise<T> => cb(),
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => {
          storage.set(key, value);
        },
        deleteAll: async () => {
          storage.clear();
        },
        setAlarm: async () => {},
      },
    } as unknown as DurableObjectState;
  }

  return {
    idFromName: (name: string) =>
      ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const key = id.toString();
      let instance = instances.get(key);
      if (!instance) {
        instance = new RateLimiter(makeState());
        instances.set(key, instance);
      }
      const obj = instance;
      return {
        fetch: (input: RequestInfo | URL) =>
          obj.fetch(input instanceof Request ? input : new Request(String(input))),
      } as unknown as DurableObjectStub;
    },
    idFromString: (s: string) =>
      ({ name: s, toString: () => s }) as unknown as DurableObjectId,
    newUniqueId: () =>
      ({ toString: () => Math.random().toString() }) as unknown as DurableObjectId,
  } as unknown as DurableObjectNamespace;
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    GROQ_API_KEY: 'test-key',
    ALLOWED_ORIGIN: 'https://styx.io',
    LLM_MODEL: 'llama-3.3-70b-versatile',
    LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    RATE_LIMITER: makeDurableObjectNamespace(),
    ...overrides,
  };
}

function makeRequest(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request('https://worker.styx.io/api/chat', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': '127.0.0.1',
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function okStream(content = 'Hello') {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(`data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('evaluateWindow (sliding-window decision)', () => {
  it('admits requests below the threshold', () => {
    const { limited, next } = evaluateWindow([1, 2, 3], 10);
    expect(limited).toBe(false);
    expect(next).toEqual([1, 2, 3, 10]);
  });

  it('rejects once the window is full and does not grow the list', () => {
    const now = 1_000;
    const full = Array.from({ length: RATE_LIMIT_MAX }, () => now);
    const { limited, next } = evaluateWindow(full, now);
    expect(limited).toBe(true);
    expect(next).toHaveLength(RATE_LIMIT_MAX);
  });

  it('evicts timestamps older than the window', () => {
    const now = 1_000_000;
    const stale = now - RATE_LIMIT_WINDOW_MS - 1;
    const { limited, next } = evaluateWindow([stale, stale], now);
    expect(limited).toBe(false);
    // stale entries dropped, only the new `now` remains
    expect(next).toEqual([now]);
  });
});

describe('RateLimiter Durable Object', () => {
  it('shares state across calls so the threshold is enforced', async () => {
    const ns = makeDurableObjectNamespace();
    const check = async () => {
      const stub = ns.get(ns.idFromName('1.2.3.4'));
      const res = await stub.fetch('https://rate-limiter/check');
      return ((await res.json()) as { limited: boolean }).limited;
    };

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await check()).toBe(false);
    }
    // The (MAX+1)th request to the SAME shared object must be limited.
    expect(await check()).toBe(true);
  });

  it('isolates counters per IP id', async () => {
    const ns = makeDurableObjectNamespace();
    const hit = async (ip: string) => {
      const stub = ns.get(ns.idFromName(ip));
      const res = await stub.fetch('https://rate-limiter/check');
      return ((await res.json()) as { limited: boolean }).limited;
    };

    for (let i = 0; i < RATE_LIMIT_MAX; i++) await hit('a');
    expect(await hit('a')).toBe(true); // 'a' exhausted
    expect(await hit('b')).toBe(false); // 'b' independent
  });
});

describe('Ask Styx Worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 204 for OPTIONS (CORS preflight)', async () => {
    const req = makeRequest('OPTIONS');
    const res = await worker.fetch(req, makeEnv() as any);

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://styx.io');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('returns 405 for non-POST methods', async () => {
    const req = makeRequest('GET');
    const res = await worker.fetch(req, makeEnv() as any);

    expect(res.status).toBe(405);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Method not allowed');
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('https://worker.styx.io/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'cf-connecting-ip': '10.0.0.1',
      },
      body: 'not json{{{',
    });
    const res = await worker.fetch(req, makeEnv() as any);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 400 when messages array is missing', async () => {
    const req = makeRequest('POST', { noMessages: true }, { 'cf-connecting-ip': '10.0.0.2' });
    const res = await worker.fetch(req, makeEnv() as any);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('messages array is required');
  });

  it('returns 400 when messages array is empty', async () => {
    const req = makeRequest('POST', { messages: [] }, { 'cf-connecting-ip': '10.0.0.3' });
    const res = await worker.fetch(req, makeEnv() as any);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('messages array is required');
  });

  it('returns streaming response for valid request', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(okStream(), { status: 200 }),
    );

    const req = makeRequest(
      'POST',
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'cf-connecting-ip': '10.0.0.4' },
    );
    const res = await worker.fetch(req, makeEnv() as any);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('returns 502 when LLM API returns an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    const req = makeRequest(
      'POST',
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'cf-connecting-ip': '10.0.0.5' },
    );
    const res = await worker.fetch(req, makeEnv() as any);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('LLM API error');
  });

  it('enforces the rate limit through the worker fetch path (429)', async () => {
    // One shared namespace across all requests, as the real binding is.
    const env = makeEnv();
    // Fresh stream per call — a single Response body can only be read once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(okStream(), { status: 200 }),
    );

    const send = () =>
      worker.fetch(
        makeRequest(
          'POST',
          { messages: [{ role: 'user', content: 'hi' }] },
          { 'cf-connecting-ip': '203.0.113.7' },
        ),
        env as any,
      );

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await send();
      expect(res.status).toBe(200);
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toContain('Rate limit exceeded');
  });

  it('sets CORS headers using ALLOWED_ORIGIN env', async () => {
    const req = makeRequest('GET', undefined, { 'cf-connecting-ip': '10.0.0.6' });
    const res = await worker.fetch(req, makeEnv({ ALLOWED_ORIGIN: 'https://custom.io' }) as any);

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://custom.io');
  });

  it('defaults CORS origin to * when ALLOWED_ORIGIN is empty', async () => {
    const req = makeRequest('GET', undefined, { 'cf-connecting-ip': '10.0.0.7' });
    const res = await worker.fetch(req, makeEnv({ ALLOWED_ORIGIN: '' }) as any);

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
