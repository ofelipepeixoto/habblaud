import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedArtifacts, type ArtifactScope } from './scoped';
import { FileFetcher } from './fetcher';

describe('operator-scoped artifacts (synthetic projects)', () => {
  let dir: string, a: string, b: string, file: string, policy: string, scope: ArtifactScope, reader: ScopedArtifacts;
  const save = (value: unknown) => writeFileSync(policy, JSON.stringify(value), { mode: 0o600 });
  const grant = () => ({ ...scope, root: a });
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'scoped-artifacts-')));
    a = join(dir, 'project-a'); b = join(dir, 'project-b');
    mkdirSync(a); mkdirSync(b);
    file = join(a, 'report.pdf'); writeFileSync(file, 'synthetic A');
    writeFileSync(join(b, 'report.pdf'), 'synthetic B');
    policy = join(dir, 'operator-policy.json');
    scope = { account: 'synthetic-account', sessionId: 'session-a', project: a };
    save([grant(), { ...scope, sessionId: 'session-b', project: b, root: b }]);
    reader = new ScopedArtifacts(policy);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('allows only the exact granted account/session/project tuple', async () => {
    expect(await reader.get(file, scope)).toEqual({ data: Buffer.from('synthetic A') });
    for (const changed of [{ account: 'other' }, { sessionId: 'session-b' }, { project: b }]) {
      expect(await reader.get(file, { ...scope, ...changed })).toMatchObject({ status: 403 });
    }
    expect(await reader.get(file)).toMatchObject({ status: 403 });
  });
  it('denies another project even when both projects have grants', async () => {
    expect(await reader.get(join(b, 'report.pdf'), scope)).toMatchObject({ status: 403 });
    expect(await reader.get(join(b, 'report.pdf'), { ...scope, sessionId: 'session-b', project: b })).toEqual({ data: Buffer.from('synthetic B') });
  });
  it('reflects changed bytes and refuses deleted origins', async () => {
    await reader.get(file, scope);
    writeFileSync(file, 'changed synthetic A');
    expect(await reader.get(file, scope)).toEqual({ data: Buffer.from('changed synthetic A') });
    rmSync(file);
    expect(await reader.get(file, scope)).toMatchObject({ status: 404 });
  });
  it('reloads revocation and rejects malformed or missing policy', async () => {
    await reader.get(file, scope); save([]);
    expect(await reader.get(file, scope)).toMatchObject({ status: 403 });
    writeFileSync(policy, '{');
    expect(await reader.get(file, scope)).toMatchObject({ status: 403 });
    expect(await new ScopedArtifacts().get(file, scope)).toMatchObject({ status: 403 });
  });
  it('denies a file symlink into B and an internal alias', async () => {
    for (const [name, target] of [['escape.pdf', join(b, 'report.pdf')], ['alias.pdf', file]]) {
      const alias = join(a, name); symlinkSync(target, alias);
      expect(await reader.get(alias, scope)).toMatchObject({ status: 403 });
    }
  });
  it('denies a directory alias into B', async () => {
    symlinkSync(b, join(a, 'linked'));
    expect(await reader.get(join(a, 'linked', 'report.pdf'), scope)).toMatchObject({ status: 403 });
  });
  it('denies an authorized root replaced by a symlink', async () => {
    rmSync(a, { recursive: true }); symlinkSync(b, a);
    expect(await reader.get(file, scope)).toMatchObject({ status: 403 });
  });
  it('denies hardlinks, traversal and sibling-prefix paths', async () => {
    linkSync(join(b, 'report.pdf'), join(a, 'hard.pdf'));
    expect(await reader.get(join(a, 'hard.pdf'), scope)).toMatchObject({ status: 403 });
    expect(await reader.get(`${a}/../project-b/report.pdf`, scope)).toMatchObject({ status: 403 });
    expect(await reader.get(`${a}-other/report.pdf`, scope)).toMatchObject({ status: 403 });
  });
  it('fails closed for ambiguous, broad, overlapping or writable grants', async () => {
    for (const value of [[grant(), grant()], [{ ...grant(), root: '/' }], [grant(), { ...grant(), sessionId: 'nested', root: join(a, 'nested'), project: join(a, 'nested') }]]) {
      save(value); expect(await reader.get(file, scope)).toMatchObject({ status: 403 });
    }
    save([grant()]); chmodSync(policy, 0o666);
    expect(await reader.get(file, scope)).toMatchObject({ status: 403 });
  });
  it('production fetcher does not fall back to mapped paths or host bridge', async () => {
    const f = new FileFetcher({ artifacts: reader, mapHostPath: () => join(b, 'report.pdf') });
    f.poll();
    expect(await f.get(join(b, 'report.pdf'), scope)).toMatchObject({ status: 403 });
    expect(f.poll()).toEqual([]);
  });
});
