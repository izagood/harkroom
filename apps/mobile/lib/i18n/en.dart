import 'strings.dart';

/// **원본.** 다른 언어는 이 파일을 보고 채운다(계획서 §7-2).
class StringsEn implements Strings {
  const StringsEn();

  @override
  String get localeCode => 'en';

  @override
  String get appName => 'Harkroom';

  @override
  String get connectTitle => 'Connect to a workspace';

  @override
  String get connectServerUrlLabel => 'Server address';

  @override
  String get connectServerUrlHint => 'https://example.com';

  @override
  String get connectContinue => 'Continue';

  @override
  String get connectErrorEmpty => 'Enter the server address.';

  @override
  String get connectErrorMalformed => 'That does not look like a server address.';

  // ATS 가 돌려주는 것은 사유 없는 "연결 실패" 뿐이다 — 그래서 무엇이 문제이고
  // 무엇으로 바꿔야 하는지를 **둘 다** 말한다.
  @override
  String get connectErrorInsecure =>
      'iOS blocks plain http:// connections. Use an https:// address.';

  @override
  String get commonLoading => 'Loading…';

  @override
  String get commonBack => 'Back';

  @override
  String get commonRetry => 'Try again';

  @override
  String get loginTitle => 'Sign in';

  @override
  String get loginIdLabel => 'Login ID';

  @override
  String get loginPasswordLabel => 'Password';

  @override
  String get loginSubmit => 'Sign in';

  @override
  String get loginErrorRejected => 'That login ID or password is not right.';

  @override
  String get loginErrorUnreachable => 'Could not reach the server. Check the address and your connection.';

  @override
  String get signOut => 'Sign out';

  @override
  String get channelsTitle => 'Channels';

  @override
  String get channelsEmpty => 'You are not in any channel yet.';

  @override
  String get messagesEmpty => 'No messages yet.';

  @override
  String get composerHint => 'Message, or @mention an agent';

  @override
  String get composerSend => 'Send';

  @override
  String get connectionOnline => 'Connected';

  @override
  String get connectionConnecting => 'Connecting…';

  @override
  String get connectionReconnecting => 'Reconnecting…';

  @override
  String get connectionDead => 'Disconnected — sign in again';

  @override
  String get noticeSessionNotSaved => 'Could not save your session to the keychain. You can keep using the app now, but you will need to sign in again next time you open it.';

  @override
  String get agentBadge => 'agent';

  @override
  String get askAnswered => 'Answered';

  @override
  String get askClosed => 'Declined';

  @override
  String get askDecline => 'Not now';

  @override
  String get askToYou => 'Waiting on you';

  @override
  String get askToAnyone => 'Waiting on someone';

  @override
  String get threadTitle => 'Thread';

  @override
  String get threadReplyHint => 'Reply in thread';

  @override
  String get threadRepliesZero => 'Reply';

  @override
  String get threadRepliesOne => '1 reply';

  @override
  String get threadRepliesMany => '{n} replies';

  @override
  String get mentionPickerEmpty => 'No match';

  @override
  String get tabChannels => 'Channels';

  @override
  String get tabInbox => 'Inbox';

  @override
  String get tabMe => 'You';

  @override
  String get inboxEmpty => 'Nothing here yet.';

  @override
  String get inboxMarkAllRead => 'Mark all read';

  @override
  String get inboxReasonMention => 'Mentioned you';

  @override
  String get inboxReasonThreadReply => 'Replied in your thread';

  @override
  String get inboxReasonDm => 'Direct message';

  @override
  String get inboxReasonAskAnswered => 'Answered your question';

  @override
  String get inboxReasonAskClosed => 'Declined your question';

  @override
  String get inboxReasonOther => 'Called you';

  @override
  String get meSignedInAs => 'Signed in as @{handle}';

  @override
  String get attachmentOpen => 'Open';

  @override
  String get attachmentFailed => 'Could not load this file.';

  @override
  String get timeUnderMinute => 'under a minute';

  @override
  String get timeMinutes => '{n}m';

  @override
  String get timeHours => '{n}h';

  @override
  String get timeDays => '{n}d';

  @override
  String get timeRunning => 'running {duration}';

  @override
  String get timeTook => 'took {duration}';

  @override
  String get timeAgo => '{duration} ago';

  @override
  String get timeJustNow => 'just now';

  @override
  String get timeIn => 'in {duration}';

  @override
  String get timeSoon => 'soon';

  @override
  String get agentWorking => 'Working';

  @override
  String get agentWaiting => 'Waiting';

  @override
  String get reportTitle => 'Done';

  @override
  String get reportChecks => 'Checked';

  @override
  String get reportFiles => 'Changed';

  @override
  String get reportRemaining => 'Still open';

  @override
  String get reportNext => 'Next';

  @override
  String get failureTitle => 'Failed';

  @override
  String get failureRetryable => 'Can be retried';

  @override
  String get failureNeedsHand => 'Needs a hand';

  @override
  String get attachmentAdd => 'Attach a file';

  @override
  String get attachmentUploadFailed => 'Could not upload that file.';
}
