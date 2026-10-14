import { fireEvent, screen, within } from '@testing-library/react';

/**
 * 사진을 고르고 「사진 맞추기」 창에서 저장까지 누른다. 고르기만으로는 올라가지 않는다(designer 시안 A).
 * jsdom 은 그림을 풀지 않으므로 창의 재는 그림에 load 를 직접 쏜다(크기 0 → 512 정사각형으로 본다).
 * 잘라 내는 `renderCrop` 은 캔버스가 없어 부르는 시험이 목으로 바꿔 둔다.
 */
export async function pickAndSave(testId: string, file: File): Promise<void> {
  fireEvent.change(await screen.findByTestId(testId), { target: { files: [file] } });
  const dialog = await screen.findByTestId('avatar-crop');
  const probe = dialog.querySelector('img.hidden');
  if (!probe) throw new Error('crop dialog probe image missing');
  fireEvent.load(probe);
  fireEvent.click(within(dialog).getByRole('button', { name: /^(저장|Save)$/ }));
}
