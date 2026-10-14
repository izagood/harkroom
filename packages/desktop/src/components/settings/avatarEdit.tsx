import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AvatarCrop } from '@harkroom/shared';
import { avatarErrorMessage } from '../../lib/avatar';
import type { AvatarSave } from '../../lib/avatarCrop';
import { getController } from '../../state/controller';
import { useT } from '../../i18n/useT';
import { AvatarCropDialog } from './AvatarCropDialog';

/**
 * 사진 바꾸기의 **상태 하나**다(#159 · Task 15-4 후속).
 *
 * 전에는 `busy` 불리언뿐이었다. 그래서 사진을 고른 뒤 화면에 생기는 변화가 **버튼이
 * 흐려지는 것 하나**였고, 큰 파일에서는 그것마저 눈에 안 띄어 사람이 "안 먹었다"로
 * 읽었다(실제로는 가는 중이었다). 반대편도 같았다 — 지우기는 확인 한 번 없이 즉시
 * 지우고, 지운 뒤에도 아무 말이 없어 눌린 것인지 알 수 없었다.
 *
 * 그래서 단계를 이름으로 가진다. 화면은 이 이름을 그리기만 하고 스스로 판단하지 않는다.
 */
export type AvatarPhase =
  | { kind: 'idle' }
  /** 바이트가 가는 중. `fraction` 은 0~1 — 서버가 total 을 안 주면 `null` 이다. */
  | { kind: 'uploading'; fraction: number | null }
  /** 바이트는 다 갔고 계정에 잇는 중이다(PUT). 여기서 막대는 꽉 찬 상태로 기다린다. */
  | { kind: 'applying' }
  | { kind: 'removing' }
  | { kind: 'done'; removed: boolean }
  | { kind: 'error'; message: string };

/** 끝난 말이 남는 시간. 짧으면 못 보고, 길면 다음 조작 옆에 낡은 말이 붙어 있다. */
const DONE_MS = 3000;

/**
 * 열려 있는 「사진 맞추기」. `src` 는 이 훅이 만든 objectURL 이라 닫을 때 이 훅이 치운다.
 * `source` 는 저장할 때 원본으로 가리킬 것 — 새로 고른 파일이거나 이미 걸린 첨부다.
 */
export type CropSession = {
  src: string;
  isGif: boolean;
  initialCrop: AvatarCrop | null;
  source: AvatarSave['source'];
};

/** 올릴 것: 맞추기를 거친 저장(`AvatarSave`) 또는 맞추기 없이 고른 파일(`File`, 워크스페이스 아이콘). */
export type AvatarEditInput = AvatarSave | File;

export type AvatarEdit = {
  phase: AvatarPhase;
  /** 열려 있는 맞추기 창. 없으면 null. */
  crop: CropSession | null;
  /** 걸린 사진을 다시 맞추려고 원본을 받는 중인가. */
  opening: boolean;
  /** 걸린 사진을 다시 맞춘다 — 원본과 지난 자리로 연다(원본이 없는 옛 사진은 걸린 그림으로). */
  openAdjust(): void;
  cancelCrop(): void;
  saveCrop(result: { blob: Blob; crop: AvatarCrop }): void;
  /** 조작 중인가 — 버튼을 잠그는 자리. */
  busy: boolean;
  /** 지우기 확인을 묻는 중인가. */
  confirmingRemove: boolean;
  pickRef: React.RefObject<HTMLInputElement | null>;
  openPicker(): void;
  onPicked(e: React.ChangeEvent<HTMLInputElement>): void;
  askRemove(): void;
  cancelRemove(): void;
  confirmRemove(): void;
};

/**
 * `apply` 는 이 화면이 아는 쓰기 경로다(사람은 `setAvatar`, 에이전트는 `setAgentAvatar`).
 * 두 화면이 같은 단계를 각자 세면 한쪽만 고치는 날이 오므로 상태는 여기 한 벌만 둔다.
 *
 * 실패 문장은 **받지 않는다** — `lib/avatar.ts` 의 `avatarErrorMessage` 하나가 원인별로
 * 낸다. 화면마다 문장을 넘기던 동안은 무엇이 실패했든 "이미지 파일만 쓸 수 있습니다" 였고,
 * 서버가 죽어 있어도 사람이 자기 파일을 의심했다. 받아 주는 형식이 늘 때 고칠 자리도 하나다.
 */
