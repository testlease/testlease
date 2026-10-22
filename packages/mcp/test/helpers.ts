import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer, type RunningServer } from '@testlease/server';
import { createMcpHttpHandler } from '../src/index.js';
import {
  createTestLease,
  EnvSecretResolver,
  noopLogger,
  validateConfig,
  type TestLeaseEngine,
} from '@testlease/core';

export const SECRETS: Record<string, string> = {
  BUYER_01_PASSWORD: 'mcp-secret-alpha-01',
  BUYER_02_PASSWORD: 'mcp-secret-bravo-02',
  BUYER_03_PASSWORD: 'mcp-secret-charlie-03',
  TOKEN_AGENT: 'agent-token-value-0123456789abcdef',
  TOKEN_OTHER: 'other-token-value-0123456789abcdef',
};

export const SECRET_VALUES = [
  SECRETS.BUYER_01_PASSWORD!,
  SECRETS.BUYER_02_PASSWORD!,
  SECRETS.BUYER_03_PASSWORD!,
];
export const SECRET_REFS = [
  'env:BUYER_01_PASSWORD',
  'env:BUYER_02_PASSWORD',
  'env:BUYER_03_PASSWORD',
  'BUYER_01_PASSWORD',
];

export function mcpConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: { host: '127.0.0.1', port: 0, db: ':memory:', maxWait: '30s', logLevel: 'silent' },
    mcp: { http: true, allowQuarantine: false },
    pools: {
      buyers: {
        defaultTtl: '10m',
        resources: [
          {
            id: 'buyer-01',
            tags: { region: 'nl' },
            metadata: { email: 'buyer01@example.test' },
            secrets: { password: 'env:BUYER_01_PASSWORD' },
          },
          {
            id: 'buyer-02',
            tags: { region: 'nl' },
            metadata: { email: 'buyer02@example.test' },
            secrets: { password: 'env:BUYER_02_PASSWORD' },
          },
          {
            id: 'buyer-03',
            tags: { region: 'be' },
            metadata: { email: 'buyer03@example.test' },
            secrets: { password: 'env:BUYER_03_PASSWORD' },
          },
        ],
      },
    },
    ...extra,
  };
}

export async function makeEngine(extra: Record<string, unknown> = {}): Promise<TestLeaseEngine> {
  const { config } = validateConfig(mcpConfig(extra), '<mcp-test>');
  return createTestLease({
    config,
    dbPath: ':memory:',
    logger: noopLogger,
    secretResolvers: [new EnvSecretResolver(SECRETS)],
    version: 'test',
    authMode: config.auth.tokens.length ? 'token' : 'insecure-local',
    mcpHttp: true,
  });
}

/** Asserts that no secret value and no secret reference appears anywhere in a serialised payload. */
export function assertNoSecrets(payload: unknown, label: string): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const v of SECRET_VALUES) {
    if (text.includes(v)) throw new Error(`${label}: secret value leaked`);
  }
  for (const ref of SECRET_REFS) {
    if (text.includes(ref)) throw new Error(`${label}: secret reference "${ref}" leaked`);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

export function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

export const TOKENS = {
  tokens: [
    { name: 'agent', token: 'env:TOKEN_AGENT', scopes: ['lease:read', 'lease:write', 'pool:read'] },
    { name: 'other', token: 'env:TOKEN_OTHER', scopes: ['lease:read', 'lease:write', 'pool:read'] },
  ],
};

export async function startHttp(
  engine: TestLeaseEngine,
  opts: { allowQuarantine?: boolean } = {},
): Promise<RunningServer> {
  return startServer({
    engine,
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    port: 0,
    extend: (app) => {
      const handler = createMcpHttpHandler({
        loopback: true,
        allowQuarantine: opts.allowQuarantine ?? false,
        authenticate: (request) => {
          const header = request.headers.get('authorization') ?? '';
          const token = header.replace(/^Bearer\s+/i, '');
          const match =
            engine.config.auth.tokens.length === 0
              ? { name: 'local' }
              : token === SECRETS.TOKEN_AGENT
                ? { name: 'agent' }
                : token === SECRETS.TOKEN_OTHER
                  ? { name: 'other' }
                  : null;
          return match ? { principal: match.name, api: engine.api.as(match.name) } : null;
        },
      });
      app.all('/mcp', (c) => handler.fetch(c.req.raw));
    },
  });
}

export async function connectHttp(
  url: string,
  token?: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${url}/mcp`),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
  );
  const client = new Client({ name: 'vitest-agent', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}
