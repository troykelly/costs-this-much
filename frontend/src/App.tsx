/**
 * @fileoverview App.tsx - A simple React application that retrieves the current AEMO
 * network price for a selected region and computes an approximate cost for a chosen
 * energy scenario (toast, EV charge, phone charge, etc.).
 *
 * Features and enhancements include:
 *  - Polling the AEMO "5MIN" endpoint every five minutes.
 *  - Automatic region determination using the pathname ("nsw", "qld", "sa", "tas", "vic").
 *  - Scenario determination via subdomain in production (query string in dev mode).
 *  - Enhanced loading and error feedback.
 *  - A manual refresh button.
 *  - Accessible icons with aria‑labels and tooltips.
 *  - Smooth transitions when pricing numbers update.
 *  - An overlaid 24‑hour trend chart displaying the latest 24‑hour period (blue)
 *    and the previous 24‑hour period (grey) with a horizontal red reference line indicating the maximum cost.
 *  - Display of "Cheapest" and "Most Expensive" scenario cards with calendar views.
 *  - A daily summary table of wholesale and retail rates, with prices formatted using the Australian locale.
 *  - Clear indication that times are based on NEM Time (Australia/Brisbane).
 *  - Improved geolocation dialog and explanatory messaging.
 *  - Navigation and scenario transition clarity through selected drawer items.
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Original Date: 16 March 2025
 * Updated: 17 March 2025
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper
} from '@mui/material';
import Alert from '@mui/material/Alert';
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

import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';

import { AemoInterval, getRetailRateFromInterval, SupportedRegion } from './pricingCalculator';
import { EnergyScenarios } from './energyScenarios';
import statesData from '../data/au-states.json';

/**
 * Formats a number into Australian currency using Intl.NumberFormat.
 *
 * @param amount The number to format.
 * @return Formatted currency string.
 */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD'
  }).format(amount);
}

/**
 * Formats an ISO8601 date string into a localised date/time string (Australia/Brisbane),
 * appending " (NEM Time)".
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
 * Formats an interval's start time into a time range (HH:MM -> HH:MM).
 */
function formatIntervalTimeRange(dateString: string): string {
  if (!dateString) return '';
  const startDate = new Date(dateString + '+10:00');
  const endDate = new Date(startDate.getTime() + 5 * 60 * 1000);
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Australia/Brisbane',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  const startTime = startDate.toLocaleTimeString('en-AU', options);
  const endTime = endDate.toLocaleTimeString('en-AU', options);
  return `${startTime} -> ${endTime}`;
}

/**
 * Computes the wholesale price (in cents/kWh) from the RRP in $/MWh,
 * flooring negative values to zero.
 */
function computeWholesale(rrp: number): number {
  const value = rrp * 0.1;
  return value < 0 ? 0 : value;
}

/**
 * Returns the scenario key from the subdomain (preferred) or query string (dev only).
 */
function getScenarioKey(): string {
  const hostParts = window.location.hostname.split('.');
  if (hostParts.length > 2) {
    const subdomain = hostParts[0].toLowerCase();
    if (subdomain) return subdomain;
  }
  const params = new URLSearchParams(window.location.search);
  const paramScenario = params.get('s');
  return paramScenario ? paramScenario.toLowerCase() : '';
}

/**
 * Maps an icon name to its corresponding MUI icon component with aria-label.
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
 * Displays a simple 404 message when a scenario is not found.
 */
function ScenarioNotFound({ scenarioKey }: { scenarioKey: string }): JSX.Element {
  return (
    <Box display="flex" flexDirection="column" height="100vh" alignItems="center" justifyContent="center" textAlign="center" bgcolor="#fafafa">
      <Typography variant="h3" gutterBottom>404 - Scenario Not Found</Typography>
      <Typography variant="body1">
        The requested scenario "{scenarioKey}" does not exist.
      </Typography>
      <Box m={2}>
        <Button variant="contained" onClick={() => (window.location.href = '/')}>Go Home</Button>
      </Box>
    </Box>
  );
}

