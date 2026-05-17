// 2nd-brain MCP client.
//
// Speaks JSON-RPC 2.0 over a single HTTP POST per call to the 2nd-brain
// MCP server (`unsubject/2nd-brain` repo, mcp-worker/). Per SPEC §10:
//
//   - All communication with 2nd-brain is via MCP; no direct DB access.
//   - Tool signatures are fixed in SPEC §10.1. If 2nd-brain's actual
//     tools differ, document the delta — don't adapt silently.
//   - SPEC §10.2: retry transient failures up to 3x with exponential
//     backoff; on final failure proceed with archive_overlap=0 and a
//     warning logged. Better to surface a possibly-redundant candidate
//     than to drop the scoring run.
//
// We deliberately use raw fetch + JSON-RPC framing rather than the
// `@modelcontextprotocol/sdk` client. The MCP shape is simple (one POST
// per call, no session state) and the codebase pattern in `llm.ts`
// already uses raw fetch; the SDK adds dependency weight without
// unlocking anything we need at v1.
//
// Transport compliance: the MCP Streamable HTTP spec requires POST
// clients to advertise BOTH application/json AND text/event-stream in
// Accept, and to accept either response shape. SDK-based MCP servers
// enforce this with a 406 before processing tools/call. 2nd-brain's own
// mcp-worker happens to always return JSON, but we follow the spec so
// the same client works against any compliant server.
//
// Graceful-fallback wrappers (`archiveSearch`, `recordPick`) swallow
// final failures and return empty results so callers don't need to
// implement the SPEC §10.2 contract themselves. A wrong-sized embedding
// is the one exception — that's a programmer error and must surface
// loudly, not silently return [].

import { env } from '../config/env.js';

/** Embedding dimension required by SPEC §10 — must match text-embedding-3-small. */
export const EXPECTED_QUERY_EMBEDDING_DIM = 1536;

/** Accept header value sent on every MCP POST — see module header for why. */
export const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;

// HTTP status codes we treat as permanent (no retry). 401/403 won't fix
// themselves on retry; 404 means the MCP URL is wrong; 406 means the
// server rejected our Accept (shouldn't happen now we send both, but if
// it does it's a config issue not a transient failure). 5xx and network
// errors retry per SPEC.
function isPermanentHttpStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

export interface ArchiveMatch {
  id: string;
  title: string;
  url: string;
  published_at: string;
  similarity: number;
  type: 'essay' | 'episode';
}

export interface RecordPickCandidate {
  headline: string;
  context: string;
  domain: string;
  keywords: string[];
  tags: string[];
  urls: string[];
}

export type PickDecision = 'pick' | 'pass' | 'defer';

export interface TwoBrainCallOptions {
  /** Override fetch — primarily for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** External abort signal — wins over the per-attempt timeout. */
  signal?: AbortSignal;
  /** Per-attempt timeout (ms). Default 15s. */
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

class PermanentMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentMcpError';
  }
}

/**
 * Parse an MCP-style SSE response body and return the JSON payload from
 * the last `message` event. Implements just enough of the SSE format
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html) for
 * a one-shot MCP tools/call response — we don't need to stream-decode
 * multiple events or maintain a connection.
 *
 * SSE rules we honour: events separated by blank lines, default event
 * type is `message` when no `event:` field is present, multi-line
 * `data:` fields concatenate with `\n`, leading single space after
 * `data:` is stripped.
 */
export function parseSseResponse(text: string): unknown {
  const events = text.split(/\r?\n\r?\n/).filter((e) => e.trim());
  // Walk events newest-first so a server emitting heartbeats before the
  // payload still resolves to the actual message event.
  for (let i = events.length - 1; i >= 0; i--) {
    const block = events[i];
    if (!block) continue;
    const lines = block.split(/\r?\n/);
    let eventType: string = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        // Strip the optional single leading space per the SSE spec.
        const value = line.slice('data:'.length);
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      // Other fields (id:, retry:, comment lines) are ignored — they
      // don't affect a single-call tools/call response.
    }
    if (eventType === 'message' && dataLines.length > 0) {
      return JSON.parse(dataLines.join('\n'));
    }
  }
  throw new Error('SSE response contained no message event with data');
}

/**
 * Read the JSON-RPC response from an HTTP Response, transparently
 * handling either content-type the MCP Streamable HTTP transport allows.
 */
async function readRpcResponse(res: Response): Promise<JsonRpcResponse> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const body = await res.text();
    return parseSseResponse(body) as JsonRpcResponse;
  }
  return (await res.json()) as JsonRpcResponse;
}

/**
 * Single attempt at an MCP tools/call. Returns the parsed tool output
 * on success. Throws on any failure — `callMcpTool` decides whether to
 * retry based on the error type.
 */
