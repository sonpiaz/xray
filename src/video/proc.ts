import { spawn } from 'node:child_process';

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Thin wrapper around `node:child_process.spawn` that captures stdout +
 * stderr fully and resolves once the process exits.
 *
 * Why not `Bun.spawn`? It's nicer ergonomically but `vitest` runs under
 * Node where the `Bun` global is undefined. Using node:child_process keeps
 * the video module testable without spinning up a separate `bun test`
 * lane. Production callers from the CLI (which DO run under Bun) still
 * work because Bun ships node:child_process compatibly.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
