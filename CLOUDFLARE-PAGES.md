# Configuring Cloudflare Pages for This Project

Below is additional detail on how the domain is configured in Cloudflare. Our GitHub Action automatically checks if the Cloudflare Pages project (“service”) exists and if the selected domain is attached—if not, it creates them.

--------------------------------------------------------------------------------

## 1. Define Variables

1. **CLOUDFLARE_SERVICE_NAME** (Action Variable)  
   - Name for your Cloudflare Pages project. The action checks if it exists, and if not, it creates it.  
2. **CLOUDFLARE_DOMAIN_NAME** (Action Variable)  
   - The base domain (e.g., “coststhismuch.au”). The workflow also handles attaching “*.coststhismuch.au.”

--------------------------------------------------------------------------------

## 2. DNS & Cloudflare

- Make sure your domain is registered under Cloudflare (i.e., add it to your account).  
- The “publish-cloudflare.yml” workflow calls Cloudflare’s API to attach the domain (and wildcard) to the Pages project automatically.

--------------------------------------------------------------------------------

## 3. Automatic Wildcard Setup

If the wildcard subdomain “*.yourdomain.com” was not previously configured, the workflow will create it. This allows subdomains (e.g., toast.coststhismuch.au, phonecharge.coststhismuch.au, etc.) to resolve through Cloudflare.

--------------------------------------------------------------------------------

## 4. Validation & SSL

After attaching the domain in Pages, Cloudflare will handle certificate provisioning. You can check the status under the Cloudflare Pages project “Custom domains” or in your DNS settings. Usually, it only takes a few minutes.

--------------------------------------------------------------------------------

## 5. Manual Overrides

While the Action automates most tasks, you can still manually:
- Create or rename a service in Pages.  
- Add custom domains.  
- Configure DNS records.  
This is helpful if you want partial or more granular configuration.

--------------------------------------------------------------------------------

## 6. Testing

Once the GitHub Action completes successfully:
1. Visit “https://yourdomain.com” (the base domain).  
2. Try a subdomain scenario URL, e.g. “https://toast.yourdomain.com.”  
   - The app logic interprets subdomains for different “scenarios,” so you should see the relevant cost overview for that scenario.

--------------------------------------------------------------------------------

### That’s It!

With wildcard domain setup, your Cloudflare Pages project covers any scenario-based subdomain. The GitHub Action ensures your Pages service and domain are in place and deploys on every push or manual workflow dispatch.