async function attemptMcpCall<T>(
  toolName: string,
  args: Record<string, unknown>,
  url: string,
  token: string,
  opts: TwoBrainCallOptions,
): Promise<T> {
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: MCP_ACCEPT_HEADER,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '<no body>')).slice(0, 300);
    const msg = `HTTP ${res.status} from MCP tool ${toolName}: ${detail}`;
    // 4xx = misconfig (wrong URL, expired token, tool path wrong). Don't
    // burn the retry budget on something that can't fix itself.
    if (isPermanentHttpStatus(res.status)) throw new PermanentMcpError(msg);
    throw new Error(msg);
  }

  let json: JsonRpcResponse;
  try {
    json = await readRpcResponse(res);
  } catch (err) {
    // Either content-type lied or the SSE/JSON body was malformed. Treat
    // as permanent — retrying won't fix a misbehaving server.
    throw new PermanentMcpError(
      `Failed to read MCP response for ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (json.error) {
    // -32601 (method not found) / -32602 (invalid params, includes "Unknown
    // tool" in 2nd-brain's impl) are server-config issues — don't retry.
    const isPermanentCode = json.error.code === -32601 || json.error.code === -32602;
    const msg = `RPC error ${json.error.code} from ${toolName}: ${json.error.message}`;
    if (isPermanentCode) throw new PermanentMcpError(msg);
    throw new Error(msg);
  }

  const content = json.result?.content?.[0];
  if (!content || content.type !== 'text' || typeof content.text !== 'string') {
    // The MCP spec allows multi-part content but every 2nd-brain tool emits
    // a single text block carrying a JSON-stringified payload. A shape we
    // don't recognise is the server speaking a dialect we haven't taught
    // ourselves; treat as permanent so we surface a config issue rather
    // than retry-loop.
    throw new PermanentMcpError(
      `Unexpected MCP content shape for ${toolName} (no text content[0])`,
    );
  }
  if (json.result?.isError) {
    // Tool-reported error (vs RPC-layer error). Probably permanent (auth,
    // bad args), so don't retry; the graceful wrapper logs it.
    throw new PermanentMcpError(
      `Tool error from ${toolName}: ${content.text.slice(0, 300)}`,
    );
  }

  try {
    return JSON.parse(content.text) as T;
  } catch (err) {
    throw new PermanentMcpError(
      `Failed to parse JSON from ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const handle = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(handle);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function callMcpTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  opts: TwoBrainCallOptions = {},
): Promise<T> {
  const url = env.twoBrainMcpUrl();
  const token = env.twoBrainMcpToken();
  if (!url || !token) {
    // Treat unconfigured as a permanent error so the wrapper short-circuits
    // to degraded behaviour without burning 3 attempts.
    throw new PermanentMcpError(
      'TWO_BRAIN_MCP_URL / TWO_BRAIN_MCP_TOKEN not configured — degrading',
    );
  }

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptMcpCall<T>(toolName, args, url, token, opts);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof PermanentMcpError || attempt === MAX_ATTEMPTS) break;
      const backoff = INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(
        `[two-brain] ${toolName} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message}; retrying in ${backoff}ms`,
      );
      try {
        await sleep(backoff, opts.signal);
      } catch {
        // External abort during backoff — surface the original failure,
        // not the abort.
        break;
      }
    }
  }

  throw lastError ?? new Error('MCP call failed without recorded error');
}

/**
 * `archive_search` per SPEC §10.1. Returns prior essays + YouTube
 * episodes by cosine similarity against the supplied 1536-dim embedding.
 *
 * Graceful by contract: any failure (network, RPC, missing tool on
 * server, missing env, etc.) returns an empty array and logs a warning,
 * so the caller's Stage 5 (archive overlap) proceeds with
 * archive_overlap=0 instead of failing the whole scoring run.
 *
 * The dim check is the one exception — a wrong-sized embedding is a
 * programmer bug that would silently produce 0 matches forever, and is
 * worth surfacing instead of hiding.
 */
export async function archiveSearch(
  queryEmbedding: number[],
  topK: number,
  opts: TwoBrainCallOptions = {},
): Promise<ArchiveMatch[]> {
  if (queryEmbedding.length !== EXPECTED_QUERY_EMBEDDING_DIM) {
    throw new Error(
      `archive_search: query_embedding must be ${EXPECTED_QUERY_EMBEDDING_DIM}-dim (got ${queryEmbedding.length})`,
    );
  }
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new Error(`archive_search: top_k must be a positive integer (got ${topK})`);
  }
  try {
    return await callMcpTool<ArchiveMatch[]>(
      'archive_search',
      { query_embedding: queryEmbedding, top_k: topK },
      opts,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[two-brain] archive_search degraded to []: ${msg}`);
    return [];
  }
}

/**
 * `record_pick` per SPEC §10.1. Best-effort write of Simon's pick / pass
 * / defer decision into 2nd-brain as a training signal. Any failure logs
 * and returns `{ ok: false }` — never throws — so a 2nd-brain outage
 * cannot block a scoring run from advancing past the curation stage.
 */
export async function recordPick(
  candidate: RecordPickCandidate,
  decision: PickDecision,
  reason: string | undefined,
  opts: TwoBrainCallOptions = {},
): Promise<{ ok: boolean }> {
  const args: Record<string, unknown> = { candidate, decision };
  if (reason !== undefined) args.reason = reason;
  try {
    return await callMcpTool<{ ok: boolean }>('record_pick', args, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[two-brain] record_pick degraded to ok=false: ${msg}`);
    return { ok: false };
  }
}
