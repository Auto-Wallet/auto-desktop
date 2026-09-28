(() => {
  // src/wallet-core/provider/provider.ts
  class AutoWalletProvider {
    isAutoWallet = true;
    isMetaMask = false;
    _events = new Map;
    _transport;
    _chainId = "0x1";
    _accounts = [];
    constructor(transport) {
      this._transport = transport;
      this._transport.subscribe((name, payload) => this._handleEvent(name, payload));
      this._init();
    }
    async _init() {
      try {
        const accounts = await this.request({ method: "eth_accounts" });
        if (accounts?.length)
          this._accounts = accounts;
        await this.request({ method: "eth_chainId" });
      } catch {}
    }
    get chainId() {
      return this._chainId;
    }
    get selectedAddress() {
      return this._accounts[0] ?? null;
    }
    async request(args) {
      const method = args.method;
      const params = Array.isArray(args.params) ? args.params : [];
      const origin = typeof location !== "undefined" ? location.origin : "";
      const result = await this._transport.request({ method, params, origin });
      if (method === "eth_requestAccounts" || method === "eth_accounts") {
        this._accounts = result ?? this._accounts;
      } else if (method === "eth_chainId") {
        const normalized = normalizeChainId(typeof result === "string" ? result : undefined);
        if (normalized)
          this._chainId = normalized;
      } else if (method === "wallet_switchEthereumChain") {
        const p = params[0];
        const normalized = normalizeChainId(p?.chainId);
        if (normalized && normalized !== this._chainId) {
          this._chainId = normalized;
          this._emit("chainChanged", normalized);
        }
      }
      return result;
    }
    enable() {
      return this.request({ method: "eth_requestAccounts" });
    }
    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === "string") {
        return this.request({ method: methodOrPayload, params: paramsOrCallback });
      }
      const payload = methodOrPayload;
      if (typeof paramsOrCallback === "function") {
        const cb = paramsOrCallback;
        this.request({ method: payload.method, params: payload.params }).then((result) => cb(null, { id: payload.id, jsonrpc: "2.0", result })).catch((err) => cb(err));
        return;
      }
      return this.request({ method: payload.method, params: payload.params });
    }
    sendAsync(payload, callback) {
      this.request({ method: payload.method, params: payload.params }).then((result) => callback(null, { id: payload.id, jsonrpc: "2.0", result })).catch((err) => callback(err));
    }
    on(event, handler) {
      if (!this._events.has(event))
        this._events.set(event, new Set);
      this._events.get(event).add(handler);
      return this;
    }
    removeListener(event, handler) {
      this._events.get(event)?.delete(handler);
      return this;
    }
    removeAllListeners(event) {
      if (event)
        this._events.delete(event);
      else
        this._events.clear();
      return this;
    }
    _emit(event, ...args) {
      this._events.get(event)?.forEach((handler) => {
        try {
          handler(...args);
        } catch (e) {
          console.error("[Auto Wallet] event handler error:", e);
        }
      });
    }
    _handleEvent(eventName, payload) {
      if (eventName === "accountsChanged") {
        this._accounts = payload ?? [];
      } else if (eventName === "chainChanged") {
        this._chainId = payload;
      }
      this._emit(eventName, payload);
    }
  }
  function normalizeChainId(id) {
    if (!id)
      return null;
    const s = id.trim();
    const value = /^0x[0-9a-fA-F]+$/i.test(s) ? BigInt(s.toLowerCase()) : /^[0-9]+$/.test(s) ? BigInt(s) : null;
    return value && value > 0n ? `0x${value.toString(16)}` : null;
  }
  // src/wallet-core/provider/inject.ts
  var BLOCKED_PROVIDER_HOSTS = new Set(["docs.google.com"]);
  function isProviderInjectionAllowed(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return false;
    return !BLOCKED_PROVIDER_HOSTS.has(url.hostname.toLowerCase());
  }
  var DEFAULT_ICON = "data:image/svg+xml;base64," + btoaSafe('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' + '<rect width="96" height="96" rx="22" fill="#5b8cff"/>' + '<text x="50%" y="56%" text-anchor="middle" dominant-baseline="middle" ' + 'font-family="system-ui,Arial" font-size="52" font-weight="700" fill="#fff">A</text>' + "</svg>");
  function btoaSafe(s) {
    if (typeof btoa === "function")
      return btoa(s);
    return Buffer.from(s, "binary").toString("base64");
  }
  var DEFAULT_PROVIDER_INFO = {
    uuid: "10a4b7f8-3c2d-4e5a-9f6b-1d2e3f4a5b6c",
    name: "Auto Wallet",
    icon: DEFAULT_ICON,
    rdns: "com.auto-wallet"
  };
  function installProvider(transport, opts = {}) {
    if (!opts.skipPolicy && !isProviderInjectionAllowed(location.href)) {
      return null;
    }
    const provider = new AutoWalletProvider(transport);
    const info = { ...DEFAULT_PROVIDER_INFO, ...opts.info };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider })
    }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    const w = window;
    const existing = w.ethereum;
    const hadOther = !!existing && existing !== provider;
    if (opts.forceInject || !existing) {
      provider.isMetaMask = !hadOther;
      if (opts.lockEthereum) {
        Object.freeze(Object.getPrototypeOf(provider));
        Object.defineProperty(w, "ethereum", {
          value: provider,
          writable: false,
          configurable: false,
          enumerable: true
        });
      } else {
        w.ethereum = provider;
      }
    }
    w.autoWallet = provider;
    return provider;
  }
  // src/injected/inpage.tauri.ts
  function findInvoke() {
    const w = window;
    if (w.__TAURI_INTERNALS__?.invoke)
      return w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    if (w.__TAURI__?.core?.invoke)
      return w.__TAURI__.core.invoke.bind(w.__TAURI__.core);
    return null;
  }
  function waitForInvoke(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const fn = findInvoke();
        if (fn)
          return resolve(fn);
        if (Date.now() - start > timeoutMs)
          return reject(new Error("AutoDesktop: Tauri IPC unavailable"));
        setTimeout(tick, 30);
      };
      tick();
    });
  }
  var invokeReady = null;
  var getInvoke = () => invokeReady ??= waitForInvoke();
  function providerError(error) {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
    const out = new Error(message);
    const codeMatch = message.match(/(?:code\s*)?(\b49\d{2}\b|\b4\d{3}\b)/i);
    if (codeMatch)
      out.code = Number(codeMatch[1]);
    return out;
  }
  var transport = {
    async request({ method, params }) {
      const invoke = await getInvoke();
      try {
        return await invoke("wallet_request", { method, params });
      } catch (e) {
        throw providerError(e);
      }
    },
    subscribe(handler) {
      const w = window;
      w.__autoWalletPush = (name, payload) => {
        try {
          handler(name, payload);
        } catch (e) {
          console.error("[AutoDesktop] push handler error", e);
        }
      };
      return () => {
        delete w.__autoWalletPush;
      };
    }
  };
  installProvider(transport, { forceInject: true, lockEthereum: true, info: { icon: "data:image/png;base64,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" } });
  console.log("[AutoDesktop] Auto Wallet provider injected");
  function installLinkInterceptor() {
    const openExternal = (url) => {
      let target;
      try {
        target = new URL(url, location.href).toString();
      } catch {
        return false;
      }
      if (!/^https?:\/\//i.test(target))
        return false;
      getInvoke().then((invoke) => invoke("open_external_url", { url: target })).catch((e) => console.error("[AutoDesktop] open_external_url failed", e));
      return true;
    };
    const nativeOpen = window.open.bind(window);
    window.open = function(url, target, features) {
      const u = url == null ? "" : String(url);
      if (u && openExternal(u))
        return null;
      return nativeOpen(url, target, features);
    };
    document.addEventListener("click", (e) => {
      const anchor = e.target?.closest?.("a");
      if (!anchor || anchor.target !== "_blank")
        return;
      const href = anchor.href || anchor.getAttribute("href") || "";
      if (openExternal(href)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }
  installLinkInterceptor();
  function installDialogInterceptor() {
    let lastTrigger = null;
    let replaying = false;
    let cachedResult = null;
    let pendingSignature = null;
    const signature = (kind, message, defaultValue) => JSON.stringify([kind, message, defaultValue ?? null]);
    const targetStillUsable = (target) => target instanceof HTMLElement && document.contains(target);
    const recordTrigger = (event) => {
      if (replaying)
        return;
      const target = event.target;
      if (event.type === "click") {
        lastTrigger = { target, type: "click" };
        return;
      }
      if (event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " ")) {
        lastTrigger = { target, type: "keydown", key: event.key };
      }
    };
    document.addEventListener("click", recordTrigger, true);
    document.addEventListener("keydown", recordTrigger, true);
    const replayLastTrigger = () => {
      const trigger = lastTrigger;
      if (!trigger || !targetStillUsable(trigger.target))
        return;
      replaying = true;
      try {
        if (trigger.type === "click") {
          trigger.target.click();
        } else {
          trigger.target.dispatchEvent(new KeyboardEvent("keydown", { key: trigger.key, bubbles: true, cancelable: true }));
        }
      } catch (e) {
        console.error("[AutoDesktop] dapp dialog replay failed", e);
      } finally {
        window.setTimeout(() => {
          replaying = false;
        }, 0);
      }
    };
    const takeCachedResult = (kind, message, defaultValue) => {
      const cached = cachedResult;
      if (!cached)
        return null;
      if (cached.kind !== kind || cached.message !== message || (cached.defaultValue ?? "") !== (defaultValue ?? "")) {
        return null;
      }
      cachedResult = null;
      return cached.result;
    };
    const showDialog = (kind, message, defaultValue) => getInvoke().then((invoke) => invoke("dapp_dialog", { kind, message, defaultValue })).catch((e) => {
      console.error("[AutoDesktop] dapp_dialog failed", e);
      return { action: "cancel", value: null };
    });
    const requestReplayableDialog = (kind, message, defaultValue) => {
      const sig = signature(kind, message, defaultValue);
      if (pendingSignature === sig)
        return;
      pendingSignature = sig;
      showDialog(kind, message, defaultValue).then((result) => {
        pendingSignature = null;
        if (result.action !== "ok")
          return;
        cachedResult = { kind, message, defaultValue, result };
        window.setTimeout(replayLastTrigger, 0);
      });
    };
    window.alert = function(message) {
      showDialog("alert", String(message ?? ""));
    };
    window.confirm = function(message) {
      const text = String(message ?? "");
      const cached = takeCachedResult("confirm", text);
      if (cached)
        return cached.action === "ok";
      requestReplayableDialog("confirm", text);
      return false;
    };
    window.prompt = function(message, defaultValue) {
      const text = String(message ?? "");
      const fallback = defaultValue == null ? "" : String(defaultValue);
      const cached = takeCachedResult("prompt", text, fallback);
      if (cached)
        return typeof cached.value === "string" ? cached.value : "";
      requestReplayableDialog("prompt", text, fallback);
      return null;
    };
    window.print = function() {
      showDialog("print", "This page requested printing.");
    };
  }
  installDialogInterceptor();
})();
