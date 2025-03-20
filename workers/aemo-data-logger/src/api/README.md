# API Worker (Authentication & Data Retrieval)

This Cloudflare Worker provides an authentication layer and data retrieval endpoints for the frontend.  

--------------------------------------------------------------------------------

## Functionality

1. Client ID & Token Issuance  
   • The frontend passes a valid client ID to a token endpoint, receiving a short-lived JWT and a refresh token (also a JWT).  
   • The Worker checks if the client ID is valid (from environment config).  

2. Data Retrieval Endpoint  
   • Accepts a valid short-lived token (signed JWT with a valid client ID).  
   • Returns up to 31 days of 5-minute data from the SQL DO or any other store, defaulting to 7 days if not specified.  

3. Refresh Token  
   • Allows the frontend to exchange a refresh token for a new short-lived token.  

4. .well-known JWKS  
   • The Worker exposes a .well-known/jwks.json endpoint that returns the public parts of the signing keys.  
   This is used by the frontend (or other clients) for token verification.  

--------------------------------------------------------------------------------

## JWT Key Rotation

• The Worker references environment variables containing an array of signing keys (private/public pairs) with start/end dates and statuses.  
• The most recent active key is used for signing new tokens.  
• Tokens signed with older, still-active keys remain valid until they expire.  
• If a key is revoked, tokens under that key are invalid.  

--------------------------------------------------------------------------------

## Local Development

1. Enable Yarn & Wrangler from the repository root:  
   - yarn install  
   - cd workers/aemo-data-logger  
   - yarn dev:api  

2. Wrangler serves the API Worker at a local dev URL. Test with cURL or Postman to see the JSON responses.  

--------------------------------------------------------------------------------

## Deployment

- Configure your ENV secrets (CLIENT_IDS, SIGNING_KEYS, etc.) in wrangler.api.toml or in Cloudflare Dashboard.  
- yarn publish:api

--------------------------------------------------------------------------------

## Environment Variables

The Worker expects environment variables for controlling key logic:

• CLIENT_IDS: Either a single string of a UUID or a JSON array of valid client IDs. Example:  
  - "00000000-0000-0000-0000-000000000000"  
  - "[\"client-id-1\", \"client-id-2\"]"  

• SIGNING_KEYS: A JSON string array of objects:  
  [
    {"private":"-----BEGIN PRIVATE KEY----- ...","public":"-----BEGIN PUBLIC KEY----- ...","start":"2025-03-01T00:00:00Z","end":"2026-03-01T00:00:00Z","revoked":false},
    ...
  ]  

--------------------------------------------------------------------------------

## File Layout

- wrangler.api.toml: Worker config for the API.  
- src/api/index.ts: Route handling for tokens, refresh, data retrieval.  
- package.json: Dev/publish scripts.  

--------------------------------------------------------------------------------