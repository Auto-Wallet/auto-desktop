import { useState } from "react";
import "./SettingsPage.css";
import mascot from "../assets/mascot.png";
import { addChain, removeChain, updateChain, useChains, type Chain } from "../lib/chains";
import { setActiveChain, useActiveChain } from "../lib/activeChain";
import { lockVault } from "../lib/vault";
import { useActiveWallet } from "../lib/accounts";
import { setLang, useT, type Lang, type TFn } from "../lib/i18n";
import { setThemePref, useThemePref, type ThemePref } from "../lib/theme";
import { setCloseBehavior, useCloseBehavior } from "../lib/appPrefs";
import { Icon, type IconName } from "../lib/icons";
import { toast } from "../lib/toast";

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
  const themePref = useThemePref();
  const closeBehavior = useCloseBehavior();
  const activeWallet = useActiveWallet();
  const [updated, setUpdated] = useState(false);
  const [editing, setEditing] = useState<Chain | "new" | null>(null);

  const themeOpts: [ThemePref, IconName, string][] = [
    ["system", "monitor", t("settings.system")],
    ["light", "sun", t("settings.light")],
    ["dark", "moon", t("settings.dark")],
  ];

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{t("settings.title")}</div>
      </div>

      <div className="page scroll">
        <div className="settings-pad">
          {/* Networks */}
          <div className="set-group">
            <div className="set-group-head">
              <h2>
                <Icon name="globe" size={16} /> {t("settings.network")}
              </h2>
              <p>{t("settings.networkHint")}</p>
            </div>
            <div className="set-card">
              {chains.map((c) => {
                const on = c.id.toLowerCase() === activeChain.toLowerCase();
                return (
                  <div key={c.id} className={`chain-row${on ? " on" : ""}`}>
                    <button className="chain-pick" onClick={() => void setActiveChain(c.id)}>
                      <span className="chain-radio" />
                      <span className="chain-dot" style={{ width: 26, height: 26, background: c.color }} />
                      <div className="chain-info">
                        <div className="chain-nm">
                          {c.name}
                          {c.builtin && <span className="badge neutral">{t("settings.builtin")}</span>}
                        </div>
                        <div className="chain-meta">
                          {c.symbol} · {c.id} · {safeHost(c.rpc)}
                        </div>
                      </div>
                    </button>
                    <div className="chain-acts">
                      <button className="icon-btn bare" title={t("settings.edit")} onClick={() => setEditing(c)}>
                        <Icon name="edit" size={16} />
                      </button>
                      {!c.builtin && (
                        <button
                          className="icon-btn bare"
                          title={t("settings.remove")}
                          onClick={() => {
                            if (confirm(t("settings.removeConfirm"))) {
                              void removeChain(c.id);
                              toast(t("dapps.removed"));
                            }
                          }}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {editing ? (
              <NetworkForm t={t} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
            ) : (
              <button className="add-net" onClick={() => setEditing("new")}>
                <Icon name="plus" size={16} /> {t("settings.addNetwork")}
              </button>
            )}
          </div>

          {/* Appearance */}
          <div className="set-group">
            <div className="set-group-head">
              <h2>
                <Icon name="sun" size={16} /> {t("settings.appearance")}
              </h2>
              <p>{t("settings.appearanceHint")}</p>
            </div>
            <div className="set-card">
              <div className="set-row">
                <div className="gr">
                  <div className="rl">{t("settings.theme")}</div>
                  <div className="rs">{t("settings.themeHint")}</div>
                </div>
                <div className="seg">
                  {themeOpts.map(([v, ic, lbl]) => (
                    <button key={v} className={themePref === v ? "on" : ""} onClick={() => setThemePref(v)}>
                      <Icon name={ic} size={15} /> {lbl}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row">
                <div className="gr">
                  <div className="rl">{t("settings.closeBehavior")}</div>
                  <div className="rs">{t("settings.closeBehaviorHint")}</div>
                </div>
                <button
                  className={`toggle${closeBehavior === "hide" ? " on" : ""}`}
                  aria-pressed={closeBehavior === "hide"}
                  onClick={() => void setCloseBehavior(closeBehavior === "hide" ? "quit" : "hide")}
                >
                  <i />
                </button>
              </div>
            </div>
          </div>

          {/* Language */}
          <div className="set-group">
            <div className="set-group-head">
              <h2>
                <Icon name="globe" size={16} /> {t("settings.language")}
              </h2>
              <p>{t("settings.languageHint")}</p>
            </div>
            <div className="set-card">
              <div className="set-row">
                <div className="gr">
                  <div className="rl">{t("settings.language")}</div>
                  <div className="rs">English · 中文</div>
                </div>
                <div className="seg">
                  {(["en", "zh"] as Lang[]).map((l) => (
                    <button key={l} className={lang === l ? "on" : ""} onClick={() => setLang(l)}>
                      {l === "en" ? "English" : "中文"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Security */}
          <div className="set-group">
            <div className="set-group-head">
              <h2>
                <Icon name="shield" size={16} /> {t("settings.security")}
              </h2>
            </div>
            <div className="set-card">
              {activeWallet?.kind === "ledger" ? (
                <div className="set-row">
                  <span className="row-ic">
                    <Icon name="ledger" size={17} />
                  </span>
                  <div className="gr">
                    <div className="rl">Ledger</div>
                    <div className="rs">{t("lock.optLedgerDesc")}</div>
                  </div>
                </div>
              ) : (
                <>
                  <button className="set-row" onClick={() => void lockVault()}>
                    <span className="row-ic">
                      <Icon name="lock" size={17} />
                    </span>
                    <div className="gr">
                      <div className="rl">{t("settings.lockNow")}</div>
                      <div className="rs">{t("settings.lockNowHint")}</div>
                    </div>
                    <Icon name="chevronR" size={16} />
                  </button>
                  {activeWallet?.kind === "hd" && (
                    <button className="set-row" onClick={() => toast(t("settings.soon"), "info")}>
                      <span className="row-ic">
                        <Icon name="key" size={17} />
                      </span>
                      <div className="gr">
                        <div className="rl">{t("settings.revealPhrase")}</div>
                        <div className="rs">{t("settings.revealPhraseHint")}</div>
                      </div>
                      <span className="badge neutral">{t("settings.soon")}</span>
                    </button>
                  )}
                  <button className="set-row" onClick={() => toast(t("settings.soon"), "info")}>
                    <span className="row-ic">
                      <Icon name="edit" size={17} />
                    </span>
                    <div className="gr">
                      <div className="rl">{t("settings.changePassword")}</div>
                      <div className="rs">{t("settings.changePasswordHint")}</div>
                    </div>
                    <span className="badge neutral">{t("settings.soon")}</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* About */}
          <div className="set-group">
            <div className="set-group-head">
              <h2>
                <Icon name="info" size={16} /> {t("settings.about")}
              </h2>
            </div>
            <div className="set-card">
              <div className="about-card">
                <img className="about-mark" src={mascot} alt="" />
                <div className="about-meta">
                  <div className="about-name">AutoDesktop</div>
                  <div className="about-tag">{t("settings.tagline")}</div>
                  {updated ? (
                    <div className="up-to-date">
                      <Icon name="check" size={13} /> {t("settings.upToDate")}
                    </div>
                  ) : (
                    <div className="about-ver">
                      {t("settings.version")} {APP_VERSION}
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setUpdated(true);
                    toast(t("settings.upToDate"));
                  }}
                >
                  {t("settings.checkUpdates")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// Add / edit a network. `initial === null` = add a custom network; otherwise edit
// (the chain id + built-in flag are fixed for an existing network).
function NetworkForm({ t, initial, onClose }: { t: TFn; initial: Chain | null; onClose: () => void }) {
  const editing = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [id, setId] = useState(initial?.id ?? "");
  const [symbol, setSymbol] = useState(initial?.symbol ?? "ETH");
  const [rpc, setRpc] = useState(initial?.rpc ?? "");
  const [decimals, setDecimals] = useState(String(initial?.decimals ?? 18));
  const [color, setColor] = useState(initial?.color ?? "#5b4bf0");
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
      <div className="net-form-title">{editing ? t("settings.editNetwork") : t("settings.addNetwork")}</div>
      <div className="net-grid">
        <div className="field net-wide">
          <label className="field-label">{t("settings.netName")}</label>
          <div className="net-name-row">
            <input type="color" className="net-color" value={color} onChange={(e) => setColor(e.target.value)} />
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Network" />
          </div>
        </div>
        <div className="field">
          <label className="field-label">{t("settings.netChainId")}</label>
          <input
            className="input mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="0x… or 1234"
            disabled={editing}
          />
        </div>
        <div className="field">
          <label className="field-label">{t("settings.netSymbol")}</label>
          <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="ETH" />
        </div>
        <div className="field net-wide">
          <label className="field-label">{t("settings.netRpc")}</label>
          <input
            className="input mono"
            value={rpc}
            onChange={(e) => setRpc(e.target.value)}
            placeholder="https://…"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div className="field">
          <label className="field-label">{t("settings.netDecimals")}</label>
          <input className="input mono" value={decimals} onChange={(e) => setDecimals(e.target.value)} placeholder="18" />
        </div>
      </div>
      {error && <div className="net-error">{error}</div>}
      <div className="net-acts">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          {t("settings.cancel")}
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy || !name || !id} onClick={submit}>
          {busy ? "…" : t("settings.save")}
        </button>
      </div>
    </div>
  );
}
