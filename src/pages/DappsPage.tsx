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

export default function DappsPage({ onOpen }: { onOpen?: (dapp: Dapp) => void }) {
  const { t } = useT();
  const dapps = useDapps();
  const [query, setQuery] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? dapps.filter(
          (d) => d.name.toLowerCase().includes(q) || hostOf(d.url).includes(q),
        )
      : dapps;
    // Pinned first, then alphabetical.
    return [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [dapps, query]);

  function submitAdd() {
    const value = query.trim();
    if (!value) return;
    try {
      addDapp(value);
      setQuery("");
      setAddError(null);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    }
  }

  const looksLikeUrl = /\.[a-z]{2,}/i.test(query) && !visible.length;

  return (
    <div className="dapps">
      <header className="dapps-head">
        <h1>{t("dapps.title")}</h1>
        <div className="search-wrap">
          <span className="search-icon">⌕</span>
          <input
            className="search"
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
            <button className="search-add" onClick={submitAdd}>
              + {t("dapps.add")}
            </button>
          )}
        </div>
      </header>

      {addError && <div className="dapps-error">{addError}</div>}

      {visible.length === 0 ? (
        <div className="dapps-empty">
          {query ? (
            <>No matches. Press <b>{t("dapps.add")}</b> to save “{query}”.</>
          ) : (
            t("dapps.empty")
          )}
        </div>
      ) : (
        <div className="dapp-grid">
          {visible.map((d) => (
            <DappCard key={d.id} dapp={d} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
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
      <div className="card-top">
        <button
          className={`pin${dapp.pinned ? " on" : ""}`}
          title={dapp.pinned ? "Unpin" : "Pin"}
          onClick={(e) => {
            e.stopPropagation();
            togglePin(dapp.id);
          }}
        >
          {dapp.pinned ? "★" : "☆"}
        </button>
        <button
          className="remove"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            removeDapp(dapp.id);
          }}
        >
          ×
        </button>
      </div>

      <Favicon dapp={dapp} />

      {editing ? (
        <input
          autoFocus
          className="name-edit"
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
          title="Double-click to rename"
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
    return (
      <div className="dapp-logo fallback">{dapp.name.charAt(0).toUpperCase()}</div>
    );
  }
  return (
    <img
      className="dapp-logo"
      src={faviconOf(dapp.url)}
      alt=""
      width={44}
      height={44}
      onError={() => setFailed(true)}
    />
  );
}
