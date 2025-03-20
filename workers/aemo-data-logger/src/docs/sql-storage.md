# SQL Storage for Durable Objects

The AemoDataDurableObject uses Cloudflare's new "SQL Storage" feature for Durable Objects. This allows you to store data in an internal SQLite database, providing:

• Familiar SQL-based insertion, querying, and indexing.  
• Simple iteration with minimal overhead.  
• Automatic versioning/hashing and potential point-in-time recovery.  

Below is a short example of the workflow with the DO:

1. The DO receives a fetch request (e.g., "/sync").  
2. In the "handleSync()" method, it runs SQL queries like CREATE TABLE, INSERT, or SELECT.  
3. The code uses "this.state.storage.sql.exec()" with prepared statements or batched queries.  

This approach is well-suited for storing time-series data like 5-minute intervals from AEMO.  

Refer to each method's robust doc in the Cloudflare Durable Objects docs:
• "sql.exec()" for running statements.  
• "cursor" objects for retrieving query results.  
• "transactionSync()" for grouping statements in an atomic block (if desired).  

Consult the official Cloudflare docs for production best practices, indexing strategies, and performance tuning.