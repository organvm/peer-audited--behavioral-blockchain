/// <reference types="@cloudflare/workers-types" />
import { STYX_KNOWLEDGE } from '../../web/lib/styx-knowledge';

interface Env {
  GROQ_API_KEY: string;
  ALLOWED_ORIGIN: string;
  LLM_MODEL: string;
  LLM_BASE_URL: string;
  // Durable Object namespace backing the cross-isolate rate limiter.
  // A Durable Object gives one single-threaded, strongly-consistent
  // instance per IP, shared across every edge isolate — so the limit
  // cannot be bypassed by hitting different POPs or by isolate restarts.
  RATE_LIMITER: DurableObjectNamespace;
}

const SYSTEM_PROMPT = `You are the Styx AI assistant — an expert on the Styx peer-audited behavioral market platform. You help stakeholders (investors, partners, developers) understand how Styx works.

GUIDELINES:
- Use plain, accessible language — your audience may be non-technical (investors, partners, advisors).
- Be concise, confident, and precise.
- Answer from the knowledge base below. Cite specific numbers, algorithms, and constants when relevant.
- If you don't know something or it's not in the knowledge base, say so rather than guessing.
- For technical questions, reference specific files, modules, or database tables.
- Keep responses focused — aim for 2-4 paragraphs unless the question warrants more detail.

KNOWLEDGE BASE:
${STYX_KNOWLEDGE}`;

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 30;

const STORAGE_KEY = 'timestamps';

/**
 * Sliding-window rate-limit decision over a list of request timestamps.
 *
 * Pure function so it can be unit-tested directly and reused inside the
 * Durable Object. Returns the next timestamp list to persist and whether
 * the current request must be rejected.
 */
export function evaluateWindow(
  timestamps: number[],
  now: number,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
  max: number = RATE_LIMIT_MAX,
): { limited: boolean; next: number[] } {
  const recent = timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    return { limited: true, next: recent };
  }
  recent.push(now);
  return { limited: false, next: recent };
}

/**
 * Durable Object that owns the rate-limit counter for a single IP.
 *
 * Cloudflare routes every request for a given object id to the SAME
 * single-threaded instance, regardless of which edge isolate served the
 * HTTP request. Reads/writes to its storage are strongly consistent and
 * serialized, so the read-modify-write sequence below is atomic — there
 * is no last-write-wins race (the failure mode of a KV-based limiter)
 * and no per-isolate divergence (the failure mode of an in-memory Map).
 */
export class RateLimiter implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(_request?: Request): Promise<Response> {
    // blockConcurrencyWhile serializes the read-modify-write so two
    // simultaneous requests to the same IP cannot both observe the old
    // count and both be admitted.
    const limited = await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const stored = (await this.state.storage.get<number[]>(STORAGE_KEY)) ?? [];
      const { limited, next } = evaluateWindow(stored, now);
      await this.state.storage.put(STORAGE_KEY, next);
      // Let the object evict itself once the window has fully elapsed so
      // idle IPs don't retain storage forever.
      await this.state.storage.setAlarm(now + RATE_LIMIT_WINDOW_MS);
      return limited;
    });

    return Response.json({ limited });
  }

  // Fired when the window elapses with no further traffic: drop the
  // counter so the object's storage is reclaimed.
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

async function isRateLimited(ip: string, namespace: DurableObjectNamespace): Promise<boolean> {
  // idFromName hashes the IP to a stable object id, so all requests from
  // one IP — across every isolate and POP — reach the same instance.
  const id = namespace.idFromName(ip);
  const stub = namespace.get(id);
  const res = await stub.fetch('https://rate-limiter/check');
  const { limited } = (await res.json()) as { limited: boolean };
  return limited;
}

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers });
    }

    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (await isRateLimited(ip, env.RATE_LIMITER)) {
      return Response.json(
        { error: 'Rate limit exceeded. Try again in a minute.' },
        { status: 429, headers },
      );
    }

    let body: { messages?: Array<{ role: string; content: string }> };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers });
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: 'messages array is required' }, { status: 400, headers });
    }

    const apiUrl = `${env.LLM_BASE_URL}/chat/completions`;
    const llmResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        stream: true,
        max_tokens: 2048,
        temperature: 0.7,
      }),
    });

    if (!llmResponse.ok) {
      await llmResponse.text().catch(() => 'LLM API error');
      return Response.json(
        { error: `LLM API error (${llmResponse.status})` },
        { status: 502, headers },
      );
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const reader = llmResponse.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              continue;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                await writer.write(
                  encoder.encode(`data: ${JSON.stringify({ content: delta })}\n\n`),
                );
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Stream error';
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        ...headers,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  },
} satisfies ExportedHandler<Env>;
