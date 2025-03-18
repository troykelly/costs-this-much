var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/AemoDataDurableObject.ts
var AemoData = class {
  static {
    __name(this, "AemoData");
  }
  /**
   * @param state - DO state object, providing SQL storage and transactions.
   * @param env   - Typed environment bindings for AEMO data (URL, headers, etc.).
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  /**
   * Standard fetch handler for this DO. Only responds to POST /sync to ingest data.
   */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/sync" && request.method === "POST") {
      return this.handleSync();
    }
    return new Response("Not found", { status: 404 });
  }
  /**
   * Sync ingestion routine:
   * 1) POST { timeScale: ["5MIN"] } to AEMO_API_URL.
   * 2) Parse expected data from the "5MIN" property of response.
   * 3) CREATE TABLE IF NOT EXISTS intervals(...) if needed.
   * 4) INSERT OR IGNORE intervals to avoid duplicates.
   * 5) Return a summary message about how many intervals were inserted.
   *
   * Uses the documented "transaction" approach from Cloudflare for SQL statements.
   */
  async handleSync() {
    try {
      const sql = this.state.storage.sql;
      if (!sql) {
        console.error("SQL storage not available. Check DO configuration/migrations.");
        return new Response("Sync failed: SQL storage not bound.", { status: 500 });
      }
      const { AEMO_API_URL, AEMO_API_HEADERS } = this.env;
      const parsedHeaders = AEMO_API_HEADERS.trim() ? JSON.parse(AEMO_API_HEADERS) : {};
      const requestBody = { timeScale: ["5MIN"] };
      const response = await fetch(AEMO_API_URL, {
        method: "POST",
        headers: {
          ...parsedHeaders,
          "content-type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error(`AEMO API error ${response.status}: ${errText}`);
        return new Response(`Sync failed: AEMO API ${response.status} - ${errText}`, { status: 500 });
      }
      const apiJson = await response.json();
      const rawData = apiJson["5MIN"];
      if (!Array.isArray(rawData)) {
        console.error("Response missing '5MIN' array property.");
        return new Response("Sync failed: '5MIN' field is invalid or missing.", { status: 500 });
      }
      const intervals = rawData.map((item) => ({
        settlementdate: item.SETTLEMENTDATE,
        regionid: item.REGIONID,
        rrp: parseFloat(String(item.RRP))
      }));
      sql.exec(`
        CREATE TABLE IF NOT EXISTS intervals (
          settlementdate TEXT PRIMARY KEY,
          regionid TEXT,
          rrp NUMERIC
        );
      `);
      let insertedCount = 0;
      await this.state.storage.transaction(async (txnStorage) => {
        const txnSql = txnStorage.sql;
        if (!txnSql) {
          console.error("SQL not available inside transaction callback.");
          return;
        }
        for (const interval of intervals) {
          const cursor = txnSql.exec(
            `INSERT OR IGNORE INTO intervals (settlementdate, regionid, rrp) VALUES (?, ?, ?)`,
            interval.settlementdate,
            interval.regionid,
            interval.rrp
          );
          insertedCount += cursor.rowsWritten;
        }
      });
      const summary = `Sync successful: retrieved ${intervals.length} intervals; inserted ${insertedCount} new.`;
      console.log(summary);
      return new Response(summary, { status: 200 });
    } catch (err) {
      console.error("Sync error:", err);
      return new Response(
        "Sync failed: " + err.message,
        { status: 500 }
      );
    }
  }
};

// src/index.ts
var src_default = {
  /**
   * Called by Cloudflare on your configured cron schedule. This function locates the DO instance
   * (by name), then invokes the /sync route to fetch and store data.
   *
   * @param controller The scheduled task controller.
   * @param env        The typed environment containing references and secrets.
   * @param ctx        The execution context for async tasks.
   */
  async scheduled(controller, env, ctx) {
    try {
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const stub = env.AEMO_DATA.get(id);
      await stub.fetch("https://dummy-url/sync", { method: "POST" });
    } catch (err) {
      console.error("Data logger scheduled task error:", err);
    }
  },
  /**
   * Minimal fetch handler. The data ingestion primarily relies on the scheduled handler above.
   * For local testing, you can run wrangler dev --test-scheduled and
   * call /__scheduled?cron=*+*+*+*+* to simulate the cron invocation.
   */
  async fetch(request, env, ctx) {
    return new Response(
      "AEMO data logger Worker. Cron triggers handle ingestion.\n",
      { headers: { "content-type": "text/plain" } }
    );
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
