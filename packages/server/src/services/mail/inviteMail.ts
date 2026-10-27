import type { MailMessage } from './mailer.js';

export type InviteMailLocale = 'ko' | 'en';

/**
 * 초대 메일 본문. 토큰은 안내 링크의 **`#` 뒤**에 싣는다 — 조각(fragment)은 브라우저가 서버로 보내지 않으므로
 * 서버·프록시 접근 로그에 남지 않고, 메일 보안 스캐너가 링크를 미리 열어도 토큰이 쓰이지 않는다(안내 페이지는
 * 가입하지 않고 보여 주기만 한다). 링크가 안 열리는 사람을 위해 서버 주소·토큰을 글로도 적는다.
 */
export function inviteMail(input: {
  to: string; token: string; publicUrl: string; inviterHandle: string; expiresAt: Date; locale: InviteMailLocale;
}): MailMessage {
  const link = `${input.publicUrl}/join#${input.token}`;
  const until = input.expiresAt.toISOString().slice(0, 10);
  if (input.locale === 'ko') {
    return {
      to: input.to,
      subject: 'Harkroom 워크스페이스 초대',
      text: [
        `@${input.inviterHandle} 님이 Harkroom 워크스페이스에 초대했습니다.`,
        '',
        `가입 안내: ${link}`,
        '',
        '링크가 열리지 않으면 Harkroom 앱의 「가입」 화면에 아래 두 값을 넣으세요.',
        `서버 주소: ${input.publicUrl}`,
        `초대 토큰: ${input.token}`,
        '',
        `이 초대는 ${until}(UTC)까지 한 번만 쓸 수 있습니다.`,
        '초대받을 일이 없다면 이 메일을 무시하세요.',
      ].join('\n'),
    };
  }
  return {
    to: input.to,
    subject: 'You are invited to a Harkroom workspace',
    text: [
      `@${input.inviterHandle} invited you to a Harkroom workspace.`,
      '',
      `Join: ${link}`,
      '',
      'If the link does not open, enter these two values on the Sign up screen of the Harkroom app.',
      `Server address: ${input.publicUrl}`,
      `Invite token: ${input.token}`,
      '',
      `This invite can be used once, until ${until} (UTC).`,
      'If you were not expecting this, you can ignore this email.',
    ].join('\n'),
  };
}
