import type { ReactNode } from 'react';

/**
 * 제공업체 계정 화면의 **하네스 한 칸**(2026-09-28). 칸마다 제목·"선택 사항" 안내·본문이고,
 * 칸 사이는 구분선이다. `SettingsGroup`(행을 담는 카드)과 따로 둔 이유: 이 칸 안에는 행 카드가
 * 여럿 들어간다(시스템 기본값·계정들·빈 칸 안내) — 카드 안의 카드가 되면 테두리가 겹친다.
 *
 * 아이콘은 **상표 로고가 아니라 글리프**다. 로고를 앱에 싣는 것은 이 화면이 할 결정이 아니다.
 */
const GLYPH = { claude: '✳', codex: '◎', opencode: '▣', cursor: '◇' } as const;

export function ProviderSection({ icon, title, description, testId, children }: {
  icon: keyof typeof GLYPH;
  title: string;
  description: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border py-8 first:pt-0 last:border-b-0" data-testid={testId}>
      <h3 className="flex items-center gap-2 text-body font-semibold text-fg">
        <span aria-hidden className="text-fg-muted">{GLYPH[icon]}</span>
        {title}
      </h3>
      <p className="mt-1 mb-5 text-fg-subtle">{description}</p>
      {children}
    </section>
  );
}
