/**
 * AboutPage.tsx
 *
 * A simple "about" page providing background on the site’s purpose and usage.
 *
 * Author: Troy Kelly
 * Date: 16 March 2025
 */

import React, { useEffect } from 'react';
import { Box, Typography, Link } from '@mui/material';
import { setMetaTag } from './App'; // Reusing setMetaTag from the same logic or define a new local version

const AboutPage: React.FC = () => {
  useEffect(() => {
    const pageTitle = 'About - Costs This Much';
    const description = 'Learn about how the site calculates electricity costs for everyday tasks.';
    document.title = pageTitle;
    setMetaTag('property', 'og:title', pageTitle);
    setMetaTag('property', 'og:description', description);
    setMetaTag('property', 'og:url', window.location.href);
    setMetaTag('property', 'og:type', 'website');
    setMetaTag('name', 'DC.title', pageTitle);
    setMetaTag('name', 'DC.description', description);
    setMetaTag('name', 'DC.subject', 'About');
  }, []);

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh" p={2} bgcolor="#ffffff">
      <Typography variant="h4" gutterBottom>About This Site</Typography>
      <Typography variant="body1" paragraph>
        This site aims to help people understand the dynamic nature of electricity pricing.
        Wholesale rates in the Australian National Electricity Market (AEMO) can change
        every five minutes. By presenting near real‑time estimates of how much it might cost
        to complete everyday tasks (such as toasting bread or charging a phone), we hope to
        demystify how shifts in wholesale prices, network fees, environmental charges, and
        retail margins combine to influence what you pay.
      </Typography>
      <Typography variant="body1" paragraph>
        The scenarios use typical assumptions for wattage, duration, and consumption.
        These examples are provided for educational purposes only – individual usage will vary.
      </Typography>
      <Typography variant="body1" paragraph>
        AEMO pricing is based on National Electricity Market (NEM)
        time (Australia/Brisbane) and may not match your local time exactly.
      </Typography>
      <Typography variant="body1" paragraph>
        This project was created by Troy Kelly and is licensed under CC0 1.0 Universal.
        For more details, visit our{' '}
        <Link href="https://github.com/troykelly/costs-how-much" target="_blank" rel="noopener noreferrer">
          GitHub repository
        </Link>.
      </Typography>
    </Box>
  );
};

export default AboutPage;