import { useState } from "react";
import "./SettingsPage.css";
import mascot from "../assets/mascot.png";
import { CHAINS } from "../lib/chains";
import { setActiveChain, useActiveChain } from "../lib/activeChain";
import { setLang, useT, type Lang } from "../lib/i18n";

const APP_VERSION = "0.1.0"; // mirrors src-tauri/tauri.conf.json

export default function SettingsPage() {
  const { t, lang } = useT();
  const activeChain = useActiveChain();
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

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
          {CHAINS.map((c) => {
            const active = c.id.toLowerCase() === activeChain.toLowerCase();
            return (
              <button
                key={c.id}
                className={`chain-row${active ? " active" : ""}`}
                onClick={() => void setActiveChain(c.id)}
              >
                <span className="chain-dot" style={{ background: c.color }} />
                <div className="chain-meta">
                  <div className="chain-name">{c.name}</div>
                  <div className="chain-sub">
                    {c.symbol} · {c.id} · {new URL(c.rpc).hostname}
                  </div>
                </div>
                {active && <span className="chain-active">{t("settings.active")}</span>}
              </button>
            );
          })}
        </div>
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
