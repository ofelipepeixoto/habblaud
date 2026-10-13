import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { FileFetcher } from '../deliveries/fetcher';
import { RemoteSessions, createRemoteGate, COOKIE } from '../http/remote';

describe('File freshness and remote response lifetime', () => {
  it('direct delivery rechecks a deleted source instead of returning cached bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-reg-'));
    try {
      const path = join(root, 'file.pdf'); writeFileSync(path, 'synthetic');
      const f = new FileFetcher({direct:true}); await f.get(path); rmSync(path);
      expect(await f.get(path)).toMatchObject({status:404});
    } finally {rmSync(root, {recursive:true, force:true});}
  });
  it('direct delivery reflects changed bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-reg-'));
    try {
      const path = join(root, 'file.pdf'); writeFileSync(path, 'old');
      const f = new FileFetcher({direct:true}); await f.get(path); writeFileSync(path, 'new');
      const r = await f.get(path); expect('data' in r && r.data.toString()).toBe('new');
    } finally {rmSync(root, {recursive:true, force:true});}
  });
  for (const reason of ['revoked', 'expired'] as const) it(`an already open remote stream closes when its token is ${reason}`, async () => {
    let now = 1800000000000;
    const sessions = new RemoteSessions(Buffer.alloc(32, 7), {user:'synthetic', passwordHashText:'synthetic'}, () => now);
    const token = sessions.issue().token;
    const gate = createRemoteGate({config:{user:'synthetic', passwordHash:{} as never}, sessions, secure:false});
    let tick: ReturnType<typeof setInterval> | undefined;
    const server = http.createServer((req,res) => {
      if (gate(req,res,new URL(req.url!, 'http://localhost'))) return;
      res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write('data: initial\n\n');
      tick = setInterval(() => res.write('data: synthetic\n\n'), 25);
      res.once('close', () => clearInterval(tick));
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    const ac = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream`, {headers:{Cookie:`${COOKIE}=${token}`}, signal:ac.signal});
      const reader=res.body!.getReader(); await reader.read();
      if(reason==='revoked') sessions.revoke(token); else now += 31*24*60*60*1000;
      expect(sessions.verify(token)).toBe(false);
      const drained = (async () => {try {while(!(await reader.read()).done) {}} catch {} return true;})();
      const closed = await Promise.race([drained,new Promise<boolean>(resolve => {deadline=setTimeout(() => resolve(false),1500);})]);
      expect(closed).toBe(true);
      const reconnect = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream`, {headers:{Cookie:`${COOKIE}=${token}`}});
      expect(reconnect.status).toBe(401);
      await reconnect.arrayBuffer();
      now += 1;
      const freshToken = sessions.issue().token;
      const fresh = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream`, {headers:{Cookie:`${COOKIE}=${freshToken}`}, signal:ac.signal});
      expect(fresh.status).toBe(200);
      await fresh.body!.cancel();
    } finally {clearTimeout(deadline); ac.abort(); server.closeAllConnections(); server.close(); clearInterval(tick);}
  });
});