export function useAvatarEdit(
  apply: (input: AvatarEditInput | null, onProgress?: (fraction: number) => void) => Promise<void>,
  /**
   * 다시 맞출 대상 — 원본을 받을 계정과 지금 걸린 아바타(원본이 없을 때 원본으로 쓴다).
   * **null 이면 맞추기 없이** 고른 파일을 그대로 올린다(`File`) — 둥글게 자르지 않는 워크스페이스 아이콘.
   */
  target: { accountId: string | null | undefined; avatarAttachmentId: string | null | undefined } | null,
): AvatarEdit {
  const t = useT();
  const [phase, setPhase] = useState<AvatarPhase>({ kind: 'idle' });
  const pickRef = useRef<HTMLInputElement | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [crop, setCrop] = useState<CropSession | null>(null);
  const [opening, setOpening] = useState(false);
  /** 지금 열린 objectURL — 바꾸거나 닫을 때, 언마운트 때 치운다. */
  const cropUrl = useRef<string | null>(null);
  const openCrop = useCallback((next: CropSession | null) => {
    if (cropUrl.current) URL.revokeObjectURL(cropUrl.current);
    cropUrl.current = next?.src ?? null;
    setCrop(next);
  }, []);
  /** 끝난 말을 내리는 타이머. 언마운트 후에 setState 하면 경고가 난다. */
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => () => {
    alive.current = false;
    if (clearTimer.current) clearTimeout(clearTimer.current);
    if (cropUrl.current) URL.revokeObjectURL(cropUrl.current);
  }, []);

  const settle = useCallback((next: AvatarPhase) => {
    if (!alive.current) return;
    setPhase(next);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    // 오류는 스스로 내려가지 않는다 — 읽히지 않은 실패는 없던 일이 된다.
    if (next.kind !== 'done') return;
    clearTimer.current = setTimeout(() => {
      if (alive.current) setPhase({ kind: 'idle' });
    }, DONE_MS);
  }, []);

  const run = useCallback(async (file: AvatarEditInput | null) => {
    setConfirmingRemove(false);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setPhase(file ? { kind: 'uploading', fraction: null } : { kind: 'removing' });
    try {
      await apply(file, file
        ? (fraction) => {
          if (!alive.current) return;
          // 1 에 닿으면 **막대를 멈추고 문구를 바꾼다** — 바이트는 갔고 서버가 저장하는
          // 중이다. 100% 인데 아직 안 끝난 상태를 말로 설명하지 않으면 멈춘 것으로 보인다.
          setPhase(fraction >= 1 ? { kind: 'applying' } : { kind: 'uploading', fraction });
        }
        : undefined);
      settle({ kind: 'done', removed: file === null });
    } catch (e) {
      // 원인을 그대로 문장으로 옮긴다 — 확장자를 믿지 않는 서버 거절(`not_an_image`)과
      // 네트워크 끊김은 사람이 해야 할 다음 행동이 다르다.
      settle({ kind: 'error', message: avatarErrorMessage(e, t) });
    } finally {
      // 같은 파일을 다시 고를 수 있게 비운다 — 안 비우면 change 가 안 난다.
      if (pickRef.current) pickRef.current.value = '';
    }
  }, [apply, settle, t]);

  const accountId = target?.accountId;
  const avatarAttachmentId = target?.avatarAttachmentId;
  const cropping = target !== null;
  const openAdjust = useCallback(async () => {
    if (!accountId || !avatarAttachmentId || opening) return;
    setConfirmingRemove(false);
    setOpening(true);
    try {
      // 원본이 있으면 원본과 지난 자리로, 없으면(이번 변경 전에 건 사진·옛 서버) 걸린 그림을 원본으로 연다 —
      // 그때는 확대만 의미가 있다(designer 시안 「흐름」 표).
      const original = await getController().fetchAvatarSource(accountId);
      const blob = original?.blob ?? await getController().fetchAvatar(accountId);
      if (!alive.current) return;
      openCrop({
        src: URL.createObjectURL(blob),
        isGif: blob.type === 'image/gif',
        initialCrop: original?.meta.crop ?? null,
        source: { kind: 'attached', attachmentId: original?.meta.attachmentId ?? avatarAttachmentId },
      });
    } catch (e) {
      settle({ kind: 'error', message: avatarErrorMessage(e, t) });
    } finally {
      if (alive.current) setOpening(false);
    }
  }, [accountId, avatarAttachmentId, opening, openCrop, settle, t]);

  const busy = phase.kind === 'uploading' || phase.kind === 'applying' || phase.kind === 'removing';

  return {
    phase,
    busy: busy || opening,
    confirmingRemove,
    pickRef,
    openPicker: () => pickRef.current?.click(),
    // 고르면 **올리지 않고** 맞추기 창을 연다 — 저장을 눌러야 올라간다(designer 시안 A).
    onPicked: (e) => {
      const f = e.target.files?.[0];
      // 같은 파일을 다시 고를 수 있게 비운다 — 안 비우면 change 가 안 난다.
      e.target.value = '';
      if (!f) return;
      if (!cropping) { void run(f); return; }
      openCrop({ src: URL.createObjectURL(f), isGif: f.type === 'image/gif', initialCrop: null, source: { kind: 'file', file: f } });
    },
    crop,
    opening,
    openAdjust: () => { void openAdjust(); },
    cancelCrop: () => openCrop(null),
    saveCrop: ({ blob, crop: c }) => {
      const session = crop;
      openCrop(null);
      if (session) void run({ cropped: blob, crop: c, source: session.source });
    },
    askRemove: () => setConfirmingRemove(true),
    cancelRemove: () => setConfirmingRemove(false),
    confirmRemove: () => { void run(null); },
  };
}

