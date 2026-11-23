import crypto from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MAX_HTTP_BODY_BYTES = 1024 * 1024; // 1 MiB

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest();
}

export function timingSafeBearerMatch(authHeader, expectedToken) {
  if (!authHeader || !expectedToken || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const provided = authHeader.slice('Bearer '.length).trim();
  if (!provided) return false;
  return crypto.timingSafeEqual(sha256(provided), sha256(expectedToken));
}

export function isAllowedLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const hostname = String(hostHeader).replace(/:\d+$/, '').toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function isAllowedOrigin(originHeader) {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    return (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

export function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_HTTP_BODY_BYTES) {
      const err = new Error('Request body exceeds 1 MiB limit');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

/**
 * Starts a stateless Streamable HTTP MCP server with Fail-Closed auth and DNS-rebinding guards.
 */
export async function startHttpServer({
  createServer,
  host = '127.0.0.1',
  port = 8788,
  token
}) {
  const cleanToken = typeof token === 'string' && token.trim() ? token.trim() : undefined;
  const loopbackBind = isLoopbackHost(host);

  if (!loopbackBind && !cleanToken) {
    throw new Error(
      `Fail-Closed: 非ループバックアドレス (${host}) で起動する場合は OMOCHI_TUNE_MCP_HTTP_TOKEN が必須です`
    );
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (loopbackBind && !isAllowedLocalHost(req.headers.host)) {
        sendJson(res, 403, { error: 'Forbidden Host header' });
        return;
      }
      if (loopbackBind && !isAllowedOrigin(req.headers.origin)) {
        sendJson(res, 403, { error: 'Forbidden Origin header' });
        return;
      }

      const reqPath = (req.url || '/').split('?')[0];

      if (reqPath === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          server: 'omochi-tune-mcp',
          transport: 'http',
          authRequired: Boolean(cleanToken)
        });
        return;
      }

      if (cleanToken && !timingSafeBearerMatch(req.headers.authorization, cleanToken)) {
        sendJson(
          res,
          401,
          { error: 'Unauthorized' },
          { 'WWW-Authenticate': 'Bearer realm="omochi-tune-mcp"' }
        );
        return;
      }

      if (reqPath !== '/mcp') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(
          res,
          405,
          {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed.' },
            id: null
          },
          { Allow: 'POST' }
        );
        return;
      }

      let parsedBody;
      try {
        parsedBody = await readJsonBody(req);
      } catch (err) {
        const status = err?.statusCode === 413 ? 413 : 400;
        sendJson(res, status, { error: err instanceof Error ? err.message : 'Invalid JSON' });
        return;
      }

      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      console.error('[omochi-tune-mcp] HTTP error:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(port, host, () => {
      httpServer.off('error', rejectPromise);
      resolvePromise();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const endpointUrl = `http://${host}:${actualPort}/mcp`;

  return {
    httpServer,
    host,
    port: actualPort,
    endpointUrl,
    async close() {
      await new Promise((resolveClose) => httpServer.close(() => resolveClose()));
    }
  };
}
