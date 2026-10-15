import { useState } from 'preact/hooks';
import { api } from '../api';

/**
 * 2 段階認証（ユーザー情報の画面）。オフのときは設定（QR コードをアプリで読み取り、6 桁で確かめて有効にする）、
 * オンのときは予備のコードの作り直しと、無効にする（パスワードとコードを確かめる）。
 * 有効にしたときと作り直したときだけ、予備のコードを表示する
 */
export function MfaCard({ enabled, recoveryLeft, onChanged }: { enabled: boolean; recoveryLeft: number; onChanged: () => void }) {
  const [setup, setSetup] = useState<{ svg: string; secret: string } | null>(null);
  const [mode, setMode] = useState<'' | 'disable' | 'recovery'>('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setSetup(null);
    setMode('');
    setCode('');
    setPassword('');
  };

  const start = () =>
    run(async () => {
      const r = await api.mfaSetup();
      setSetup({ svg: await qrSvg(r.uri), secret: r.secret });
    });
  const enable = (e: Event) => {
    e.preventDefault();
    run(async () => {
      const r = await api.mfaEnable(code.trim());
      reset();
      setCodes(r.recoveryCodes);
      setMessage('2 段階認証を有効にしました。ほかの端末では、ログアウトされます。');
      onChanged();
    });
  };
  const disable = (e: Event) => {
    e.preventDefault();
    run(async () => {
      await api.mfaDisable(password, code.trim());
      reset();
      setCodes(null);
      setMessage('2 段階認証を無効にしました。');
      onChanged();
    });
  };
  const renew = (e: Event) => {
    e.preventDefault();
    run(async () => {
      const r = await api.mfaRecovery(code.trim());
      reset();
      setCodes(r.recoveryCodes);
      setMessage('予備のコードを作り直しました。前の予備のコードは使えなくなりました。');
      onChanged();
    });
  };

  const codeInput = (
    <input
      type="text"
      inputMode="numeric"
      autocomplete="one-time-code"
      placeholder="確認コード（6 桁）"
      aria-label="確認コード"
      value={code}
      onInput={(e) => setCode(e.currentTarget.value)}
    />
  );

  return (
    <section class="card">
      <h3>2 段階認証</h3>
      {codes ? (
        <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
      ) : enabled ? (
        <>
          <p>
            有効です。ログインのときに、パスワードと、認証アプリの確認コードを入力します。
            <span class="muted">（予備のコードの残り {recoveryLeft} 個）</span>
          </p>
          {mode === '' && (
            <div class="visit-actions">
              <button type="button" class="text-btn" onClick={() => setMode('recovery')}>
                予備のコードを作り直す
              </button>
              <button type="button" class="text-btn danger-text" onClick={() => setMode('disable')}>
                無効にする
              </button>
            </div>
          )}
          {mode === 'recovery' && (
            <form class="password-form" onSubmit={renew}>
              <p class="muted">確認のため、認証アプリの確認コードを入力してください。</p>
              {codeInput}
              <div class="visit-actions">
                <button type="submit" disabled={busy || !code.trim()}>作り直す</button>
                <button type="button" class="text-btn" onClick={reset}>キャンセル</button>
              </div>
            </form>
          )}
          {mode === 'disable' && (
            <form class="password-form" onSubmit={disable}>
              <p class="muted">確認のため、パスワードと、認証アプリの確認コードを入力してください。</p>
              <input type="password" autocomplete="current-password" placeholder="パスワード" aria-label="パスワード" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
              {codeInput}
              <div class="visit-actions">
                <button type="submit" class="danger-btn" disabled={busy || !password || !code.trim()}>無効にする</button>
                <button type="button" class="text-btn" onClick={reset}>キャンセル</button>
              </div>
            </form>
          )}
        </>
      ) : setup ? (
        <form class="mfa-setup" onSubmit={enable}>
          <ol>
            <li>スマホの認証アプリ（Google Authenticator など）で、次の QR コードを読み取ります。</li>
          </ol>
          <div class="mfa-qr" dangerouslySetInnerHTML={{ __html: setup.svg }} />
          <p class="muted note">
            読み取れないときは、アプリで「セットアップキーを入力」を選び、次のキーを入力します。
            <br />
            <code class="mfa-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </p>
          <ol start={2}>
            <li>アプリに表示された 6 桁を入力して、「有効にする」を押します。</li>
          </ol>
          <div class="password-form">
            {codeInput}
            <div class="visit-actions">
              <button type="submit" disabled={busy || !code.trim()}>有効にする</button>
              <button type="button" class="text-btn" onClick={reset}>キャンセル</button>
            </div>
          </div>
        </form>
      ) : (
        <>
          <p>ログインのときに、パスワードに加えて、スマホの認証アプリ（Google Authenticator など）の確認コードを入力するようにします。</p>
          <button type="button" disabled={busy} onClick={start}>
            設定する
          </button>
        </>
      )}
      {message && <p>{message}</p>}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

/** otpauth の URI の QR コード（SVG）。QR のライブラリは、設定を始めたときだけ読み込む（ふだんの画面を軽くするため） */
async function qrSvg(uri: string): Promise<string> {
  const { default: qrcode } = await import('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/** 予備のコード（この 1 回だけ表示する） */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div class="mfa-recovery">
      <p>
        <strong>予備のコードを保存してください。</strong>
      </p>
      <p class="muted note">
        認証アプリを使えなくなったとき（スマホをなくしたときなど）に、確認コードの代わりに入力できます。1 つのコードは 1 回だけ使えます。この画面を閉じると、もう表示できません。
      </p>
      <ul class="mfa-codes">
        {codes.map((c) => (
          <li>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div class="visit-actions">
        <button type="button" class="text-btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).catch(() => {})}>
          コピー
        </button>
        <button type="button" onClick={onDone}>
          保存しました
        </button>
      </div>
    </div>
  );
}
