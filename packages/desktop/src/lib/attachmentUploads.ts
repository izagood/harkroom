import type { AttachmentRow } from '@harkroom/shared';
import { getActiveStore, getActiveController, type AppStore } from '../state/communities';
import type { Controller } from '../state/controller';
import type { PendingUpload } from '../state/appStore';

/**
 * 작성창 첨부 업로드 — **작성창을 기다리게 하지 않는다.**
 *
 * 고른 순간 칩이 서고(올리는 중), 업로드는 뒤에서 돈다. 전송은 업로드를 기다리지 않고
 * 작성창을 비운다 — 그 글이 자기 첨부를 기다렸다가 나간다(`waitForUploads`). 상태는
 * 커뮤니티 스토어의 `uploads` 에 자리별로 있고, 이 모듈은 그 상태를 움직이는 길 하나다.
 * 📎·붙여넣기·끌어 놓기·"파일로 옮기기" 가 모두 이 길을 지난다.
 *
 * **시작한 커뮤니티의 스토어·컨트롤러를 붙잡는다.** 올리는 동안 커뮤니티를 옮기면 활성
 * 쪽은 이미 남이다 — 결과를 거기에 적으면 남의 작성창에 칩이 선다.
 */

/** 한꺼번에 올리는 수. 스크린샷 열 장을 붙여도 연결 여섯 개를 다 잡아 메시지·WS 를 굶기지 않는다. */
export const MAX_PARALLEL_UPLOADS = 3;

export class UploadFailedError extends Error {
  constructor(readonly filename: string) {
    super(`upload failed: ${filename}`);
  }
}

interface Track {
  store: AppStore;
  controller: Controller;
  /** 마지막 시도의 결과. 다시 올리면 갈아 끼운다. */
  promise: Promise<AttachmentRow>;
  abort: AbortController;
  file: File;
}

const tracks = new Map<string, Track>();

/**
 * 고른 파일의 미리보기 objectURL. **파일 하나에 하나**다 — 칩이 올리는 중(흐림)에서 다 올라감
 * (서버 바이트 자리 지킴)으로 바뀌며 부품이 갈려도 같은 URL 을 써야 그 사이에 📎 가 끼지 않는다.
 * 해제는 첨부가 작성창에서 사라질 때 한 번(`discardUploads`·로그아웃) 한다.
 */
const previewUrls = new WeakMap<File, string>();

export function previewUrlFor(file: File): string | null {
  if (typeof URL.createObjectURL !== 'function') return null;
  let url = previewUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    previewUrls.set(file, url);
  }
  return url;
}

function releasePreviewUrl(file: File | undefined): void {
  if (!file) return;
  const url = previewUrls.get(file);
  if (!url) return;
  previewUrls.delete(file);
  URL.revokeObjectURL(url);
}

/**
 * 스토어에서 첨부가 사라지면(로그아웃 `reset`) 그 업로드를 끊는다. 안 끊으면 끝난 세션의
 * XHR 이 끝까지 돌고, 동시 업로드 자리도 그만큼 잡힌다. 스토어마다 한 번만 건다.
 */
const watched = new WeakSet<AppStore>();
function watch(store: AppStore): void {
  if (watched.has(store)) return;
  watched.add(store);
  store.subscribe((state) => {
    for (const [id, track] of tracks) {
      if (track.store !== store || id in state.uploads) continue;
      tracks.delete(id);
      track.abort.abort();
      releasePreviewUrl(track.file);
    }
  });
}
let seq = 0;
let running = 0;
const queue: (() => void)[] = [];

const slot = (): Promise<void> => new Promise((resolve) => {
  if (running < MAX_PARALLEL_UPLOADS) { running += 1; resolve(); return; }
  queue.push(() => { running += 1; resolve(); });
});
const release = () => {
  running -= 1;
  queue.shift()?.();
};

function run(localId: string, store: AppStore, controller: Controller, file: File, abort: AbortController): Promise<AttachmentRow> {
  const p = (async () => {
    await slot();
    try {
      // 줄을 서는 사이에 사람이 칩을 뗐으면 올리지 않는다.
      if (abort.signal.aborted || !store.getState().uploads[localId]) throw new UploadFailedError(file.name);
      const row = await controller.upload(file, (fraction) => {
        store.getState().patchUpload(localId, { fraction });
      }, abort.signal);
      store.getState().patchUpload(localId, { status: 'done', fraction: 1, row });
      return row;
    } catch {
      store.getState().patchUpload(localId, { status: 'failed', fraction: null });
      throw new UploadFailedError(file.name);
    } finally {
      release();
    }
  })();
  // 기다리는 쪽이 없을 때(칩만 떠 있을 때)의 실패는 칩이 말한다 — 처리 안 된 거부로 새지 않게.
  p.catch(() => {});
  return p;
}

