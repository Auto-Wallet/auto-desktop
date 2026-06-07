import { useState } from "react";
import "./LockScreen.css";
import mascot from "../assets/mascot.png";
import { useT } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { LedgerList, useLedgerScan } from "../lib/LedgerPicker";
import {
  createVault,
  importPrivateKey,
  importVault,
  resetVault,
  unlockVault,
  useVault,
} from "../lib/vault";

// The wallet's front door (VISION ④⑤ — real key ownership), restyled to the
// Aurora design. Shown by App whenever the vault isn't unlocked for this session:
//   * absent vault → a first-run chooser: Create HD / Import (phrase|key) / Ledger
//   * existing vault → Unlock with the password (+ a forgot-password reset escape)
// Keys never appear here; only addresses, and the mnemonic ONCE on the backup
// screen for the user to write down.

type Mode = "choose" | "create" | "import" | "ledger" | "backup" | "unlock" | "reset";

export default function LockScreen({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const vault = useVault();
  const [mode, setMode] = useState<Mode>(vault.phase === "locked" ? "unlock" : "choose");
  const [mnemonic, setMnemonic] = useState("");

  return (
    <div className="lock">
      <span className="lock-aura" />
      <div className={`lock-card${mode === "ledger" ? " wide" : ""}`}>
        <div className="lock-brand">
          <div className="lock-mark-wrap">
            <span className="ring" />
            <img className="lock-mark" src={mascot} alt="" />
          </div>
          <h1>AutoDesktop</h1>
          <p className="lock-tag">{t("lock.tagline")}</p>
        </div>

        {mode === "choose" && <Choose onPick={setMode} />}
        {mode === "create" && (
          <CreateForm
            onBack={() => setMode("choose")}
            onCreated={(phrase) => {
              setMnemonic(phrase);
              setMode("backup");
            }}
          />
        )}
        {mode === "import" && <ImportForm onBack={() => setMode("choose")} onDone={onDone} />}
        {mode === "ledger" && <LedgerPanel onBack={() => setMode("choose")} onDone={onDone} />}
        {mode === "backup" && <BackupScreen mnemonic={mnemonic} onDone={onDone} />}
        {mode === "unlock" && <UnlockForm onDone={onDone} onForgot={() => setMode("reset")} />}
        {mode === "reset" && (
          <ResetForm onBack={() => setMode("unlock")} onReset={() => setMode("choose")} />
        )}
      </div>
    </div>
  );
}

function Choose({ onPick }: { onPick: (m: Mode) => void }) {
  const { t } = useT();
  const opts: { m: Mode; ic: "plus" | "download" | "ledger"; t: string; d: string; coral?: boolean }[] = [
    { m: "create", ic: "plus", t: t("lock.optCreate"), d: t("lock.optCreateDesc") },
    { m: "import", ic: "download", t: t("lock.optImport"), d: t("lock.optImportDesc"), coral: true },
    { m: "ledger", ic: "ledger", t: t("lock.optLedger"), d: t("lock.optLedgerDesc") },
  ];
  return (
    <div className="lock-body">
      <div className="lock-h">{t("lock.chooseTitle")}</div>
      {opts.map((o) => (
        <button key={o.m} className={`opt${o.coral ? " coral" : ""}`} onClick={() => onPick(o.m)}>
          <span className="opt-ic">
            <Icon name={o.ic} size={20} />
          </span>
          <span className="opt-tx">
            <span className="opt-t">{o.t}</span>
            <span className="opt-d">{o.d}</span>
          </span>
          <span className="opt-ch">
            <Icon name="chevronR" size={18} />
          </span>
        </button>
      ))}
    </div>
  );
}

function pwScore(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9!@#$%^&*]/.test(pw)) s++;
  return Math.min(s, 4);
}

function PasswordField({
  value,
  onChange,
  placeholder,
  autoFocus,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="lock-input-wrap">
      <input
        className="input"
        type={show ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        style={{ paddingRight: 44 }}
      />
      <button className="reveal" type="button" tabIndex={-1} onClick={() => setShow((s) => !s)}>
        <Icon name={show ? "eyeOff" : "eye"} size={17} />
      </button>
    </div>
  );
}

function CreateForm({ onBack, onCreated }: { onBack: () => void; onCreated: (m: string) => void }) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const score = pwScore(pw);

  async function submit() {
    if (pw.length < 8) return setError(t("lock.errShort"));
    if (pw !== confirm) return setError(t("lock.errMatch"));
    setBusy(true);
    setError(null);
    try {
      const { mnemonic } = await createVault(pw);
      onCreated(mnemonic);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="lock-body">
      <div className="lock-h">{t("lock.create")}</div>
      <div className="field">
        <label className="field-label">{t("lock.newPassword")}</label>
        <PasswordField
          value={pw}
          onChange={(v) => {
            setPw(v);
            setError(null);
          }}
          placeholder={t("lock.min8")}
          autoFocus
        />
        <div className={`pw-strength s${score}`}>
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="field">
        <label className="field-label">{t("lock.confirm")}</label>
        <PasswordField
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            setError(null);
          }}
          placeholder={t("lock.confirm")}
          onEnter={submit}
        />
      </div>
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <button className="btn btn-aurora btn-lg btn-block" disabled={busy} onClick={submit}>
        {busy ? "…" : t("lock.continue")}
      </button>
      <button className="lock-link lock-back" onClick={onBack}>
        <Icon name="chevronL" size={14} /> {t("lock.back")}
      </button>
    </div>
  );
}

function ImportForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useT();
  const [tab, setTab] = useState<"phrase" | "privkey">("phrase");
  const [phrase, setPhrase] = useState("");
  const [privkey, setPrivkey] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (tab === "phrase") {
      const words = phrase.trim().split(/\s+/).length;
      if (words !== 12 && words !== 24) return setError(t("lock.errPhrase"));
    } else {
      const body = privkey.trim().replace(/^0x/i, "");
      if (!/^[0-9a-fA-F]{64}$/.test(body)) return setError(t("lock.errPrivkey"));
    }
    if (pw.length < 8) return setError(t("lock.errShort"));
    if (pw !== confirm) return setError(t("lock.errMatch"));
    setBusy(true);
    setError(null);
    try {
      if (tab === "phrase") await importVault(pw, phrase);
      else await importPrivateKey(pw, privkey);
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="lock-body">
      <div className="lock-h">{t("lock.optImport")}</div>
      <div className="seg lock-seg">
        <button className={tab === "phrase" ? "on" : ""} onClick={() => setTab("phrase")}>
          {t("lock.importTab.phrase")}
        </button>
        <button className={tab === "privkey" ? "on" : ""} onClick={() => setTab("privkey")}>
          {t("lock.importTab.privkey")}
        </button>
      </div>

      {tab === "phrase" ? (
        <div className="field">
          <label className="field-label">{t("lock.recoveryPhrase")}</label>
          <textarea
            className="textarea mono"
            autoFocus
            rows={3}
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value);
              setError(null);
            }}
            placeholder={t("lock.phrasePlaceholder")}
          />
        </div>
      ) : (
        <div className="field">
          <label className="field-label">{t("lock.privateKey")}</label>
          <textarea
            className="textarea mono"
            autoFocus
            rows={2}
            value={privkey}
            onChange={(e) => {
              setPrivkey(e.target.value);
              setError(null);
            }}
            placeholder={t("lock.privkeyPlaceholder")}
          />
        </div>
      )}

      <div className="field">
        <label className="field-label">{t("lock.newPassword")}</label>
        <PasswordField value={pw} onChange={(v) => { setPw(v); setError(null); }} placeholder={t("lock.min8")} />
      </div>
      <div className="field">
        <label className="field-label">{t("lock.confirm")}</label>
        <PasswordField
          value={confirm}
          onChange={(v) => { setConfirm(v); setError(null); }}
          placeholder={t("lock.confirm")}
          onEnter={submit}
        />
      </div>
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <button className="btn btn-aurora btn-lg btn-block" disabled={busy} onClick={submit}>
        {busy ? "…" : tab === "phrase" ? t("lock.import") : t("lock.importPrivkey")}
      </button>
      <button className="lock-link lock-back" onClick={onBack}>
        <Icon name="chevronL" size={14} /> {t("lock.back")}
      </button>
    </div>
  );
}

