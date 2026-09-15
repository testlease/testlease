import { randomUUID } from 'node:crypto';
import {
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { TestLeaseApi } from '@testlease/protocol';
import { createTestLeaseMcpServer, type TestLeaseMcpOptions } from './server.js';

export interface McpHttpIdentity {
  /** Authenticated principal (token name or `local`). */
  principal: string;
  /** API bound to that principal. */
  api: TestLeaseApi;
}

export interface McpHttpHandlerOptions extends Omit<TestLeaseMcpOptions, 'api' | 'owner'> {
  /** Resolves the caller's identity from the HTTP request (Bearer token). Return null for 401. */
  authenticate: (request: Request) => McpHttpIdentity | null;
  /** Hostnames accepted in Host/Origin when not bound to loopback (DNS rebinding protection). */
  allowedHosts?: string[];
  /** Whether the server is bound to a loopback address (enables localhost-only protection). */
  loopback: boolean;
  /** Idle session eviction (default 30 minutes). */
  sessionIdleMs?: number;
  log?: (level: 'info' | 'warn', obj: Record<string, unknown>, msg: string) => void;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  principal: string;
  owner: string;
  lastSeen: number;
}

export interface McpHttpHandler {
  fetch(request: Request): Promise<Response>;
  /** Number of live sessions (for health/diagnostics). */
  sessionCount(): number;
  close(): Promise<void>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const rpcError = (status: number, code: number, message: string) =>
  json(status, { jsonrpc: '2.0', error: { code, message }, id: null });

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Hostname of a Host/Origin value without the port (IPv6 brackets kept), or null if unparsable. */
export function hostnameOf(value: string, isOrigin: boolean): string | null {
  try {
    const url = new URL(isOrigin ? value : `http://${value}`);
    return url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  } catch {
    return null;
  }
}

/**
 * Port-agnostic DNS-rebinding protection, mirroring the official Hono middleware semantics:
 * the Host header must name an allowed hostname; an Origin header, when present, must too.
 */
export function checkRebinding(request: Request, allowed: ReadonlySet<string>): string | null {
  const host = request.headers.get('host');
  if (!host) return 'Missing Host header';
  const hostName = hostnameOf(host, false);
  if (!hostName || !allowed.has(hostName)) return `Invalid Host header: ${host}`;
  const origin = request.headers.get('origin');
  if (origin) {
    const originName = hostnameOf(origin, true);
    if (!originName || !allowed.has(originName)) return `Invalid Origin header: ${origin}`;
  }
  return null;
}

/**
 * Streamable HTTP endpoint with per-session MCP servers. Each session is bound to the principal
 * that initialised it; leases acquired in the session are owned by `mcp:<principal>:<session>`.
 * Sessions are only a connection concept: closing one never releases leases (ADR-0005).
 */
export function createMcpHttpHandler(options: McpHttpHandlerOptions): McpHttpHandler {
  const sessions = new Map<string, Session>();
  const idleMs = options.sessionIdleMs ?? 30 * 60_000;
  const log = options.log ?? (() => undefined);
  const allowedHosts: ReadonlySet<string> | null = options.allowedHosts?.length
    ? new Set(options.allowedHosts.map((h) => hostnameOf(h, false) ?? h))
    : options.loopback
      ? LOOPBACK_HOSTS
      : null;

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > idleMs) {
        log(
          'info',
          { event: 'mcp.session_idle', sessionId: id, principal: s.principal },
          'closing idle MCP session',
        );
        void s.transport.close();
        sessions.delete(id);
      }
    }
  }, 60_000);
  sweeper.unref();

  async function fetch(request: Request): Promise<Response> {
    if (allowedHosts) {
      const problem = checkRebinding(request, allowedHosts);
      if (problem) return rpcError(403, -32000, problem);
    }
    const identity = options.authenticate(request);
    if (!identity) {
      return rpcError(
        401,
        -32001,
        'Missing or invalid API token. Send "Authorization: Bearer <token>".',
      );
    }
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session)
        return rpcError(404, -32001, 'Unknown or expired MCP session; initialize again.');
      if (session.principal !== identity.principal) {
        return rpcError(403, -32001, 'This MCP session belongs to a different API token.');
      }
      session.lastSeen = Date.now();
      return session.transport.handleRequest(request);
    }
    if (request.method !== 'POST') {
      return rpcError(400, -32000, 'Mcp-Session-Id header required for this request.');
    }

    // New session: bind a fresh MCP server to this principal.
    const id = randomUUID();
    const owner = `mcp:${identity.principal}:${id.slice(0, 8)}`;
    const server = createTestLeaseMcpServer({ ...options, api: identity.api, owner });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      // Host/Origin validation is done above, port-agnostically, before any session logic.
      enableDnsRebindingProtection: false,
      onsessioninitialized: (sid) => {
        sessions.set(sid, {
          transport,
          server,
          principal: identity.principal,
          owner,
          lastSeen: Date.now(),
        });
        log(
          'info',
          { event: 'mcp.session_started', sessionId: sid, principal: identity.principal, owner },
          'MCP session started',
        );
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        log(
          'info',
          { event: 'mcp.session_closed', sessionId: sid, principal: identity.principal },
          'MCP session closed; active leases are kept until release or expiry',
        );
      },
    });
    transport.onclose = () => {
      sessions.delete(id);
    };
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  return {
    fetch,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweeper);
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      sessions.clear();
    },
  };
}
