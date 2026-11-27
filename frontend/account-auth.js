const minimumPasswordLength = 12;
const passwordRules = [
  ['英文大寫字母', /[A-Z]/],
  ['英文小寫字母', /[a-z]/],
  ['數字', /[0-9]/],
  ['特殊符號（如 !、@、#）', /[!@#$%^&*()_+\-=[\]{};'\\:"|<>?,.\/\x60~]/]
];

const views = {
  login: ['登入端股', '登入後可在電腦和手機查看同一份持股、交易與自選清單。', '登入'],
  signup: ['建立帳號', '設定暱稱與密碼，再到電子郵件收取註冊驗證信。', '建立帳號'],
  signupCode: ['驗證電子郵件', '請輸入驗證信中的數字，或直接點選信中的確認連結。', '驗證帳號'],
  forgot: ['忘記密碼', '輸入登入端股時使用的電子郵件。', '寄送重設密碼信'],
  recoveryCode: ['驗證重設請求', '請輸入重設信中的數字，或點選信中的重設連結。', '驗證後設定新密碼'],
  reset: ['設定新密碼', '輸入新密碼，再輸入一次確認。', '儲存新密碼']
};

const sentMessages = {
  signupCode: '若信件寄送成功，請查看收件匣或垃圾郵件。',
  recoveryCode: '若此電子郵件可以重設密碼，驗證信將寄到你的收件匣。'
};

function authErrorMessage(error, view) {
  if (error?.status === 429 || ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(error?.code)) {
    return '操作太頻繁，請稍候再試。';
  }
  if (error?.code === 'email_address_not_authorized') return '目前無法寄出驗證信，請聯絡網站管理者。';
  if (error?.code === 'weak_password') return '新密碼未符合安全要求，請換一組較長且難猜的密碼。';
  if (error?.code === 'same_password') return '請輸入與目前不同的新密碼。';
  if (view === 'signupCode' || view === 'recoveryCode') return '無法驗證。請確認輸入的是最新一封信中的驗證碼，或重新寄送。';
  if (view === 'login') return '登入失敗，請檢查電子郵件和密碼，或使用忘記密碼。';
  if (view === 'reset') return '暫時無法更新密碼。如果重設驗證已失效，請重新申請。';
  return '暫時無法完成操作，請稍後再試。';
}

export function getAccountCallback(location) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const accessToken = hash.get('access_token'), refreshToken = hash.get('refresh_token');
  const recovery = hash.get('type') === 'recovery';
  const query = new URLSearchParams(location.search);
  const expired = hash.has('error_code') || query.has('error_code');
  return { recovery, expired, tokens: accessToken && refreshToken ? { access_token: accessToken, refresh_token: refreshToken } : null };
}

export function mountAccountAuth({ auth, createRecoveryAuth, onSession, onShowGate, onNotice }) {
  const $ = (id) => document.getElementById(id);
  const form = $('accountForm'), status = $('accountStatus'), submit = $('accountSubmit');
  const email = $('accountEmail'), password = $('accountPassword'), confirm = $('accountConfirm');
  const passwordHint = $('accountPasswordHint');
  const nickname = $('accountNickname'), code = $('accountCode');
  const toggle = $('accountModeToggle'), forgot = $('accountForgot'), verify = $('accountVerify'), resend = $('accountResend');
  const profile = $('accountProfileBtn'), profileDialog = $('accountProfileDialog'), profileInput = $('accountProfileName');
  const profileStatus = $('accountProfileStatus'), profileSave = $('accountProfileSave');
  let view = 'login', busy = false, recoveryAuth = null, signedInUser = null;

  function setStatus(message = '', tone = '') {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function refreshForm() {
    const newPassword = view === 'signup' || view === 'reset';
    const hasCode = view === 'signupCode' || view === 'recoveryCode';
    const fields = [
      [email, view !== 'reset'], [nickname, view === 'signup'], [password, newPassword || view === 'login'],
      [confirm, newPassword], [code, hasCode]
    ];
    for (const [input, visible] of fields) {
      input.closest('label').hidden = !visible;
      input.disabled = !visible;
      input.required = visible;
      input.readOnly = busy;
    }
    $('accountTitle').textContent = views[view][0];
    $('accountIntro').textContent = views[view][1];
    $('accountPasswordLabel').textContent = view === 'reset' ? '新密碼' : '密碼';
    password.autocomplete = newPassword ? 'new-password' : 'current-password';
    passwordHint.hidden = !newPassword;
    if (newPassword) password.setAttribute('aria-describedby', passwordHint.id);
    else password.removeAttribute('aria-describedby');
    toggle.textContent = view === 'login' ? '建立帳號' : '返回登入';
    forgot.hidden = verify.hidden = view !== 'login';
    resend.hidden = !hasCode;
    submit.textContent = busy ? '處理中…' : views[view][2];
    for (const button of [submit, toggle, forgot, verify, resend]) button.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
  }

  function showView(next, message = '', tone = '', moveFocus = true) {
    view = next;
    for (const input of [password, confirm, code]) input.value = '';
    if (next !== 'signup') nickname.value = '';
    refreshForm();
    setStatus(message, tone);
    if (moveFocus) $('accountTitle').focus();
  }

  function requireEmail() {
    const address = email.value.trim();
    if (!address || !email.checkValidity()) {
      email.focus();
      email.reportValidity();
      return '';
    }
    return address;
  }

  async function withBusy(task, fallback = view) {
    if (busy) return;
    busy = true;
    refreshForm();
    setStatus();
    try { await task(); }
    catch (error) { setStatus(authErrorMessage(error, fallback), 'error'); }
    finally { busy = false; refreshForm(); }
  }

  async function clearRecovery() {
    const temporaryAuth = recoveryAuth;
    recoveryAuth = null;
    if (temporaryAuth) await temporaryAuth.signOut({ scope: 'local' }).catch(() => {});
  }

  async function sendCode(address, target) {
    const result = target === 'signupCode'
      ? await auth.resend({ type: 'signup', email: address, options: { emailRedirectTo: location.origin } })
      : await auth.resetPasswordForEmail(address, { redirectTo: location.origin });
    if (result.error && !['user_not_found', 'user_already_exists', 'email_exists'].includes(result.error.code)) throw result.error;
    showView(target, sentMessages[target], 'success');
  }

  $('accountActions').hidden = false;
  refreshForm();
  toggle.addEventListener('click', () => {
    if (view === 'reset') {
      void withBusy(async () => { await clearRecovery(); showView('login'); });
    } else {
      showView(view === 'login' ? 'signup' : 'login');
    }
  });
  forgot.addEventListener('click', () => showView('forgot'));
  verify.addEventListener('click', () => showView('signupCode'));
  resend.addEventListener('click', () => {
    const address = requireEmail();
    if (address) void withBusy(() => sendCode(address, view), 'forgot');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const address = view === 'reset' ? '' : requireEmail();
    if (view !== 'reset' && !address) return;
    if (['signup', 'reset'].includes(view)) {
      const missing = passwordRules.filter(([, pattern]) => !pattern.test(password.value)).map(([label]) => label);
      const tooShort = [...password.value].length < minimumPasswordLength;
      const tooLong = new TextEncoder().encode(password.value).length > 72;
      if (tooShort || tooLong || missing.length) {
        const requirements = [
          tooShort && `密碼須至少 ${minimumPasswordLength} 個字元。`,
          tooLong && '密碼太長，請縮短後再試。',
          missing.length > 0 && `請加入${missing.join('、')}。`
        ];
        setStatus(requirements.filter(Boolean).join(' '), 'error');
        password.focus();
        return;
      }
      if (password.value !== confirm.value) {
        setStatus('兩次輸入的密碼不同，請再確認。', 'error');
        confirm.focus();
        return;
      }
    }
    if (view === 'signup' && !nickname.value.trim()) {
      setStatus('請輸入帳號暱稱。', 'error');
      nickname.focus();
      return;
    }

    void withBusy(async () => {
      if (view === 'forgot') return sendCode(address, 'recoveryCode');

      if (view === 'reset') {
        const result = await recoveryAuth.updateUser({ password: password.value });
        if (result.error) throw result.error;
        const recoveredUser = result.data.user;
        await clearRecovery();
        const { data } = await auth.getSession().catch(() => ({}));
        if (recoveredUser?.id && data?.session?.user?.id === recoveredUser.id) {
          await auth.signOut({ scope: 'local' }).catch(() => {});
        }
        if (recoveredUser?.email) email.value = recoveredUser.email;
        showView('login', '密碼已更新，請用新密碼登入。', 'success');
        return;
      }

      if (view === 'recoveryCode') {
        const temporaryAuth = createRecoveryAuth();
        const { data, error } = await temporaryAuth.verifyOtp({ email: address, token: code.value.trim(), type: 'recovery' });
        if (error || !data?.session?.user) throw error || new Error('Missing recovery session');
        recoveryAuth = temporaryAuth;
        showView('reset', '電子郵件已驗證。', 'success');
        return;
      }

      let result;
      if (view === 'signupCode') {
        result = await auth.verifyOtp({ email: address, token: code.value.trim(), type: 'email' });
      } else if (view === 'signup') {
        result = await auth.signUp({
          email: address, password: password.value,
          options: { data: { display_name: nickname.value.trim() }, emailRedirectTo: location.origin }
        });
        if ((!result.error && !result.data?.session) || ['user_already_exists', 'email_exists'].includes(result.error?.code)) {
          showView('signupCode', sentMessages.signupCode, 'success');
          return;
        }
      } else {
        result = await auth.signInWithPassword({ email: address, password: password.value });
        if (result.error?.code === 'email_not_confirmed') {
          showView('signupCode', '請先完成電子郵件驗證。你可以重新寄送驗證信。', 'error');
          return;
        }
      }
      if (result.error || !result.data?.session) throw result.error || new Error('Missing session');
      password.value = confirm.value = code.value = '';
      await onSession(result.data.session);
    });
  });

  function setProfile(user) {
    signedInUser = user;
    const value = user?.user_metadata?.display_name;
    const displayName = typeof value === 'string' ? value.trim().slice(0, 32) : '';
    profile.hidden = !user;
    profile.textContent = displayName ? '帳號：' + displayName : '設定帳號暱稱';
    profile.title = profile.textContent;
  }

  profile.addEventListener('click', () => {
    if (!signedInUser) return;
    const value = signedInUser.user_metadata?.display_name;
    profileInput.value = typeof value === 'string' ? value.slice(0, 32) : '';
    profileStatus.textContent = '';
    profileDialog.showModal();
    profileInput.focus();
  });
  $('accountProfileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (profileSave.disabled || !signedInUser) return;
    const value = profileInput.value.trim(), userId = signedInUser.id;
    if (!value) { profileStatus.textContent = '請輸入暱稱。'; profileInput.focus(); return; }
    profileSave.disabled = true;
    profileStatus.textContent = '';
    try {
      const { data, error } = await auth.updateUser({ data: { display_name: value } });
      if (error) throw error;
      if (data?.user?.id !== userId || signedInUser?.id !== userId) return;
      setProfile(data.user);
      profileDialog.close();
      onNotice('已更新帳號暱稱。');
    } catch { profileStatus.textContent = '暱稱儲存失敗，請稍後再試。'; }
    finally { profileSave.disabled = false; }
  });

  return {
    isRecovering: () => ['forgot', 'recoveryCode', 'reset'].includes(view),
    setProfile,
    async openRecoveryLink(tokens) {
      onShowGate();
      showView('forgot', '', '', false);
      if (!tokens) { setStatus('重設連結已失效，請重新申請。', 'error'); return; }
      await withBusy(async () => {
        const temporaryAuth = createRecoveryAuth();
        const { data, error } = await temporaryAuth.setSession(tokens);
        if (error || !data?.session?.user) {
          setStatus('重設連結已失效，請重新申請。', 'error');
          return;
        }
        recoveryAuth = temporaryAuth;
        if (typeof data.session.user.email === 'string') email.value = data.session.user.email;
        showView('reset', '電子郵件已驗證。', 'success');
      });
    }
  };
}
