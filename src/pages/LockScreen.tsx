import { useState } from "react";
import "./LockScreen.css";
import mascot from "../assets/mascot.png";
import { useT } from "../lib/i18n";
import {
  createVault,
  importPrivateKey,
  importVault,
  resetVault,
  unlockVault,
  useVault,
} from "../lib/vault";

// The wallet's front door (VISION ④⑤ — real key ownership). Shown by App whenever
// the vault isn't unlocked for this session. Paths:
//   * absent vault → a first-run chooser: Create HD / Import (phrase|key) / Ledger
//   * existing vault → Unlock with the password (+ a forgot-password reset escape)
// Keys never appear here; only addresses, and the mnemonic ONCE on the backup
// screen for the user to write down (the universal wallet pattern, in the trusted
// shell — never the dApp boundary).

type Mode = "choose" | "create" | "import" | "ledger" | "backup" | "unlock" | "reset";

export default function LockScreen({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const vault = useVault();
  const [mode, setMode] = useState<Mode>(vault.phase === "locked" ? "unlock" : "choose");
  const [mnemonic, setMnemonic] = useState(""); // shown on the backup screen after create

  return (
    <div className="lock">
      <div className="lock-card">
        <div className="lock-brand">
          <img src={mascot} alt="" width={56} height={56} />
          <h1>AutoDesktop</h1>
          <p className="lock-tag">{t("lock.tagline")}</p>
        </div>

        {mode === "choose" && (
          <div className="lock-choose">
            <div className="lock-choose-title">{t("lock.chooseTitle")}</div>
            <ChooseOption
              title={t("lock.optCreate")}
              desc={t("lock.optCreateDesc")}
              onClick={() => setMode("create")}
            />
            <ChooseOption
              title={t("lock.optImport")}
              desc={t("lock.optImportDesc")}
              onClick={() => setMode("import")}
            />
            <ChooseOption
              title={t("lock.optLedger")}
              desc={t("lock.optLedgerDesc")}
              onClick={() => setMode("ledger")}
            />
          </div>
        )}

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

        {mode === "ledger" && <LedgerPanel onBack={() => setMode("choose")} />}

        {mode === "backup" && <BackupScreen mnemonic={mnemonic} onDone={onDone} />}

        {mode === "unlock" && (
          <UnlockForm onDone={onDone} onForgot={() => setMode("reset")} />
        )}

        {mode === "reset" && (
          <ResetForm onBack={() => setMode("unlock")} onReset={() => setMode("choose")} />
        )}
      </div>
    </div>
  );
}

function ChooseOption({
  title,
  desc,
  onClick,
}: {
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button className="lock-option" onClick={onClick}>
      <span className="lock-option-text">
        <span className="lock-option-title">{title}</span>
        <span className="lock-option-desc">{desc}</span>
      </span>
      <span className="lock-option-chevron">›</span>
    </button>
  );
}

function CreateForm({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: (mnemonic: string) => void;
}) {
  const { t } = useT();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (pw.length < 8) return setError(t("lock.errShort"));
    if (pw !== confirm) return setError(t("lock.errMatch"));
    setBusy(true);
    setError(null);
    try {
      const mnemonic = await createVault(pw);
      onCreated(mnemonic);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="lock-form">
      <label className="lock-label">{t("lock.newPassword")}</label>
      <input
        className="lock-input"
        type="password"
        autoFocus
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder={t("lock.min8")}
      />
      <input
        className="lock-input"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("lock.confirm")}
      />
      {error && <div className="lock-error">{error}</div>}
      <button className="lock-primary" disabled={busy} onClick={submit}>
        {busy ? "…" : t("lock.create")}
      </button>
      <button className="lock-link" onClick={onBack}>
        ‹ {t("lock.back")}
      </button>
    </div>
  );
}

