export interface Env {
  CLIENT_IDS: string;       // e.g., "[\"client-id-1\", ...]" or single string
  SIGNING_KEYS: string;     // JSON array of key objects
}

export interface KeyDefinition {
  private: string;
  public: string;
  start: string;  // iso date
  end: string;    // iso date
  revoked?: boolean;
}