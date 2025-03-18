/**
 * ScenarioNotFound.tsx
 *
 * A simple 404-like component displayed when the requested scenario
 * (based on URL subdomain / param) is not found in the scenario library.
 *
 * Author: Troy Kelly
 * Date: 16 March 2025
 */

import React from 'react';
import { Box, Typography, Button } from '@mui/material';

interface ScenarioNotFoundProps {
  scenarioKey: string;
}

const ScenarioNotFound: React.FC<ScenarioNotFoundProps> = ({ scenarioKey }) => {
  return (
    <Box display="flex" flexDirection="column" height="100vh" alignItems="center" justifyContent="center" textAlign="center" bgcolor="#ffffff">
      <Typography variant="h3" gutterBottom>404 - Scenario Not Found</Typography>
      <Typography variant="body1">
        The requested scenario "{scenarioKey}" does not exist.
      </Typography>
      <Box m={2}>
        <Button variant="contained" onClick={() => (window.location.href = '/')}>Go Home</Button>
      </Box>
    </Box>
  );
};

export default ScenarioNotFound;