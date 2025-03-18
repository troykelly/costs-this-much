# AEMO Data Logger Worker

This Cloudflare Worker is responsible for periodically retrieving electricity market data from AEMO, storing it in a SQL Durable Object. It is scheduled to run every five minutes offset by one minute (e.g., 00:01, 00:06, 00:11, and so on). It ensures that any missing records for the last 36 hours are retrieved and inserted, rather than blindly appending the newest record.

--------------------------------------------------------------------------------

## Overview

• On each scheduled execution (controlled by Wrangler's schedule definition), this worker:  
  1. Calculates which intervals (within the last 36 hours) are missing from the database.  
  2. Queries AEMO for 5-minute data (which often includes up to 36 hours of data).  
  3. Inserts any missing intervals that are present in the AEMO response.  
  4. Ignores intervals not yet available or not returned by AEMO, and waits until the next scheduled run for those.  

By storing the data in a Cloudflare Durable Object using SQLite, you can easily handle queries for up to 36 hours (or beyond, if you choose) of 5-minute intervals, with minimal overhead. 

--------------------------------------------------------------------------------

## Local Development

1. Ensure you have Yarn and Wrangler installed globally or via Corepack.  
2. From the repository root:  
   • yarn install  
   • cd workers/aemo-data-logger  
   • yarn dev  

When running locally, the schedule events typically do not fire in the same manner they do in production. Instead, you can directly invoke or test your code with Wrangler console or normal Worker requests.  

--------------------------------------------------------------------------------

## Deployment

1. Configure your Cloudflare account settings (API keys or tokens, etc.) in Wrangler config.  
2. Run:  
   • yarn publish  

This will build (if needed) and deploy the Worker code to your assigned Cloudflare Worker subdomain.  

--------------------------------------------------------------------------------

## Environment Variables & Configuration

• You can define environment variables in your wrangler.toml, under [vars], or in your Cloudflare dashboard. Examples:  
  - AEMO_API_URL: The base URL for retrieving AEMO data.  
  - ANY_AUTH_HEADERS: If needed, to authenticate with AEMO.  

--------------------------------------------------------------------------------

## File Layout

- wrangler.toml: The Worker configuration and Durable Object definitions.  
- package.json: Scripts for dev/publish.  
- src/index.ts: Entry point for the Worker event listeners (scheduled/cron).  
- src/AemoDataDurableObject.ts: Durable Object class with SQL backend.  
- src/docs/sql-storage.md: Example documentation snippet for using the SQL API in Durable Objects.

--------------------------------------------------------------------------------

## Next Steps

• Supply your AEMO fetch logic in src/index.ts, referencing the Durable Object (AemoDataDurableObject) to store the intervals.  
• Customise the schedule trigger in wrangler.toml.  
• Add advanced logic for partial outages, error handling and performance monitoring.  

--------------------------------------------------------------------------------