// Import an existing wallet — either a BIP-39 recovery phrase or a single raw
// private key, chosen by the tab toggle. The private-key path yields a one-account
// wallet (no HD derivation), matching the backend.
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
    <div className="lock-form">
      <div className="lock-tabs">
        <button
          className={`lock-tab${tab === "phrase" ? " active" : ""}`}
          onClick={() => setTab("phrase")}
        >
          {t("lock.importTab.phrase")}
        </button>
        <button
          className={`lock-tab${tab === "privkey" ? " active" : ""}`}
          onClick={() => setTab("privkey")}
        >
          {t("lock.importTab.privkey")}
        </button>
      </div>

      {tab === "phrase" ? (
        <>
          <label className="lock-label">{t("lock.recoveryPhrase")}</label>
          <textarea
            className="lock-textarea"
            autoFocus
            rows={3}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={t("lock.phrasePlaceholder")}
          />
        </>
      ) : (
        <>
          <label className="lock-label">{t("lock.privateKey")}</label>
          <textarea
            className="lock-textarea"
            autoFocus
            rows={2}
            value={privkey}
            onChange={(e) => setPrivkey(e.target.value)}
            placeholder={t("lock.privkeyPlaceholder")}
          />
        </>
      )}

      <input
        className="lock-input"
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder={t("lock.newPassword")}
      />
      <input
        className="lock-input"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("lock.confirm")}
      />
      {error && <div className="lock-error">{error}</div>}
      <button className="lock-primary" disabled={busy} onClick={submit}>
        {busy ? "…" : tab === "phrase" ? t("lock.import") : t("lock.importPrivkey")}
      </button>
      <button className="lock-link" onClick={onBack}>
        ‹ {t("lock.back")}
      </button>
    </div>
  );
}

// Ledger isn't wired yet (needs the native USB/HID backend — Phase C). Be honest:
// present the option, but don't fake a connection. When it lands, the device PIN
// replaces the app password (the user won't set one here).
function LedgerPanel({ onBack }: { onBack: () => void }) {
  const { t } = useT();
  return (
    <div className="lock-form">
      <div className="lock-info-title">{t("lock.ledgerTitle")}</div>
      <div className="lock-info">{t("lock.ledgerSoon")}</div>
      <button className="lock-ghost" onClick={onBack}>
        ‹ {t("lock.back")}
      </button>
    </div>
  );
}

function BackupScreen({ mnemonic, onDone }: { mnemonic: string; onDone: () => void }) {
  const { t } = useT();
  const [acked, setAcked] = useState(false);
  const words = mnemonic.trim().split(/\s+/);

  return (
    <div className="lock-form">
      <div className="lock-warn">{t("lock.backupWarn")}</div>
      <ol className="mnemonic-grid">
        {words.map((w, i) => (
          <li key={i} className="mnemonic-word">
            <span className="mnemonic-idx">{i + 1}</span>
            {w}
          </li>
        ))}
      </ol>
      <label className="lock-check">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
        {t("lock.backupAck")}
      </label>
      <button className="lock-primary" disabled={!acked} onClick={onDone}>
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
    <div className="lock-form">
      <label className="lock-label">{t("lock.password")}</label>
      <input
        className="lock-input"
        type="password"
        autoFocus
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("lock.password")}
      />
      {error && <div className="lock-error">{error}</div>}
      <button className="lock-primary" disabled={busy} onClick={submit}>
        {busy ? "…" : t("lock.unlock")}
      </button>
      <button className="lock-link" onClick={onForgot}>
        {t("lock.forgot")}
      </button>
    </div>
  );
}

// Forgot-password escape hatch. Deleting the keystore is IRREVERSIBLE — gated
// behind an explicit, clearly-worded acknowledgement. Recovery is ONLY via the
// user's own mnemonic/key backup (AutoDesktop keeps no copy).
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
    <div className="lock-form">
      <div className="lock-info-title">{t("lock.resetTitle")}</div>
      <div className="lock-warn lock-warn-danger">{t("lock.resetWarn")}</div>
      <label className="lock-check">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
        {t("lock.resetAck")}
      </label>
      {error && <div className="lock-error">{error}</div>}
      <button className="lock-danger" disabled={!acked || busy} onClick={submit}>
        {busy ? "…" : t("lock.resetConfirm")}
      </button>
      <button className="lock-link" onClick={onBack}>
        ‹ {t("lock.back")}
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