/** 파일들을 그 자리에 붙이고 올리기 시작한다. 만든 `localId` 들을 돌려준다. */
export function startUploads(scope: string, files: File[]): string[] {
  if (!files.length) return [];
  const store = getActiveStore();
  const controller = getActiveController();
  watch(store);
  return files.map((file) => {
    seq += 1;
    const localId = `up-${Date.now().toString(36)}-${seq}`;
    const item: PendingUpload = { localId, scope, file, status: 'uploading', fraction: null, row: null };
    store.getState().patchUpload(localId, item);
    const abort = new AbortController();
    tracks.set(localId, { store, controller, abort, file, promise: run(localId, store, controller, file, abort) });
    return localId;
  });
}

/** 실패한 것을 다시 올린다. */
export function retryUpload(localId: string): void {
  const track = tracks.get(localId);
  const item = track?.store.getState().uploads[localId];
  if (!track || !item || item.status !== 'failed') return;
  track.store.getState().patchUpload(localId, { status: 'uploading', fraction: null });
  track.abort = new AbortController();
  track.promise = run(localId, track.store, track.controller, item.file, track.abort);
}

/**
 * 첨부를 뗀다(칩의 ×, 보낸 뒤 정리). 올리는 중이면 끊는다 — 이미 다 간 바이트는 서버에
 * 어디에도 안 붙은 업로드로 남는데, 다 올라간 칩을 뗄 때와 같은 처지다.
 */
export function discardUploads(localIds: string[]): void {
  for (const id of localIds) {
    const track = tracks.get(id);
    tracks.delete(id);
    track?.abort.abort();
    releasePreviewUrl(track?.file);
    (track?.store ?? getActiveStore()).getState().patchUpload(id, null);
  }
}

/** 전송이 가져간다 — 작성창에서 칩이 빠지되 업로드는 계속된다. 넣은 순서를 지킨다. */
export function takeUploads(scope: string): string[] {
  const store = getActiveStore();
  const ids = Object.values(store.getState().uploads).filter((u) => u.scope === scope).map((u) => u.localId);
  for (const id of ids) store.getState().patchUpload(id, { scope: null });
  return ids;
}

/** 되돌린다(보냄 취소·전송 실패) — **쓴 자리로** 돌려놓는다. 이미 뗀 것은 건너뛴다. */
export function returnUploads(scope: string, localIds: string[]): void {
  for (const id of localIds) {
    const track = tracks.get(id);
    track?.store.getState().patchUpload(id, { scope });
  }
}

/** 전부 올라가기를 기다린다. 하나라도 실패하면 `UploadFailedError` 로 거부한다. */
export function waitForUploads(localIds: string[]): Promise<AttachmentRow[]> {
  return Promise.all(localIds.map((id) => {
    const track = tracks.get(id);
    return track ? track.promise : Promise.reject(new UploadFailedError(id));
  }));
}

/**
 * 첨부들의 진행률(0~100, 바이트로 잰다). 대기 줄이 쓴다 — 개수로 세면 큰 그림 한 장은 끝날
 * 때까지 `0/1` 이다. 길이를 모르는 것이 하나라도 있으면 `null`(가짜 비율을 그리지 않는다).
 */
export function uploadPercent(uploads: Record<string, PendingUpload>, localIds: string[]): number | null {
  let total = 0;
  let sent = 0;
  for (const id of localIds) {
    const u = uploads[id];
    if (!u) continue;
    const size = Math.max(1, u.file.size);
    const fraction = u.status === 'done' ? 1 : u.fraction;
    if (fraction === null) return null;
    total += size;
    sent += size * fraction;
  }
  if (!total) return null;
  // 다 가기 전에는 100 을 보이지 않는다 — 서버가 저장하는 동안 `100%` 에 멈춘 줄은 끝난 것처럼 읽힌다.
  return Math.min(99, Math.floor((sent / total) * 100));
}
