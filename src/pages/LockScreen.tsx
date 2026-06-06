import { useState } from "react";
import "./LockScreen.css";
import mascot from "../assets/mascot.png";
import { useT } from "../lib/i18n";
import { createVault, importVault, unlockVault, useVault } from "../lib/vault";

// The wallet's front door (VISION ④⑤ — real key ownership). Shown by App whenever
// the vault isn't unlocked for this session. Three entry paths:
//   * absent vault → Create (then a one-time mnemonic backup) or Import a phrase
//   * existing vault → Unlock with the password
// Keys never appear here; only the address, and the mnemonic ONCE on the backup
// screen for the user to write down (the universal wallet pattern, in the trusted
// shell — never the dApp boundary).

type Mode = "choose" | "create" | "import" | "backup" | "unlock";

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
            <button className="lock-primary" onClick={() => setMode("create")}>
              {t("lock.create")}
            </button>
            <button className="lock-ghost" onClick={() => setMode("import")}>
              {t("lock.import")}
            </button>
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

        {mode === "backup" && <BackupScreen mnemonic={mnemonic} onDone={onDone} />}

        {mode === "unlock" && (
          <UnlockForm onDone={onDone} address={vault.address} />
        )}
      </div>
    </div>
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

function ImportForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useT();
  const [phrase, setPhrase] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const words = phrase.trim().split(/\s+/).length;
    if (words !== 12 && words !== 24) return setError(t("lock.errPhrase"));
    if (pw.length < 8) return setError(t("lock.errShort"));
    if (pw !== confirm) return setError(t("lock.errMatch"));
    setBusy(true);
    setError(null);
    try {
      await importVault(pw, phrase);
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="lock-form">
      <label className="lock-label">{t("lock.recoveryPhrase")}</label>
      <textarea
        className="lock-textarea"
        autoFocus
        rows={3}
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder={t("lock.phrasePlaceholder")}
      />
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
        {busy ? "…" : t("lock.import")}
      </button>
      <button className="lock-link" onClick={onBack}>
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

function UnlockForm({ onDone, address }: { onDone: () => void; address: string | null }) {
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
      {address && <div className="lock-addr">{address}</div>}
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
    </div>
  );
}

// Tauri command errors arrive as a plain string (our Err(String)); surface it.
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
