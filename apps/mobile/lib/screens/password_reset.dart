import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/api_error.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../time.dart';
import '../ui/parts.dart';

/// 비밀번호 재설정 코드 — 모바일(스레드 a6017542, 서버 #1409, designer 시안 M1~M3·R1~R8).
///
/// - M1 로그인 화면의 「비밀번호를 잊었다면」 → [showForgotPasswordSheet] 바텀시트(서버 호출 없음, R2)
/// - M3 [ResetPasswordScreen] — 로그인 ID·코드·새 비밀번호를 한 화면에서. 성공하면 곧바로 들어간다(R5).
/// - R7 [PasswordResetNoticeBand] — 내 계정에 발급된 코드를 **전부** 보이고, [확인] 은 보인 id 만 내린다.
///
/// 관리자 발급 창은 데스크톱(#1410)에만 있다 — 모바일 범위는 잊은 사람 쪽과 알림이다.

/// 사람이 친 코드를 4-4-4 로 묶는다. 서버는 하이픈·대소문자를 무시한다(입력 칸 표시용).
String groupResetCode(String raw) {
  final s = raw.replaceAll(RegExp(r'[\s-]'), '').toUpperCase();
  final cut = s.length > 12 ? s.substring(0, 12) : s;
  final b = StringBuffer();
  for (var i = 0; i < cut.length; i++) {
    if (i > 0 && i % 4 == 0) b.write('-');
    b.write(cut[i]);
  }
  return b.toString();
}

class _CodeFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final next = groupResetCode(newValue.text);
    return TextEditingValue(text: next, selection: TextSelection.collapsed(offset: next.length));
  }
}

/// ② 안내 바텀시트. 로그인 화면 맥락(서버 주소·입력한 ID)을 잃지 않으려고 시트로 띄운다(M2).
Future<void> showForgotPasswordSheet(BuildContext context, {required String loginId}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheet) {
      final t = sheet.t;
      return SafeArea(
        child: Padding(
          key: const Key('pwreset-guide'),
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(t.pwresetGuideTitle, style: Theme.of(sheet).textTheme.titleMedium),
              const SizedBox(height: 8),
              Text(t.pwresetGuideBody),
              const SizedBox(height: 8),
              Text(t.pwresetGuideStep1),
              Text(t.pwresetGuideStep2),
              const SizedBox(height: 8),
              Text(t.pwresetGuideNote, style: Theme.of(sheet).textTheme.bodySmall),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('pwreset-have-code'),
                onPressed: () {
                  // 시트는 **시트의 context 로** 닫는다 — 바깥 context 로 pop 하면 시트 대신 아래 화면이 빠진다(#1390).
                  Navigator.of(sheet).pop();
                  Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => ResetPasswordScreen(initialLoginId: loginId),
                  ));
                },
                child: Text(t.pwresetGuideHaveCode),
              ),
              TextButton(onPressed: () => Navigator.of(sheet).pop(), child: Text(t.pwresetGuideClose)),
              ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: Text(t.pwresetGuideNoAdminSummary, style: Theme.of(sheet).textTheme.bodySmall),
                children: [Text(t.pwresetGuideNoAdminBody, style: Theme.of(sheet).textTheme.bodySmall)],
              ),
            ],
          ),
        ),
      );
    },
  );
}

/// ③ 로그인 ID·코드·새 비밀번호. 실패 문구는 하나다(R1).
class ResetPasswordScreen extends StatefulWidget {
  const ResetPasswordScreen({super.key, required this.initialLoginId});

  final String initialLoginId;

