/**
 * @fileoverview App.tsx - A simple React application that retrieves the current AEMO
 * network price for a selected region and computes an approximate cost for a chosen
 * energy scenario (toast, EV charge, phone charge, etc.).
 *
 * Features and enhancements include:
 *  - Polling the AEMO "5MIN" endpoint every five minutes
 *  - Automatic region determination using the pathname (nsw, qld, sa, tas, vic)
 *  - Scenario determination via subdomain or query string, with a default fallback.
 *  - Enhanced loading feedback with a clear "Loading latest pricing…" message.
 *  - Manual refresh option via a visible refresh button.
 *  - Accessible icons with aria‑labels and tooltips.
 *  - Smooth visual transitions when pricing numbers update.
 *  - An overlaid sparkline chart displaying two 24‑hour trends (today in blue, yesterday in grey)
 *    that fills the full column width along with a red reference line for the highest value.
 *  - Display of “Cheapest” and “Most Expensive” scenario cost cards with calendar views.
 *  - A daily summary table of wholesale and retail rates for the current region.
 *  - Clear indications of the timezone (NEM Time, Australia/Brisbane).
 *  - A refined geolocation consent dialog with clear messaging.
 *  - Navigation and scenario selection guidance via a select control and drawer menu.
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Original Date: 16 March 2025
 * Updated: 17 March 2025
 */

import React, { useEffect, useState, ReactNode, useMemo } from 'react';
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
  Paper,
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

import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';

import { AemoInterval, getRetailRateFromInterval, SupportedRegion } from './pricingCalculator';
import { EnergyScenarios } from './energyScenarios';
import statesData from '../data/au-states.json';

/**
 * Formats an ISO8601 date string into a localised date/time string using Australia/Brisbane timezone.
 *
 * @param {string} dateString - The ISO date string (e.g., "2025-03-16T14:05:00")
 * @return {string} The formatted string with " (NEM Time)" appended.
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
 * Formats a 5‑minute interval time range for display as "HH:MM -> HH:MM".
 *
 * @param {string} dateString The ISO8601 settlement date/time.
 * @return {string} The formatted time range.
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
 * Computes the wholesale price from RRP in $/MWh, converting to cents/kWh and flooring negatives.
 *
 * @param {number} rrp The RRP value in $/MWh.
 * @return {number} The computed wholesale in cents/kWh.
 */
function computeWholesale(rrp: number): number {
  const value = rrp * 0.1;
  return value < 0 ? 0 : value;
}

/**
 * Retrieves the scenario key from subdomain or query string 's'.
 *
 * @return {string} The scenario key.
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
 * Maps the provided icon name to a corresponding MUI icon component with aria-label.
 *
 * @param {string | undefined} iconName The icon name.
 * @return {JSX.Element} The icon element.
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
 * Displays a message when the requested scenario is not found.
 *
 * @param {object} props
 * @param {string} props.scenarioKey The scenario key.
 * @return {JSX.Element}
 */
