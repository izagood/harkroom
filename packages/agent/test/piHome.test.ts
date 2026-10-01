// pi 의 러너 전용 루트와 읽기 전용 허용 목록 (실측 2026-10-01, pi 0.99.2 — `src/adapters/pi.ts`).
import { mkdtemp, mkdir, readFile, writeFile, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ensurePiHome, parsePiMcpList, piSessionFile, piSessionsDir, piToolName, readonlyToolList, toPiMcp,
} from '../src/piHome.js';
import { readonlyToolsFor } from '../src/adapters/index.js';

const BRIDGE = { harkroom: { type: 'stdio' as const, command: '/opt/harkroom/harkroom-operator', args: ['mcp-bridge'] } };
const PI = readonlyToolsFor('pi')!;

describe('읽기 전용 허용 목록 — 닫힌 목록이다', () => {
  it('MCP 도구는 **정확한 이름**으로 적는다 — `mcp__harkroom__*` 는 pi 가 안 받는다(실측)', () => {
    const list = readonlyToolList(PI, { harkroom: ['message.post', 'message.read'], avcs: ['avcs_sync_push'] });
    expect(list.split(',')).toEqual(['read', 'grep', 'find', 'ls', 'mcp__harkroom__message_post', 'mcp__harkroom__message_read']);
    expect(list).not.toContain('*');
  });

  it('harkroom 밖의 MCP(avcs·개인 서버)와 쓰기·셸 내장은 넣지 않는다', () => {
    const list = readonlyToolList(PI, { harkroom: ['message.post'], avcs: ['avcs_sync_push'], gmail: ['send'] }).split(',');
    for (const banned of ['bash', 'edit', 'write']) expect(list).not.toContain(banned);
    expect(list.some((t) => t.startsWith('mcp__avcs__') || t.startsWith('mcp__gmail__'))).toBe(false);
  });

  it('도구 이름을 못 받으면 내장 읽기 도구만 — 답할 길을 잃어도 쓰기는 열지 않는다', () => {
    expect(readonlyToolList(PI, null)).toBe('read,grep,find,ls');
  });

  it('pi 의 이름 규칙: 영숫자·`_` 밖은 `_`', () => {
    expect(piToolName('harkroom', 'message.post')).toBe('mcp__harkroom__message_post');
    expect(piToolName('my-srv', 'a.b-c')).toBe('mcp__my_srv__a_b_c');
  });

  it('`pi mcp list --json` 출력을 서버별 도구로 읽는다', () => {
    const out = JSON.stringify({ servers: [{ name: 'harkroom', state: 'connected', tools: ['message.post'] }], errors: [] });
    expect(parsePiMcpList(out)).toEqual({ harkroom: ['message.post'] });
    expect(parsePiMcpList('not json')).toBeNull();
  });
});

describe('세션 기록 파일 찾기 — 비밀 보관소 D7 의 가리기 대상(security U2)', () => {
  it('`--session-dir` 배치(`<시각>_<id>.jsonl`, cwd 폴더 없음)에서 id 로 찾는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-sess-'));
    await mkdir(piSessionsDir(home), { recursive: true });
    const id = '2cecdc12-f8b5-4d04-8cc3-e6ca28a9e816';
    await writeFile(join(piSessionsDir(home), `2026-10-01T10-42-41-940Z_${id}.jsonl`), '{}\n');
    await writeFile(join(piSessionsDir(home), '2026-10-01T10-00-00-000Z_other.jsonl'), '{}\n');
    expect(await piSessionFile(home, id)).toBe(join(piSessionsDir(home), `2026-10-01T10-42-41-940Z_${id}.jsonl`));
    expect(await piSessionFile(home, 'missing')).toBeNull();
  });
});

describe('격리 루트가 물려받는 것과 안 받는 것', () => {
  async function fixture(): Promise<{ home: string; sourceDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'pi-home-'));
    const sourceDir = join(root, 'user-pi');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'auth.json'), '{"x":{"type":"api_key","key":"k"}}');
    await writeFile(join(sourceDir, 'models.json'), '{"providers":{"gw":{"baseUrl":"https://gw.example/v1"}}}');
    await writeFile(join(sourceDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'gw', defaultModel: 'm1',
      // 사람의 확장·도구 설정 — **넘어오면 안 된다**(확장은 pi 안에서 도는 코드다).
      packages: ['npm:some-extension'], defaultTools: ['+bash'],
    }));
    await writeFile(join(sourceDir, 'mcp.json'), JSON.stringify({ mcpServers: { gmail: { command: 'gmail-mcp' } } }));
    return { home: join(root, 'runner-pi'), sourceDir };
  }

  it('로그인·제공자는 링크, 설정은 기본 제공자·모델만, MCP 는 우리 표만', async () => {
    const { home, sourceDir } = await fixture();
    await ensurePiHome({ piHome: home, mcpServers: BRIDGE, sourceDir });

    for (const f of ['auth.json', 'models.json']) {
      expect((await lstat(join(home, f))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(home, f))).toBe(join(sourceDir, f));
    }
    expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))).toEqual({ defaultProvider: 'gw', defaultModel: 'm1' });
    const mcp = JSON.parse(await readFile(join(home, 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['harkroom']);
    // `direct` 가 아니면 도구가 모델에 선언되지 않아 `message.post` 를 바로 못 부른다.
    expect(mcp.mcpServers.harkroom).toEqual({ command: '/opt/harkroom/harkroom-operator', args: ['mcp-bridge'], exposure: 'direct' });
  });

  it('두 번 불러도 같다 — 매 턴 불린다', async () => {
    const { home, sourceDir } = await fixture();
    await ensurePiHome({ piHome: home, mcpServers: BRIDGE, sourceDir });
    await ensurePiHome({ piHome: home, mcpServers: BRIDGE, sourceDir });
    expect(await readlink(join(home, 'auth.json'))).toBe(join(sourceDir, 'auth.json'));
  });

  it('사람 설정이 없어도 뜬다(환경변수 키만 쓰는 사람)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-home-'));
    await ensurePiHome({ piHome: join(root, 'r'), mcpServers: BRIDGE, sourceDir: join(root, 'none') });
    expect(await lstat(join(root, 'r', 'auth.json')).catch(() => null)).toBeNull();
  });

  it('원격 MCP 는 url·headers 로 옮긴다', () => {
    expect(toPiMcp({ s: { type: 'http', url: 'https://mcp.example/x', headers: { A: 'b' } } }))
      .toEqual({ s: { url: 'https://mcp.example/x', exposure: 'direct', headers: { A: 'b' } } });
  });
});