  @override
  State<ResetPasswordScreen> createState() => _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends State<ResetPasswordScreen> {
  late final _loginId = TextEditingController(text: widget.initialLoginId);
  final _code = TextEditingController();
  final _pw = TextEditingController();
  final _pw2 = TextEditingController();
  final _pwFocus = FocusNode();
  bool _busy = false;
  bool _pwTouched = false;
  bool _tried = false;

  /// 실패 사유 — 문구가 아니라 키. 서버 400 은 모두 `invalid` 하나다.
  String? _errorKey;

  @override
  void initState() {
    super.initState();
    // 「8자 이상」은 칸을 떠난 뒤에만 말한다(designer #1410 n5).
    _pwFocus.addListener(() {
      if (!_pwFocus.hasFocus && _pw.text.isNotEmpty) setState(() => _pwTouched = true);
    });
    for (final c in [_loginId, _code, _pw, _pw2]) {
      c.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    for (final c in [_loginId, _code, _pw, _pw2]) {
      c.dispose();
    }
    _pwFocus.dispose();
    super.dispose();
  }

  bool get _short => _pw.text.isNotEmpty && _pw.text.length < 8;
  // 서버 규칙은 8~128자. 칸에 상한을 걸면 붙여 넣은 값이 말없이 잘린다 — 문구로만 막는다(security #1410 nit).
  bool get _long => _pw.text.length > 128;
  bool get _mismatch => _pw2.text.isNotEmpty && _pw.text != _pw2.text;
  bool get _blocked =>
      _busy ||
      _loginId.text.trim().isEmpty ||
      _code.text.replaceAll('-', '').length != 12 ||
      _pw.text.length < 8 ||
      _long ||
      _pw.text != _pw2.text;

  Future<void> _submit() async {
    setState(() => _tried = true);
    if (_blocked) return;
    setState(() {
      _busy = true;
      _errorKey = null;
    });
    try {
      await context.app.resetPasswordWithCode(_loginId.text.trim(), _code.text, _pw.text);
      if (!mounted) return;
      _pw.clear();
      _pw2.clear();
      // 들어갔다 — 이 화면을 걷어 앱 뿌리(홈)가 보이게 한다.
      Navigator.of(context).popUntil((r) => r.isFirst);
    } on ResetUnsupported {
      setState(() => _errorKey = 'unsupported');
    } on ApiError catch (e) {
      setState(() => _errorKey = e.status == 429 ? 'limited' : e.status == 400 ? 'invalid' : 'unreachable');
    } on NetworkError {
      setState(() => _errorKey = 'unreachable');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _message(Strings t, String key) => switch (key) {
        'invalid' => t.pwresetFormInvalid,
        'limited' => t.pwresetFormLimited,
        'unsupported' => t.pwresetFormUnsupported,
        _ => t.loginErrorUnreachable,
      };

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final err = Theme.of(context).colorScheme.error;
    final errorKey = _errorKey;
    return Scaffold(
      appBar: AppBar(title: Text(t.pwresetFormTitle)),
      body: SafeArea(
        child: AutofillGroup(
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              TextField(
                key: const Key('pwreset-login-id'),
                controller: _loginId,
                autofocus: widget.initialLoginId.isEmpty,
                autocorrect: false,
                enableSuggestions: false,
                autofillHints: const [AutofillHints.username],
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(labelText: t.loginIdLabel),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('pwreset-code'),
                controller: _code,
                // 로그인 ID 가 채워져 왔으면 코드 칸부터(designer #1410 n4).
                autofocus: widget.initialLoginId.isNotEmpty,
                autocorrect: false,
                enableSuggestions: false,
                textCapitalization: TextCapitalization.characters,
                autofillHints: const [AutofillHints.oneTimeCode],
                inputFormatters: [_CodeFormatter()],
                textInputAction: TextInputAction.next,
                style: const TextStyle(fontFamily: 'monospace', letterSpacing: 1.5),
                decoration: InputDecoration(labelText: t.pwresetFormCode, hintText: 'K7QF-9MXD-2PQR', helperText: t.pwresetFormCodeHint),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('pwreset-new'),
                controller: _pw,
                focusNode: _pwFocus,
                obscureText: true,
                autofillHints: const [AutofillHints.newPassword],
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(
                  labelText: t.pwresetFormNewPassword,
                  errorText: _long
                      ? t.pwresetFormTooLong
                      : (_short && (_pwTouched || _tried))
                          ? t.pwresetFormTooShort
                          : null,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('pwreset-confirm'),
                controller: _pw2,
                obscureText: true,
                autofillHints: const [AutofillHints.newPassword],
                // 키보드 「완료」로 보낸다(designer #1410 s2 — 모바일은 Enter 대신).
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                  labelText: t.pwresetFormConfirm,
                  errorText: _mismatch ? t.pwresetFormMismatch : null,
                ),
              ),
              if (errorKey != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(_message(t, errorKey), key: const Key('pwreset-error'), style: TextStyle(color: err)),
                ),
              const SizedBox(height: 20),
              FilledButton(
                key: const Key('pwreset-submit'),
                onPressed: _blocked ? null : _submit,
                child: Text(_busy ? t.pwresetFormSubmitting : t.pwresetFormSubmit),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 내 계정에 발급된 재설정 코드 알림(R7). **전부** 한 줄씩 보이고, [확인] 은 그린 id 만 내린다(security #1410 F1).
class PasswordResetNoticeBand extends StatelessWidget {
  const PasswordResetNoticeBand({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final notices = app.passwordResetNotices;
    if (notices.isEmpty) return const SizedBox.shrink();
    final t = context.t;
    final now = DateTime.now();
    String nameOf(String id) {
      final a = app.accounts[id];
      if (a == null) return t.pwresetNoticeUnknownAdmin;
      final shown = a.displayName.isNotEmpty ? a.displayName : a.handle;
      return '$shown (@${a.handle})';
    }

    String line(PasswordResetNotice n) {
      final by = nameOf(n.issuedById);
      final when = agoLabel(n.issuedAt, now, t);
      if (n.usedAt != null) return t.pwresetNoticeUsed(by, when);
      final issued = t.pwresetNoticeIssued(by, when);
      return n.revokedAt != null ? '$issued ${t.pwresetNoticeRevokedTag}' : issued;
    }

    final anyUsed = notices.any((n) => n.usedAt != null);
    final anyUnused = notices.any((n) => n.usedAt == null);
    final text = [
      ...notices.map(line),
      [if (anyUsed) t.pwresetNoticeUsedDetail, if (anyUnused) t.pwresetNoticeIssuedDetail].join(' '),
    ].join('\n');
    final shownIds = [for (final n in notices) n.id];
    return StatusBand(
      key: const Key('pwreset-notice'),
      text: text,
      tone: BandTone.warn,
      actionLabel: t.pwresetNoticeAck,
      onAction: () => app.ackPasswordResetNotices(shownIds),
    );
  }
}