/**
 * Creates or updates a meta tag with the given attribute and content.
 */
function setMetaTag(attrName: string, attrValue: string, content: string): void {
  let element = document.querySelector(`meta[${attrName}="${attrValue}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attrName, attrValue);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

// Ray-casting and state determination functions (omitted for brevity; unchanged)
function isPointInPolygon(polygon: number[][], lat: number, lon: number): boolean { /* ... */ let inside = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const xi = polygon[i][1], yi = polygon[i][0]; const xj = polygon[j][1], yj = polygon[j][0]; const intersect = ((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi); if (intersect) inside = !inside; } return inside; }
function isPointInRingArray(ringArray: number[][][], lat: number, lon: number): boolean {
  if (ringArray.length === 0) return false;
  const outerRing = ringArray[0];
  return isPointInPolygon(outerRing, lat, lon);
}
function getStateNameForLatLon(lat: number, lon: number): string | null {
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
}
function mapStateNameToRegionKey(stateName: string): string | null {
  const lowerName = stateName.toLowerCase();
  if (lowerName.includes('wales')) return 'nsw';
  if (lowerName.includes('victoria')) return 'vic';
  if (lowerName.includes('queensland')) return 'qld';
  if (lowerName.includes('south australia')) return 'sa';
  if (lowerName.includes('tasmania')) return 'tas';
  return null;
}
function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

///////////////////////////////////////////////////////////////////////////
// SparklineChart Component
///////////////////////////////////////////////////////////////////////////
interface SparklineChartProps {
  todayIntervals: AemoInterval[];
  yesterdayIntervals: AemoInterval[];
  region: SupportedRegion;
  scenarioKey: string;
}
const SparklineChart: React.FC<SparklineChartProps> = ({ todayIntervals, yesterdayIntervals, region, scenarioKey }) => {
  const viewBoxWidth = 500;
  const svgHeight = 60;
  const padding = 5;
  
  // Compute the X coordinate based on linear time scale
  const computeX = (dt: Date, base: Date): number => {
    const diff = dt.getTime() - base.getTime();
    const fraction = diff / (24 * 60 * 60 * 1000);
    return padding + fraction * (viewBoxWidth - 2 * padding);
  };

  /**
   * Compute SVG polyline points for a group of intervals.
   * 
   * Added improvement: if the maximum cost is above $1, a logarithmic transformation
   * is applied (using an offset of 1) to compress outlier spikes while still showing
   * lower values with more context.
   */
  const computePoints = (intervals: AemoInterval[], base: Date): string => {
    const allCosts = [...todayIntervals, ...yesterdayIntervals].map(iv =>
      EnergyScenarios.getCostForScenario(scenarioKey, getRetailRateFromInterval(iv, region, false, true))
    );
    const maxCost = allCosts.length > 0 ? Math.max(...allCosts) : 0;
    const useLogScale = maxCost > 1; // Use log scale if max cost > $1
    const offset = 1; // Offset added to cost for log transformation to avoid log(0)
    let maxScaled = maxCost;
    if(useLogScale) {
      const allScaled = allCosts.map(c => Math.log(c + offset));
      maxScaled = Math.max(...allScaled);
    }
    return intervals.map(iv => {
      const dt = new Date(iv.SETTLEMENTDATE + '+10:00');
      const retailRate = getRetailRateFromInterval(iv, region, false, true);
      const cost = EnergyScenarios.getCostForScenario(scenarioKey, retailRate);
      const x = computeX(dt, base);
      let scaledValue = cost;
      if(useLogScale) {
        scaledValue = Math.log(cost + offset);
      }
      const y = svgHeight - padding - ((scaledValue / (maxScaled || 1)) * (svgHeight - 2 * padding));
      console.log(`SparklineChart Data point: SETTLEMENTDATE=${iv.SETTLEMENTDATE}, Parsed Date=${dt}, retailRate=${retailRate.toFixed(3)} c/kWh, cost=${cost.toFixed(4)} $, scaledValue=${scaledValue.toFixed(4)}, x=${x.toFixed(2)}, y=${y.toFixed(2)}`);
      return `${x},${y}`;
    }).join(' ');
  };

  // For the chart, we set the base time for each line at the start of each 24h period.
  const recentPeriodBase = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
  const previousPeriodBase = new Date(new Date().getTime() - 48 * 60 * 60 * 1000);

  const todayPoints = computePoints(todayIntervals, recentPeriodBase);
  const yesterdayPoints = computePoints(yesterdayIntervals, previousPeriodBase);

  // Compute overall maximum cost for reference line.
  const overallAllCosts = [...todayIntervals, ...yesterdayIntervals].map(iv =>
    EnergyScenarios.getCostForScenario(scenarioKey, getRetailRateFromInterval(iv, region, false, true))
  );
  const overallMaxCost = overallAllCosts.length > 0 ? Math.max(...overallAllCosts) : 0;
  const useLogScale = overallMaxCost > 1;
  const offset = 1;
  let overallMaxScaled = overallMaxCost;
  if(useLogScale) {
    overallMaxScaled = Math.max(...overallAllCosts.map(c => Math.log(c + offset)));
  }
  const yRef = svgHeight - padding - (((useLogScale ? Math.log(overallMaxCost + offset) : overallMaxCost) / (useLogScale ? overallMaxScaled : (overallMaxCost || 1))) * (svgHeight - 2 * padding));

  // Build final chart data object
  const chartData = {
    today: todayIntervals.map(iv => ({
      date: iv.SETTLEMENTDATE,
      cost: EnergyScenarios.getCostForScenario(scenarioKey, getRetailRateFromInterval(iv, region, false, true))
    })),
    yesterday: yesterdayIntervals.map(iv => ({
      date: iv.SETTLEMENTDATE,
      cost: EnergyScenarios.getCostForScenario(scenarioKey, getRetailRateFromInterval(iv, region, false, true))
    })),
    todayPoints,
    yesterdayPoints
  };
  console.log("SparklineChart - Final Chart Data Object:", JSON.stringify(chartData, null, 2));

  return (
    <Box mt={2}>
      <Typography variant="subtitle2">
        24‑Hour Trend (Recent 24h in blue, Previous 24h in grey){useLogScale ? " (Log Scale Applied)" : ""}
      </Typography>
      <svg width="100%" viewBox={`0 0 ${viewBoxWidth} ${svgHeight}`} aria-label="24-hour scenario cost trend">
        {yesterdayIntervals.length > 0 && (
          <polyline fill="none" stroke="#888888" strokeWidth="2" points={yesterdayPoints} />
        )}
        {todayIntervals.length > 0 && (
          <polyline fill="none" stroke="#1976d2" strokeWidth="2" points={todayPoints} />
        )}
        <line x1={padding} y1={yRef} x2={viewBoxWidth - padding} y2={yRef} stroke="#ff0000" strokeDasharray="4" strokeWidth="1" />
        <text x={padding + 2} y={yRef - 2} fill="#ff0000" fontSize="10">
          Max: {formatCurrency(overallMaxCost)}
        </text>
      </svg>
    </Box>
  );
};

///////////////////////////////////////////////////////////////////////////
// Main App Component
///////////////////////////////////////////////////////////////////////////
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

  const isDevMode = window.location.hostname.includes('localhost') || window.location.hostname.includes('127.');

  const toggleDrawer = (open: boolean) => (): void => {
    setDrawerOpen(open);
  };

  // Update scenario using subdomain if in production or query parameter if in dev mode.
  function handleScenarioChange(newScenario: string): void {
    const url = new URL(window.location.href);
    if (!isDevMode && url.hostname.split('.').length > 2) {
      const parts = url.hostname.split('.');
      parts[0] = newScenario;
      url.hostname = parts.join('.');
      window.location.assign(url.toString());
    } else {
      url.searchParams.set('s', newScenario);
      window.location.assign(url.toString());
    }
  }

  // Change region by updating the pathname (region is determined from the first path segment)
  function handleRegionClick(newRegion: string): void {
    const scenarioKey = getScenarioKey();
    const url = new URL(window.location.href);
    url.pathname = '/' + newRegion;
    if (isDevMode && scenarioKey) {
      url.searchParams.set('s', scenarioKey);
    }
    window.location.assign(url.toString());
  }

  // Determine region from pathname; if the first segment is "about", render the About page.
  const pathParts = window.location.pathname.split('/');
  const regionKey = pathParts[1]?.toLowerCase() || 'nsw';
  if (regionKey === 'about') {
    return <AboutPage drawerOpen={drawerOpen} toggleDrawer={toggleDrawer} handleScenarioChange={handleScenarioChange} />;
  }

  const regionMapping: Record<string, string> = {
    nsw: 'NSW1',
    qld: 'QLD1',
    sa: 'SA1',
    tas: 'TAS1',
    vic: 'VIC1'
  };

  const scenarioKeyStr = getScenarioKey().trim();
  if (!scenarioKeyStr) {
    window.location.href = '/nsw?s=toast';
    return null;
  }
  const scenarioData = EnergyScenarios.getScenarioById(scenarioKeyStr);
  if (!scenarioData) {
    return <ScenarioNotFound scenarioKey={scenarioKeyStr} />;
  }
  const regionFilter = regionMapping[regionKey] ?? 'NSW1';

  /**
   * Fetches the latest AEMO 5‑minute data.
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
      const data: { '5MIN': AemoInterval[] } = await response.json();
      console.log("Fetched AEMO intervals (raw):", data['5MIN'].length);
      setAllIntervals(data['5MIN']);
      const regData: AemoInterval[] = data['5MIN'].filter(iv => iv.REGIONID === regionFilter);
      regData.sort((a, b) => new Date(a.SETTLEMENTDATE).getTime() - new Date(b.SETTLEMENTDATE).getTime());
      console.log("Fetched regionIntervals for region", regionFilter, ":", regData.length);
      setRegionIntervals(regData);
      if (regData.length > 0) {
        const latest = regData[regData.length - 1];
        let wholesale = latest.RRP * 0.1;
        if (wholesale < 0) wholesale = 0;
        setRrpCentsPerKWh(wholesale);
        const computedRate = getRetailRateFromInterval(latest, regionKey as SupportedRegion, false, true);
        setFinalRateCents(computedRate);
        const cost = EnergyScenarios.getCostForScenario(scenarioKeyStr, computedRate);
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

  useEffect(() => {
    fetchAemoData();
    const intervalId = setInterval(fetchAemoData, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [regionFilter, scenarioKeyStr]);

  // -----------------------------------------------------------------------
  // NEW 24+24 HOUR INTERVAL LOGIC
  // Compute Brisbane current time using a fixed +10 hour offset (as Brisbane is UTC+10 always)
  function getBrisbaneNow(): Date {
    const now = new Date();
    const brisbaneOffsetMinutes = 10 * 60; // +10 hours in minutes
    const localOffsetMinutes = now.getTimezoneOffset();
    return new Date(now.getTime() + (brisbaneOffsetMinutes + localOffsetMinutes) * 60000);
  }
  const brisbaneNow = getBrisbaneNow();
  const twentyFourHoursAgo = new Date(brisbaneNow.getTime() - 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(brisbaneNow.getTime() - 48 * 60 * 60 * 1000);
  console.log("App Component - Brisbane Now:", brisbaneNow);
  console.log("App Component - 24 Hours Ago:", twentyFourHoursAgo);
  console.log("App Component - 48 Hours Ago:", fortyEightHoursAgo);

  const recent24Intervals = regionIntervals.filter(iv => {
    const d = new Date(iv.SETTLEMENTDATE + '+10:00');
    console.log("Recent 24h filtering: SETTLEMENTDATE=", iv.SETTLEMENTDATE, " parsed as ", d);
    return d >= twentyFourHoursAgo && d <= brisbaneNow;
  });
  const previous24Intervals = regionIntervals.filter(iv => {
    const d = new Date(iv.SETTLEMENTDATE + '+10:00');
    console.log("Previous 24h filtering: SETTLEMENTDATE=", iv.SETTLEMENTDATE, " parsed as ", d);
    return d >= fortyEightHoursAgo && d < twentyFourHoursAgo;
  });

  // -----------------------------------------------------------------------
  // Compute daily summaries for the Daily Summary Table.
  interface DailySummary {
    date: string;
    minWholesale: number;
    minRetail: number;
    maxWholesale: number;
    maxRetail: number;
  }
  function computeDailySummaries(intervals: AemoInterval[], region: SupportedRegion): DailySummary[] {
    const summaryMap: Record<string, DailySummary> = {};
    intervals.forEach(iv => {
      const d = new Date(iv.SETTLEMENTDATE + '+10:00');
      const dateKey = d.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' });
      let wholesale = iv.RRP * 0.1;
      if (wholesale < 0) wholesale = 0;
      const retail = getRetailRateFromInterval(iv, region, false, true);
      if (!summaryMap[dateKey]) {
         summaryMap[dateKey] = {
            date: dateKey,
            minWholesale: wholesale,
            minRetail: retail,
            maxWholesale: wholesale,
            maxRetail: retail
         };
      } else {
         summaryMap[dateKey].minWholesale = Math.min(summaryMap[dateKey].minWholesale, wholesale);
         summaryMap[dateKey].minRetail = Math.min(summaryMap[dateKey].minRetail, retail);
         summaryMap[dateKey].maxWholesale = Math.max(summaryMap[dateKey].maxWholesale, wholesale);
         summaryMap[dateKey].maxRetail = Math.max(summaryMap[dateKey].maxRetail, retail);
      }
    });
    return Object.values(summaryMap).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }
  const dailySummaries = computeDailySummaries(regionIntervals, regionKey as SupportedRegion);

  // Get scenario icon element.
  const scenarioIconElement = getScenarioIcon(scenarioData.iconName);

  // Update meta tags on scenario change.
  useEffect(() => {
    const scenarioTitle = scenarioData.name;
    const regionUpper = regionKey.toUpperCase();
    const pageTitle = `Cost to ${scenarioTitle} in ${regionUpper}`;
    const fullURL = window.location.href;
    document.title = pageTitle;
    setMetaTag('property', 'og:title', pageTitle);
    setMetaTag('property', 'og:description', scenarioData.description);
    setMetaTag('property', 'og:url', fullURL);
    setMetaTag('property', 'og:type', 'website');
    setMetaTag('name', 'DC.title', pageTitle);
    setMetaTag('name', 'DC.description', scenarioData.description);
    setMetaTag('name', 'DC.subject', scenarioTitle);
  }, [scenarioData, regionKey]);

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

      <Drawer anchor="left" open={drawerOpen} onClose={toggleDrawer(false)}>
        <Box sx={{ width: 250 }} role="presentation" onClick={toggleDrawer(false)} onKeyDown={toggleDrawer(false)}>
          <List>
            <ListItem button onClick={() => handleScenarioChange('toast')} selected={'toast' === scenarioKeyStr}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="Home" />
            </ListItem>
            <ListItem button onClick={() => (window.location.href = '/about')}>
              <ListItemIcon>
                <InfoIcon />
              </ListItemIcon>
              <ListItemText primary="About" />
            </ListItem>
            {EnergyScenarios.getAllScenarios().map(item => (
              <ListItem key={item.id} button onClick={() => handleScenarioChange(item.id.toLowerCase())} selected={item.id.toLowerCase() === scenarioKeyStr}>
                <ListItemIcon>{getScenarioIcon(item.iconName)}</ListItemIcon>
                <ListItemText primary={item.name} />
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>

      <Box component="main" flexGrow={1} display="flex" justifyContent="center" alignItems="flex-start" bgcolor="#fafafa" p={2}>
        <Box sx={{ marginBottom: 4, maxWidth: 480, width: '100%' }}>
          <Box sx={{ marginBottom: 2 }}>
            <FormControl fullWidth>
              <InputLabel id="scenario-select-label">Select Scenario</InputLabel>
              <Select
                labelId="scenario-select-label"
                label="Select Scenario"
                value={scenarioKeyStr}
                onChange={(event: SelectChangeEvent) => handleScenarioChange(event.target.value)}
              >
                {EnergyScenarios.getAllScenarios().map(scn => (
                  <MenuItem key={scn.id} value={scn.id.toLowerCase()}>
                    {scn.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" mt={1}>
              Note: Subdomains are used for scenario selection in production.
            </Typography>
          </Box>

          <Card sx={{ maxWidth: 480, width: '100%' }}>
            <CardHeader
              avatar={getScenarioIcon(scenarioData.iconName)}
              title={`Cost for ${scenarioData.name}`}
              action={
                <Tooltip title="Refresh Data">
                  <IconButton onClick={fetchAemoData} aria-label="Refresh Data">
                    <RefreshIcon />
                  </IconButton>
                </Tooltip>
              }
            />
            <CardContent>
              {error ? (
                <Alert severity="error" action={<Button color="inherit" size="small" onClick={fetchAemoData}>Retry</Button>}>
                  {error}
                </Alert>
              ) : loading ? (
                <Box display="flex" flexDirection="column" alignItems="center" mt={2}>
                  <CircularProgress />
                  <Typography variant="body2" mt={1}>Loading latest pricing…</Typography>
                </Box>
              ) : (
                <>
                  <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" mb={3}>
                    <Box display="flex" alignItems="center" mb={1}>
                      <MonetizationOnIcon fontSize="large" sx={{ marginRight: 1 }} aria-label="Price icon" />
                      <Typography variant="h4" color="secondary" sx={{ transition: 'all 0.5s ease' }}>
                        {formatCurrency(toastCostDollars)}
                      </Typography>
                    </Box>
                    <Typography variant="subtitle1" align="center">(per scenario usage)</Typography>
                  </Box>
                  <Typography variant="body1" gutterBottom>Region: {regionFilter}</Typography>
                  <Typography variant="body1" gutterBottom>
                    Current Wholesale Spot Price: {rrpCentsPerKWh.toFixed(3)} c/kWh{' '}
                    <Tooltip title="This is the real-time wholesale price from AEMO. Negative values are floored to 0.">
                      <IconButton size="small" aria-label="Wholesale info">
                        <InfoIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Typography>
                  <Typography variant="body1" gutterBottom>
                    Final Price (incl. GST): {finalRateCents.toFixed(3)} c/kWh{' '}
                    <Tooltip title="This is the approximate retail rate, including all charges.">
                      <IconButton size="small" aria-label="Retail info">
                        <InfoIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Typography>
                  {scenarioData.description && (
                    <Typography variant="body2" sx={{ marginTop: 2 }}>
                      {scenarioData.description}
                    </Typography>
                  )}
                  {scenarioData.assumptions && scenarioData.assumptions.length > 0 && (
                    <Box mt={2}>
                      <Typography variant="subtitle1">Assumptions:</Typography>
                      <ul>
                        {scenarioData.assumptions.map((assumption, idx) => (
                          <li key={idx}>
                            <Typography variant="body2">{assumption}</Typography>
                          </li>
                        ))}
                      </ul>
                    </Box>
                  )}
                  <Typography variant="caption" display="block" mt={2}>
                    Updated automatically every 5 minutes.
                  </Typography>
                </>
              )}
            </CardContent>
            <CardActions>
              <Typography variant="caption">
                Interval used for calculation: {formatIntervalDate(usedIntervalDate)}{' '}
                <Tooltip title="AEMO operates on NEM Time (Australia/Brisbane).">
                  <IconButton size="small" aria-label="Time info">
                    <InfoIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Typography>
            </CardActions>
          </Card>

          {/* 24+24 Hour Comparative Chart */}
          <SparklineChart
            todayIntervals={recent24Intervals}
            yesterdayIntervals={previous24Intervals}
            region={regionKey as SupportedRegion}
            scenarioKey={scenarioKeyStr}
          />

          {/* Reference Grid for other regions */}
          <Box sx={{ maxWidth: 480, width: '100%', marginTop: 2 }}>
            <Typography variant="h6" gutterBottom>
              Reference Costs for Other Regions
            </Typography>
            <Grid container spacing={2}>
              {(() => {
                const otherRegions = Object.keys(regionMapping).filter(r => r !== regionKey);
                const refs = otherRegions.map(r => {
                  const intervalsForR = allIntervals.filter(iv => iv.REGIONID === regionMapping[r]);
                  intervalsForR.sort((a, b) => new Date(a.SETTLEMENTDATE).getTime() - new Date(b.SETTLEMENTDATE).getTime());
                  if (intervalsForR.length > 0) {
                    const latest = intervalsForR[intervalsForR.length - 1];
                    let wholesale = latest.RRP * 0.1;
                    if (wholesale < 0) wholesale = 0;
                    const finalRate = getRetailRateFromInterval(latest, r as SupportedRegion, false, true);
                    const cost = EnergyScenarios.getCostForScenario(scenarioKeyStr, finalRate);
                    return {
                      region: r.toUpperCase(),
                      wholesaleCents: wholesale,
                      scenarioCost: cost,
                      date: latest.SETTLEMENTDATE
                    };
                  } else {
                    return { region: r.toUpperCase(), wholesaleCents: 0, scenarioCost: 0, date: '' };
                  }
                });
                return refs.map(item => {
                  const cost = item.scenarioCost;
                  const isMin = cost === Math.min(...[toastCostDollars, ...refs.map(r => r.scenarioCost)]);
                  const isMax = cost === Math.max(...[toastCostDollars, ...refs.map(r => r.scenarioCost)]);
                  let tag: ReactNode = null;
                  if (isMin && isMax) {
                    tag = (
                      <Chip label="Cheapest & Most Expensive" icon={<StarIcon />} color="warning" size="small" sx={{ mt: 1 }} />
                    );
                  } else if (isMin) {
                    tag = (
                      <Chip label="Cheapest" icon={<StarIcon />} color="success" size="small" sx={{ mt: 1 }} />
                    );
                  } else if (isMax) {
                    tag = (
                      <Chip label="Most Expensive" icon={<WarningIcon />} color="error" size="small" sx={{ mt: 1 }} />
                    );
                  }
                  let regKeyStr = 'nsw';
                  switch (item.region.toLowerCase()) {
                    case 'nsw': regKeyStr = 'nsw'; break;
                    case 'qld': regKeyStr = 'qld'; break;
                    case 'sa': regKeyStr = 'sa'; break;
                    case 'tas': regKeyStr = 'tas'; break;
                    case 'vic': regKeyStr = 'vic'; break;
                    default: regKeyStr = 'nsw';
                  }
                  return (
                    <Grid item xs={6} sm={4} key={item.region}>
                      <Card sx={{ cursor: 'pointer' }} onClick={() => handleRegionClick(regKeyStr)}>
                        <CardContent>
                          <Typography variant="h6">{item.region}</Typography>
                          <Typography variant="body1">{formatCurrency(item.scenarioCost)}</Typography>
                          {tag}
                        </CardContent>
                      </Card>
                    </Grid>
                  );
                });
              })()}
            </Grid>
          </Box>

          {/* Daily Summary Table */}
          <Box sx={{ maxWidth: 480, width: '100%', marginTop: 2 }}>
            <Typography variant="h6" gutterBottom>
              Daily Wholesale and Retail Rates Summary
            </Typography>
            {dailySummaries.length === 0 ? (
              <Typography variant="body2">No daily summary data available.</Typography>
            ) : (
              <TableContainer component={Paper}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Date</TableCell>
                      <TableCell align="right">Cheapest Wholesale ($/kWh)</TableCell>
                      <TableCell align="right">Cheapest Retail ($/kWh)</TableCell>
                      <TableCell align="right">Most Expensive Wholesale ($/kWh)</TableCell>
                      <TableCell align="right">Most Expensive Retail ($/kWh)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {dailySummaries.map(row => (
                      <TableRow key={row.date}>
                        <TableCell component="th" scope="row">{row.date}</TableCell>
                        <TableCell align="right">{(row.minWholesale / 100).toFixed(2)}</TableCell>
                        <TableCell align="right">{(row.minRetail / 100).toFixed(2)}</TableCell>
                        <TableCell align="right">{(row.maxWholesale / 100).toFixed(2)}</TableCell>
                        <TableCell align="right">{(row.maxRetail / 100).toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        </Box>
      </Box>

      <Box component="footer" sx={{ textAlign: 'center', py: 2 }}>
        <Typography variant="body2">
          CC0 1.0 Universal | <a href="https://github.com/troykelly/costs-this-much">GitHub</a> | <a href="https://troykelly.com/">Troy Kelly</a>
          <br />
          Data sourced from{' '}
          <Link href="https://www.aemo.com.au/" target="_blank" rel="noopener noreferrer">
            AEMO
          </Link>
        </Typography>
        <Box mt={1}>
          <Button variant="outlined" onClick={() => setLocationDialogOpen(true)}>My Location</Button>
        </Box>
      </Box>

      <Dialog open={locationDialogOpen} onClose={() => setLocationDialogOpen(false)}>
        <DialogTitle>Location Data Request</DialogTitle>
        <DialogContent>
          <Typography variant="body1">
            We are about to request your location data to determine the nearest region for pricing.
            This is entirely voluntary – no long‑term tracking occurs and your data will not be stored.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLocationDialogOpen(false)} color="error">Deny</Button>
          <Button onClick={() => {
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
                  alert('It appears you are outside of the serviced area. We will default to NSW.');
                  handleRegionClick('nsw');
                  return;
                }
                const mappedRegion = mapStateNameToRegionKey(stateName);
                if (mappedRegion && regionMapping[mappedRegion]) {
                  handleRegionClick(mappedRegion);
                } else {
                  alert('It appears your location is not in a supported region. We will default to NSW.');
                  handleRegionClick('nsw');
                }
              },
              () => {
                alert('Unable to retrieve your location. Please check permissions.');
              }
            );
          }} color="primary">Allow</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

/**
 * AboutPage component - provides details about the application.
 */
interface AboutPageProps {
  drawerOpen: boolean;
  toggleDrawer: (open: boolean) => () => void;
  handleScenarioChange: (newScenario: string) => void;
}
function AboutPage(props: AboutPageProps): JSX.Element {
  const { drawerOpen, toggleDrawer, handleScenarioChange } = props;
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
    <Box display="flex" flexDirection="column" minHeight="100vh">
      <AppBar position="static" sx={{ marginBottom: 2 }}>
        <Toolbar>
          <IconButton edge="start" color="inherit" aria-label="menu" onClick={toggleDrawer(true)}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>About</Typography>
        </Toolbar>
      </AppBar>
      <Drawer anchor="left" open={drawerOpen} onClose={toggleDrawer(false)}>
        <Box sx={{ width: 250 }} role="presentation" onClick={toggleDrawer(false)} onKeyDown={toggleDrawer(false)}>
          <List>
            <ListItem button onClick={() => handleScenarioChange('toast')}>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="Home" />
            </ListItem>
            <ListItem button onClick={() => (window.location.href = '/about')}>
              <ListItemIcon>
                <InfoIcon />
              </ListItemIcon>
              <ListItemText primary="About" />
            </ListItem>
          </List>
        </Box>
      </Drawer>
      <Box component="main" flexGrow={1} p={2}>
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
          Keep in mind that AEMO pricing is based on National Electricity Market (NEM)
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
      <Box component="footer" sx={{ textAlign: 'center', py: 2 }}>
        <Typography variant="body2">© 2025 Troy Kelly | CC0 1.0 Universal</Typography>
      </Box>
    </Box>
  );
}

export default App;