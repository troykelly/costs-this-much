# GitHub Action for Cloudflare Pages Deployment

This repository includes a GitHub Action workflow (see “.github/workflows/publish-cloudflare.yml”) that performs the following tasks:

1. Checks if a Cloudflare Pages “service” (a.k.a. project) exists.  
   - If not, it creates that project via Wrangler.  
2. Checks if your chosen domain (including a wildcard for subdomains) is attached to that Pages project.  
   - If not, it attaches them using the Cloudflare API.  
3. Installs dependencies, builds the React frontend, and deploys the final output to Cloudflare Pages.

--------------------------------------------------------------------------------

## Usage & Triggers

The workflow will run on:
- Any push to the “main” branch.
- Manual triggers (through the GitHub UI or API).

--------------------------------------------------------------------------------

## Required Secrets

Add these GitHub repository secrets under “Settings → Secrets and variables → Actions”:

1. **CLOUDFLARE_API_TOKEN**  
   - Must have permissions for Pages/Workers creation and domain configuration.  
   - Retrieve from Cloudflare → “My Profile → API Tokens → Create Token.”
2. **CLOUDFLARE_ACCOUNT_ID**  
   - Obtain from your Cloudflare dashboard, in the Workers & Pages overview.

--------------------------------------------------------------------------------

## Required Action Variables

Create or configure these GitHub “Actions variables” (in “Settings → Actions → Variables” for your repo):

1. **CLOUDFLARE_SERVICE_NAME**  
   - The name used for your Pages project. e.g., “costs-how-much”
2. **CLOUDFLARE_DOMAIN_NAME**  
   - The custom domain used for your Pages site. e.g., “coststhismuch.au”

These variables can be set at the repository level or organisation level. They are accessed as “${{ vars.VARIABLE_NAME }}” inside the workflow.

--------------------------------------------------------------------------------

## Flow Overview

1. **Check or Create Pages Project**  
   The workflow uses Wrangler to list pages projects. If none match “CLOUDFLARE_SERVICE_NAME,” it creates a new one.

2. **Check or Create Domain Mappings**  
   The workflow queries the Cloudflare Pages Domain endpoints to see if “CLOUDFLARE_DOMAIN_NAME” and “*.CLOUDFLARE_DOMAIN_NAME” are already set up. If not, they are appended to the project automatically.

3. **Install & Build**  
   The workflow runs Yarn to install dependencies and build the frontend.

4. **Deploy**  
   Finally, the built files are deployed to Cloudflare Pages via Wrangler, referencing the same “CLOUDFLARE_SERVICE_NAME.”

--------------------------------------------------------------------------------

## Running Manually

To run the workflow manually:
1. Navigate to your repository’s “Actions” tab.
2. Locate the “Cloudflare Pages Publish” workflow.
3. Click “Run workflow” → choose your branch (“main,” by default).

--------------------------------------------------------------------------------

## Notes & Troubleshooting

- Ensure you have valid permissions for your Cloudflare API token (Pages/Workers creation, DNS domain updates).  
- If the domain or wildcard domain cannot be added (e.g., DNS not controlled by Cloudflare, lacking permissions), the curl calls will raise errors in the logs.  
- The environment variables “CLOUDFLARE_API_TOKEN” and “CLOUDFLARE_ACCOUNT_ID” are secrets; the domain/service name are action variables—both are required.  
- For further domain configuration steps or general Cloudflare setup, see “CLOUDFLARE-PAGES.md.”