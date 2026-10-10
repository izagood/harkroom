import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { SettingsGrid } from '../src/components/settings/primitives';

// 설정 폭 PR 3 — 목록 화면 7개는 `layout` 으로 넓히고 줄을 격자·칸으로 나눈다(시안 v1 list).
const SRC = join(__dirname, '../src/components/settings');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('SettingsGrid', () => {
  it('칸 수 클래스를 통째 문자열로 싣는다(조각으로 이으면 Tailwind 가 CSS 를 안 만든다)', () => {
    render(<SettingsGrid as="ul" testId="g"><li>a</li></SettingsGrid>);
    const g = screen.getByTestId('g');
    expect(g.tagName).toBe('UL');
    expect(g.className).toContain('@min-[1100px]/settings:grid-cols-2');
    expect(g.className).toContain('@min-[1700px]/settings:grid-cols-3');
    expect(g.className).toContain('items-start');
  });
});

describe('목록 화면 7개가 넓은 꼴을 쓴다', () => {
  it.each([
    ['InviteSettings.tsx', 'list', 'members-columns'],
    ['OperatorsSettings.tsx', 'list', 'operators-grid'],
    ['SkillsSettings.tsx', 'list', 'skills-grid-'],
    ['AutomationsSettings.tsx', 'list', 'automations-grid'],
    ['SecretsSettings.tsx', 'list', 'secrets-list'],
    ['CommunitySettings.tsx', 'cards', 'communities-columns'],
    ['WorkspaceCleanupSettings.tsx', 'list', 'cleanup-columns'],
  ])('%s', (file, layout, testId) => {
    const s = read(file);
    expect(s).toContain(`layout="${layout}"`);
    expect(s).toContain(testId);
  });

  it('머지 grant 는 표다', () => {
    const s = read('AgentGrantsSection.tsx');
    expect(s).toMatch(/<table[^>]*data-testid="agent-grants-list"/);
  });
});
