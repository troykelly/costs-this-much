var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/AemoDataDurableObject.ts
var AemoData = class {
  /**
   * Constructs the DO, assigning Cloudflare’s SQL storage to "this.sql".
   * Immediately creates the "intervals" table if it doesn’t exist.
   */
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.env = env;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS intervals (
        settlementdate TEXT PRIMARY KEY,
        regionid TEXT,
        rrp NUMERIC
      );
    `);
  }
  static {
    __name(this, "AemoData");
  }
  /**
   * The DO responds to POST /sync by:
   * 1) Fetching data from AEMO_API_URL with a body of { timeScale: ["5MIN"] }.
   * 2) Parsing the "5MIN" array.
   * 3) Inserting intervals using INSERT OR IGNORE to skip duplicates.
   */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      return this.handleSync();
    }
    return new Response("Not Found", { status: 404 });
  }
  /**
   * Makes a POST to AEMO_API_URL, converts response to typed intervals,
   * then inserts them into the table, ignoring duplicates.
   */
  async handleSync() {
    const requestBody = { timeScale: ["5MIN"] };
    const headers = this.parseHeaders(this.env.AEMO_API_HEADERS);
    const resp = await fetch(this.env.AEMO_API_URL, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    if (!resp.ok) {
      const err = await resp.text();
      return new Response(`AEMO API error ${resp.status}: ${err}`, { status: 500 });
    }
    const data = await resp.json();
    if (!Array.isArray(data["5MIN"])) {
      return new Response(`Invalid or missing "5MIN" array in response.`, { status: 500 });
    }
    const intervals = data["5MIN"].map((item) => ({
      settlementdate: item.SETTLEMENTDATE,
      regionid: item.REGIONID,
      rrp: parseFloat(String(item.RRP))
    }));
    let insertedCount = 0;
    for (const interval of intervals) {
      const cursor = this.sql.exec(
        `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
        interval.settlementdate,
        interval.regionid,
        interval.rrp
      );
      insertedCount += cursor.rowsWritten;
    }
    return new Response(
      `Synced ${intervals.length} intervals, inserted ${insertedCount} new.`,
      { status: 200 }
    );
  }
  /**
   * Safely parse JSON headers or return an empty object if invalid.
   */
  parseHeaders(raw) {
    try {
      return raw && raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
};

// src/index.ts
var WORKER_INFO = `AEMO Data Logger Worker. 
Runs on a CRON schedule, calls the DO\u2019s /sync route to ingest intervals.`;
var src_default = {
  /**
   * Invoked by Cloudflare’s scheduler as configured in wrangler.*.toml (e.g., every 5min).
   */
  async scheduled(controller, env, ctx) {
    const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
    const stub = env.AEMO_DATA.get(id);
    await stub.fetch("https://dummy-url/sync", { method: "POST" });
  },
  /**
   * Minimal fetch handler. For local dev, you can run wrangler dev --test-scheduled
   * or call /__scheduled?cron=*+*+*+*+* to simulate the scheduled event triggers.
   */
  async fetch(req, env, ctx) {
    return new Response(WORKER_INFO, { headers: { "Content-Type": "text/plain" } });
  }
};

// ../../../../usr/local/share/npm-global/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../usr/local/share/npm-global/lib/node_modules/wrangler/templates/middleware/middleware-scheduled.ts
var scheduled = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  const url = new URL(request.url);
  if (url.pathname === "/__scheduled") {
    const cron = url.searchParams.get("cron") ?? "";
    await middlewareCtx.dispatch("scheduled", { cron });
    return new Response("Ran scheduled event");
  }
  const resp = await middlewareCtx.next(request, env);
  if (request.headers.get("referer")?.endsWith("/__scheduled") && url.pathname === "/favicon.ico" && resp.status === 500) {
    return new Response(null, { status: 404 });
  }
  return resp;
}, "scheduled");
var middleware_scheduled_default = scheduled;

// ../../../../usr/local/share/npm-global/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-NpG2Z4/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_scheduled_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../usr/local/share/npm-global/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-NpG2Z4/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  AemoData,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
