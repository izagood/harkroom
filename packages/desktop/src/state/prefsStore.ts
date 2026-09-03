import { create } from 'zustand';
import { DEFAULT_PREFS, prefsStorage, type NotificationPrefs, type Prefs } from '../lib/prefs';
import { validateRunnerCommand } from '../lib/runnerLauncher';

export interface PrefsState extends Prefs {
  setNotifications(patch: Partial<NotificationPrefs>): void;
  setRunnerAutoStart(enabled: boolean): void;
  setRunnerRepoPath(path: string): void;
  /**
   * `pnpm` 절대 경로를 저장한다(#305). **검증을 통과한 값만 저장하고**, 통과하지 못하면
   * 사유를 돌려주고 저장하지 않는다 — 저장해 두고 기동 때 거절하면 사람은 설정 화면에서
   * 아무 문제도 못 보고 러너만 안 뜬다.
   */
  setRunnerCommand(command: string): string | null;
}

// useAppStore 와 반드시 별개다 — appStore.reset() 은 로그아웃 때 도메인 데이터를 비우는데,
// 설정은 로그아웃해도 남아야 한다.
export const usePrefsStore = create<PrefsState>((set, get) => {
  /**
   * 저장할 `Prefs` 를 만든다. **필드를 손으로 나열하지 않는다**(#250).
   *
   * 원래 각 setter 가 `{ notifications, sidebarWidth, ... }` 를 통째로 다시 적었고, 설정을
   * 하나 더할 때마다 setter 마다 한 줄씩 더해야 했다 — 한 곳을 빼먹으면 그 setter 를 부른
   * 순간 **다른 설정이 조용히 기본값으로 되돌아간다**. 컴파일러도 잡지 못한다(빠진 필드가
   * 아니라 남은 필드가 문제여서 타입은 여전히 맞는다). 저장 대상 키만 `DEFAULT_PREFS` 에서
   * 뽑아 스토어의 현재 값으로 채운다.
   */
  const snapshot = (patch: Partial<Prefs>): Prefs => {
    const current = get();
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
      next[key] = current[key];
    }
    return { ...(next as unknown as Prefs), ...patch };
  };

  const update = (patch: Partial<Prefs>): void => {
    const next = snapshot(patch);
    prefsStorage.save(next);
    set(next);
  };

  return {
    ...prefsStorage.load(),
    setNotifications: (patch) => update({ notifications: { ...get().notifications, ...patch } }),
    setRunnerAutoStart: (enabled) => update({ runnerAutoStart: enabled }),
    setRunnerRepoPath: (path) => update({ runnerRepoPath: path }),
    setRunnerCommand: (command) => {
      const error = validateRunnerCommand(command);
      if (error) return error;
      update({ runnerCommand: command.trim() });
      return null;
    },
  };
});
