# Costs How Much

This repository helps illustrate the dynamic nature of electricity pricing in the Australian National Electricity Market (NEM). By fetching live wholesale spot prices from AEMO (updated every five minutes) and combining them with typical overheads, it presents real-time estimates of how much common scenarios (like toasting a slice of bread or charging a phone) might cost.

I built this to demystify the complexities of electricity tariff structures and to show the impacts on your everyday usage. Since wholesale prices can sometimes swing dramatically (including going negative), seeing the effect on something as simple as boiling your kettle is both educational and eye-opening.

--------------------------------------------------------------------------------

## Status

• Work in Progress – This project is under active development.  
• I openly welcome contributions, pull requests, and forks.  

Anyone can clone or replicate this repository, host it wherever they please, and even modify it to suit their needs.

--------------------------------------------------------------------------------

## Why I Created It

1. **Education**: Energy pricing can seem complicated, so I decided to show a friendly, scenario-based approach to see how everyday tasks can add up.  
2. **Transparency**: Demonstrating how wholesale prices, network fees, and retailer margins factor into final rates fosters a clearer understanding of your bill.  
3. **Exploration**: By experimenting with this “Cost to ...” concept, I’ve opened the door to add any sort of scenario – from running a washing machine to fully charging an EV.  

--------------------------------------------------------------------------------

## Highlights & Features

• Fetches real-time (every five minutes) wholesale data from AEMO’s public endpoint.  
• Converts wholesale ($/MWh) into approximate retail rates (c/kWh) by adding representative network, environment, overhead, and margin costs.  
• Provides a library of usage scenarios (e.g., toasting, boiling water, EV charging) with typical assumptions about wattage and duration – easily extendable.  
• Integrates gracefully with Cloudflare Pages for automatic builds and deployments, but the build output can be hosted just about anywhere.

--------------------------------------------------------------------------------

## Local Development & Installation

1. **Clone the Repository**  
   » `git clone https://github.com/troykelly/costs-how-much.git`

2. **Install Dependencies**  
   » From the repository root:  
     yarn install

3. **Run Locally in Development Mode**  
   1. Navigate to the frontend directory:  
      cd frontend
   2. Start the dev server:  
      yarn dev
   3. In your browser, visit the URL displayed in the terminal (commonly http://127.0.0.1:5173 or similar).

4. **Build for Production**  
   »
   cd frontend
   yarn build
   This creates a production-ready built folder (dist) within the frontend directory, ready to be served.

--------------------------------------------------------------------------------

## Hosting & Deployment

### Cloudflare Pages (Partial Configuration)

• This repository includes a workflow (.github/workflows/publish-cloudflare.yml) that can deploy the frontend to Cloudflare Pages automatically.  
• If you set the right secrets (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID), as well as action variables (CLOUDFLARE_SERVICE_NAME, CLOUDFLARE_DOMAIN_NAME), the workflow can create (or verify) your Pages project, attach the domain, and push the latest build.

### Other Hosting Options

• The frontend compiles static assets (HTML, JS, CSS) which can be hosted on any static file server – from an S3 bucket to a custom VPS.  
• Simply upload the contents of the frontend/dist/folder to your host of choice.

--------------------------------------------------------------------------------

## Contributing

1. **Fork** the repository or create a new branch.  
2. **Make your changes** – whether that’s refining the deployment approach, adding a new scenario, or tweaking the user interface.  
3. **Test thoroughly** by running the local dev server.  
4. **Submit a Pull Request** for review.

Contributions of all kinds are welcome, including bug reports, new scenario ideas, locale adjustments, or performance improvements.

--------------------------------------------------------------------------------

## License

All code here is released under the [CC0 1.0 Universal](./LICENSE) public domain dedication. Essentially, you can do whatever you like with it:

- No attribution required.  
- No warranty implied.

However, I do appreciate references or mentions, and welcome forks and derivatives that build on these ideas.

--------------------------------------------------------------------------------

## Disclaimer

• The data and calculations here are approximate – do not treat them as exact or invoice-level accurate.  
• Negative wholesale spot prices are floored to zero for simplicity.  
• Different distribution zones in each state often have unique tariffs. I use a representative or “typical” approach.

--------------------------------------------------------------------------------

## Contact & More Info

Authored by [Troy Kelly](https://troykelly.com).  
I actively encourage issues, PRs, and forking. Thank you for your interest, and I hope this helps spark conversations about real-time energy costing.