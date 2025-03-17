/**
 * @fileoverview App.tsx - The main React application component integrating retail electricity rate
 * calculations, scenario cost estimation, and regional comparisons.
 *
 * Enhancements added:
 *  - Enhanced loading and error feedback with a clear "Loading latest pricing…" message.
 *  - A manual refresh button.
 *  - Accessible icons and proper aria‑labels.
 *  - A subtle transition on pricing value changes.
 *  - An overlaid sparkline chart showing today's and yesterday's 24‑hour trends (with a reference line for the highest cost).
 *  - Clarification of timezone (NEM Time in Australia/Brisbane) displayed in the interval text.
 *  - Refined geolocation consent messaging.
 *  - Drawer navigation with the current scenario highlighted.
 *  - Additional guidance on scenario selection.
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Date: 17 March 2025
 */

import React, { useEffect, useState, ReactNode } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  CircularProgress,
  CardActions,
  Tooltip,
  IconButton,
  Link,
  AppBar,
  Toolbar,
  Drawer,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  SelectChangeEvent,
  Grid,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Fade
} from '@mui/material';
import CardHeader from '@mui/material/CardHeader';
import BreakfastDiningIcon from '@mui/icons-material/BreakfastDining';
import InfoIcon from '@mui/icons-material/Info';
import MenuIcon from '@mui/icons-material/Menu';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOn';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import ShowerIcon from '@mui/icons-material/Shower';
import LocalCafeIcon from '@mui/icons-material/LocalCafe';
import MicrowaveIcon from '@mui/icons-material/Microwave';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import SmartphoneIcon from '@mui/icons-material/Smartphone';
import LaptopIcon from '@mui/icons-material/Laptop';
import LocalLaundryServiceIcon from '@mui/icons-material/LocalLaundryService';
import LocalDiningIcon from '@mui/icons-material/LocalDining';
import ElectricCarIcon from '@mui/icons-material/ElectricCar';
import StarIcon from '@mui/icons-material/Star';
import WarningIcon from '@mui/icons-material/Warning';
import RefreshIcon from '@mui/icons-material/Refresh';

import {
  AemoInterval,
  getRetailRateFromInterval,
  SupportedRegion
} from './pricingCalculator';
import { EnergyScenarios, EnergyScenario } from './energyScenarios';

// Import AU states GeoJSON for geolocation.
import statesData from '../data/au-states.json';

/**
 * Formats an ISO8601 date string into a localised date/time string using Australia/Brisbane timezone.
 *
 * @param {string} dateString - The ISO date string (e.g., "2025-03-16T14:05:00")
 * @return {string} The formatted localised string with "NEM Time" appended.
 */
function formatIntervalDate(dateString: string): string {
  if (!dateString) return '';
  const date = new Date(dateString + '+10:00');
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Australia/Brisbane',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  return date.toLocaleString('en-AU', options) + ' (NEM Time)';
}

/**
 * Formats a number as Australian currency with 4 decimal places.
 *
 * @param {number} value - The value to format.
 * @return {string} The formatted currency string.
 */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 4
  }).format(value);
}

/**
 * Retrieves the scenario key from the subdomain or query string parameter 's'.
 *
 * @return {string} The scenario ID.
 */
function getScenarioKey(): string {
  const hostParts = window.location.hostname.split('.');
  if (hostParts.length > 2) {
    const subdomain = hostParts[0].toLowerCase();
    if (subdomain) {
      return subdomain;
    }
  }
  const params = new URLSearchParams(window.location.search);
  const paramScenario = params.get('s');
  if (paramScenario) {
    return paramScenario.toLowerCase();
  }
  return '';
}

/**
 * Returns an icon component for the provided scenario icon name.
 *
 * @param {string | undefined} iconName - The name of the icon.
 * @return {JSX.Element} The corresponding icon.
 */
