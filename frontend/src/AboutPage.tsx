/**
 * AboutPage.tsx
 *
 * Refactored on 18 March 2025 to provide a more elegant, press-release style layout,
 * allowing the reader to easily navigate between sections and link back to the main calculator.
 *
 * Author: Troy Kelly
 * Original Creation: 16 March 2025
 * Last Update: 18 March 2025
 */

import React, { useEffect } from 'react';
import { Box, Typography, Link, Button, Divider, Paper } from '@mui/material';
import { setMetaTag } from './App';

const AboutPage: React.FC = () => {
  useEffect(() => {
    const pageTitle = 'About This Site - Costs This Much';
    const description = "A live guide to the real cost of electricity in Australia's dynamic energy market.";
    document.title = pageTitle;

    setMetaTag('property', 'og:title', pageTitle);
    setMetaTag('property', 'og:description', description);
    setMetaTag('property', 'og:url', window.location.href);
    setMetaTag('property', 'og:type', 'website');

    setMetaTag('name', 'DC.title', pageTitle);
    setMetaTag('name', 'DC.description', description);
    setMetaTag('name', 'DC.subject', 'About');
  }, []);

  // Internal anchors for quick nav
  const sections = [
    { id: 'aboutSite', label: 'About This Site' },
    { id: 'aemoDynamicPricing', label: "Understanding AEMO's Dynamic Pricing" },
    { id: 'howSiteWorks', label: 'How This Site Works' },
    { id: 'whatToKnow', label: 'What You Need to Know' },
    { id: 'disclaimer', label: 'Our Disclaimer' },
    { id: 'pressInquiries', label: 'Media & Press Inquiries' }
  ];

  const handleAnchorClick = (anchorId: string): void => {
    const element = document.getElementById(anchorId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh" bgcolor="#fff">
      {/* Top heading + quick nav */}
      <Box sx={{ backgroundColor: '#f5f5f5', p: 2, borderBottom: '1px solid #ccc' }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
          About & Press
        </Typography>
        <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {sections.map((sec) => (
            <Button
              key={sec.id}
              variant="outlined"
              size="small"
              onClick={() => handleAnchorClick(sec.id)}
            >
              {sec.label}
            </Button>
          ))}
          <Button
            variant="contained"
            color="primary"
            size="small"
            sx={{ ml: 'auto' }}
            onClick={() => (window.location.href = '/nsw')}
          >
            Return to Calculator
          </Button>
        </Box>
      </Box>

      <Box sx={{ p: 3, flexGrow: 1 }}>
        {/* SECTION: About This Site */}
        <Box id="aboutSite" mb={4}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 'bold' }}>
            About This Site
          </Typography>
          <Typography variant="body1" paragraph>
            A live guide to the real cost of electricity in Australia's dynamic energy market.
            We're here to illustrate how wholesale prices (updated every five minutes by AEMO)
            translate into everyday usage costs—like the price of charging your phone, running
            the dishwasher, or toasting a slice of bread. That cost is never static—it flexes
            wildly with supply and demand. Our goal? To provide real-time transparency and
            empower Australians with energy insights.
          </Typography>
        </Box>

        <Divider sx={{ mb: 4 }} />

        {/* SECTION: Understanding AEMO's Dynamic Pricing */}
        <Box id="aemoDynamicPricing" mb={4}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 'bold' }}>
            Understanding AEMO's Dynamic Pricing
          </Typography>

          {/* Subsection: How Electricity Pricing Works in Australia */}
          <Typography variant="h6" mt={2} sx={{ fontWeight: 'bold' }}>
            How Electricity Pricing Works in Australia
          </Typography>
          <Typography variant="body1" paragraph>
            The Australian Energy Market Operator (AEMO) orchestrates the national wholesale
            electricity market, ensuring the grid balances supply and demand. With prices
            determined every five minutes, what retailers pay can swing from deeply negative
            (during solar oversupply) to exceptionally high during peak times. Consumers typically
            only see a blended rate on their electricity bill, concealing these price extremes.
          </Typography>
          <Typography variant="body1" paragraph>
            By making real-time AEMO data accessible, Costs This Much help everyday Australians understand
            how the cost of simple activities can change throughout the day, and why timing
            your energy usage matters.
          </Typography>

          {/* Subsection: What is Dynamic Pricing? */}
          <Typography variant="h6" mt={3} sx={{ fontWeight: 'bold' }}>
            What Is Dynamic Pricing?
          </Typography>
          <Typography variant="body1" paragraph>
            Dynamic pricing links retail electricity charges to real-time wholesale markets.
            When power is abundant (think midday solar), prices can drop dramatically—even
            going below zero. But in high demand or supply-tight conditions, rates can spike.
            That means making toast, boiling water, or running a clothes dryer can be very
            cheap at some hours—but surprisingly expensive at others.
          </Typography>
          <Typography variant="body1" paragraph>
            Our site highlights this variability, helping you navigate the best times to
            power up your devices or appliances.
          </Typography>

          {/* Subsection: Why This Matters for You */}
          <Typography variant="h6" mt={3} sx={{ fontWeight: 'bold' }}>
            Why This Matters for You
          </Typography>
          <Typography variant="body1" paragraph>
            Most of us discover our energy costs only when the bill arrives—too late to adjust
            usage decisions. In reality, a load of laundry could cost mere cents or several
            dollars, depending on the real-time rate. Charging an EV might be $10 at one hour,
            or hundreds during a peak price event.
          </Typography>
          <Typography variant="body1" paragraph>
            This site gives immediate context. See how tasks—like{' '}
            <Link href="https://toast.coststhismuch.au/nsw" target="_blank">
              toasting a slice of bread
            </Link>
            ,{' '}
            <Link href="https://boilwater.coststhismuch.au/nsw" target="_blank">
              boiling 1 L of water
            </Link>
            , or{' '}
            <Link href="https://evcharge.coststhismuch.au/nsw" target="_blank">
              charging an EV
            </Link>{' '}
            —translate into real costs, in real time.
          </Typography>

          <Paper
            variant="outlined"
            sx={{ my: 2, p: 2, borderLeft: '5px solid #1976d2', backgroundColor: '#fafafa' }}
          >
            <Typography variant="body1" fontStyle="italic">
              “Electricity is the only thing most Australians buy without knowing the real-time
              price. We're here to change that.”
            </Typography>
          </Paper>
        </Box>

        <Divider sx={{ mb: 4 }} />

        {/* SECTION: How This Site Works */}
        <Box id="howSiteWorks" mb={4}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 'bold' }}>
            How This Site Works
          </Typography>

          {/* Subsection: Live Price Tracking */}
          <Typography variant="h6" mt={2} sx={{ fontWeight: 'bold' }}>
            Live Price Tracking
          </Typography>
          <Typography variant="body1" paragraph>
            Costs This Much regularly fetch AEMO's five-minute wholesale energy prices and layer on typical
            network charges, environmental levies, and modest overhead to approximate a
            “real-world” retail rate. Then Costs This Much apply these rates to common usage scenarios:
          </Typography>
          <ul>
            <li>
              <Link href="https://toast.coststhismuch.au/nsw" target="_blank">
                Toasting a slice of bread
              </Link>
            </li>
            <li>
              <Link href="https://boilwater.coststhismuch.au/nsw" target="_blank">
                Boiling 1 L of water
              </Link>
            </li>
            <li>
              <Link href="https://phonecharge.coststhismuch.au/nsw" target="_blank">
                Charging a smartphone
              </Link>
            </li>
            <li>
              <Link href="https://bulbhour.coststhismuch.au/nsw" target="_blank">
                Running a 60W bulb for 1h
              </Link>
            </li>
            <li>
              <Link href="https://laptop.coststhismuch.au/nsw" target="_blank">
                Laptop charge
              </Link>
            </li>
            <li>
              <Link href="https://washingmachine.coststhismuch.au/nsw" target="_blank">
                Washing machine cycle
              </Link>
            </li>
            <li>
              <Link href="https://dishwasher.coststhismuch.au/nsw" target="_blank">
                Dishwasher cycle
              </Link>
            </li>
            <li>
              <Link href="https://microwave5min.coststhismuch.au/nsw" target="_blank">
                Microwaving for 5 minutes
              </Link>
            </li>
            <li>
              <Link href="https://shower10min.coststhismuch.au/nsw" target="_blank">
                Taking a 10-minute electric hot shower
              </Link>
            </li>
            <li>
              <Link href="https://evcharge.coststhismuch.au/nsw" target="_blank">
                Charging an EV from near-empty
              </Link>
            </li>
          </ul>
          <Typography variant="body1" paragraph>
            These numbers update as market conditions shift. It's a snapshot, not a precise
            invoice. Your provider's final rate likely differs, but Costs This Much offer a real-time
            benchmark for what's happening in the market.
          </Typography>

          {/* Subsection: What This Data Represents */}
          <Typography variant="h6" mt={3} sx={{ fontWeight: 'bold' }}>
            What This Data Represents
          </Typography>
          <Typography variant="body1" paragraph>
            The site is an educational tool. By converting wholesale ($/MWh) to an approximate
            retail (c/kWh) and multiplying by typical usage, Costs This Much reveal a ballpark figure for
            everyday tasks. It's an eye-opener—a single kilowatt-hour could cost you cents or
            many dollars. When the market dips or spikes, you'll see the impact on tasks you
            routinely take for granted.
          </Typography>

          <Paper
            variant="outlined"
            sx={{ my: 2, p: 2, borderLeft: '5px solid #1976d2', backgroundColor: '#fafafa' }}
          >
            <Typography variant="body1" fontStyle="italic">
              “A single kWh could cost you cents or dollars—it all depends on timing.”
            </Typography>
          </Paper>
        </Box>

        <Divider sx={{ mb: 4 }} />

        {/* SECTION: What You Need to Know */}
        <Box id="whatToKnow" mb={4}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 'bold' }}>
            What You Need to Know Before Using This Data
          </Typography>

          {/* Subsection: Costs This Much Can't Predict Your Exact Bill */}
          <Typography variant="h6" mt={2} sx={{ fontWeight: 'bold' }}>
            Costs This Much Can't Predict Your Exact Bill
          </Typography>
          <Typography variant="body1" paragraph>
            Each retailer has its own structure—some blend wholesale costs over a day or a
            month, others impose flat or time-of-use rates. Our numbers reflect a
            simplified “live” approach. Actual charges on your invoice will likely vary due
            to your provider's fees, network costs, or special tariffs.
          </Typography>

          {/* Subsection: This is for Awareness, Not Absolute Accuracy */}
          <Typography variant="h6" mt={3} sx={{ fontWeight: 'bold' }}>
            This is for Awareness, Not Absolute Accuracy
          </Typography>
          <Typography variant="body1" paragraph>
            Costs This Much do everything Costs This Much can to keep the data fresh and relevant, but it's still an
            approximation. Think of these figures as a knowledge tool—helpful for deciding
            when to run energy-heavy appliances—but not a guarantee of your final bill.
          </Typography>

          <Paper
            variant="outlined"
            sx={{ my: 2, p: 2, borderLeft: '5px solid #1976d2', backgroundColor: '#fafafa' }}
          >
            <Typography variant="body1" fontStyle="italic">
              “Knowledge is power—literally. But your final bill will depend on your retailer, not just AEMO rates.”
            </Typography>
          </Paper>
        </Box>

        <Divider sx={{ mb: 4 }} />

        {/* SECTION: Our Disclaimer */}
        <Box id="disclaimer" mb={4}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 'bold' }}>
            Our Disclaimer
          </Typography>

          {/* Subsection: Costs This Much Are Not Responsible for Your Energy Decisions */}
          <Typography variant="h6" mt={2} sx={{ fontWeight: 'bold' }}>
            Costs This Much Are Not Responsible for Your Energy Decisions
          </Typography>
          <Typography variant="body1" paragraph>
            This site is strictly for educational purposes. While Costs This Much illustrate costs
            using real-time data, any major financial or usage decisions should be informed
            by multiple sources, including official tariffs and retailer advice. Costs This Much can't
            be held liable for actions taken solely based on these estimates.
          </Typography>

          {/* Subsection: No Liability for Data Accuracy */}
          <Typography variant="h6" mt={3} sx={{ fontWeight: 'bold' }}>
            No Liability for Data Accuracy
          </Typography>
          <Typography variant="body1" paragraph>
            Though Costs This Much pull from credible sources (notably AEMO), data can shift minute by
            minute. By the time you see a rate, it may already have changed. Accept that
            minor discrepancies or lags are inevitable when dealing with live market data.
          </Typography>

          <Paper
            variant="outlined"
            sx={{ my: 2, p: 2, borderLeft: '5px solid #1976d2', backgroundColor: '#fafafa' }}
          >
            <Typography variant="body1" fontStyle="italic">
              “Think of this as an energy weather forecast—not a guarantee.”
            </Typography>
          </Paper>
        </Box>

        <Divider sx={{ mb: 4 }} />

        {/* SECTION: Media & Press Inquiries */}
        <Box id="pressInquiries" mb={4}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 'bold' }}>
            Media & Press Inquiries
          </Typography>

          {/* Subsection: Why This is a Big Deal */}
          <Typography variant="h6" mt={2} sx={{ fontWeight: 'bold' }}>
            Why This is a Big Deal
          </Typography>
          <Typography variant="body1" paragraph>
            Energy prices in Australia are under intense scrutiny. With rising costs,
            grid transformations, and the shift to renewables, real-time transparency has
            never been more crucial. This site bridges a longstanding information gap,
            speaking plainly to households, small businesses, and journalists.
          </Typography>
          <Typography variant="body1" paragraph>
            By showcasing how drastically costs can vary, Costs This Much enable meaningful conversations
            about usage habits, policy debates, and the push toward innovative tariffs.
          </Typography>

          {/* Subsection: Get in Touch */}
          <Typography variant="h6" mt={3} sx={{ fontWeight: 'bold' }}>
            Get in Touch
          </Typography>
          <Typography variant="body1" paragraph>
            Writing a story or report on electricity prices, dynamic tariffs, or just curious
            about real-world energy costs? <a href="https://www.troykelly.com/contact">I'd love to speak with you</a>. Whether you're a
            journalist, blogger, researcher, or policy maker, I can provide interviews
            and deeper data insights.
          </Typography>

          <Paper
            variant="outlined"
            sx={{ my: 2, p: 2, borderLeft: '5px solid #1976d2', backgroundColor: '#fafafa' }}
          >
            <Typography variant="body1" fontStyle="italic">
              “Energy pricing has never been more complex. Costs This Much make it simple.”
            </Typography>
          </Paper>
        </Box>
      </Box>

      {/* Footer CTA */}
      <Box
        component="footer"
        sx={{
          borderTop: '1px solid #CCC',
          p: 2,
          textAlign: 'center',
          mt: 'auto',
          backgroundColor: '#ffffff'
        }}
      >
        <Typography variant="body2" sx={{ mb: 1 }}>
          <Link href="/nsw" color="primary">
            Return to Calculator
          </Link>
        </Typography>
        <Typography variant="caption" display="block">
          CC0 1.0 Universal | By Troy Kelly
        </Typography>
      </Box>
    </Box>
  );
};

export default AboutPage;