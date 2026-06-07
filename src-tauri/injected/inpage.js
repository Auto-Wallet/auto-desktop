(() => {
  // ../auto-wallet-core/src/provider/provider.ts
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
        const chainId = await this.request({ method: "eth_chainId" });
        if (chainId)
          this._chainId = chainId;
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
        this._chainId = result;
      } else if (method === "wallet_switchEthereumChain") {
        const p = params[0];
        if (p?.chainId) {
          this._chainId = p.chainId;
          this._emit("chainChanged", p.chainId);
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
  // ../auto-wallet-core/src/provider/inject.ts
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
      w.ethereum = provider;
      provider.isMetaMask = !hadOther;
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
  var transport = {
    async request({ method, params }) {
      const invoke = await getInvoke();
      return invoke("wallet_request", { method, params });
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
  installProvider(transport, { forceInject: true });
  console.log("[AutoDesktop] Auto Wallet provider injected");
  function installLinkInterceptor() {
    const openExternal = (url) => {
      if (!/^https?:\/\//i.test(url))
        return false;
      getInvoke().then((invoke) => invoke("open_external_url", { url })).catch((e) => console.error("[AutoDesktop] open_external_url failed", e));
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
})();
