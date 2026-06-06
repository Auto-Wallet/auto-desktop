import { useState } from "react";
import "./SettingsPage.css";
import mascot from "../assets/mascot.png";
import { addChain, removeChain, updateChain, useChains, type Chain } from "../lib/chains";
import { setActiveChain, useActiveChain } from "../lib/activeChain";
import { setLang, useT, type Lang, type TFn } from "../lib/i18n";

const APP_VERSION = "0.1.0"; // mirrors src-tauri/tauri.conf.json

function safeHost(rpc: string): string {
  try {
    return new URL(rpc).hostname;
  } catch {
    return rpc;
  }
}
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export default function SettingsPage() {
  const { t, lang } = useT();
  const chains = useChains();
  const activeChain = useActiveChain();
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  // null = closed; "new" = add form; Chain = edit that chain.
  const [editing, setEditing] = useState<Chain | "new" | null>(null);

  return (
    <div className="settings-page">
      <h1>{t("settings.title")}</h1>

      {/* ---- Network ---- */}
      <section className="set-section">
        <div className="set-head">
          <h2>{t("settings.network")}</h2>
          <p>{t("settings.networkHint")}</p>
        </div>
        <div className="chain-list">
          {chains.map((c) => {
            const active = c.id.toLowerCase() === activeChain.toLowerCase();
            return (
              <div key={c.id} className={`chain-row${active ? " active" : ""}`}>
                <button className="chain-pick" onClick={() => void setActiveChain(c.id)}>
                  <span className="chain-dot" style={{ background: c.color }} />
                  <div className="chain-meta">
                    <div className="chain-name">
                      {c.name}
                      {c.builtin && <span className="chain-builtin">{t("settings.builtin")}</span>}
                    </div>
                    <div className="chain-sub">
                      {c.symbol} · {c.id} · {safeHost(c.rpc)}
                    </div>
                  </div>
                  {active && <span className="chain-active">{t("settings.active")}</span>}
                </button>
                <div className="chain-actions">
                  <button
                    className="chain-icon"
                    title={t("settings.edit")}
                    onClick={() => setEditing(c)}
                  >
                    ✎
                  </button>
                  {!c.builtin && (
                    <button
                      className="chain-icon danger"
                      title={t("settings.remove")}
                      onClick={() => {
                        if (confirm(t("settings.removeConfirm"))) void removeChain(c.id);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {editing ? (
          <NetworkForm
            t={t}
            initial={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
          />
        ) : (
          <button className="add-network-btn" onClick={() => setEditing("new")}>
            + {t("settings.addNetwork")}
          </button>
        )}
      </section>

      {/* ---- Language ---- */}
      <section className="set-section">
        <div className="set-head">
          <h2>{t("settings.language")}</h2>
          <p>{t("settings.languageHint")}</p>
        </div>
        <div className="lang-toggle">
          {(["en", "zh"] as Lang[]).map((l) => (
            <button
              key={l}
              className={`lang-btn${lang === l ? " active" : ""}`}
              onClick={() => setLang(l)}
            >
              {l === "en" ? "English" : "中文"}
            </button>
          ))}
        </div>
      </section>

      {/* ---- About ---- */}
      <section className="set-section">
        <div className="set-head">
          <h2>{t("settings.about")}</h2>
        </div>
        <div className="about-card">
          <img className="about-mascot" src={mascot} alt="" width={56} height={56} />
          <div className="about-meta">
            <div className="about-name">AutoDesktop</div>
            <div className="about-tag">{t("settings.tagline")}</div>
            <div className="about-version">
              {t("settings.version")} {APP_VERSION}
            </div>
          </div>
          <div className="about-actions">
            <button className="check-btn" onClick={() => setUpdateMsg(t("settings.upToDate"))}>
              {t("settings.checkUpdates")}
            </button>
            {updateMsg && <div className="check-msg">{updateMsg}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

// Add / edit a network. `initial === null` = add a custom network; otherwise edit
// (the chain id + built-in flag are fixed for an existing network).
function NetworkForm({
  t,
  initial,
  onClose,
}: {
  t: TFn;
  initial: Chain | null;
  onClose: () => void;
}) {
  const editing = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [id, setId] = useState(initial?.id ?? "");
  const [symbol, setSymbol] = useState(initial?.symbol ?? "ETH");
  const [rpc, setRpc] = useState(initial?.rpc ?? "");
  const [decimals, setDecimals] = useState(String(initial?.decimals ?? 18));
  const [color, setColor] = useState(initial?.color ?? "#6b7280");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const base = {
        id: id.trim(),
        name: name.trim(),
        symbol: symbol.trim() || "ETH",
        rpc: rpc.trim(),
        decimals: parseInt(decimals, 10) || 18,
        color,
      };
      if (editing) await updateChain({ ...base, builtin: initial.builtin });
      else await addChain(base);
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="net-form">
      <div className="net-form-title">
        {editing ? t("settings.editNetwork") : t("settings.addNetwork")}
      </div>
      <div className="net-grid">
        <label className="net-field net-wide">
          {t("settings.netName")}
          <div className="net-name-row">
            <input
              type="color"
              className="net-color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              title="Color"
            />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Network" />
          </div>
        </label>
        <label className="net-field">
          {t("settings.netChainId")}
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="0x… or 1234"
            disabled={editing}
          />
        </label>
        <label className="net-field">
          {t("settings.netSymbol")}
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="ETH" />
        </label>
        <label className="net-field net-wide">
          {t("settings.netRpc")}
          <input
            value={rpc}
            onChange={(e) => setRpc(e.target.value)}
            placeholder="https://…"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <label className="net-field">
          {t("settings.netDecimals")}
          <input value={decimals} onChange={(e) => setDecimals(e.target.value)} placeholder="18" />
        </label>
      </div>
      {error && <div className="net-error">{error}</div>}
      <div className="net-form-actions">
        <button className="net-cancel" onClick={onClose}>
          {t("settings.cancel")}
        </button>
        <button className="net-save" disabled={busy} onClick={submit}>
          {busy ? "…" : t("settings.save")}
        </button>
      </div>
    </div>
  );
}
