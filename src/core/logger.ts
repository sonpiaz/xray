import { loadConfig } from './config.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const min = order[loadConfig().log.level];
  if (order[level] < min) return;
  const prefix = `[${ts()}] ${level.toUpperCase().padEnd(5)} xray:`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stderr;
  if (meta && Object.keys(meta).length > 0) {
    stream.write(`${prefix} ${msg} ${JSON.stringify(meta)}\n`);
  } else {
    stream.write(`${prefix} ${msg}\n`);
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
