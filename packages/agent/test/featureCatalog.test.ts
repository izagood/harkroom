import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CATALOG_ELSEWHERE, FEATURE_CATALOG, openFeatures } from '@harkroom/shared/featureCatalog';
import { buildSystemPrompt, featureSection } from '../src/prompt.js';
import { READONLY_ALLOW } from '../src/turn.js';

/**
 * 기능 카탈로그(c1)의 두 선. ① 서버에 등록된 harkroom 도구는 모두 카탈로그나 「다른 절이 맡음」 중 한 곳에 있다 —
 * 새 도구를 만들고 「언제」를 안 적으면 아무도 안 쓴다(message.delegate #762 → #809). ② 이 턴에 닫힌 도구는 권하지 않는다.
 */
const PLUGIN = fileURLToPath(new URL('../../server/src/mcp/mcpPlugin.ts', import.meta.url));
const registered = [...readFileSync(PLUGIN, 'utf8').matchAll(/registerTool\('([a-zA-Z.]+)'/g)].map((m) => m[1]!);
const inCatalog = new Set(FEATURE_CATALOG.flatMap((e) => e.tools));
const roOpen = (t: string) => READONLY_ALLOW.includes(`mcp__harkroom__${t.replace(/\./g, '_')}`);
const base = { handle: 'forge', channelName: 'dev', instructions: '', guide: '', memory: { core: 'C', slugs: ['mem/a'] } };

describe('기능 카탈로그 (2026-10-27 c1)', () => {
  it('서버에 등록된 도구는 모두 카탈로그나 CATALOG_ELSEWHERE 중 정확히 한 곳에 있다', () => {
    expect(registered.length).toBeGreaterThan(40);
    for (const t of registered) {
      const n = Number(inCatalog.has(t)) + Number(t in CATALOG_ELSEWHERE);
      expect(n, t).toBe(1);
    }
  });

  it('카탈로그·CATALOG_ELSEWHERE 에 서버에 없는 도구 이름이 없다 — 이름이 바뀌면 없는 도구를 가리킨다', () => {
    for (const t of [...inCatalog, ...Object.keys(CATALOG_ELSEWHERE)]) expect(registered, t).toContain(t);
  });

  it('읽기 전용 턴에 고른 항목의 도구는 전부 허용 목록 안이다 — 구조적으로 막힌 도구를 권하지 않는다', () => {
    for (const e of openFeatures(roOpen, { secretCreate: true })) {
      for (const t of e.tools) expect(roOpen(t), `${e.id}/${t}`).toBe(true);
    }
  });

  it('a1·n5: 읽기 전용 턴은 비밀 만들기 권한이 있어도 askBundle·secret.generate·rotate 안내가 없다', () => {
    const ro = buildSystemPrompt({ ...base, readOnly: true, secretCreate: true });
    for (const t of ['askBundle', 'secret.generate', 'secret.rotate', 'secret.import', 'secret.mount', 'automation.run', 'workitem.upsert']) {
      expect(ro, t).not.toContain(t);
    }
    // 열린 것은 그대로 실린다.
    for (const t of ['`message.post`', '`message.report`', '`message.ask`', '`message.fail`', '`message.search`', '`channel.doc`']) {
      expect(ro, t).toContain(t);
    }
  });

  // security F1: 옛 만들기 절의 금지(MCP 인자·파일 포함)가 옮긴 뒤에도 받기만 한 에이전트에게 간다.
  it('비밀 쓰기 안내는 값을 MCP 인자·메시지·기억·파일·커밋에 쓰지 말라고 한다 — 만들기 권한과 무관하다', () => {
    expect(buildSystemPrompt(base)).toContain('값을 출력·복사하거나 MCP 인자·메시지·기억·파일·커밋에 쓰지 않는다');
  });

  // security n1: 무엇을 보드에 걸지는 앱이 말하지 않는다(설계 원칙 2, #1606 문구).
  it('workitem 항목은 걸 대상의 예시를 들지 않는다', () => {
    const w = FEATURE_CATALOG.find((e) => e.id === 'workitem')!.lines.join('\n');
    expect(w).toContain('밖의 시스템 항목');
    expect(w).not.toMatch(/PR|이슈|intent/);
  });

  it('비밀 만들기 안내는 권한이 있는 일반 턴에만 실린다', () => {
    expect(buildSystemPrompt({ ...base, secretCreate: true })).toContain('`secret.generate`');
    expect(buildSystemPrompt(base)).not.toContain('secret.generate');
  });

  it('API 키 연결 턴의 기능 절은 일반 턴과 같다 — mcp__harkroom 전체가 열려 있다', () => {
    expect(featureSection({ readOnly: false })).toEqual(featureSection({}));
    const lane = buildSystemPrompt({ ...base, laneModel: 'Org/Model' });
    expect(lane).toContain(featureSection({}).join('\n'));
  });

  // S P1: 읽기 전용 턴은 셸·permission.request 가 막혀 있다 — 머지 래퍼·권한 요청·외부 API·PR 서명 절을 싣지 않는다.
  it('읽기 전용 턴에는 머지·권한 요청·외부 API·PR 서명 절이 없고, 일반 턴에는 있다', () => {
    const grants = {
      merge: { operatorBin: '/opt/hr/harkroom-operator', repos: ['acme/app'] },
      permissions: { toolAllows: [] },
      api: { operatorBin: '/opt/hr/harkroom-operator', connectors: ['svc'] },
    };
    const marks = ['harkroom-operator merge', '`permission.request`', 'harkroom-operator api', 'Opened by `@forge`'];
    const full = buildSystemPrompt({ ...base, ...grants });
    for (const m of marks) expect(full, m).toContain(m);
    const ro = buildSystemPrompt({ ...base, ...grants, readOnly: true });
    for (const m of marks) expect(ro, m).not.toContain(m);
    expect(ro).toContain('셸 명령(머지·PR 열기·권한 요청 포함)은 이 턴에 없으니');
  });
});