function getScenarioIcon(iconName?: string): JSX.Element {
  switch ((iconName || '').toLowerCase()) {
    case 'breakfastdining':
      return <BreakfastDiningIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Toaster icon" />;
    case 'shower':
      return <ShowerIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Shower icon" />;
    case 'localcafe':
      return <LocalCafeIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Boiling water icon" />;
    case 'microwave':
      return <MicrowaveIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Microwave icon" />;
    case 'lightbulb':
      return <LightbulbIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Light bulb icon" />;
    case 'smartphone':
      return <SmartphoneIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Smartphone icon" />;
    case 'laptop':
      return <LaptopIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Laptop icon" />;
    case 'locallaundryservice':
      return <LocalLaundryServiceIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Washing machine icon" />;
    case 'localdining':
      return <LocalDiningIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Dishwasher icon" />;
    case 'electriccar':
      return <ElectricCarIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Electric vehicle icon" />;
    default:
      return <HelpOutlineIcon fontSize="large" style={{ marginRight: 8 }} aria-label="Unknown scenario icon" />;
  }
}

/**
 * Component displayed when a requested scenario is not found.
 */
function ScenarioNotFound({ scenarioKey }: { scenarioKey: string }): JSX.Element {
  return (
    <Box
      display="flex"
      flexDirection="column"
      height="100vh"
      alignItems="center"
      justifyContent="center"
      textAlign="center"
      bgcolor="#fafafa"
    >
      <Typography variant="h3" gutterBottom>
        404 - Scenario Not Found
      </Typography>
      <Typography variant="body1">
        The requested scenario "{scenarioKey}" does not exist.
      </Typography>
      <Box m={2}>
        <Button variant="contained" onClick={() => (window.location.href = '/')}>
          Go Home
        </Button>
      </Box>
    </Box>
  );
}

/**
 * Props for the PricingCard component.
 */
interface PricingCardProps {
  loading: boolean;
  error: string | null;
  scenarioName: string;
  scenarioIcon: ReactNode;
  scenarioCost: number;
  rrpCents: number;
  finalRateCents: number;
  settlementDate: string;
  onRefresh: () => void;
}

/**
 * PricingCard component displays the current pricing and scenario cost,
 * with refresh option and smooth animation on updates.
 */
const PricingCard: React.FC<PricingCardProps> = ({
  loading,
  error,
  scenarioName,
  scenarioIcon,
  scenarioCost,
  rrpCents,
  finalRateCents,
  settlementDate,
  onRefresh
}) => {
  return (
    <Card sx={{ maxWidth: 480, width: '100%' }}>
      <CardHeader
        avatar={scenarioIcon}
        title={`Cost for ${scenarioName}`}
        action={
          <Tooltip title="Refresh Data">
            <IconButton onClick={onRefresh} aria-label="Refresh Data">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        }
      />
      <CardContent>
        {loading ? (
          <Box display="flex" flexDirection="column" alignItems="center" mt={2}>
            <CircularProgress />
            <Typography variant="body2" mt={1}>
              Loading latest pricing...
            </Typography>
          </Box>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <Fade in={!loading}>
            <Box
              display="flex"
              flexDirection="column"
              justifyContent="center"
              alignItems="center"
              mb={3}
            >
              <Box display="flex" alignItems="center" mb={1}>
                <MonetizationOnIcon fontSize="large" sx={{ marginRight: 1 }} aria-label="Price Icon" />
                <Typography variant="h4" color="secondary" sx={{ transition: 'all 0.5s ease' }}>
                  {formatCurrency(scenarioCost)}
                </Typography>
              </Box>
              <Typography variant="subtitle1" align="center">
                (per scenario usage)
              </Typography>
            </Box>
          </Fade>
        )}
        <Typography variant="body1" gutterBottom>
          Region Wholesale Spot Price: {rrpCents.toFixed(3)} c/kWh{' '}
          <Tooltip title="This is the real-time five-minute wholesale price from AEMO. Negative values are floored to 0.">
            <IconButton size="small" aria-label="Wholesale info">
              <InfoIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        </Typography>
        <Typography variant="body1" gutterBottom>
          Final Retail Price (incl. GST): {finalRateCents.toFixed(3)} c/kWh{' '}
          <Tooltip title="This is the approximate retail rate, including all charges.">
            <IconButton size="small" aria-label="Retail info">
              <InfoIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        </Typography>
        {loading || error ? null : (
          <Typography variant="caption" display="block" mt={2}>
            Updated automatically every 5 minutes.
          </Typography>
        )}
      </CardContent>
      <CardActions>
        <Typography variant="caption">
          Interval used: {formatIntervalDate(settlementDate)}{' '}
          <Tooltip title="AEMO operates on National Electricity Market time (Australia/Brisbane).">
            <IconButton size="small" aria-label="Time info">
              <InfoIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        </Typography>
      </CardActions>
    </Card>
  );
};

