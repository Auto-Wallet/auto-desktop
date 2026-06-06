import { useMemo, useState } from "react";
import "./DappsPage.css";
import {
  addDapp,
  faviconOf,
  hostOf,
  removeDapp,
  renameDapp,
  togglePin,
  useDapps,
  type Dapp,
} from "../lib/dapps";
import { useT } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";

// dApps page (VISION ②) — Aurora: search + add, a Pinned section, the grid, and
// per-card pin / remove / double-click rename. Real store (localStorage).
export default function DappsPage({ onOpen }: { onOpen?: (dapp: Dapp) => void }) {
  const { t } = useT();
  const dapps = useDapps();
  const [query, setQuery] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? dapps.filter((d) => d.name.toLowerCase().includes(q) || hostOf(d.url).includes(q))
      : dapps;
  }, [dapps, query]);

  const pinned = filtered.filter((d) => d.pinned).sort((a, b) => a.name.localeCompare(b.name));
  const rest = filtered.filter((d) => !d.pinned).sort((a, b) => a.name.localeCompare(b.name));
  const looksLikeUrl = /\.[a-z]{2,}/i.test(query) && filtered.length === 0;

  function submitAdd() {
    const value = query.trim();
    if (!value) return;
    try {
      addDapp(value);
      setQuery("");
      setAddError(null);
      toast(t("dapps.added"));
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{t("dapps.exploreTitle")}</div>
        <div className="grow" />
        <div className="dapps-search">
          <Icon name="search" size={18} />
          <input
            placeholder={t("dapps.search")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && looksLikeUrl) submitAdd();
            }}
          />
          {looksLikeUrl && (
            <button className="btn btn-primary btn-sm" onClick={submitAdd}>
              {t("dapps.add")}
            </button>
          )}
        </div>
      </div>

      {addError && <div className="dapps-error">{addError}</div>}

      <div className="page scroll">
        <div className="dapps-pad">
          {pinned.length > 0 && (
            <>
              <div className="dapp-section-label">
                <Icon name="star" size={13} fill="currentColor" /> {t("dapps.pinned")}
              </div>
              <div className="dapp-grid">
                {pinned.map((d) => (
                  <DappCard key={d.id} dapp={d} onOpen={onOpen} />
                ))}
              </div>
            </>
          )}

          <div className="dapp-section-label">
            <Icon name="apps" size={13} /> {pinned.length ? t("dapps.all") : t("dapps.yours")}
          </div>
          {rest.length === 0 && pinned.length === 0 ? (
            <div className="empty">
              {query ? (
                <>
                  No matches. Press <b>{t("dapps.add")}</b> to save “{query}”.
                </>
              ) : (
                t("dapps.empty")
              )}
            </div>
          ) : (
            <div className="dapp-grid">
              {rest.map((d) => (
                <DappCard key={d.id} dapp={d} onOpen={onOpen} />
              ))}
              <button className="dapp-card dapp-add-card" onClick={() => toast(t("dapps.addHint"), "info")}>
                <Icon name="plus" size={26} />
                <div className="dapp-name" style={{ color: "inherit", marginTop: 4 }}>
                  {t("dapps.addCard")}
                </div>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function DappCard({ dapp, onOpen }: { dapp: Dapp; onOpen?: (d: Dapp) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(dapp.name);

  function commitName() {
    renameDapp(dapp.id, name);
    setEditing(false);
  }

  return (
    <div className="dapp-card" onClick={() => !editing && onOpen?.(dapp)}>
      <div className="dapp-top">
        <button
          className={`dapp-icobtn${dapp.pinned ? " pinned" : ""}`}
          title={dapp.pinned ? "Unpin" : "Pin"}
          onClick={(e) => {
            e.stopPropagation();
            togglePin(dapp.id);
          }}
        >
          <Icon name="star" size={16} fill={dapp.pinned ? "currentColor" : "none"} />
        </button>
        <button
          className="dapp-icobtn rm"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            removeDapp(dapp.id);
          }}
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      <Favicon dapp={dapp} />

      {editing ? (
        <input
          autoFocus
          className="dapp-name-edit"
          value={name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={commitName}
        />
      ) : (
        <div
          className="dapp-name"
          title={dapp.name}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setName(dapp.name);
            setEditing(true);
          }}
        >
          {dapp.name}
        </div>
      )}
      <div className="dapp-host">{hostOf(dapp.url)}</div>
    </div>
  );
}

function Favicon({ dapp }: { dapp: Dapp }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="dapp-logo fb">{dapp.name.charAt(0).toUpperCase()}</div>;
  }
  return (
    <img
      className="dapp-logo"
      src={faviconOf(dapp.url)}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}
