import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null };
const worker = fileURLToPath(new URL('./fixtures/event-intelligence-process-worker.ts', import.meta.url));

function spawnWorker(mode: 'first' | 'reopen', home: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', worker, mode, home], {
    env: { ...process.env, EI_CANDIDATE_CONFORMANCE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  const exited: Promise<ProcessResult> = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  async function awaitLine(prefix: string) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const match = stdout.split('\n').find(line => line.startsWith(prefix));
      if (match) return JSON.parse(match.slice(prefix.length));
      const terminated = child.exitCode !== null || child.signalCode !== null;
      if (terminated) throw new Error(mode + ' exited before ' + prefix + ': ' + stderr + stdout);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('timed out waiting for ' + mode + ' ' + prefix + ': ' + stderr + stdout);
  }
  return { child, awaitLine, exited, logs: () => ({ stdout, stderr }) };
}

describe.skipIf(process.env.EI_CANDIDATE_CONFORMANCE !== '1')(
  'Muffin EI canonical host contract real OS process crash/reopen', () => {
    it('preserves EI wake receipts and host-owned Turn dedup after SIGKILL', async () => {
      const home = mkdtempSync(join(tmpdir(), 'muffin-ei-os-restart-'));
      let first: ReturnType<typeof spawnWorker> | null = null;
      let reopened: ReturnType<typeof spawnWorker> | null = null;
      try {
        first = spawnWorker('first', home);
        const ready = await first.awaitLine('READY ');
        expect(ready.wakeId).toBeTruthy();
        expect(ready.receiptId).toBeTruthy();
        expect(ready.receiptId).not.toBe(ready.wakeId);
        first.child.kill('SIGKILL');
        const killed = await first.exited;
        expect(killed.signal).toBe('SIGKILL');

        reopened = spawnWorker('reopen', home);
        const report = await reopened.awaitLine('RESULT ');
        const exit = await reopened.exited;
        expect(exit).toEqual({ code: 0, signal: null });
        expect(report).toMatchObject({
          schema: 'muffin.ei-host.process-restart.v1',
          passed: true,
          deduplicatedAfterSigkill: true,
          hostReceiptReopenLookupVerified: true,
          postCrashPendingWakeRetryVerified: false,
          freshAfterSigkill: true,
          hostReceiptPersistence: 'fixture-json-file',
          actualNetworkMcp: false,
        });
      } finally {
        if (first?.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL');
        if (reopened?.child.exitCode === null && reopened.child.signalCode === null) reopened.child.kill('SIGKILL');
        rmSync(home, { recursive: true, force: true });
      }
    }, 25000);
  },
);
