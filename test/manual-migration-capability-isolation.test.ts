import { expect, test } from 'bun:test';

const capabilityCases = [
  'an issued capability does not arm the runner; only passing it crosses the gate',
  'authorized run applies v126 exactly once; retry keeps approved clients',
  'the --yes capability is one-shot: a later gated run in the same process blocks',
  '--yes issues once and read-only flags never issue a capability',
  'a process can issue at most one capability from its actual CLI argv',
  'blocked / clear reflect the gated migration state',
  'a single capability crosses only the FIRST of two consecutive manual migrations',
] as const;

for (const name of capabilityCases) {
  test(`isolated issuer process: ${name}`, () => {
    const child = Bun.spawnSync({
      cmd: ['bun', 'test', 'test/manual-migration-gate.test.ts', '--reporter=dot', '-t', name],
      cwd: process.cwd(),
      env: { ...process.env, GBRAIN_ISOLATED_CAPABILITY_TEST: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode, Buffer.from(child.stderr).toString()).toBe(0);
  }, 120000);
}

test('isolated issuer process: --non-interactive issues but read-only combinations do not', () => {
  const script = [
    "const m = await import('./src/core/migrate.ts');",
    "process.argv = ['bun', 'gbrain', 'apply-migrations', '--non-interactive'];",
    "if (!m.issueManualMigrationCapabilityForCurrentProcess()) process.exit(1);",
  ].join(' ');
  const child = Bun.spawnSync({
    cmd: ['bun', '-e', script],
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode, Buffer.from(child.stderr).toString()).toBe(0);
});
