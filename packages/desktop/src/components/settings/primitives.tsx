import type { ReactNode } from 'react';

/** 섹션 한 장의 껍데기 — 제목·설명·본문. 섹션마다 다시 만들면 여백이 어긋난다. */
export function SettingsPage({ title, description, children }: {
  title: string; description?: string; children: ReactNode;
}) {
  return (
    <div className="max-w-3xl px-10 py-10">
      <h2 className="text-2xl font-bold text-fg">{title}</h2>
      <p className="mt-1 mb-8 text-fg-subtle">{description ?? ''}</p>
      {children}
    </div>
  );
}

/** 카드 하나. 행 사이 구분선은 여기서만 긋는다. */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      {title && <h3 className="mb-2 text-[13px] font-semibold text-fg-subtle">{title}</h3>}
      <div className="divide-y divide-border rounded-xl border border-border bg-surface-raised">
        {children}
      </div>
    </section>
  );
}

/** 고칠 수 없는 값을 보여 주는 행. 서버에 변경 엔드포인트가 없는 항목이 여기 온다. */
export function ReadonlyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span className="font-medium text-fg">{label}</span>
      <span className="ml-auto min-w-0 truncate text-fg-muted">{value}</span>
    </div>
  );
}

/** 스위치 한 줄. role="switch" 를 단 checkbox 라 키보드·스크린리더 동작이 그대로 산다. */
export function Toggle({ label, description, checked, disabled, onChange }: {
  label: string; description?: string; checked: boolean; disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className={`flex items-start gap-4 px-4 py-3 ${disabled ? 'opacity-50' : ''}`}>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-fg-subtle">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-border
                   transition before:block before:h-4 before:w-4 before:translate-x-0.5
                   before:translate-y-0.5 before:rounded-full before:bg-white before:transition
                   checked:bg-accent checked:before:translate-x-4 disabled:cursor-default"
      />
    </label>
  );
}
