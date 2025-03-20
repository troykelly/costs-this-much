/**
 * @fileoverview Shared types for the API worker.
 */

export interface Env {
  // Provided in secrets:
  CLIENT_IDS: string;       // e.g., '["client-id-1", "client-id-2"]'
  SIGNING_KEYS: string;     // JSON array of key objects (RSA pairs), each with { private, public, start, end, revoked? }
  LOG_LEVEL?: string;       // e.g., "DEBUG", "INFO", "WARN", "ERROR"
  // Rate limiting (also from secrets):
  RATE_LIMIT_MAX?: string;         // e.g., "60"
  RATE_LIMIT_WINDOW_SEC?: string;  // e.g., "60"

  // DO references:
  AEMO_DATA: DurableObjectNamespace;
  API_ABUSE: DurableObjectNamespace;
}

export interface KeyDefinition {
  private: string;
  public: string;
  start: string;  // iso date
  end: string;    // iso date
  revoked?: boolean;
}