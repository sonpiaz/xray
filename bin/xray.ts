#!/usr/bin/env bun
import { runCli } from '../src/cli/index.ts';

const code = await runCli(process.argv);
process.exit(code);
