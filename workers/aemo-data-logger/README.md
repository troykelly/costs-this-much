# AEMO Data Logger & API Worker

This folder now contains two Cloudflare Worker modes of operation that share a single SQL-based Durable Object (“AemoDataDO"):

1. **Data Logger Mode**  
   - Retrieves electricity market data from AEMO at scheduled intervals.  
   - Uses the “wrangler.logger.toml” to configure cron scheduling.  

2. **API Mode**  
   - Provides authentication (JWT issuance & refresh) and offers a data retrieval endpoint for clients.  
   - Uses the “wrangler.api.toml” to configure HTTP routes for token and data operations.  

--------------------------------------------------------------------------------

## Overview

Both modes rely on the same Durable Object, which uses Cloudflare’s SQL-backed storage to persist time-series data. This allows you to:

• Store historical intervals (e.g., 5-minute settlement data) without complicated external databases.  
• Query stored intervals to serve requests in the API.  

--------------------------------------------------------------------------------

## Data Logger Mode

• **Purpose**: Continuously fetch and store data from AEMO.  
• **Configuration File**: “wrangler.logger.toml”  
• **Entry Point**: “src/index.ts”  

Key steps in this mode:

1. **Scheduled Execution**: Runs every 5 minutes offset by 1 minute (e.g., 01, 06, 11, 16...).  
2. **Missing Data Detection** (Future Implementation Needed):  
   - Determine which intervals in the last 36 hours are not in the DO’s database.  
3. **Fetching & Insertion**:  
   - Retrieve data from AEMO, parse the intervals, and insert new records into the Durable Object’s SQL database.  
   - Duplicate records are skipped by an “INSERT OR IGNORE” approach to prevent re-inserting intervals.  
4. **Error Handling** (Future Implementation Needed):  
   - Properly handle network or data inaccuracies. Possibly re-fetch on failures.  

--------------------------------------------------------------------------------

## API Mode

• **Purpose**: Exposes JWT-secured endpoints for retrieving data (and, optionally, issuing/revoking tokens).  
• **Configuration File**: “wrangler.api.toml”  
• **Entry Point**: “src/api/index.ts”  

Key endpoints (placeholders):

1. **/.well-known/jwks.json**  
   - Returns public keys for clients to verify JWT signatures.  
2. **POST /token**  
   - Issues short-lived access token and a longer-lived refresh token for valid client IDs.  
3. **POST /refresh**  
   - Exchanges a refresh token for a new short-lived access token.  
4. **GET /data**  
   - Retrieves data (such as up to 31 days of 5-minute intervals) from the shared DO, currently a stub.  

--------------------------------------------------------------------------------

## Local Development

1. **Install Dependencies**  
   - From the repo root, run:  
     yarn install
   - Then cd into this folder:  
     cd workers/aemo-data-logger

2. **Run Logger Mode**  
   - Prepare a local environment and run:  
     yarn dev:logger
   - This uses “wrangler.logger.toml” and follows the code in “src/index.ts”.  
   - Note: Cron triggers are not automatically fired locally unless you use the Wrangler “test scheduled” mechanism.  
   - To invoke scheduled logic for testing, run:  
     npx wrangler dev --test-scheduled  
     curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"

3. **Run API Mode**  
   - To start the API in local dev mode, run:  
     yarn dev:api
   - This uses “wrangler.api.toml” and hosts the endpoints in “src/api/index.ts”.  

4. **Testing**  
   - For the API, test endpoints with curl or Postman (e.g., “GET /data”).  
   - For the logger in local development, trigger the scheduled event as shown above.  

--------------------------------------------------------------------------------

## Publishing

• **Logger**:  
  yarn publish:logger  
  Deploys the scheduled Worker that retrieves data from AEMO.

• **API**:  
  yarn publish:api  
  Deploys the authentication and data retrieval API.  

--------------------------------------------------------------------------------

## Environment Variables

Both modes rely on environment variables set in their respective “wrangler.*.toml” or the Cloudflare Dashboard:

• **AEMO_API_URL** / **AEMO_API_HEADERS** (Logger)  
  - Used to fetch data from AEMO.  
• **CLIENT_IDS** (API)  
  - JSON array or string specifying valid client IDs for token requests.  
• **SIGNING_KEYS** (API)  
  - JSON array describing public/private RSA (or other supported) keys for token signing and verification.  

--------------------------------------------------------------------------------

## Outstanding Tasks

1. **Complete Data Fetch Logic** (Completed)  
2. **Implement Real Error Handling**  
   - Properly handle network or data inaccuracies. Possibly re-fetch on failures.  
3. **Proper Token Signing/Verification**  
   - Replace the “FAKE” token placeholders in “src/api/jwtSupport.ts” with a real signing algorithm.  
4. **Enhance Data Retrieval**  
   - In “API Mode,” the “/data” endpoint is stubbed. Implement logic to query intervals.  
5. **Add Security Layers**  
   - Restrict or throttle repeated requests, protect from injection or rate-limits, etc.  
6. **Performance Monitoring & Alerts**  
   - Evaluate how to handle large volumes of data or potential latency spikes.  

--------------------------------------------------------------------------------

## File Layout

- **wrangler.logger.toml**  
  Schedules the logger Worker for periodic data retrieval.  
- **wrangler.api.toml**  
  Hosts the API endpoints for token issuance and data retrieval.  
- **src/index.ts**  
  The main logger code (scheduled/cron).  
- **src/AemoDataDurableObject.ts**  
  Shared Durable Object used by both modes, storing intervals in a SQLite DB.  
- **src/api/**  
  The API logic (JWT issuance, refresh, data endpoint).  
- **src/docs/sql-storage.md**  
  Example and reference docs for using “sql.exec()” in the Durable Object.  

--------------------------------------------------------------------------------

## Next Steps

After implementing the above todos, you can run or publish to Cloudflare. This design ensures that both the scheduled data-logging logic and the client-facing API share the same SQL-based Durable Object for data consistency and reliability.