function ScenarioNotFound({ scenarioKey }: { scenarioKey: string }): JSX.Element {
  return (
    <Box display="flex" flexDirection="column" height="100vh" alignItems="center" justifyContent="center" textAlign="center" bgcolor="#fafafa">
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
 * Creates/updates a meta tag with the given attribute and content.
 *
 * @param {string} attrName The meta attribute name.
 * @param {string} attrValue The meta attribute value.
 * @param {string} content The content value.
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

/**
 * Ray-casting algorithm to determine if a point is inside the polygon.
 *
 * @param {number[][]} polygon Array of [lon, lat] pairs.
 * @param {number} lat The latitude.
 * @param {number} lon The longitude.
 * @return {boolean} True if inside.
 */
function isPointInPolygon(polygon: number[][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1], yi = polygon[i][0];
    const xj = polygon[j][1], yj = polygon[j][0];
    const intersect = ((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Checks if a point is inside the first (outer) ring of a GeoJSON polygon.
 *
 * @param {number[][][]} ringArray Array of rings.
 * @param {number} lat The latitude.
 * @param {number} lon The longitude.
 * @return {boolean} True if inside.
 */
function isPointInRingArray(ringArray: number[][][], lat: number, lon: number): boolean {
  if (ringArray.length === 0) return false;
  const outerRing = ringArray[0];
  return isPointInPolygon(outerRing, lat, lon);
}

/**
 * Determines the AU state name from given coordinates using GeoJSON.
 *
 * @param {number} lat The latitude.
 * @param {number} lon The longitude.
 * @return {string | null} The state name if found.
 */
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

/**
 * Maps a full state name to one of the supported region keys.
 *
 * @param {string} stateName The full state name.
 * @return {string | null} The corresponding region key.
 */
function mapStateNameToRegionKey(stateName: string): string | null {
  const lowerName = stateName.toLowerCase();
  if (lowerName.includes('wales')) return 'nsw';
  if (lowerName.includes('victoria')) return 'vic';
  if (lowerName.includes('queensland')) return 'qld';
  if (lowerName.includes('south australia')) return 'sa';
  if (lowerName.includes('tasmania')) return 'tas';
  return null;
}

/**
 * Checks if a given date is on a weekend.
 *
 * @param {Date} date The date.
 * @return {boolean} True if Saturday or Sunday.
 */
function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * Enum representing time-of-use periods.
 */
enum TouPeriod {
  PEAK = 'peak',
  SHOULDER = 'shoulder',
  OFFPEAK = 'offpeak'
}

/**
 * Determines the time-of-use period for a given date in a region.
 *
 * @param {Date} date The date to evaluate.
 * @param {SupportedRegion} region The region code.
 * @return {TouPeriod} The period ('peak', 'shoulder', 'offpeak').
 */
function getTimeOfUsePeriodForRegion(date: Date, region: SupportedRegion): TouPeriod {
  const hour = date.getHours();
  const dayIsWeekend = isWeekend(date);
  switch (region) {
    case 'nsw': {
      if (!dayIsWeekend) {
        if (hour >= 14 && hour < 20) return TouPeriod.PEAK;
        else if ((hour >= 7 && hour < 14) || (hour >= 20 && hour < 22)) return TouPeriod.SHOULDER;
        else return TouPeriod.OFFPEAK;
      } else {
        if (hour >= 7 && hour < 22) return TouPeriod.SHOULDER;
        else return TouPeriod.OFFPEAK;
      }
    }
    case 'qld': {
      if (!dayIsWeekend) {
        if (hour >= 16 && hour < 20) return TouPeriod.PEAK;
        else if ((hour >= 7 && hour < 16) || (hour >= 20 && hour < 22)) return TouPeriod.SHOULDER;
        else return TouPeriod.OFFPEAK;
      } else {
        if (hour >= 7 && hour < 22) return TouPeriod.SHOULDER;
        else return TouPeriod.OFFPEAK;
      }
    }
    case 'vic': {
      if (!dayIsWeekend) {
        if (hour >= 15 && hour < 21) return TouPeriod.PEAK;
        else if ((hour >= 7 && hour < 15) || (hour >= 21 && hour < 22)) return TouPeriod.SHOULDER;
        else return TouPeriod.OFFPEAK;
      } else {
        if (hour >= 7 && hour < 22) return TouPeriod.SHOULDER;
        else return TouPeriod.OFFPEAK;
      }
    }
    case 'sa': {
      if (hour >= 1 && hour < 6) return TouPeriod.OFFPEAK;
      if ((hour >= 6 && hour < 10) || (hour >= 15 && hour <= 23) || hour === 0) return TouPeriod.PEAK;
      return TouPeriod.SHOULDER;
    }
    case 'tas': {
      if (!dayIsWeekend) {
        const isMorningPeak = hour >= 7 && hour < 10; 
        const isEveningPeak = hour >= 16 && hour < 21;
        if (isMorningPeak || isEveningPeak) return TouPeriod.PEAK;
        return TouPeriod.OFFPEAK;
      } else {
        return TouPeriod.OFFPEAK;
      }
    }
  }
}

/**
 * SparklineChart component displays an overlaid chart of retail rates for two 24‑hour periods:
 * today (in blue) and yesterday (in grey). The chart fills the full width of its container,
 * and includes a reference horizontal line at the highest cost for scale.
 *
 * @param {object} props
 * @param {AemoInterval[]} todayIntervals Array of intervals for today.
 * @param {AemoInterval[]} yesterdayIntervals Array of intervals for yesterday.
 * @param {SupportedRegion} region The region to use for calculation.
 * @return {JSX.Element | null} The sparkline chart.
 */
interface SparklineChartProps {
  todayIntervals: AemoInterval[];
  yesterdayIntervals: AemoInterval[];
  region: SupportedRegion;
}
const SparklineChart: React.FC<SparklineChartProps> = ({ todayIntervals, yesterdayIntervals, region }) => {
  // Fixed SVG dimensions; width will stretch to 100% of container.
  const svgWidth = 500;
  const svgHeight = 60;
  const padding = 5;
  // Compute today and yesterday midnights in Australia/Brisbane
  const now = new Date();
  const todayMidnight = new Date(now.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' }));
  const yesterdayMidnight = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);
  const tomorrowMidnight = new Date(todayMidnight.getTime() + 24 * 60 * 60 * 1000);

  // Helper: compute x position based on time offset from base midnight
  const computeX = (dt: Date, base: Date): number => {
    const diff = dt.getTime() - base.getTime();
    const fraction = diff / (24 * 60 * 60 * 1000);
    return padding + fraction * (svgWidth - 2 * padding);
  };

  // Compute points for a set of intervals using a base midnight.
  const computePoints = (intervals: AemoInterval[], base: Date): string => {
    return intervals.map(iv => {
      const dt = new Date(iv.SETTLEMENTDATE + '+10:00');
      const x = computeX(dt, base);
      const rate = getRetailRateFromInterval(iv, region, false, true);
      // Normalize y: lower rate => higher y value (since (0,0) at top-left)
      const y = svgHeight - padding - ((rate - 0) / (Math.max(...[...todayIntervals, ...yesterdayIntervals].map(iv => getRetailRateFromInterval(iv, region, false, true))) * (svgHeight - 2 * padding));
      return `${x},${y}`;
    }).join(' ');
  };

  const todayPoints = computePoints(todayIntervals, todayMidnight);
  const yesterdayPoints = computePoints(yesterdayIntervals, yesterdayMidnight);

  // Determine overall maximum to draw reference line.
  const allRates = [...todayIntervals, ...yesterdayIntervals].map(iv => getRetailRateFromInterval(iv, region, false, true));
  const maxRate = allRates.length > 0 ? Math.max(...allRates) : 0;
  const yRef = svgHeight - padding - (maxRate / (maxRate || 1)) * (svgHeight - 2 * padding);

  return (
    <Box mt={2}>
      <Typography variant="subtitle2">24‑Hour Trend (Today in blue, Yesterday in grey)</Typography>
      <svg width="100%" viewBox={`0 0 ${svgWidth} ${svgHeight}`} aria-label="24-hour retail rate trend">
        {yesterdayIntervals.length > 0 && (
          <polyline fill="none" stroke="#888888" strokeWidth="2" points={yesterdayPoints} />
        )}
        {todayIntervals.length > 0 && (
          <polyline fill="none" stroke="#1976d2" strokeWidth="2" points={todayPoints} />
        )}
        <line x1={padding} y1={yRef} x2={svgWidth - padding} y2={yRef} stroke="#ff0000" strokeDasharray="4" strokeWidth="1" />
        <text x={padding + 2} y={yRef - 2} fill="#ff0000" fontSize="10">Max: {maxRate.toFixed(2)} c/kWh</text>
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

  // For error feedback (if needed).
  const [error, setError] = useState<string | null>(null);

  const toggleDrawer = (open: boolean) => (): void => {
    setDrawerOpen(open);
  };

  // Determine region from the pathname; if the first path is "about" load AboutPage.
  const pathParts = window.location.pathname.split('/');
  const regionKey = pathParts[1]?.toLowerCase() || 'nsw';
  if (regionKey === 'about') {
    return <AboutPage drawerOpen={drawerOpen} toggleDrawer={toggleDrawer} />;
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
    // If no scenario is provided, default to "toast"
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
      setAllIntervals(data['5MIN']);
      const regData = data['5MIN'].filter(iv => iv.REGIONID === regionFilter);
      regData.sort((a, b) => new Date(a.SETTLEMENTDATE).getTime() - new Date(b.SETTLEMENTDATE).getTime());
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

  // Compute cheapest and most expensive intervals for current region.
  let cheapestCost: number | null = null;
  let cheapestInterval: AemoInterval | null = null;
  let expensiveCost: number | null = null;
  let expensiveInterval: AemoInterval | null = null;
  for (const iv of regionIntervals) {
    const rate = getRetailRateFromInterval(iv, regionKey as SupportedRegion, false, true);
    const cost = EnergyScenarios.getCostForScenario(scenarioKeyStr, rate);
    if (cheapestCost === null || cost < cheapestCost) {
      cheapestCost = cost;
      cheapestInterval = iv;
    }
    if (expensiveCost === null || cost > expensiveCost) {
      expensiveCost = cost;
      expensiveInterval = iv;
    }
  }
  let cheapestWholesale = 0;
  let cheapestIntervalRate = 0;
  if (cheapestInterval) {
    let raw = cheapestInterval.RRP * 0.1;
    if (raw < 0) raw = 0;
    cheapestWholesale = raw;
    cheapestIntervalRate = getRetailRateFromInterval(cheapestInterval, regionKey as SupportedRegion, false, true);
  }
  let expensiveWholesale = 0;
  let expensiveIntervalRate = 0;
  if (expensiveInterval) {
    let raw = expensiveInterval.RRP * 0.1;
    if (raw < 0) raw = 0;
    expensiveWholesale = raw;
    expensiveIntervalRate = getRetailRateFromInterval(expensiveInterval, regionKey as SupportedRegion, false, true);
  }

  // Compute daily summaries by grouping intervals by day.
  const dailySummaries = useMemo(() => {
    const groups: { [day: string]: AemoInterval[] } = {};
    regionIntervals.forEach(iv => {
      const day = iv.SETTLEMENTDATE.slice(0, 10);
      if (!groups[day]) groups[day] = [];
      groups[day].push(iv);
    });
    const summaries: { date: string; minWholesale: number; minRetail: number; maxWholesale: number; maxRetail: number }[] = [];
    for (const day in groups) {
      const ivs = groups[day];
      let minIv = ivs[0];
      let maxIv = ivs[0];
      ivs.forEach(iv => {
        if (computeWholesale(iv.RRP) < computeWholesale(minIv.RRP)) {
          minIv = iv;
        }
        if (computeWholesale(iv.RRP) > computeWholesale(maxIv.RRP)) {
          maxIv = iv;
        }
      });
      summaries.push({
        date: day,
        minWholesale: computeWholesale(minIv.RRP),
        minRetail: getRetailRateFromInterval(minIv, regionKey as SupportedRegion, false, true),
        maxWholesale: computeWholesale(maxIv.RRP),
        maxRetail: getRetailRateFromInterval(maxIv, regionKey as SupportedRegion, false, true)
      });
    }
    summaries.sort((a, b) => a.date.localeCompare(b.date));
    return summaries;
  }, [regionIntervals, regionKey]);

  // For sparkline, compute "today" and "yesterday" intervals using Australia/Brisbane time.
  const nowTime = new Date();
  const brisbaneTodayMidnight = new Date(nowTime.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' }));
  const brisbaneTomorrowMidnight = new Date(brisbaneTodayMidnight.getTime() + 24 * 60 * 60 * 1000);
  const brisbaneYesterdayMidnight = new Date(brisbaneTodayMidnight.getTime() - 24 * 60 * 60 * 1000);
  const todayIntervals = regionIntervals.filter(iv => {
    const d = new Date(iv.SETTLEMENTDATE + '+10:00');
    return d >= brisbaneTodayMidnight && d < brisbaneTomorrowMidnight;
  });
  const yesterdayIntervals = regionIntervals.filter(iv => {
    const d = new Date(iv.SETTLEMENTDATE + '+10:00');
    return d >= brisbaneYesterdayMidnight && d < brisbaneTodayMidnight;
  });

  let currentRegionTag: ReactNode = null;
  if (toastCostDollars === cheapestCost && toastCostDollars === expensiveCost) {
    currentRegionTag = (
      <Chip label="Cheapest & Most Expensive" icon={<StarIcon />} color="warning" sx={{ ml: 1 }} />
    );
  } else if (toastCostDollars === cheapestCost) {
    currentRegionTag = (
      <Chip label="Cheapest" icon={<StarIcon />} color="success" sx={{ ml: 1 }} />
    );
  } else if (toastCostDollars === expensiveCost) {
    currentRegionTag = (
      <Chip label="Most Expensive" icon={<WarningIcon />} color="error" sx={{ ml: 1 }} />
    );
  }

  /**
   * Handles scenario changes by redirecting.
   *
   * @param {string} newScenario The new scenario ID.
   */
  const handleScenarioChange = (newScenario: string): void => {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const isLocalDev =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname.includes('192.168.');
    const regionPath = regionKey;
    let finalUrl = '';
    if (isLocalDev) {
      finalUrl = `${protocol}//${hostname}${port ? ':' + port : ''}/${regionPath}?s=${newScenario}`;
    } else {
      const domainParts = hostname.split('.');
      if (domainParts.length > 2) domainParts.shift();
      const baseDomain = domainParts.join('.');
      finalUrl = `${protocol}//${newScenario}.${baseDomain}${port ? ':' + port : ''}/${regionPath}`;
    }
    window.location.href = finalUrl;
  };

  /**
   * Handles region selection clicks by redirecting.
   *
   * @param {string} newRegion The new region.
   */
  const handleRegionClick = (newRegion: string): void => {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const isLocalDev =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname.includes('192.168.');
    const scenario = getScenarioKey();
    let finalUrl = '';
    if (isLocalDev) {
      finalUrl = `${protocol}//${hostname}${port ? ':' + port : ''}/${newRegion}?s=${scenario}`;
    } else {
      const domainParts = hostname.split('.');
      if (domainParts.length > 2) domainParts.shift();
      const baseDomain = domainParts.join('.');
      finalUrl = `${protocol}//${scenario}.${baseDomain}${port ? ':' + port : ''}/${newRegion}`;
    }
    window.location.href = finalUrl;
  };

  const handleMyLocationClick = (): void => {
    setLocationDialogOpen(true);
  };

  const handleDenyLocation = (): void => {
    setLocationDialogOpen(false);
  };

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
  };

  // Set metadata when scenario and region change.
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
            {EnergyScenarios.getAllScenarios().map((item) => (
              <ListItem button key={item.id} onClick={() => handleScenarioChange(item.id)}>
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
                value={scenarioKey}
                onChange={(event: SelectChangeEvent) => handleScenarioChange(event.target.value)}
              >
                {EnergyScenarios.getAllScenarios().map((scn) => (
                  <MenuItem key={scn.id} value={scn.id}>{scn.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" mt={1}>
              You can also change the scenario via a subdomain (e.g., toast.coststhismuch.au)
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
              {loading ? (
                <Box display="flex" flexDirection="column" alignItems="center" mt={2}>
                  <CircularProgress />
                  <Typography variant="body2" mt={1}>
                    Loading latest pricing…
                  </Typography>
                </Box>
              ) : (
                <>
                  <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" mb={3}>
                    <Box display="flex" alignItems="center" mb={1}>
                      <MonetizationOnIcon fontSize="large" sx={{ marginRight: 1 }} aria-label="Price icon" />
                      <Typography
                        variant="h4"
                        color="secondary"
                        sx={{ transition: 'all 0.5s ease' }}
                      >
                        {formatCurrency(toastCostDollars)}
                      </Typography>
                      {currentRegionTag}
                    </Box>
                    <Typography variant="subtitle1" align="center">
                      (per scenario usage)
                    </Typography>
                  </Box>
                  <Typography variant="body1" gutterBottom>
                    Region: {regionFilter}
                  </Typography>
                  <Typography variant="body1" gutterBottom>
                    {'Current Wholesale Spot Price: ' + rrpCentsPerKWh.toFixed(3)} c/kWh{' '}
                    <Tooltip title="This is the real-time five-minute wholesale electricity price from AEMO. Negative values are floored to 0.">
                      <IconButton size="small" aria-label="Wholesale info">
                        <InfoIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Typography>
                  <Typography variant="body1" gutterBottom>
                    {'Final Price (incl. GST): ' + finalRateCents.toFixed(3)} c/kWh{' '}
                    <Tooltip title="This is the approximate retail rate, including wholesale, network, environment, overheads, margin, and GST.">
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
                <Tooltip title="AEMO operates on National Electricity Market time (Australia/Brisbane).">
                  <IconButton size="small" aria-label="Time info">
                    <InfoIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Typography>
            </CardActions>
          </Card>

          {/* Cheapest and Most Expensive Cards */}
          <Box display="flex" flexDirection="row" justifyContent="space-between" sx={{ maxWidth: 480, width: '100%', marginTop: 2 }}>
            <Card sx={{ width: '48%' }}>
              <CardHeader title="Cheapest" />
              <CardContent>
                {cheapestCost !== null && cheapestInterval ? (
                  <Tooltip arrow title={`Wholesale: ${cheapestWholesale.toFixed(3)} c/kWh\nRetail: ${cheapestIntervalRate.toFixed(3)} c/kWh`}>
                    <Box>
                      <Typography variant="h4" color="secondary">
                        {formatCurrency(cheapestCost)}
                      </Typography>
                      <Typography variant="h6">
                        {formatIntervalTimeRange(cheapestInterval.SETTLEMENTDATE)}
                      </Typography>
                      <Calendar
                        value={new Date(cheapestInterval.SETTLEMENTDATE + '+10:00')}
                        minDetail="month"
                        maxDetail="month"
                        showNeighboringMonth={false}
                        onChange={() => {}}
                        style={{ width: 300, marginTop: 8 }}
                      />
                    </Box>
                  </Tooltip>
                ) : (
                  <Typography variant="body2">No data available</Typography>
                )}
              </CardContent>
            </Card>

            <Card sx={{ width: '48%' }}>
              <CardHeader title="Most Expensive" />
              <CardContent>
                {expensiveCost !== null && expensiveInterval ? (
                  <Tooltip arrow title={`Wholesale: ${expensiveWholesale.toFixed(3)} c/kWh\nRetail: ${expensiveIntervalRate.toFixed(3)} c/kWh`}>
                    <Box>
                      <Typography variant="h4" color="secondary">
                        {formatCurrency(expensiveCost)}
                      </Typography>
                      <Typography variant="h6">
                        {formatIntervalTimeRange(expensiveInterval.SETTLEMENTDATE)}
                      </Typography>
                      <Calendar
                        value={new Date(expensiveInterval.SETTLEMENTDATE + '+10:00')}
                        minDetail="month"
                        maxDetail="month"
                        showNeighboringMonth={false}
                        onChange={() => {}}
                        style={{ width: 300, marginTop: 8 }}
                      />
                    </Box>
                  </Tooltip>
                ) : (
                  <Typography variant="body2">No data available</Typography>
                )}
              </CardContent>
            </Card>
          </Box>

          {/* Sparkline Chart for 24-hour trend (today and yesterday overlaid) */}
          <SparklineChart todayIntervals={todayIntervals} yesterdayIntervals={yesterdayIntervals} region={regionKey as SupportedRegion} />

          {/* Reference Grid for other regions */}
          <Box sx={{ maxWidth: 480, width: '100%', marginTop: 2 }}>
            <Typography variant="h6" gutterBottom>
              Reference Costs for Other Regions
            </Typography>
            <Grid container spacing={2}>
              {(() => {
                // Prepare reference cost for each other region
                const otherRegions = Object.keys(regionMapping).filter(r => r !== regionKey);
                const refs = otherRegions.map(r => {
                  const intervals = allIntervals.filter(iv => iv.REGIONID === regionMapping[r]);
                  intervals.sort((a, b) => new Date(a.SETTLEMENTDATE).getTime() - new Date(b.SETTLEMENTDATE).getTime());
                  if (intervals.length > 0) {
                    const latest = intervals[intervals.length - 1];
                    let wholesale = latest.RRP * 0.1;
                    if (wholesale < 0) wholesale = 0;
                    const retail = getRetailRateFromInterval(latest, r as SupportedRegion, false, true);
                    const cost = EnergyScenarios.getCostForScenario(scenarioKeyStr, retail);
                    return {
                      region: r.toUpperCase(),
                      wholesale,
                      scenarioCost: cost,
                      date: latest.SETTLEMENTDATE
                    };
                  } else {
                    return { region: r.toUpperCase(), wholesale: 0, scenarioCost: 0, date: '' };
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

          {/* Daily Summary Table for Wholesale and Retail Rates */}
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
          CC0 1.0 Universal | <a href="https://github.com/troykelly/costs-this-much">GitHub</a> |{' '}
          <a href="https://troykelly.com/">Troy Kelly</a>
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

      <Dialog open={locationDialogOpen} onClose={handleDenyLocation}>
        <DialogTitle>Location Data Request</DialogTitle>
        <DialogContent>
          <Typography variant="body1">
            We would like to access your location to determine the nearest electricity pricing region.
            Your location data will be used solely for this purpose and is not stored beyond this session.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDenyLocation} color="error">Deny</Button>
          <Button onClick={handleAllowLocation} color="primary">Allow</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

/**
 * AboutPage component - explains the purpose of the site.
 *
 * @param {object} props
 * @param {boolean} props.drawerOpen Whether the drawer is open.
 * @param {(open: boolean) => () => void} props.toggleDrawer Function to toggle the drawer.
 * @return {JSX.Element}
 */
function AboutPage(props: { drawerOpen: boolean; toggleDrawer: (open: boolean) => () => void }): JSX.Element {
  const { drawerOpen, toggleDrawer } = props;
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
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            About
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer anchor="left" open={drawerOpen} onClose={toggleDrawer(false)}>
        <Box sx={{ width: 250 }} role="presentation" onClick={toggleDrawer(false)} onKeyDown={toggleDrawer(false)}>
          <List>
            <ListItem>
              <ListItemIcon>
                <BreakfastDiningIcon />
              </ListItemIcon>
              <ListItemText primary="Home" />
            </ListItem>
            <ListItem>
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
          every five minutes. By presenting near real‑time estimates of how much it might cost
          to complete everyday tasks (such as toasting bread or charging a phone), we hope to
          demystify how wholesale prices, network fees, environmental charges, and retail margins
          combine to influence what you pay.
        </Typography>
        <Typography variant="body1" paragraph>
          The scenarios use typical assumptions for wattage, duration, and consumption.
          These examples are provided for educational purposes only – individual usage will vary.
        </Typography>
        <Typography variant="body1" paragraph>
          Keep in mind that AEMO pricing is based on National Electricity Market (NEM) time
          (Australia/Brisbane) and may not match your local time exactly.
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