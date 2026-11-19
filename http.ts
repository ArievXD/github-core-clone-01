// github-core-clone-01 — HTTP helpers shared by every surface.
//
// Every REST reply is application/json, never HTML, and carries a non-empty X-GitHub-Request-Id.
// An error carries a JSON body with a string message.

import type { IncomingMessage, ServerResponse } from 'node:http';

export class MalformedJsonError extends Error {}

let requestCounter = 0;

/** A deterministic per-request id (a counter, never random, so runs stay comparable). */
export function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body; always sets content-type and X-GitHub-Request-Id. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes (a packfile, a blob) under the given content type. */
export function sendBytes(
  res: ServerResponse,
  status: number,
  data: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(data);
}

/** Read a request body fully. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Read and parse a JSON body. Throws MalformedJsonError on bad JSON; an empty body parses as {}. */
export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new MalformedJsonError('the request body is not valid JSON');
  }
}

/** The bearer token from `Authorization: Bearer <token>`, or null when absent/malformed. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match === null ? null : (match[1] ?? null);
}

/** A Link header for pagination: rel="next" when there is a next page. */
export function linkHeader(base: string, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const next = `${base}?page=${page + 1}&per_page=${perPage}`;
  return `<${next}>; rel="next"`;
}