/**
 * 단계를 **한 줄로** 그린다. 막대는 진행 중일 때만 있고, 끝나면 문장 하나만 남는다 —
 * 다 찬 막대를 남겨 두면 다음 조작 옆에서 "지금 올리는 중"으로 읽힌다.
 *
 * 눈에 보이게 낸다. `sr-only` 로만 두면 스크린리더가 아닌 사람에게는 **아무 일도 일어나지
 * 않은 것**과 구분되지 않는다 — 그것이 이 고침의 출발점이었다.
 */
export function AvatarStatus({ phase }: { phase: AvatarPhase }) {
  const t = useT();
  if (phase.kind === 'idle') return null;

  if (phase.kind === 'error') {
    return <p role="alert" data-testid="avatar-error" className="mt-1 text-meta text-danger">{phase.message}</p>;
  }

  if (phase.kind === 'done') {
    return (
      <p
        role="status"
        data-testid="avatar-done"
        className="mt-1 text-meta text-fg-muted"
      >
        {t(phase.removed ? 'avatarEdit.result.removed' : 'avatarEdit.result.changed')}
      </p>
    );
  }

  // 지우기는 올릴 바이트가 없다 — 막대 대신 말만 둔다. 있지도 않은 진행을 그리지 않는다.
  if (phase.kind === 'removing') {
    return <p role="status" data-testid="avatar-removing" className="mt-1 text-meta text-fg-muted">{t('avatarEdit.progress.removing')}</p>;
  }

  const pct = phase.kind === 'applying' ? 100 : Math.round((phase.fraction ?? 0) * 100);
  /** total 을 모르면 비율을 못 쓴다 — 그때는 막대를 채우지 않고 문구로만 알린다. */
  const unknown = phase.kind === 'uploading' && phase.fraction === null;

  return (
    <div className="mt-1 flex items-center gap-2" data-testid="avatar-uploading">
      <div
        role="progressbar"
        data-testid="avatar-progress"
        aria-label={t('avatarEdit.progress.aria')}
        aria-valuemin={0}
        aria-valuemax={100}
        // 비율을 모르는 구간에서는 valuenow 를 비운다(불확정) — 0 으로 두면 스크린리더가
        // "0%" 라고 읽고, 그건 모른다는 것과 다른 말이다.
        aria-valuenow={unknown ? undefined : pct}
        className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-150 ${unknown ? 'animate-pulse' : ''}`}
          style={{ width: unknown ? '15%' : `${pct}%` }}
        />
      </div>
      <span className="text-meta text-fg-muted">
        {phase.kind === 'applying' ? t('avatarEdit.progress.applying')
          : unknown ? t('avatarEdit.progress.uploading')
            : t('avatarEdit.progress.uploadingPct', { pct })}
      </span>
    </div>
  );
}

/**
 * 맞추기 창을 띄우는 자리. 두 화면(내 프로필·에이전트)이 같은 창을 같은 규칙으로 띄운다.
 * 「다른 사진…」은 같은 파일 고르개를 다시 연다 — 고르면 `onPicked` 가 창의 사진을 바꾼다.
 */
export function AvatarCropHost({ edit, name }: { edit: AvatarEdit; name: string }) {
  if (!edit.crop) return null;
  return (
    <AvatarCropDialog
      key={edit.crop.src}
      src={edit.crop.src}
      isGif={edit.crop.isGif}
      initialCrop={edit.crop.initialCrop}
      name={name}
      onCancel={edit.cancelCrop}
      onSave={edit.saveCrop}
      onPickOther={edit.openPicker}
    />
  );
}

/**
 * 걸린 아바타를 누르면 맞추기 창이 열린다(hover·포커스에 「맞추기」). 사진이 없으면 그냥 그림이다 —
 * 맞출 것이 없는데 눌리는 척하면 안 된다. 누를 곳을 둘(아바타·Adjust 버튼)로 두는 것은 시안 규칙이다:
 * 하나뿐이면 발견되지 않는다.
 */
export function AvatarAdjustTrigger({ edit, enabled, children, testId }: {
  edit: AvatarEdit; enabled: boolean; children: ReactNode; testId: string;
}) {
  const t = useT();
  if (!enabled) return <>{children}</>;
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={t('avatarCrop.title')}
      disabled={edit.busy}
      onClick={edit.openAdjust}
      className="group relative shrink-0 rounded-[27.78%] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
    >
      {children}
      <span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center rounded-[27.78%] bg-black/45 text-meta font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:opacity-0"
      >
        {t('avatarCrop.adjust')}
      </span>
    </button>
  );
}
