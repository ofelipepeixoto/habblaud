import { expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { loadConfig } from '../config';
it('demo ignores real account, state and action settings', () => {
  const config = loadConfig({ HOME: '/synthetic-real-home', HABBLAUD_DEMO: '1', HABBLAUD_IN_DOCKER: '0', HABBLAUD_HOST: '0.0.0.0', HABBLAUD_CLAUDE_DIRS: '/synthetic-account', HABBLAUD_DATA_DIR: '/synthetic-state', HABBLAUD_USAGE_DIR: '/synthetic-usage', HABBLAUD_TERMINAL: '1', HABBLAUD_MENSAGENS: '1', HABBLAUD_PTY: '1', HABBLAUD_CODEX: '1', HABBLAUD_UPDATE_CHECK: '1' }, []);
  try {
    expect(config.home).not.toBe('/synthetic-real-home');
    expect(config.dataDir).toBe(config.home);
    expect(config.usageDir.startsWith(config.home)).toBe(true);
    expect(config.claudeDirs).toEqual([]);
    expect(config).toMatchObject({ demo: true, host: '127.0.0.1', terminal: false, messages: false, codex: false, updateCheck: false, timeline: false, remote: undefined });
  } finally { rmSync(config.home, { recursive: true, force: true }); }
});

// Launch only inside the test runner's synthetic environment; no inherited account env.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { OfficeSnapshot } from '../../shared/types';

it('startup demo never discovers configured synthetic accounts or exposes real actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'demo-startup-'));
  const accounts = join(root, 'account'); mkdirSync(accounts);
  writeFileSync(join(accounts, '.claude.json'), JSON.stringify({ email: 'synthetic@example.invalid' }));
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>(done => socket.close(() => done()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { PATH: process.env.PATH, HOME: root, HABBLAUD_PORT: String(port), HABBLAUD_DEMO: '1', HABBLAUD_CLAUDE_DIRS: accounts, HABBLAUD_CODEX_DIRS: accounts, HABBLAUD_DATA_DIR: join(root, 'do-not-create'), HABBLAUD_PTY: '1', HABBLAUD_TERMINAL: '1', HABBLAUD_MENSAGENS: '1', HABBLAUD_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
  const exited = once(child, 'exit');
  try {
    let snapshot: OfficeSnapshot | undefined;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
        if (response.ok) { snapshot = await response.json() as OfficeSnapshot; break; }
      } catch { /* startup */ }
      await new Promise(done => setTimeout(done, 50));
    }
    expect(snapshot, output).toBeDefined();
    expect(snapshot!.accounts.every(a => a.id.startsWith('demo:'))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('synthetic@example.invalid');
    expect(snapshot!.meta).toMatchObject({ demo: true, terminal: false });
    expect(snapshot!.meta.messages).toBeFalsy();
    expect(snapshot!.meta.pty?.enabled).toBe(false);
    expect(snapshot!.meta.sources).toEqual([]);
    expect(snapshot!.agents.length).toBeGreaterThan(0);
    expect(snapshot!.agents.every(a => a.id.startsWith('demo:'))).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/api/deliveries`)).status).toBe(403);
  } finally {
    child.kill('SIGTERM'); await exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
