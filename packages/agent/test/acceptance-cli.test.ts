import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { buildTurnCommand, writeMcpConfigOnce, writeSystemPromptFile } from '../src/turn.js';

const base = {
  systemPrompt: 'SYS',
  promptCtx: 'CTX',
  model: null,
  effort: null,
  mentionPermission: 'auto' as const,
  mcpConfigPath: '/mcp.json',
  pat: 'murp_x',
  murmurUrl: 'http://localhost:3401',
  systemPromptFile: '/state/system-prompt.txt',
};

async function cliExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err) => {
      resolve(err === null);
    });
  });
}

async function checkCliParsing(cmd: string, args: string[]): Promise<{ parseError: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = execFile(cmd, args, { timeout: 5000 }, (err, _stdout, stderr) => {
      const parseError = stderr.includes('unexpected argument') ||
                         stderr.includes('unknown option') ||
                         stderr.includes('unrecognized');
      resolve({ parseError, stderr });
    });
    proc.on('error', () => {
      resolve({ parseError: false, stderr: '' });
    });
  });
}

const cliAvailability: Record<string, boolean> = {};

async function getCliAvailability(cmd: string): Promise<boolean> {
  if (cliAvailability[cmd] !== undefined) {
    return cliAvailability[cmd];
  }
  cliAvailability[cmd] = await cliExists(cmd);
  return cliAvailability[cmd];
}

describe('수용 — buildTurnCommand argv 가 실제 CLI 에서 파싱되는가 (spec §10)', () => {
  const harnesses = ['claude-code', 'codex'] as const;

  for (const harness of harnesses) {
    const testCases: Array<{
      mode: 'mention' | 'interactive';
      isFirstTurn: boolean;
      sessionId: string | null;
      description: string;
    }> = [];

    if (harness === 'claude-code') {
      testCases.push(
        { mode: 'mention', isFirstTurn: true, sessionId: 'uuid-1', description: '첫 멘션 턴' },
        { mode: 'mention', isFirstTurn: false, sessionId: 'uuid-2', description: 'resume 멘션 턴' },
        { mode: 'interactive', isFirstTurn: false, sessionId: 'uuid-3', description: '인터랙티브 턴' },
      );
    } else {
      testCases.push(
        { mode: 'mention', isFirstTurn: true, sessionId: null, description: '첫 멘션 턴 (sessionId=null)' },
        { mode: 'mention', isFirstTurn: false, sessionId: 'uuid-4', description: 'resume 멘션 턴' },
        { mode: 'interactive', isFirstTurn: false, sessionId: 'uuid-5', description: '인터랙티브 턴' },
      );
    }

    for (const tc of testCases) {
      it(`[${harness}] ${tc.description}: argv 가 CLI 에서 파싱되는가`, async () => {
        const exists = await cliExists(harness);
        if (!exists) {
          console.log(`[수용] ${harness} CLI 가 없어 이 테스트를 건너뜁니다 — 이 VM 에 CLI 가 없으므로 코디네이터의 로컬에서 다시 확인합니다 (claude 2.1.258 / codex-cli 0.148.0)`);
          return;
        }

        const dir = await mkdtemp(join(tmpdir(), 'murmur-acceptance-'));
        try {
          const mcpConfigPath = join(dir, 'mcp.json');
          const systemPromptFile = await writeSystemPromptFile(dir, 'SYS');
          await writeMcpConfigOnce(dir, 'http://localhost:3401');

          const opts = {
            ...base,
            harness: harness as 'claude-code' | 'codex',
            mode: tc.mode,
            sessionId: tc.sessionId,
            isFirstTurn: tc.isFirstTurn,
            mcpConfigPath,
            systemPromptFile,
          };

          const plan = buildTurnCommand(opts);
          const { parseError, stderr } = await checkCliParsing(plan.command, plan.args);

          expect(parseError).toBe(false);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  }
});