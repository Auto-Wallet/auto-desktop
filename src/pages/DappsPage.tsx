import { useMemo, useState } from "react";
import "./DappsPage.css";
import {
  addDapp,
  dappIconOf,
  hostOf,
  isDappUrlInput,
  removeDapp,
  togglePin,
  updateDapp,
  useDapps,
  type Dapp,
} from "../lib/dapps";
import { useT } from "../lib/i18n";
import { Icon } from "../lib/icons";
import { DappAvatar } from "../lib/ui";
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
  const canAddQuery = isDappUrlInput(query) && filtered.length === 0;

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
              if (e.key === "Enter" && canAddQuery) submitAdd();
            }}
          />
          {canAddQuery && (
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
                <div className="empty-add">
                  <span>{t("dapps.noMatches")}</span>
                  {canAddQuery && (
                    <button className="btn btn-primary btn-sm" onClick={submitAdd}>
                      <Icon name="plus" size={14} />
                      {t("dapps.saveQuery", { query })}
                    </button>
                  )}
                </div>
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
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(dapp.name);
  const [url, setUrl] = useState(dapp.url);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setName(dapp.name);
    setUrl(dapp.url);
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setName(dapp.name);
    setUrl(dapp.url);
    setError(null);
    setEditing(false);
  }

  function saveEdit() {
    try {
      updateDapp(dapp.id, url, name);
      setError(null);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
        <div className="dapp-actions">
          <button
            className="dapp-icobtn edit"
            title={t("settings.edit")}
            onClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
          >
            <Icon name="edit" size={14} />
          </button>
          <button
            className="dapp-icobtn rm"
            title={t("settings.remove")}
            onClick={(e) => {
              e.stopPropagation();
              removeDapp(dapp.id);
            }}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>

      <Favicon dapp={dapp} />

      {editing ? (
        <div className="dapp-edit-form" onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            className="dapp-name-edit"
            aria-label={t("dapps.displayName")}
            placeholder={t("dapps.displayName")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") cancelEdit();
            }}
          />
          <input
            className="dapp-url-edit"
            aria-label={t("dapps.url")}
            placeholder={t("dapps.url")}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") cancelEdit();
            }}
          />
          {error && <div className="dapp-edit-error">{error}</div>}
          <div className="dapp-edit-actions">
            <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
              {t("settings.cancel")}
            </button>
            <button className="btn btn-primary btn-sm" onClick={saveEdit}>
              {t("settings.save")}
            </button>
          </div>
        </div>
      ) : (
        <div
          className="dapp-name"
          title={dapp.name}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          {dapp.name}
        </div>
      )}
      {!editing && <div className="dapp-host">{hostOf(dapp.url)}</div>}
    </div>
  );
}

function Favicon({ dapp }: { dapp: Dapp }) {
  const local = dappIconOf(dapp.url);
  if (local) {
    return <img className="dapp-logo" src={local} alt="" />;
  }
  return (
    <DappAvatar name={dapp.name} size={50} style={{ marginTop: 6 }} />
  );
}
