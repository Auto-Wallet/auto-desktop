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
  installProvider(transport, { forceInject: true, lockEthereum: true });
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