function LedgerPanel({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useT();
  const { accounts, page, loading, connecting, started, error, scan, nextPage, prevPage, pick } =
    useLedgerScan(onDone);
  const showList = started && (accounts.length > 0 || loading);

  return (
    <div className="lock-body">
      <div className="lock-h">{t("lock.ledgerTitle")}</div>
      <div className="ledger-art">
        <div className="ledger-dev">
          <div className="scr">
            <i />
          </div>
          <div className="btn1" />
        </div>
      </div>

      {showList ? (
        <LedgerList
          accounts={accounts}
          page={page}
          loading={loading}
          connecting={connecting}
          onPick={pick}
          onPrev={prevPage}
          onNext={nextPage}
        />
      ) : (
        <div className="lock-info">{connecting ? t("lock.ledgerConnecting") : t("lock.ledgerIntro")}</div>
      )}

      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}

      {!showList && (
        <button className="btn btn-aurora btn-lg btn-block" disabled={loading} onClick={scan}>
          {loading ? "…" : error ? t("lock.retry") : t("lock.ledgerScan")}
        </button>
      )}

      <button className="lock-link lock-back" onClick={onBack}>
        <Icon name="chevronL" size={14} /> {t("lock.back")}
      </button>
    </div>
  );
}

function BackupScreen({ mnemonic, onDone }: { mnemonic: string; onDone: () => void }) {
  const { t } = useT();
  const [revealed, setRevealed] = useState(false);
  const [acked, setAcked] = useState(false);
  const words = mnemonic.trim().split(/\s+/);

  return (
    <div className="lock-body">
      <div className="lock-h">{t("lock.recoveryPhrase")}</div>
      <div className="warn-box">
        <Icon name="alert" size={16} /> {t("lock.backupWarn")}
      </div>
      <div style={{ position: "relative" }}>
        <ol className={`mnemonic${revealed ? "" : " blurred"}`}>
          {words.map((w, i) => (
            <li key={i}>
              <span className="n">{i + 1}</span>
              {w}
            </li>
          ))}
        </ol>
        {!revealed && (
          <div className="reveal-mnemonic" onClick={() => setRevealed(true)}>
            <span className="pill">
              <Icon name="eye" size={15} /> {t("lock.tapReveal")}
            </span>
          </div>
        )}
      </div>
      <label className="lock-check">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
        {t("lock.backupAck")}
      </label>
      <button className="btn btn-aurora btn-lg btn-block" disabled={!acked} onClick={onDone}>
        {t("lock.continue")}
      </button>
    </div>
  );
}

function UnlockForm({ onDone, onForgot }: { onDone: () => void; onForgot: () => void }) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await unlockVault(pw);
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="lock-body">
      <div className="field">
        <label className="field-label">{t("lock.password")}</label>
        <PasswordField value={pw} onChange={(v) => { setPw(v); setError(null); }} placeholder={t("lock.password")} autoFocus onEnter={submit} />
      </div>
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <button className="btn btn-aurora btn-lg btn-block" disabled={busy} onClick={submit}>
        <Icon name="unlock" size={18} /> {busy ? "…" : t("lock.unlock")}
      </button>
      <button className="lock-link" onClick={onForgot}>
        {t("lock.forgot")}
      </button>
    </div>
  );
}

function ResetForm({ onBack, onReset }: { onBack: () => void; onReset: () => void }) {
  const { t } = useT();
  const [acked, setAcked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await resetVault();
      onReset();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="lock-body">
      <div className="lock-h">{t("lock.resetTitle")}</div>
      <div className="warn-box danger">
        <Icon name="alert" size={16} /> {t("lock.resetWarn")}
      </div>
      <label className="lock-check">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
        {t("lock.resetAck")}
      </label>
      {error && (
        <div className="lock-err">
          <Icon name="alert" size={16} /> {error}
        </div>
      )}
      <button className="btn btn-danger btn-lg btn-block" disabled={!acked || busy} onClick={submit}>
        <Icon name="trash" size={17} /> {busy ? "…" : t("lock.resetConfirm")}
      </button>
      <button className="lock-link lock-back" onClick={onBack}>
        <Icon name="chevronL" size={14} /> {t("lock.back")}
      </button>
    </div>
  );
}

// Tauri command errors arrive as a plain string (our Err(String)); surface it.
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