/**
 * Type for reference cost information.
 */
interface ReferenceCost {
  region: string;
  wholesaleCents: number;
  scenarioCost: number;
  date: string;
}

/**
 * ReferenceGrid component displays a grid of costs from other regions.
 */
interface ReferenceGridProps {
  referenceCosts: ReferenceCost[];
  onRegionClick: (region: string) => void;
  lowestCost: number;
  highestCost: number;
}
const ReferenceGrid: React.FC<ReferenceGridProps> = ({
  referenceCosts,
  onRegionClick,
  lowestCost,
  highestCost
}) => {
  return (
    <Box sx={{ maxWidth: 480, width: '100%', marginTop: 2 }}>
      <Typography variant="h6" gutterBottom>
        Reference Costs for Other Regions
      </Typography>
      <Grid container spacing={2}>
        {referenceCosts.map((item) => {
          const cost = item.scenarioCost;
          const isMin = cost === lowestCost;
          const isMax = cost === highestCost;
          let regionTag: ReactNode = null;
          if (isMin && isMax) {
            regionTag = (
              <Chip
                label="Cheapest & Most Expensive"
                icon={<StarIcon />}
                color="warning"
                size="small"
                sx={{ mt: 1 }}
              />
            );
          } else if (isMin) {
            regionTag = (
              <Chip
                label="Cheapest"
                icon={<StarIcon />}
                color="success"
                size="small"
                sx={{ mt: 1 }}
              />
            );
          } else if (isMax) {
            regionTag = (
              <Chip
                label="Most Expensive"
                icon={<WarningIcon />}
                color="error"
                size="small"
                sx={{ mt: 1 }}
              />
            );
          }
          return (
            <Grid item xs={6} sm={4} key={item.region}>
              <Card sx={{ cursor: 'pointer' }} onClick={() => onRegionClick(item.region.toLowerCase())}>
                <CardContent>
                  <Typography variant="h6">{item.region}</Typography>
                  <Typography variant="body1">{formatCurrency(item.scenarioCost)}</Typography>
                  {regionTag}
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>
    </Box>
  );
};

/**
 * SparklineChart component displays an overlaid 24‑hour line chart for both
 * today and yesterday's retail rates.
 */
interface SparklineChartProps {
  todayIntervals: AemoInterval[];
  yesterdayIntervals: AemoInterval[];
  region: SupportedRegion;
}
const SparklineChart: React.FC<SparklineChartProps> = ({ todayIntervals, yesterdayIntervals, region }) => {
  // We'll use a fixed SVG viewBox and allow full width.
  const svgWidth = 500;
  const svgHeight = 60;
  const padding = 5;

  // Determine today and yesterday midnights in Australia/Brisbane time
  const now = new Date();
  const todayMidnight = new Date(now.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' }));
  const yesterdayMidnight = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);

  // Helper: Given an interval and a base midnight, compute x coordinate (0 to 24h mapped to svgWidth-paddings)
  const computeX = (intervalDate: Date, baseMidnight: Date): number => {
    const diff = intervalDate.getTime() - baseMidnight.getTime();
    const fraction = diff / (24 * 60 * 60 * 1000);
    return padding + fraction * (svgWidth - 2 * padding);
  };

  // Compute retail rates (c/kWh) for today and yesterday intervals.
  const todayData: number[] = todayIntervals.map(interval =>
    getRetailRateFromInterval(interval, region, false, true)
  );
  const yesterdayData: number[] = yesterdayIntervals.map(interval =>
    getRetailRateFromInterval(interval, region, false, true)
  );

  if (todayData.length === 0 && yesterdayData.length === 0) return null;

  const allData = [...todayData, ...yesterdayData];
  const minValue = Math.min(...allData);
  const maxValue = Math.max(...allData);
  const range = maxValue - minValue || 1;

  // Compute points for a dataset using its respective midnight as base.
  const computePointsForData = (dataIntervals: AemoInterval[], baseMidnight: Date): string => {
    return dataIntervals.map(interval => {
      const intervalDate = new Date(interval.SETTLEMENTDATE + '+10:00');
      const x = computeX(intervalDate, baseMidnight);
      const y = svgHeight - padding - ((getRetailRateFromInterval(interval, region, false, true) - minValue) / range) * (svgHeight - 2 * padding);
      return `${x},${y}`;
    }).join(' ');
  };

  const todayPoints = computePointsForData(todayIntervals, todayMidnight);
  const yesterdayPoints = computePointsForData(yesterdayIntervals, yesterdayMidnight);

  // y position for reference line (highest value)
  const yRef = svgHeight - padding - ((maxValue - minValue) / range) * (svgHeight - 2 * padding);

  return (
    <Box mt={2}>
      <Typography variant="subtitle2">24‑Hour Trend (Today in blue, Yesterday in grey)</Typography>
      <svg width="100%" viewBox={`0 0 ${svgWidth} ${svgHeight}`} aria-label="Sparkline chart for rate trends">
        {/* Yesterday data */}
        {yesterdayData.length > 0 && (
          <polyline fill="none" stroke="#888888" strokeWidth="2" points={yesterdayPoints} />
        )}
        {/* Today data */}
        {todayData.length > 0 && (
          <polyline fill="none" stroke="#1976d2" strokeWidth="2" points={todayPoints} />
        )}
        {/* Horizontal reference line for the highest cost */}
        <line x1={padding} y1={yRef} x2={svgWidth - padding} y2={yRef} stroke="#ff0000" strokeDasharray="4" strokeWidth="1" />
        <text x={padding + 2} y={yRef - 2} fill="#ff0000" fontSize="10">Highest: {maxValue.toFixed(2)} c/kWh</text>
      </svg>
    </Box>
  );
};

/**
 * GeolocationDialog provides a dialog prompting the user to allow location sharing
 * for determining the nearest region.
 */
interface GeolocationDialogProps {
  open: boolean;
  onAllow: () => void;
  onDeny: () => void;
}
const GeolocationDialog: React.FC<GeolocationDialogProps> = ({ open, onAllow, onDeny }) => (
  <Dialog open={open} onClose={onDeny}>
    <DialogTitle>Location Data Request</DialogTitle>
    <DialogContent>
      <Typography variant="body1">
        We would like to access your location only to determine your nearest electricity pricing region.
        Your location data is used solely for this purpose and is not stored or tracked beyond this session.
      </Typography>
    </DialogContent>
    <DialogActions>
      <Button onClick={onDeny} color="error">Deny</Button>
      <Button onClick={onAllow} color="primary">Allow</Button>
    </DialogActions>
  </Dialog>
);

/**
 * ScenarioSelector component for selecting an energy usage scenario.
 */
interface ScenarioSelectorProps {
  currentScenarioKey: string;
  onScenarioChange: (newScenario: string) => void;
}
const ScenarioSelector: React.FC<ScenarioSelectorProps> = ({ currentScenarioKey, onScenarioChange }) => (
  <Box sx={{ marginBottom: 2, display: 'flex', flexDirection: 'column' }}>
    <FormControl fullWidth>
      <InputLabel id="scenario-select-label">Select Scenario</InputLabel>
      <Select
        labelId="scenario-select-label"
        label="Select Scenario"
        value={currentScenarioKey}
        onChange={(event: SelectChangeEvent) => onScenarioChange(event.target.value)}
      >
        {EnergyScenarios.getAllScenarios().map((scn) => (
          <MenuItem key={scn.id} value={scn.id}>
            {scn.name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
    <Typography variant="caption" mt={1}>
      You can also change the scenario by using a subdomain (e.g., toast.coststhismuch.au)
    </Typography>
  </Box>
);

/**
 * AboutPage component - provides detailed information about the app and usage instructions.
 */
function AboutPage({ drawerOpen, toggleDrawer }: { drawerOpen: boolean; toggleDrawer: (open: boolean) => () => void; }): JSX.Element {
  useEffect(() => {
    const pageTitle = 'About - Costs This Much';
    document.title = pageTitle;
  }, []);
  return (
    <Box display="flex" flexDirection="column" minHeight="100vh">
      <AppBar position="static" sx={{ marginBottom: 2 }}>
        <Toolbar>
          <IconButton edge="start" color="inherit" aria-label="menu" onClick={toggleDrawer(true)}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            About
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer anchor="left" open={drawerOpen} onClose={toggleDrawer(false)}>
        <Box sx={{ width: 250 }} role="presentation" onClick={toggleDrawer(false)} onKeyDown={toggleDrawer(false)}>
          <List>
            <ListItem button onClick={() => onNavigateHome()}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="Home" />
            </ListItem>
            <ListItem button selected>
              <ListItemIcon>
                <InfoIcon />
              </ListItemIcon>
              <ListItemText primary="About" />
            </ListItem>
          </List>
        </Box>
      </Drawer>
      <Box component="main" flexGrow={1} p={2}>
        <Typography variant="h4" gutterBottom>
          About This Site
        </Typography>
        <Typography variant="body1" paragraph>
          This site aims to help people understand the dynamic nature of electricity pricing.
          Wholesale rates in the Australian National Electricity Market (AEMO) can change
          every five minutes. By presenting near real‑time estimates of how much it might
          cost to complete everyday tasks, we hope to demystify how shifts in wholesale prices,
          network fees, environmental charges and retail margins come together to impact what you pay.
        </Typography>
        <Typography variant="body1" paragraph>
          The scenarios offered include typical assumptions for wattage, duration and energy usage.
          These examples are provided for educational purposes; your own costs may vary.
        </Typography>
        <Typography variant="body1" paragraph>
          Note that AEMO pricing is based on the National Electricity Market (NEM) time
          (Australia/Brisbane) and may not exactly reflect your local time.
        </Typography>
        <Typography variant="body1" paragraph>
          This project was created by Troy Kelly, and all content is released under the CC0 1.0 Universal
          dedication. For further details, please visit our{' '}
          <Link href="https://github.com/troykelly/costs-how-much" target="_blank" rel="noopener noreferrer">
            GitHub repository
          </Link>.
        </Typography>
      </Box>
      <Box component="footer" sx={{ textAlign: 'center', py: 2 }}>
        <Typography variant="body2">
          © 2025 Troy Kelly | CC0 1.0 Universal
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * Helper function for AboutPage navigation.
 */
function onNavigateHome(): void {
  window.location.href = '/nsw?s=toast';
}

/**
 * Main App component.
 */
const App: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [rrpCentsPerKWh, setRrpCentsPerKWh] = useState<number>(0);
  const [finalRateCents, setFinalRateCents] = useState<number>(0);
  const [toastCostDollars, setToastCostDollars] = useState<number>(0);
  const [usedIntervalDate, setUsedIntervalDate] = useState<string>('');
  const [regionIntervals, setRegionIntervals] = useState<AemoInterval[]>([]);
  const [allIntervals, setAllIntervals] = useState<AemoInterval[]>([]);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [locationDialogOpen, setLocationDialogOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Determine region from the pathname, defaulting to 'nsw'
  const pathParts = window.location.pathname.split('/');
  const regionKey = pathParts[1]?.toLowerCase() || 'nsw';
  const regionMapping: Record<string, string> = {
    nsw: 'NSW1',
    qld: 'QLD1',
    vic: 'VIC1',
    sa: 'SA1',
    tas: 'TAS1'
  };
  const regionFilter = regionMapping[regionKey] ?? 'NSW1';

  // Determine the energy scenario from subdomain or query parameters.
  const [scenarioKey, setScenarioKey] = useState<string>(getScenarioKey());
  if (!scenarioKey) {
    window.location.href = '/nsw?s=toast';
  }
  const scenarioData: EnergyScenario | null = EnergyScenarios.getScenarioById(scenarioKey);
  if (!scenarioData) {
    return <ScenarioNotFound scenarioKey={scenarioKey} />;
  }

  /**
   * Fetches AEMO 5-minute data and computes retail rates and scenario cost.
   */
  const fetchAemoData = async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeScale: ['5MIN'] })
      });
      if (!response.ok) {
        throw new Error(`Network response was not OK. Status: ${response.status}`);
      }
      const data = (await response.json()) as { '5MIN': AemoInterval[] };
      setAllIntervals(data['5MIN']);
      const regionData = data['5MIN'].filter(interval => interval.REGIONID === regionFilter);
      regionData.sort((a, b) => new Date(a.SETTLEMENTDATE).getTime() - new Date(b.SETTLEMENTDATE).getTime());
      setRegionIntervals(regionData);
      if (regionData.length > 0) {
        const latest = regionData[regionData.length - 1];
        let wholesale = latest.RRP * 0.1;
        if (wholesale < 0) wholesale = 0;
        setRrpCentsPerKWh(wholesale);
        const computedRate = getRetailRateFromInterval(latest, regionKey as SupportedRegion, false, true);
        setFinalRateCents(computedRate);
        const cost = EnergyScenarios.getCostForScenario(scenarioKey, computedRate);
        setToastCostDollars(cost);
        setUsedIntervalDate(latest.SETTLEMENTDATE);
      } else {
        setRrpCentsPerKWh(0);
        setFinalRateCents(0);
        setToastCostDollars(0);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch AEMO data.');
      setRrpCentsPerKWh(0);
      setFinalRateCents(0);
      setToastCostDollars(0);
    } finally {
      setLoading(false);
    }
  };

  // Fetch data immediately and refresh every 5 minutes.
  useEffect(() => {
    fetchAemoData();
    const intervalId = setInterval(fetchAemoData, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [regionFilter, scenarioKey]);

  // If the URL includes "/about", then render the About page.
  if (window.location.pathname.toLowerCase().includes('/about')) {
    return <AboutPage drawerOpen={drawerOpen} toggleDrawer={(open: boolean) => () => setDrawerOpen(open)} />;
  }

  /**
   * Computes reference cost data for other regions.
   *
   * @return {ReferenceCost[]} Array of reference cost information.
   */
  const getReferenceCosts = (): ReferenceCost[] => {
    const otherRegions = Object.keys(regionMapping).filter(r => r !== regionKey);
    const results: ReferenceCost[] = [];
    for (const r of otherRegions) {
      const intervalsForR = allIntervals.filter(intv => intv.REGIONID === regionMapping[r]);
      intervalsForR.sort((a, b) => new Date(a.SETTLEMENTDATE).getTime() - new Date(b.SETTLEMENTDATE).getTime());
      if (intervalsForR.length > 0) {
        const latest = intervalsForR[intervalsForR.length - 1];
        let wholesale = latest.RRP * 0.1;
        if (wholesale < 0) wholesale = 0;
        const rate = getRetailRateFromInterval(latest, r as SupportedRegion, false, true);
        const cost = EnergyScenarios.getCostForScenario(scenarioKey, rate);
        results.push({
          region: r.toUpperCase(),
          wholesaleCents: wholesale,
          scenarioCost: cost,
          date: latest.SETTLEMENTDATE
        });
      } else {
        results.push({ region: r.toUpperCase(), wholesaleCents: 0, scenarioCost: 0, date: '' });
      }
    }
    return results;
  };

  const referenceCosts = getReferenceCosts();
  const allRegionCosts = [
    { region: regionKey.toUpperCase(), scenarioCost: toastCostDollars },
    ...referenceCosts
  ];
  const lowestCost = Math.min(...allRegionCosts.map(r => r.scenarioCost));
  const highestCost = Math.max(...allRegionCosts.map(r => r.scenarioCost));

  /**
   * Handles scenario change.
   *
   * @param {string} newScenario - The new scenario ID.
   */
  const handleScenarioChange = (newScenario: string): void => {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.includes('192.168.');
    const regionPath = regionKey;
    let finalUrl = '';
    if (isLocalDev) {
      finalUrl = `${protocol}//${hostname}${port ? ':' + port : ''}/${regionPath}?s=${newScenario}`;
    } else {
      const domainParts = hostname.split('.');
      if (domainParts.length > 2) { domainParts.shift(); }
      const baseDomain = domainParts.join('.');
      const newHost = `${newScenario}.${baseDomain}`;
      finalUrl = `${protocol}//${newHost}${port ? ':' + port : ''}/${regionPath}`;
    }
    window.location.href = finalUrl;
  };

  /**
   * Handles region selection change.
   *
   * @param {string} newRegion - The new region.
   */
  const handleRegionClick = (newRegion: string): void => {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.includes('192.168.');
    const scenario = scenarioKey;
    let finalUrl = '';
    if (isLocalDev) {
      finalUrl = `${protocol}//${hostname}${port ? ':' + port : ''}/${newRegion}?s=${scenario}`;
    } else {
      const domainParts = hostname.split('.');
      if (domainParts.length > 2) { domainParts.shift(); }
      const baseDomain = domainParts.join('.');
      const newHost = `${scenario}.${baseDomain}`;
      finalUrl = `${protocol}//${newHost}${port ? ':' + port : ''}/${newRegion}`;
    }
    window.location.href = finalUrl;
  };

  /**
   * Handle the "My Location" button click.
   */
  const handleMyLocationClick = (): void => {
    setLocationDialogOpen(true);
  };

  /**
   * Handles geolocation denial.
   */
  const handleDenyLocation = (): void => {
    setLocationDialogOpen(false);
  };

  /**
   * Handles geolocation permission and attempts to map the user's location to a state.
   */
  const handleAllowLocation = (): void => {
    setLocationDialogOpen(false);
    localStorage.setItem('hasAskedLocation', 'true');
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        const stateName = getStateNameForLatLon(lat, lon);
        if (!stateName) {
          alert('It appears you are outside of the serviced area. Defaulting to NSW.');
          handleRegionClick('nsw');
          return;
        }
        const mappedRegion = mapStateNameToRegionKey(stateName);
        if (mappedRegion && regionMapping[mappedRegion]) {
          handleRegionClick(mappedRegion);
        } else {
          alert('Your location is not in a supported region. Defaulting to NSW.');
          handleRegionClick('nsw');
        }
      },
      (error) => {
        alert('Unable to retrieve your location. Please check permissions.');
      }
    );
  };

  /**
   * Determines which state (if any) the given latitude and longitude fall into.
   *
   * @param {number} lat - Latitude.
   * @param {number} lon - Longitude.
   * @return {string | null} The state name or null.
   */
  const getStateNameForLatLon = (lat: number, lon: number): string | null => {
    for (const feature of statesData.features) {
      const geometry = feature.geometry;
      if (geometry.type === 'Polygon') {
        if (isPointInRingArray(geometry.coordinates, lat, lon)) {
          return feature.properties.STATE_NAME;
        }
      } else if (geometry.type === 'MultiPolygon') {
        for (const polygon of geometry.coordinates) {
          if (isPointInRingArray(polygon, lat, lon)) {
            return feature.properties.STATE_NAME;
          }
        }
      }
    }
    return null;
  };

  /**
   * Checks if a point is inside the polygon defined by the given ring array.
   *
   * @param {number[][][]} ringArray - Array of rings.
   * @param {number} lat - Latitude.
   * @param {number} lon - Longitude.
   * @return {boolean} True if inside.
   */
  const isPointInRingArray = (ringArray: number[][][], lat: number, lon: number): boolean => {
    if (ringArray.length === 0) return false;
    const outerRing = ringArray[0];
    return isPointInPolygon(outerRing, lat, lon);
  };

  /**
   * Ray-casting algorithm to determine if a point is within a polygon.
   *
   * @param {number[][]} polygon - Array of [lon, lat] pairs.
   * @param {number} lat - Latitude.
   * @param {number} lon - Longitude.
   * @return {boolean} True if inside.
   */
  const isPointInPolygon = (polygon: number[][], lat: number, lon: number): boolean => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][1], yi = polygon[i][0];
      const xj = polygon[j][1], yj = polygon[j][0];
      const intersect = ((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  /**
   * Maps the full state name to a supported region key.
   *
   * @param {string} stateName - The full state name.
   * @return {string | null} The supported region key (e.g. 'nsw') or null.
   */
  const mapStateNameToRegionKey = (stateName: string): string | null => {
    const lowerName = stateName.toLowerCase();
    if (lowerName.includes('wales')) return 'nsw';
    if (lowerName.includes('victoria')) return 'vic';
    if (lowerName.includes('queensland')) return 'qld';
    if (lowerName.includes('south australia')) return 'sa';
    if (lowerName.includes('tasmania')) return 'tas';
    return null;
  };

  // Compute intervals for today and yesterday based on Australia/Brisbane time.
  const nowTime = new Date();
  const brisbaneTodayMidnight = new Date(nowTime.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' }));
  const brisbaneTomorrowMidnight = new Date(brisbaneTodayMidnight.getTime() + 24 * 60 * 60 * 1000);
  const brisbaneYesterdayMidnight = new Date(brisbaneTodayMidnight.getTime() - 24 * 60 * 60 * 1000);

  const todayIntervals = regionIntervals.filter((intv) => {
    const d = new Date(intv.SETTLEMENTDATE + '+10:00');
    return d >= brisbaneTodayMidnight && d < brisbaneTomorrowMidnight;
  });
  const yesterdayIntervals = regionIntervals.filter((intv) => {
    const d = new Date(intv.SETTLEMENTDATE + '+10:00');
    return d >= brisbaneYesterdayMidnight && d < brisbaneTodayMidnight;
  });

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh">
      <AppBar position="static" sx={{ marginBottom: 2 }}>
        <Toolbar>
          <IconButton edge="start" color="inherit" aria-label="Menu" onClick={() => setDrawerOpen(true)}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Cost to {regionKey.toUpperCase()}
          </Typography>
        </Toolbar>
      </AppBar>

      <Drawer anchor="left" open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Box
          sx={{ width: 250 }}
          role="presentation"
          onClick={() => setDrawerOpen(false)}
          onKeyDown={() => setDrawerOpen(false)}
        >
          <List>
            <ListItem button onClick={() => (window.location.href = '/nsw?s=toast')} selected={regionKey === 'nsw'}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="NSW" />
            </ListItem>
            <ListItem button onClick={() => handleRegionClick('qld')} selected={regionKey === 'qld'}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="QLD" />
            </ListItem>
            <ListItem button onClick={() => handleRegionClick('vic')} selected={regionKey === 'vic'}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="VIC" />
            </ListItem>
            <ListItem button onClick={() => handleRegionClick('sa')} selected={regionKey === 'sa'}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="SA" />
            </ListItem>
            <ListItem button onClick={() => handleRegionClick('tas')} selected={regionKey === 'tas'}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="TAS" />
            </ListItem>
            <ListItem button onClick={() => (window.location.href = '/about')}>
              <ListItemIcon>
                <InfoIcon />
              </ListItemIcon>
              <ListItemText primary="About" />
            </ListItem>
            {EnergyScenarios.getAllScenarios().map((item) => (
              <ListItem
                button
                key={item.id}
                onClick={() => handleScenarioChange(item.id)}
                selected={item.id === scenarioKey}
              >
                <ListItemIcon>{getScenarioIcon(item.iconName)}</ListItemIcon>
                <ListItemText primary={item.name} />
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>

      <Box component="main" flexGrow={1} display="flex" justifyContent="center" alignItems="flex-start" bgcolor="#fafafa" p={2}>
        <Box sx={{ marginBottom: 4, width: '100%', maxWidth: 480 }}>
          <ScenarioSelector currentScenarioKey={scenarioKey} onScenarioChange={(newScn) => handleScenarioChange(newScn)} />
          <PricingCard
            loading={loading}
            error={error}
            scenarioName={scenarioData.name}
            scenarioIcon={getScenarioIcon(scenarioData.iconName)}
            scenarioCost={toastCostDollars}
            rrpCents={rrpCentsPerKWh}
            finalRateCents={finalRateCents}
            settlementDate={usedIntervalDate}
            onRefresh={fetchAemoData}
          />
          <SparklineChart
            todayIntervals={todayIntervals}
            yesterdayIntervals={yesterdayIntervals}
            region={regionKey as SupportedRegion}
          />
          <ReferenceGrid
            referenceCosts={getReferenceCosts()}
            onRegionClick={handleRegionClick}
            lowestCost={lowestCost}
            highestCost={highestCost}
          />
        </Box>
      </Box>

      <Box component="footer" sx={{ textAlign: 'center', py: 2 }}>
        <Typography variant="body2">
          CC0 1.0 Universal | <a href="https://github.com/troykelly/costs-how-much">GitHub</a> | <a href="https://troykelly.com/">Troy Kelly</a>
          <br />
          Data sourced from{' '}
          <Link href="https://www.aemo.com.au/" target="_blank" rel="noopener noreferrer">
            AEMO
          </Link>
        </Typography>
        <Box mt={1}>
          <Button variant="outlined" onClick={handleMyLocationClick}>
            My Location
          </Button>
        </Box>
      </Box>

      <GeolocationDialog open={locationDialogOpen} onAllow={handleAllowLocation} onDeny={handleDenyLocation} />
    </Box>
  );
};

export default App;