import { hostname, userInfo } from 'node:os';
import { TestLeaseClient } from '@testlease/client';
import { Output } from './output.js';

export interface GlobalOptions {
  url?: string;
  token?: string;
  owner?: string;
  json?: boolean;
  color?: boolean;
}

export interface CliContext {
  out: Output;
  url: string;
  token: string | undefined;
  owner: string;
  client: () => TestLeaseClient;
  env: NodeJS.ProcessEnv;
}

export const DEFAULT_URL = 'http://127.0.0.1:4747';

export function defaultCliOwner(env: NodeJS.ProcessEnv): string {
  if (env.TESTLEASE_OWNER) return env.TESTLEASE_OWNER;
  let user = 'user';
  try {
    user = userInfo().username;
  } catch {
    user = env.USER ?? env.USERNAME ?? 'user';
  }
  return `cli:${user}@${hostname()}`;
}

export function createContext(
  opts: GlobalOptions,
  io: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    env: NodeJS.ProcessEnv;
    isTTY: boolean;
  },
): CliContext {
  const color = opts.color ?? (io.isTTY && !io.env.NO_COLOR && io.env.TERM !== 'dumb');
  const out = new Output({ json: opts.json ?? false, color, stdout: io.stdout, stderr: io.stderr });
  const url = opts.url ?? io.env.TESTLEASE_URL ?? DEFAULT_URL;
  const token = opts.token ?? io.env.TESTLEASE_TOKEN;
  const owner = opts.owner ?? defaultCliOwner(io.env);
  return {
    out,
    url,
    token,
    owner,
    env: io.env,
    client: () =>
      new TestLeaseClient({ baseUrl: url, token, owner, userAgent: 'testlease-cli/0.1.0' }),
  };
}
