/**
 * @fileoverview App.tsx - A React application that retrieves the current AEMO
 * network price for a selected region and computes an approximate cost for a chosen
 * energy scenario (toast, EV charge, phone charge, etc.).
 *
 * Updated (18 March 2025):
 * • Production-ready interface (no example placeholders/timeframes).
 * • Modern layout changes for the header and info boxes as requested.
 * • Now displays two separate sets of cheapest/most expensive values:
 *   1) "Cheapest Rate" and "Most Expensive Rate" under the header, based on the retail rate (c/kWh).
 *   2) "Cheapest" and "Most Expensive" (scenario cost in dollars) below the current scenario cost block.
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Original: 16 March 2025
 * Last Updated: 18 March 2025
 */

import React, { useEffect, useState, ReactNode } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  CircularProgress,
  Link,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  SelectChangeEvent,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import StarIcon from '@mui/icons-material/Star';
import WarningIcon from '@mui/icons-material/Warning';
import ElectricBoltIcon from '@mui/icons-material/ElectricBolt';
import { AemoInterval, getRetailRateFromInterval, SupportedRegion } from './pricingCalculator';
import { EnergyScenarios } from './energyScenarios';
import statesData from '../data/au-states.json';

// Discrete components
import SparklineChart from './SparklineChart';
import ScenarioNotFound from './ScenarioNotFound';
import AboutPage from './AboutPage';

/**
 * Maps region keys to a descriptive string for display.
 */
const regionNameMap: Record<string, string> = {
  nsw: 'New South Wales',
  qld: 'Queensland',
  vic: 'Victoria',
  sa: 'South Australia',
  tas: 'Tasmania'
};

/**
 * Formats a number into Australian currency using Intl.NumberFormat.
 */
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD'
  }).format(amount);
}

/**
 * Generates a scenario-specific URL for both local (querystring) and
 * production (subdomain) environments, without hardcoding a domain.
 *
 * @param {string} scenarioId - The scenario identifier (e.g., "toast").
 * @param {string} region - The NEM region (default "nsw").
 * @returns A link string that either uses query params (dev) or subdomain (production).
 */
function scenarioUrl(scenarioId: string, region: string = 'nsw'): string {
  const { hostname } = window.location;
  const isDev = hostname.includes('localhost') || hostname.includes('127.');
  if (isDev) {
    // Dev environment
    return `/${region}?s=${scenarioId}`;
  } else {
    // Production environment
    return `https://${scenarioId}.${hostname}/${region}`;
  }
}

/**
 * Returns a full date/time string with "NEM Time" for display (ISO8601 + +10:00).
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
 * Formats a short "day + 24 hour AEMO TIME" string (e.g. "Mon 14:05 AEMO TIME").
 */
function formatDayTimeAemoString(dateString: string): string {
  if (!dateString) return '';
  const d = new Date(dateString + '+10:00');
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Australia/Brisbane',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  return d.toLocaleString('en-AU', options) + ' AEMO TIME';
}

/**
 * Derives the scenario from subdomain (preferred) or from a "s" param.
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
 * Exported setMetaTag so other files can import it without error.
 */
export function setMetaTag(attrName: string, attrValue: string, content: string): void {
  let element = document.querySelector(`meta[${attrName}="${attrValue}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attrName, attrValue);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

/**
 * Minimal geo checks: see if lat/lon in polygon => state name, map that => region key.
 */
function isPointInPolygon(polygon: number[][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1];
    const yi = polygon[i][0];
    const xj = polygon[j][1];
    const yj = polygon[j][0];
    const intersect =
      (yi > lon !== yj > lon) &&
      lat < ((xj - xi) * (lon - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
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

const App: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);

  // "Current" interval results
  const [rrpCentsPerKWh, setRrpCentsPerKWh] = useState<number>(0);
  const [finalRateCents, setFinalRateCents] = useState<number>(0);
  const [toastCostDollars, setToastCostDollars] = useState<number>(0);
  const [usedIntervalDate, setUsedIntervalDate] = useState<string>('');

  // All intervals and region intervals
  const [allIntervals, setAllIntervals] = useState<AemoInterval[]>([]);
  const [regionIntervals, setRegionIntervals] = useState<AemoInterval[]>([]);

  // For scenario cost min/max
  const [lowestScenarioCost, setLowestScenarioCost] = useState<number>(0);
  const [lowestScenarioTimestamp, setLowestScenarioTimestamp] = useState<string>('');
  const [highestScenarioCost, setHighestScenarioCost] = useState<number>(0);
  const [highestScenarioTimestamp, setHighestScenarioTimestamp] = useState<string>('');

  // For retail rate min/max
  const [lowestRetailRate, setLowestRetailRate] = useState<number>(0);
  const [lowestRetailRateTimestamp, setLowestRetailRateTimestamp] = useState<string>('');
  const [highestRetailRate, setHighestRetailRate] = useState<number>(0);
  const [highestRetailRateTimestamp, setHighestRetailRateTimestamp] = useState<string>('');

  // Location
  const [locationDialogOpen, setLocationDialogOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const isDevMode = window.location.hostname.includes('localhost') || window.location.hostname.includes('127.');
  const pathParts = window.location.pathname.split('/');
  const regionKey = pathParts[1]?.toLowerCase() || 'nsw';

  // If about
  if (regionKey === 'about') {
    return <AboutPage />;
  }

  // Scenario
  const scenarioKeyStr = getScenarioKey().trim();
  if (!scenarioKeyStr) {
    window.location.href = scenarioUrl('toast', regionKey);
    return null;
  }
  const scenarioData = EnergyScenarios.getScenarioById(scenarioKeyStr);
  if (!scenarioData) {
    return <ScenarioNotFound scenarioKey={scenarioKeyStr} />;
  }

  const regionMapping: Record<string, string> = {
    nsw: 'NSW1',
    qld: 'QLD1',
    sa: 'SA1',
    tas: 'TAS1',
    vic: 'VIC1'
  };
  const regionFilter = regionMapping[regionKey] ?? 'NSW1';

  // Page meta
  useEffect(() => {
    const scenarioTitle = scenarioData.name;
    const regionUpper = regionKey.toUpperCase();
    const pageTitle = `Cost to ${scenarioTitle} in ${regionUpper}`;
    document.title = pageTitle;

    setMetaTag('property', 'og:title', pageTitle);
    setMetaTag('property', 'og:description', scenarioData.description);
    setMetaTag('property', 'og:url', window.location.href);
    setMetaTag('property', 'og:type', 'website');
    setMetaTag('name', 'DC.title', pageTitle);
    setMetaTag('name', 'DC.description', scenarioData.description);
    setMetaTag('name', 'DC.subject', scenarioTitle);
  }, [scenarioData, regionKey]);

  function handleScenarioChange(newScenario: string): void {
    const url = new URL(window.location.href);
    if (!isDevMode) {
      const parts = url.hostname.split('.');
      if (parts.length === 2) {
        url.hostname = `${newScenario}.${url.hostname}`;
      } else {
        parts[0] = newScenario;
        url.hostname = parts.join('.');
      }
      window.location.assign(url.toString());
    } else {
      url.searchParams.set('s', newScenario);
      window.location.assign(url.toString());
    }
  }

  function handleRegionClick(newRegion: string): void {
    const url = new URL(window.location.href);
    const existingScenario = getScenarioKey();
    url.pathname = '/' + newRegion;
    if (isDevMode && existingScenario) {
      url.searchParams.set('s', existingScenario);
    }
    window.location.assign(url.toString());
  }

  async function fetchAemoData(): Promise<void> {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeScale: ['5MIN'] })
      });
      if (!response.ok) {
        throw new Error(`Network response not OK: ${response.status}`);
      }
      const data: { '5MIN': AemoInterval[] } = await response.json();

      setAllIntervals(data['5MIN']);

      const regData: AemoInterval[] = data['5MIN'].filter(iv => iv.REGIONID === regionFilter);
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

      let minRate = Number.MAX_VALUE;
      let maxRate = -Infinity;
      let minRateTS = '';
      let maxRateTS = '';
      regData.forEach(iv => {
        const r = getRetailRateFromInterval(iv, regionKey as SupportedRegion, false, true);
        if (r < minRate) {
          minRate = r;
          minRateTS = iv.SETTLEMENTDATE;
        }
        if (r > maxRate) {
          maxRate = r;
          maxRateTS = iv.SETTLEMENTDATE;
        }
      });
      if (regData.length === 0) {
        minRate = 0;
        maxRate = 0;
      }
      setLowestRetailRate(minRate);
      setLowestRetailRateTimestamp(minRateTS);
      setHighestRetailRate(maxRate);
      setHighestRetailRateTimestamp(maxRateTS);

      let minScenarioCost = Number.MAX_VALUE;
      let maxScenarioCost = -Infinity;
      let minScenTS = '';
      let maxScenTS = '';
      regData.forEach(iv => {
        const retRate = getRetailRateFromInterval(iv, regionKey as SupportedRegion, false, true);
        const scenarioCost = EnergyScenarios.getCostForScenario(scenarioKeyStr, retRate);
        if (scenarioCost < minScenarioCost) {
          minScenarioCost = scenarioCost;
          minScenTS = iv.SETTLEMENTDATE;
        }
        if (scenarioCost > maxScenarioCost) {
          maxScenarioCost = scenarioCost;
          maxScenTS = iv.SETTLEMENTDATE;
        }
      });
      if (regData.length === 0) {
        minScenarioCost = 0;
        maxScenarioCost = 0;
      }
      setLowestScenarioCost(minScenarioCost);
      setLowestScenarioTimestamp(minScenTS);
      setHighestScenarioCost(maxScenarioCost);
      setHighestScenarioTimestamp(maxScenTS);

    } catch (err: any) {
      setError(err.message || 'Failed to fetch AEMO data.');
      setRrpCentsPerKWh(0);
      setFinalRateCents(0);
      setToastCostDollars(0);
      setLowestRetailRate(0);
      setHighestRetailRate(0);
      setLowestScenarioCost(0);
      setHighestScenarioCost(0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAemoData();
    const intervalId = setInterval(fetchAemoData, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [regionFilter, scenarioKeyStr]);

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
      const dt = new Date(iv.SETTLEMENTDATE + '+10:00');
      const dateKey = dt.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' });
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

  function getBrisbaneNow(): Date {
    const now = new Date();
    const brisbaneOffsetMinutes = 10 * 60;
    const localOffsetMinutes = now.getTimezoneOffset();
    return new Date(now.getTime() + (brisbaneOffsetMinutes + localOffsetMinutes) * 60000);
  }
  const brisbaneNow = getBrisbaneNow();
  const twentyFourHoursAgo = new Date(brisbaneNow.getTime() - 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(brisbaneNow.getTime() - 48 * 60 * 60 * 1000);
  const recent24Intervals = regionIntervals.filter(iv => {
    const d = new Date(iv.SETTLEMENTDATE + '+10:00');
    return d >= twentyFourHoursAgo && d <= brisbaneNow;
  });
  const previous24Intervals = regionIntervals.filter(iv => {
    const d = new Date(iv.SETTLEMENTDATE + '+10:00');
    return d >= fortyEightHoursAgo && d < twentyFourHoursAgo;
  });

  const otherRegions = Object.keys(regionMapping).filter(r => r !== regionKey);

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh" bgcolor="#ffffff">
      {/* Top header */}
      <Box
        sx={{
          backgroundColor: '#2196f3',
          margin: 0,
          padding: '0.75rem 0',
          textAlign: 'center'
        }}
      >
        <Typography
          variant="h5"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            fontWeight: 'bold',
            color: '#fff'
          }}
        >
          <ElectricBoltIcon fontSize="large" sx={{ marginRight: 1 }} />
          Power Costs This Much!
        </Typography>
      </Box>

      {/* Header info row */}
      <Box sx={{ borderBottom: '1px solid #CCC', backgroundColor: '#fff', padding: '1rem' }}>
        <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          {/* Region block */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              borderRight: '1px solid #CCC',
              paddingRight: '1rem',
              marginRight: '1rem'
            }}
          >
            <Typography
              sx={{
                fontWeight: 'bold',
                color: '#2196f3'
              }}
            >
              {regionNameMap[regionKey] || regionKey.toUpperCase()}
            </Typography>
            <Box
              sx={{ mt: 1 }}
              dangerouslySetInnerHTML={{ __html: (() => {
                const svgMap: Record<string, string> = {
                  nsw: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
     d="m 402.68219,327.7504 -19.25,-9.7 -0.98,-0.08 0.88,-1.52 0.11,-0.97 -1,-2.04 -0.69,-0.88 -0.56,-4.42 -1.18,-0.75 -1.82,-0.78 -0.93,0.36 -1.53,-0.29 -1.01,0.17 -1.01,1.26 -0.98,0.09 -1.82,0.64 -1.46,-0.1 -2.42,-0.76 -0.97,-0.76 -1.12,-0.17 -0.68,0.09 -0.38,0.4 -1.14,0.49 -2.25,-0.2 -3.1,-0.59 -0.76,-0.32 -1.28,-1.23 -0.79,-0.62 -0.27,-0.03 -0.82,0.18 -0.95,0.52 -0.95,-0.09 -0.37,-0.3 -1.33,0 -1.36,0.35 -0.2,0.24 -0.38,1.38 0.17,1.36 -1.92,0.54 -0.42,-0.11 -1.34,-0.78 -2.28,-2.67 -0.56,-1.28 -0.25,-0.26 -0.62,-0.2 -1.1,-0.98 -0.84,-1.16 -1.86,-0.99 -1.67,-1.27 -0.77,-0.28 -0.45,0.1 -0.67,-0.5 -0.18,-0.28 0.25,-0.76 -0.42,-0.65 -0.88,-0.22 -0.81,-0.5 -0.5,-1.1 -0.29,-1.65 0.26,-1.31 0.01,-0.83 -0.14,-0.21 -2.31,-1.26 -1.62,-0.11 -1.28,-0.52 -0.15,-0.36 -0.68,-0.45 -0.62,0.21 -0.19,0.27 -0.35,1.55 -0.49,0.62 -0.92,-0.18 -0.37,-0.43 0.03,-0.26 -0.58,-1.55 -0.94,-0.87 -0.05,-1.88 -1.51,-2.54 -0.87,-0.6 -1.25,-0.57 -1.7,0.35 -1.61,-0.42 -0.96,0.37 -0.61,0.84 -0.53,0.28 -0.19,-0.26 -1.21,-0.74 -1.78,-0.83 -1.87,-0.14 -0.33,-0.09 -0.51,-0.5 0,0 0.05,-63.7 0,0 1.29,-0.01 0,0 21.8,0.01 0,0 16.91,0 0,0 13.78,0 0,0 32.53,0 0.83,-0.41 1.27,-1.59 3.47,-2.95 1.2,-0.33 0.28,0.05 0.17,0.36 0.95,0.28 3.34,-0.29 1.56,-0.6 1.47,-0.18 0.3,0.07 0.83,0.86 0.75,0.51 1.81,0.05 1.64,-0.34 2.74,1.25 2.77,2.39 0.13,1.88 0.44,0.98 0.24,0.11 0.53,-0.13 0.52,-0.55 0.98,-2 1.87,-0.83 0.4,0.77 0.67,0.32 2.08,-1 0.35,-2.01 -0.98,-2.22 1.05,-0.83 1.22,-0.6 2.16,-0.71 0.44,-0.3 0.22,-0.56 0.62,-0.52 0.48,0.07 0.71,0.73 1.78,0.39 2.03,-0.21 1.79,0.12 0.83,-1.1 1.45,-0.27 1.19,-0.46 0.81,-0.66 0,0 0.78,0.71 0.15,0.81 -0.35,2.67 0.2,1.4 0.5,0.68 -0.2,2.48 -1.71,2.24 -1.2,3.52 0.3,0.87 -1.21,6.89 -0.53,2.02 -2.02,5.68 -0.14,3.35 0.17,0.61 0.38,0.05 0.19,0.77 -1.11,3.72 -0.21,1.47 -1.14,3.77 -0.96,1.96 -2.2,2.78 -0.5,1.3 0.32,1.69 -0.13,1.79 -1.89,1.6 -0.81,0.94 -1.67,1.04 -0.09,0.55 0.27,0.58 -2.08,0.73 -1.53,0.79 -1.55,2.33 -1.03,2.55 -0.24,0.2 -0.55,0.04 -0.51,0.41 -0.11,0.59 0.46,0.41 -0.35,1.39 -1.24,1.66 -0.47,3.5 -0.26,0.94 -0.39,0.3 -0.63,-0.07 -0.85,0.34 0.6,0.16 0.44,0.41 -0.88,1.43 -0.98,0.73 -0.97,1.43 -1.02,2.97 0.44,0.54 -0.54,2.46 -0.7,0.44 -0.22,0.76 0.38,1.11 0.76,0.79 -0.17,0.88 -0.29,0.25 -0.36,-0.39 0.13,-0.27 -0.15,-0.61 -0.29,-0.03 -0.69,0.43 -0.08,0.44 0.28,0.68 -0.61,0.68 -1.16,0.64 -0.59,1.11 -0.06,0.56 -0.8,2.32 -0.55,0.89 -2.1,4.6 -0.27,2.29 -0.02,2.9 -0.63,0.82 -0.58,3.22 -0.62,2.25 -0.69,1.74 0.05,1.97 1.08,1.25 0.14,0.94 -0.01,0.45 -0.32,-0.1 -0.46,0.34 0.02,1.58 0.36,1.54 z m -9.53,-22.32 0.08,-0.4 -0.24,-2.75 0.62,-2.48 0.52,-0.73 0.82,-0.39 1.01,0.14 0.48,-0.43 -0.67,-0.43 -1,-0.36 -0.57,-0.68 -1.27,-0.72 -2.85,2.1 -0.52,2.56 -0.02,1.85 0.29,0.79 1.45,2.15 0.26,0.22 1.09,0.37 0.52,-0.81 z"
     title="New South Wales"
     id="AU-NSW" />
</svg>
    `,
                  qld: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
     d="m 402.68219,140.4104 0,0.18 0.67,0.64 -0.56,-1.93 -0.71,-1.46 0.01,-0.55 0.42,-1.11 0.43,-0.56 0.48,-0.13 0.38,0.16 0.83,1.28 0.49,1.39 1.32,0.54 1.72,1.18 1.23,0.56 -0.63,-1.49 -0.01,-0.88 0.3,-0.61 0.79,0.14 0.77,1.15 -0.32,0.74 0.08,0.57 1.47,2.09 -0.69,4.67 0.61,1.26 -0.13,1.68 0.72,1.46 0.88,0.48 0.81,0.12 0.31,0.71 0.74,0.56 0.52,1.5 0.77,0.42 0.36,0 0.51,0.36 1.15,1.42 0.74,0.22 0.58,0.46 -0.17,0.27 0.07,0.33 0.3,0.12 0.53,-0.52 0.02,-0.64 0.26,-0.25 0.48,0.14 1.13,1.3 1.58,1.41 0.83,2.47 1.32,2.16 1.58,1.21 1.53,0.6 0.54,0.62 0.32,0.77 0.11,1.43 1.78,2.95 1.49,0.45 1.07,0.07 0.42,1.76 -0.13,1.06 -0.44,0.45 0.06,1.4 0.24,0.67 0.36,0.34 0.33,0.09 0.58,1.42 1.56,0.71 0.04,0.29 -0.52,1.13 -0.71,2.9 0.2,0.78 0.27,3.57 0.3,0.73 0.15,4.27 -0.67,0.21 -0.66,0.93 0.33,1.66 1.19,0.92 0.88,1.1 0.68,2.33 0.92,1.29 0.32,0.87 -0.24,1.63 0.54,1.36 0.5,0.7 0,0 -0.81,0.66 -1.19,0.46 -1.45,0.27 -0.83,1.1 -1.79,-0.12 -2.03,0.21 -1.78,-0.39 -0.71,-0.73 -0.48,-0.07 -0.62,0.52 -0.22,0.56 -0.44,0.3 -2.16,0.71 -1.22,0.6 -1.05,0.83 0.98,2.22 -0.35,2.01 -2.08,1 -0.67,-0.32 -0.4,-0.77 -1.87,0.83 -0.98,2 -0.52,0.55 -0.53,0.13 -0.24,-0.11 -0.44,-0.98 -0.13,-1.88 -2.77,-2.39 -2.74,-1.25 -1.64,0.34 -1.81,-0.05 -0.75,-0.51 -0.83,-0.86 -0.3,-0.07 -1.47,0.18 -1.56,0.6 -3.34,0.29 -0.95,-0.28 -0.17,-0.36 -0.28,-0.05 -1.2,0.33 -3.47,2.95 -1.27,1.59 -0.83,0.41 -32.53,0 0,0 -13.82,0 0,0 -16.9,0 0,0 -21.8,-0.01 0,0 -1.3,0.03 0,0 -0.02,-36.54 -32.57,0 0,0 0,-109.549995 0,0 2.11,1.72 1.04,0.4 2.13,0.51 1.66,-0.1 0.52,0.38 1.69,0.71 1.82,0.26 1.42,1.97 0.23,1.46 0.55,1.06 0.52,0.51 0.83,0.29 1.09,0.13 1.07,0.71 0.88,0.89 2.15,0.62 0.74,0.44 1.05,0.94 0.43,0.18 1.23,0.07 2.87,-0.52 1.49,-0.55 0.93,-0.5 1.5,-1.16 0.82,-0.29 0.57,-1.04 0.61,-2.36 0.16,-1.69 2.58,-3.35 1,-2.26 0.32,-1.64 1.21,-3.18 -0.28,-1.89 0.65,-4.14 1.89,-4.33 0.34,-1.37 -1.07,-2.94 -0.49,-3.15 0.16,-0.92 0.62,-1.59 0.08,-1.24 -0.24,-0.87 -1.09,-1.3 -0.09,-1.34 0.79,-3.28 1.59,-3.09 -0.12,-0.49 -0.5,-0.56 -0.49,-1.92 0.09,-0.32 0.14,-0.25 1.11,-0.7 0.42,-0.51 0.53,-1.47 0.65,0.2 0.35,0.6 0.01,0.89 0.46,0.7 0.09,-0.47 -0.61,-1.78 -0.48,-0.35 -1.32,-1.98 0.32,-0.26 -0.21,-0.16 -0.71,-0.05 -0.09,0.65 0.34,0.46 -0.63,0.2 -0.38,-0.17 0.02,-0.25 1.02,-2.21 0.95,-1.31 -0.17,-0.38 0.49,-1.4 0.47,-0.7 0.47,-0.21 0.27,1.32 1.16,-0.23 0.09,-0.27 -0.88,-0.86 -0.04,-0.45 0.24,-1.28 1.67,-4.8 0.39,-2.45 -0.22,-1.9300002 0.1,-0.27 0.4,-0.29 1.72,-0.3 0.61,-0.81 0.49,-1.23 0.81,-0.03 1.02,0.48 -0.34,0.52 -0.72,0.66 -0.08,1.01 0.69,-0.88 0.39,0.03 1.47,1.25 0.47,1.0300002 0.84,3.42 -0.28,1.32 0.3,2.25 -0.08,1.29 1.18,1.04 0.75,0.06 0.71,-0.32 0.31,0.12 0.73,0.8 -1.05,1.69 -0.22,0.93 -0.05,1.21 0.56,0.16 0.34,-0.09 0.96,0.47 0.3,0.33 0.04,1.16 0.48,0.5 0.41,0.04 0.74,0.56 -0.6,1.39 -0.14,1.17 0.47,0.24 1.07,-0.12 0.11,0.22 -0.17,2.43 0.25,2.28 0.08,0.4 0.43,0.41 0.28,0.6 -0.09,1.04 -0.61,2.56 0.77,2 0.92,0.97 0.14,1.8 0.42,1.49 0.49,1.05 0.37,0.4 0.78,0.42 1.35,0.01 1.54,-1.2 3.06,-1.4 0.45,-1.01 0.43,0.1 0.68,1.02 -0.13,1.06 0.52,1.41 0.68,0.81 1.64,0.63 0.74,0.05 0.68,1.51 2.68,1.21 1.19,0.93 -0.07,0.66 -0.82,1.45 0.04,0.66 0.43,0.71 0.14,0.83 -0.44,1.29 0.61,1.21 0.59,2.01 0,2.03 0.55,0.55 0.57,1.33 -0.18,2.3 -0.41,0.57 -0.07,1.16 0.1,0.33 0.57,0.36 3.71,4.63 0.36,-0.3 1.01,-0.17 0.26,0.32 -0.84,1.59 0.05,0.35 0.77,1.32 0.85,1.99 0.58,2.13 0.2,1.57 -0.2,1.08 0.16,1.16 -0.07,0.75 -1,2.12 0.08,1.09 2.2,2.88 1.32,0.5 -0.08,1.27 -0.49,1.14 -0.14,1.21 0.1,0.38 0.63,0.84 0.95,0.74 0.27,0.519995 1.27,0.83 0.97,0.46 1.19,0.03 1.33,1.33 0.74,0.03 1.29,0.42 0.73,0.69 1.24,0.26 1.94,-0.15 0.16,-0.34 -0.49,-0.85 0.62,0.71 1.05,1.89 0.43,2.2 0.26,0.53 0.55,0.59 0.59,0.14 0.5,-0.12 -0.17,-0.93 0.08,-0.4 0.66,0.01 0.32,0.34 0.13,1.27 0.52,0.49 0.65,0.28 1.36,-0.06 1.34,0.39 0.86,1.04 -0.35,0.14 0.09,0.31 0.64,0.79 0.86,0.7 0.57,-0.25 0.04,-0.68 -0.34,-0.31 0.15,-0.4 0.75,0.28 1.64,1.47 1.04,0.19 0.37,0.51 0.69,1.94 0.41,0.11 0.33,0.92 -0.61,-0.15 -0.52,-0.53 -0.44,-0.21 -0.53,0.22 -0.8,0.99 0.67,1.8 1.31,1.37 0.78,0.54 1.16,0.41 1.44,1.12 0.59,0.75 -0.11,0.86 0.38,1.44 0.54,0.46 0.42,1.38 0.62,1.09 0.62,0.59 -0.14,2.21 0.99,3.54 0.75,1.82 0.69,0.99 0.47,0.38 0.03,1.19 -0.33,0.5 0.73,-0.37 0.58,-0.48 0.27,-0.45 1.7,2.11 z m 33.7,38.18 -0.47,-0.1 -0.44,-0.59 -0.59,-2.15 0.58,-1.42 0.73,-1.21 -0.01,-1.03 -0.15,-0.26 0.45,-0.94 1.13,-0.91 0.5,-0.98 0.09,-0.53 -0.11,-0.41 -0.65,-1.06 -0.21,-0.12 0.41,-0.76 0.93,-0.61 0.09,2.44 0.25,0.55 0.52,0.34 0.11,0.42 -2.65,6.24 -0.48,1.57 0.16,0.97 -0.19,0.55 z m -151.26,-104.789995 -0.11,-0.66 0.29,-1.15 0.62,-0.86 0.91,-0.69 1.88,-0.23 0.59,-0.32 2.09,0.34 0.06,0.66 -0.47,0.22 -0.71,0.15 -0.47,-0.38 -1,0.4 0.16,0.35 -0.67,1.11 -1.21,0.46 -1.57,0.29 -0.39,0.31 z m 131.13,80.889995 -0.59,-0.55 -0.42,-0.93 -0.73,-0.66 -0.42,-0.94 -0.1,-0.82 0.48,-0.11 1.52,0.96 0.21,0.35 0.7,1.34 0.13,0.92 -0.29,0.35 -0.49,0.09 z m -53.6,-61.269995 -0.75,-0.29 -0.21,-1.04 -0.48,-0.65 -0.5,-0.24 -0.27,-0.5 0.45,-0.11 1.54,0.72 0.9,1.3 -0.32,0.62 -0.36,0.19 z m 77.26,108.569995 -0.19,-0.42 0.06,-1.04 0.42,-2.38 0.42,-0.1 0.75,0.13 -0.72,2.38 -0.23,1.37 -0.51,0.06 z m 0.2,-4.48 -0.72,-2.02 0,-1.64 0.93,-0.51 0.24,0.18 -0.56,2.12 0.11,1.87 z m -122.04,-190.2799952 -0.68,-0.55 -0.05,-0.69 0.65,-0.43 0.45,-0.09 0.53,0.8 -0.07,0.41 -0.52,0.13 -0.31,0.42 z m 1.05,-5.54 -0.75,-0.32 -0.23,-0.36 0.42,-0.64000003 0.6,-0.11 0.36,0.17 0.25,0.44 -0.65,0.82000003 z m -30.96,76.4500002 -0.31,-0.65 1.11,-1.04 0.56,0.4 0.18,0.83 -1.28,-0.03 -0.26,0.49 z"
     title="Queensland"
     id="AU-QLD" />
</svg>
    `,
                  sa: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
     d="m 254.26219,283.5504 -1.08,1.74 -0.88,0.39 -0.93,1.59 -1.12,0.7 -0.67,1.33 -0.77,2.33 0.27,0.13 0.48,-0.06 1.45,-1.02 0.15,0.69 -0.17,2.59 -0.52,0.22 -0.29,-0.55 -0.91,-1.01 -0.65,-0.4 -0.68,0.1 -0.48,1.13 -0.39,-0.01 -0.41,-0.79 -1.43,-1.87 -1.61,-1.66 -0.85,-0.68 -0.35,-0.11 -1.12,0.39 0.43,-1.19 0.62,-0.89 0.05,0.82 1.42,1.52 0.57,0.39 1.08,-0.35 -1.1,-0.44 -0.14,-0.41 -0.06,-0.34 0.18,-0.4 -0.48,-2.7 -0.83,-2.21 -0.13,-1.48 -0.73,-1.13 -1.74,-1.96 -2.09,-1.7 0.3,-1.25 -0.11,-0.9 -0.54,-1.54 -1.1,-2.27 -1.24,-0.48 -2.01,0.32 -0.86,0.49 -0.66,-0.74 0.01,-0.33 -0.8,-2.13 -1.32,-3 0.87,0.06 0.43,0.4 0.15,0.65 0.74,-1.01 0.22,-0.66 -0.22,-1.14 -0.77,-1.09 -0.68,-0.59 -0.31,-0.05 -1.72,0.54 -0.7,0.67 -0.41,-0.08 0.02,-1.04 0.31,-0.71 0.55,0.22 0.18,-0.3 -1.35,-1.88 -1.09,-0.64 -0.68,-0.61 0.12,-0.47 -0.74,-0.23 -0.27,0.22 -0.16,0.65 -0.89,0.56 -3.46,-0.24 -0.33,-0.08 -0.76,-0.82 -1,-0.36 -1.53,-1.45 -0.52,-0.28 -2.18,-0.26 -1.04,0.21 -0.81,0.75 -0.94,0.33 -0.68,0.05 -0.75,-0.19 -1.83,-1.85 -2.8,-2.03 -4.39,-2.27 -2.35,-0.88 -0.36,0.04 -1.11,0.9 -1.83,0.71 -0.55,0.07 -5.76,-0.43 -1.24,0.04 -2.31,0.18 -1.06,0.27 -6.58,0.56 -2.5,0.41 0,0 0.06,-70.18 0,0 9.71,-0.07 0,0 14.47,0.01 0,0 73.46,-0.01 0,0 32.57,0 0.03,36.55 0,0 -0.05,63.7 0,0 -0.28,-0.37 -0.04,54.4 0,0 -1.27,-0.13 -0.86,0.26 -0.79,-0.03 -1.83,-0.98 -1.89,-1.9 -1.28,-2.59 -1.27,-1.93 -0.78,-0.55 -0.61,0.03 -1.95,-2.62 -0.68,-1.36 0.34,-0.7 -0.03,-0.55 -0.51,-1.27 0.2,-1.25 0.77,-0.64 0.42,-1.08 -0.01,-1.81 -0.4,-1.43 -1.9,-4.63 -3,-4 -1.98,-2.13 -1.16,-0.94 0.53,0.17 2.96,2.59 1.96,2.69 0.83,1.71 -0.12,-0.93 -0.5,-1.41 -0.41,-0.61 -1.29,-1.49 -3.78,-3.62 -0.02,-1.18 0.67,-0.27 0.82,0.71 -0.1,1.67 0.17,0.23 1.02,-0.11 0.28,-1.16 0.13,-1.77 -0.18,-1.27 -1.56,-0.77 -0.84,0.83 -0.6,0.18 -0.64,-0.03 -0.55,0.24 -0.22,0.54 0.11,0.35 0.62,0.2 0.21,0.26 -0.49,0.63 -2.93,-0.25 -0.77,0.32 -0.65,0.79 -0.59,0.41 -3.92,0.21 -0.89,-0.67 0.65,-1.15 1.44,-0.72 1.66,-1.79 0.31,-1.75 -0.13,-0.46 0.11,-0.84 0.53,-1.16 -0.36,-2.14 0.25,-1.18 -0.09,-0.58 -0.66,-1.14 -1.74,-2.13 -0.6,-2.16 -1.38,-2.35 -0.26,0.06 -0.66,1.54 0.29,0.58 -0.16,0.55 -1.03,1.06 -0.38,1.31 -0.15,2.44 -1.37,4.46 -0.01,1.1 -0.8,0.65 -1.54,-0.7 -0.79,-0.2 -0.42,0.08 -2.04,0.77 -0.46,0.75 -0.26,0.17 -1.51,-0.23 -0.84,0.74 -0.62,0.23 -0.35,-0.17 -0.31,-0.52 0.4,-0.65 0.74,-0.73 0.26,-0.63 0.18,-1.86 0.51,-0.75 0.91,0.36 0.93,-0.25 0.96,-0.06 0.19,0.3 0.93,0.42 0.54,-0.29 0.22,-0.55 0.48,-3.14 -0.19,-2.45 0.13,-2.43 -0.45,-1.65 0.16,-0.22 0.53,0 0.32,-0.62 0.55,-1.82 0.09,-0.94 1.9,-2.43 1.22,-1.2 0.46,-0.13 0.18,-0.47 -0.35,-1.53 -1.1,-2.11 0.33,-0.98 0.62,-0.44 0.58,-0.23 0.7,-0.02 0.3,-0.24 -0.08,-0.66 -0.33,-0.63 -0.59,-0.25 -0.63,-2.86 -0.57,-1.27 -0.3,-1.55 -0.58,-0.44 -0.09,2.09 0.25,0.14 0.25,0.44 0.07,1.37 -0.36,1.86 -0.57,0.03 -1.38,0.44 -1.16,1.26 -1.12,2.23 -0.06,1.07 -0.2,0.6 -1.64,3.07 -0.74,0.62 -1.32,0.05 -0.77,-0.47 -0.71,1.06 0.2,0.14 -0.42,0.44 -3.08,1.63 -1.81,1.42 -0.62,0.64 -0.06,0.42 -0.54,1.02 z m 17.43,20.18 1.65,0.45 0.53,0.72 0.01,0.7 -0.79,0.71 -1.29,-0.63 -1.74,-0.13 -1.53,0.72 -0.2,0.28 0.14,0.92 -0.31,0.31 -1.42,0.7 -1.06,-1.08 -1.43,-0.27 -0.4,0.13 -0.12,0.49 -0.31,0.18 -1.29,-0.12 -1.43,0.22 -2.04,0.06 -0.35,-0.58 -1.54,-1.28 -0.05,-0.47 0.51,-1.5 3.98,-1.18 0.85,-0.01 1.02,-0.24 2.14,-0.95 2.27,0.19 0.64,0.61 -0.01,1.08 0.15,0.2 1.04,0.14 1.07,0.61 0.64,0.05 0.67,-1.03 z"
     title="South Australia"
     id="AU-SA" />
</svg>
    `,
                  tas: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
     d="m 369.45219,414.7604 -0.9,0.45 -0.2,-0.45 -1.4,-0.22 -0.94,-0.71 -0.92,-0.2 -2.37,-0.12 -0.23,-0.16 -0.16,-0.43 -0.31,-0.09 -1.31,0.4 -0.78,-0.26 -1.15,-1.81 0.64,-0.45 1.2,0.18 0.59,0.32 0.82,0.17 0.02,-0.98 -0.77,-0.64 -0.42,0.76 -2.89,-0.37 -0.24,-0.17 -1.19,-2.43 -1.43,-2.28 -0.23,-0.23 -0.68,0.03 -0.56,-0.9 -0.4,-0.85 -0.75,-2.77 -0.47,-0.51 -0.55,-0.16 -0.68,-4.38 0.08,-0.83 0.2,-0.26 0.29,0.52 1.91,1.46 0.47,2.18 0.9,-2.52 -0.57,-0.4 -0.45,0.04 -1.93,-2.12 -0.21,-0.6 0.02,-0.88 -0.16,-0.66 -0.69,-1.41 -1.41,-1.33 -1.09,-1.93 -2.92,-7.17 0.1,-0.51 -0.3,-1.52 -0.33,-0.62 -0.2,-1.44 0.88,-0.8 0.02,-1.66 0.66,-0.44 2.43,0.29 1.42,1.05 1.72,-0.28 0.66,0.56 2.21,0.72 3.62,2.15 3.48,1.64 2.3,0.21 1.02,-0.31 0.94,0.53 -0.05,-0.5 0.85,-0.9 0.77,-0.27 0.57,0.18 0.24,0.95 0.57,0.29 0.91,-0.02 -0.32,-0.46 -0.76,-0.17 -0.22,-0.21 -0.05,-0.69 0.49,-0.45 1.66,-0.75 1.41,0.47 2.27,-0.46 0.66,0.59 0.78,-0.47 1.09,-1.89 0.24,-0.15 0.69,-0.17 0.26,0.38 1.13,0.51 0.38,-0.02 0.69,-0.4 0.35,-0.59 0.19,-0.87 0.22,-0.24 0.46,0.02 0.71,0.33 1.54,1.14 0.57,0.75 0.6,1.35 -0.69,2.46 0.08,0.74 0.45,0.59 0.04,1.09 -0.47,1.72 0.07,1.23 0.37,1.07 -0.54,2.92 0.36,3.2 0.66,1.07 0.06,1.66 -0.57,0.81 -0.39,-0.33 -0.05,-0.35 0.29,-0.37 0.13,-0.96 -0.77,-2.07 -0.47,-0.77 -1.26,2.5 -0.82,5.93 -0.49,0.5 -0.16,0.84 0.12,1.52 -0.78,0.81 -0.44,1.48 0.15,0.24 0.47,-0.03 -0.2,-0.43 0.32,-0.24 0.69,0.42 0.28,0.55 0.06,1.03 -0.41,0.27 -0.17,1.29 0.58,1.31 -0.1,0.84 -0.27,0.02 -0.77,-0.68 -0.78,0.34 -0.41,0.61 -1,-1.24 -0.71,-1.45 -0.14,-0.71 0.6,-1.07 0.35,-0.1 0.26,0.24 0.05,0.36 -0.17,0.35 0.67,0.72 0.93,-0.07 0.34,-0.29 -0.8,-1.4 -2.54,-1.55 -0.37,0.06 -0.6,0.45 0.21,1.01 0.34,0.74 -0.29,0.58 -1.07,0.35 -0.25,-0.62 0.21,-0.13 -0.16,-1.5 -0.98,-0.63 0.34,0.86 -0.24,1.54 -0.63,0.77 -0.29,1.08 0.22,1.04 -0.16,0.97 -0.37,0.24 -0.38,-0.05 -0.87,-0.56 -0.79,-0.93 -0.15,-0.94 -0.23,-0.09 -0.23,0.37 -0.01,1 1.37,1.25 -0.44,1.1 -0.57,0.89 -0.54,1.57 -0.16,1.08 z m 13.16,-48.64 -0.98,-0.54 -0.28,-1.06 0.06,-0.3 -1.24,-2.33 -1.55,-1.38 1.32,-1.74 0.93,-0.4 2.15,2.87 0.4,0.29 0.83,0.22 0.09,0.41 0.51,2.79 -0.04,0.38 -0.3,0.28 -1.37,0.25 z m -45.67,-1.95 -0.38,-0.28 -0.14,-0.73 0.2,-0.15 0,-0.98 -0.62,-0.81 0.03,-0.77 0.19,-2.27 0.85,-0.63 0.13,-0.37 -0.11,-0.81 0.46,-0.13 0.97,0.59 0.45,0.65 0.15,2.29 0.26,1.47 -0.1,0.77 -0.33,0.74 z m 47.95,5.2 -0.03,-0.69 -0.19,-0.28 -2.52,0.32 -0.97,-0.42 0.02,-0.55 0.72,-0.59 0.74,-0.04 0.76,0.23 1.52,-0.77 1.48,1.76 -0.02,0.15 -0.75,0.29 z m -11.25,43.83 -0.69,-0.32 -0.69,0.15 -0.57,-1.19 1.92,-2.37 0.7,1.83 -0.48,1.74 z m 0.64,-3.73 -0.75,-1.57 0.7,-1.22 0.43,0.66 0.39,1.81 -0.03,0.17 z m 7.09,-7.54 0.05,-1.96 0.63,-0.48 0.56,0.05 0.49,0.96 -0.05,0.15 -0.76,0.01 z m -33.93,-29.34 -0.19,-0.14 -0.05,-0.69 0.65,-0.77 0.98,1.12 z"
     title="Tasmania"
      id="AU-TAS"/>
</svg>
    `,
                  vic: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
     d="m 398.35219,330.7904 -1.32,0.65 -1.6,0.16 -5.25,0.03 -1.82,0.26 -1.79,-0.07 -2.01,0.14 -3.75,1.11 -2.22,1.1 -2.37,1.8 -1.83,1.71 -1.73,1.72 -2.64,3.07 -1.04,0.92 -2.43,0.31 -2.38,0.6 -0.85,-0.27 -0.99,0.06 -0.45,0.19 -0.38,0.57 1.21,2.21 1.25,-0.88 0.23,-0.84 0.39,0.18 0.16,3.76 -0.64,0.81 -0.34,0.17 -0.51,-0.24 -0.3,-0.45 -0.79,-2.07 -1.14,-1.43 -0.84,-0.36 -0.53,0.17 -0.15,0.43 -1.07,-0.09 -0.88,-1.78 0.26,-0.42 -0.34,-0.64 -0.96,-0.15 -0.75,0.5 -0.55,0.09 -0.45,-0.26 -1.63,-1.65 0.18,-1.29 0.96,-0.4 0.38,-0.67 -0.76,-1.74 -0.45,-0.29 -2.05,0.15 -0.46,1.54 -1.98,2.04 -0.96,0.19 -0.44,-0.07 -1.52,-1.77 1.29,0 1.14,-0.51 1.59,-2.8 -0.35,-1.29 -1.34,-2.07 -0.63,-0.32 -1.01,0.46 -1.45,1.39 -1.78,1.33 -1.53,0.16 -0.19,0.19 0.06,0.5 1.5,0.26 0.84,-0.29 0.5,-0.37 0.75,0.21 0.16,0.4 -0.12,0.61 -0.56,0.86 -0.27,0.2 -0.93,-0.22 -1.67,0.36 -0.35,0.21 -3.27,2.21 -2.38,2.93 -1.2,0.33 -0.4,0.28 -0.24,0.61 -1.41,1.04 -0.41,-0.11 -0.67,-0.79 -0.61,-0.36 -2.25,-0.72 -0.51,-0.52 -0.92,-0.57 -0.83,-0.11 -1.83,-0.74 -2.91,-2.25 -1.69,-0.67 -1.2,0.29 -0.2,0.23 -0.98,-0.02 -1.06,-0.61 -1.06,-0.88 -1.56,-0.34 -0.76,-0.01 -0.78,0.22 -0.64,0.54 0,0.43 0.33,0.65 -0.86,0.24 -1.27,-0.62 -0.94,-1.14 -1.89,-1.77 -0.97,-0.64 -1.47,-0.68 0,0 0.04,-54.4 0.28,0.37 0,0 0.51,0.5 0.33,0.09 1.87,0.14 1.78,0.83 1.21,0.74 0.19,0.26 0.53,-0.28 0.61,-0.84 0.96,-0.37 1.61,0.42 1.7,-0.35 1.25,0.57 0.87,0.6 1.51,2.54 0.05,1.88 0.94,0.87 0.58,1.55 -0.03,0.26 0.37,0.43 0.92,0.18 0.49,-0.62 0.35,-1.55 0.19,-0.27 0.62,-0.21 0.68,0.45 0.15,0.36 1.28,0.52 1.62,0.11 2.31,1.26 0.14,0.21 -0.01,0.83 -0.26,1.31 0.29,1.65 0.5,1.1 0.81,0.5 0.88,0.22 0.42,0.65 -0.25,0.76 0.18,0.28 0.67,0.5 0.45,-0.1 0.77,0.28 1.67,1.27 1.86,0.99 0.84,1.16 1.1,0.98 0.62,0.2 0.25,0.26 0.56,1.28 2.28,2.67 1.34,0.78 0.42,0.11 1.92,-0.54 -0.17,-1.36 0.38,-1.38 0.2,-0.24 1.36,-0.35 1.33,0 0.37,0.3 0.95,0.09 0.95,-0.52 0.82,-0.18 0.27,0.03 0.79,0.62 1.28,1.23 0.76,0.32 3.1,0.59 2.25,0.2 1.14,-0.49 0.38,-0.4 0.68,-0.09 1.12,0.17 0.97,0.76 2.42,0.76 1.46,0.1 1.82,-0.64 0.98,-0.09 1.01,-1.26 1.01,-0.17 1.53,0.29 0.93,-0.36 1.82,0.78 1.18,0.75 0.56,4.42 0.69,0.88 1,2.04 -0.11,0.97 -0.88,1.52 0.98,0.08 19.25,9.7 0,0 -0.85,0.54 -1.24,0.11 -1.22,1.86 -0.98,0.5 z m -45.84,9.55 -0.78,-0.3 -0.14,-0.63 0.27,-0.89 1.74,0.36 0.44,0.52 -0.12,0.2 -0.7,0.01 -0.71,0.73 z m -0.02,1.92 -0.37,-0.45 -0.53,-0.23 -1.68,0.14 0.03,-0.15 0.76,-0.74 1.01,-0.2 0.29,0.19 0.58,1.39 -0.09,0.05 z"
     title="Victoria"
     id="AU-VIC" />
</svg>
    `
                };
                return svgMap[regionKey] || '<svg width="80" height="60"></svg>';
              })() }}
            />
            {usedIntervalDate && (
              <Typography variant="caption" sx={{ mt: 1, color: '#555' }}>
                Last interval: {formatIntervalDate(usedIntervalDate)}
              </Typography>
            )}
          </Box>

          {/* Four columns: CurrentWholesale, CurrentRetail, CheapestRate, MostExpensiveRate */}
          <Box sx={{ display: 'flex', flexDirection: 'row' }}>
            {/* Current Wholesale */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid #CCC',
                marginRight: '1rem',
                paddingRight: '1rem'
              }}
            >
              <Typography sx={{ color: '#666' }}>Current<br/>Wholesale</Typography>
              {loading ? (
                <CircularProgress size="1rem" />
              ) : (
                <>
                  <Typography sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.5rem' }}>
                    {(rrpCentsPerKWh / 100).toFixed(2)} $/kWh
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#555' }}>
                    {usedIntervalDate && formatDayTimeAemoString(usedIntervalDate)}
                  </Typography>
                </>
              )}
            </Box>

            {/* Current Retail */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid #CCC',
                marginRight: '1rem',
                paddingRight: '1rem'
              }}
            >
              <Typography sx={{ color: '#666' }}>Current<br/>Retail</Typography>
              {loading ? (
                <CircularProgress size="1rem" />
              ) : (
                <>
                  <Typography sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.5rem' }}>
                    {(finalRateCents / 100).toFixed(2)} $/kWh
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#555' }}>
                    {usedIntervalDate && formatDayTimeAemoString(usedIntervalDate)}
                  </Typography>
                </>
              )}
            </Box>

            {/* Cheapest Rate */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid #CCC',
                marginRight: '1rem',
                paddingRight: '1rem'
              }}
            >
              <Typography sx={{ color: '#666' }}>Cheapest<br/>Rate</Typography>
              {loading ? (
                <CircularProgress size="1rem" />
              ) : (
                <>
                  <Typography variant="h5" sx={{ fontWeight: 'bold', lineHeight: 1.2, color: '#000' }}>
                    {(lowestRetailRate / 100).toFixed(2)} $/kWh
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#555' }}>
                    {formatDayTimeAemoString(lowestRetailRateTimestamp)}
                  </Typography>
                </>
              )}
            </Box>

            {/* Most Expensive Rate */}
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography sx={{ color: '#666' }}>Most<br/>Expensive<br/>Rate</Typography>
              {loading ? (
                <CircularProgress size="1rem" />
              ) : (
                <>
                  <Typography variant="h5" sx={{ fontWeight: 'bold', lineHeight: 1.2, color: '#000' }}>
                    {(highestRetailRate / 100).toFixed(2)} $/kWh
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#555' }}>
                    {formatDayTimeAemoString(highestRetailRateTimestamp)}
                  </Typography>
                </>
              )}
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Body main content */}
      <Box sx={{ p: 2, flexGrow: 1, backgroundColor: '#fff' }}>
        {/* Big "scenario currently costs" block */}
        <Box textAlign="center" mt={2}>
          <Typography variant="h6" gutterBottom sx={{ color: '#444' }}>
            {scenarioData.name.toLowerCase()} currently costs
          </Typography>
          {loading ? (
            <Box display="inline-flex" flexDirection="column" alignItems="center" mt={2}>
              <CircularProgress />
              <Typography variant="body2" mt={1} sx={{ color: '#444' }}>Loading…</Typography>
            </Box>
          ) : (
            <Typography variant="h2" sx={{ fontWeight: 'bold', lineHeight: 1, color: '#000' }}>
              {formatCurrency(toastCostDollars)}
            </Typography>
          )}
          <Typography variant="body2" mt={1} sx={{ color: '#555' }}>
            {usedIntervalDate ? `@ ${formatIntervalDate(usedIntervalDate)}` : ''}
          </Typography>
        </Box>

        {/* Cheapest/Most Expensive scenario cost */}
        <Box textAlign="center" mt={3}>
          <Box display="inline-flex" gap={2}>
            {/* Cheapest scenario */}
            <Card>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography sx={{ color: '#2196f3' }}>Cheapest</Typography>
                {loading ? (
                  <CircularProgress size="1rem" />
                ) : (
                  <>
                    <Typography variant="h5" sx={{ fontWeight: 'bold', lineHeight: 1.2, color: '#000' }}>
                      {formatCurrency(lowestScenarioCost)}
                    </Typography>
                    <Typography variant="caption" sx={{ color: '#555' }}>
                      {formatDayTimeAemoString(lowestScenarioTimestamp)}
                    </Typography>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Most Expensive scenario */}
            <Card>
              <CardContent sx={{ textAlign: 'center' }}>
                <Typography sx={{ color: '#2196f3' }}>Most Expensive</Typography>
                {loading ? (
                  <CircularProgress size="1rem" />
                ) : (
                  <>
                    <Typography variant="h5" sx={{ fontWeight: 'bold', lineHeight: 1.2, color: '#000' }}>
                      {formatCurrency(highestScenarioCost)}
                    </Typography>
                    <Typography variant="caption" sx={{ color: '#555' }}>
                      {formatDayTimeAemoString(highestScenarioTimestamp)}
                    </Typography>
                  </>
                )}
              </CardContent>
            </Card>
          </Box>
        </Box>

        {/* Other Regions */}
        <Box textAlign="center" mt={3}>
          <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold', color: '#444' }}>
            Other Regions
          </Typography>
          <Box sx={{ display: 'inline-flex', gap: 1 }}>
            {(() => {
              const references = otherRegions.map(r => {
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
                    cost,
                    date: latest.SETTLEMENTDATE
                  };
                } else {
                  return { region: r.toUpperCase(), cost: 0, date: '' };
                }
              });
              const allCosts = [toastCostDollars, ...references.map(x => x.cost)];
              const minVal = Math.min(...allCosts);
              const maxVal = Math.max(...allCosts);

              return references.map(item => {
                const cost = item.cost;
                let tag: ReactNode = null;
                if (cost === minVal && minVal === maxVal) {
                  tag = <Chip label="CHEAP & EXP" icon={<StarIcon />} color="warning" size="small" sx={{ mt: 1 }} />;
                } else if (cost === minVal) {
                  tag = <Chip label="CHEAP" icon={<StarIcon />} color="success" size="small" sx={{ mt: 1 }} />;
                } else if (cost === maxVal) {
                  tag = <Chip label="EXP" icon={<WarningIcon />} color="error" size="small" sx={{ mt: 1 }} />;
                }
                return (
                  <Card
                    key={item.region}
                    sx={{
                      cursor: 'pointer',
                      minWidth: 80,
                      margin: 1,
                      backgroundColor: '#fff'
                    }}
                    onClick={() => handleRegionClick(item.region.toLowerCase())}
                  >
                    <CardContent sx={{ textAlign: 'center' }}>
                      <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#444' }}>
                        {item.region}
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.1rem' }}>
                        {formatCurrency(item.cost)}
                      </Typography>
                      {tag}
                    </CardContent>
                  </Card>
                );
              });
            })()}
          </Box>
        </Box>

        {/* Scenario dropdown */}
        <Box mt={3} textAlign="center">
          <Box sx={{ display: 'inline-block', minWidth: 300 }}>
            <FormControl fullWidth>
              <InputLabel id="scenario-select-label">Scenario</InputLabel>
              <Select
                labelId="scenario-select-label"
                label="Scenario"
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
          </Box>
        </Box>

        {/* Assumptions */}
        {scenarioData.assumptions && scenarioData.assumptions.length > 0 && (
          <Box mt={3} textAlign="center">
            <Box sx={{ display: 'inline-block', maxWidth: 480, width: '100%' }}>
              <Card sx={{ backgroundColor: '#fff' }}>
                <CardContent>
                  <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#444' }}>
                    Assumptions
                  </Typography>
                  <ul style={{ textAlign: 'left', color: '#444' }}>
                    {scenarioData.assumptions.map((ass, i) => (
                      <li key={i}>
                        <Typography variant="body2">{ass}</Typography>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </Box>
          </Box>
        )}

        {/* Sparkline for last 48h scenario cost */}
        {!loading && regionIntervals.length > 0 && (
          <SparklineChart
            todayIntervals={recent24Intervals}
            yesterdayIntervals={previous24Intervals}
            region={regionKey as SupportedRegion}
            scenarioKey={scenarioKeyStr}
          />
        )}

        {/* Daily Summaries */}
        <Box textAlign="center" mt={3}>
          <Box sx={{ display: 'inline-block', maxWidth: 480, width: '100%' }}>
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#444' }}>
                  Daily Summaries
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                {dailySummaries.length === 0 ? (
                  <Typography variant="body2" sx={{ color: '#444' }}>
                    No daily summary data available.
                  </Typography>
                ) : (
                  <TableContainer component={Paper}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Date</TableCell>
                          <TableCell align="right">Min Whl ($/kWh)</TableCell>
                          <TableCell align="right">Min Rtl ($/kWh)</TableCell>
                          <TableCell align="right">Max Whl ($/kWh)</TableCell>
                          <TableCell align="right">Max Rtl ($/kWh)</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {dailySummaries.map(ds => (
                          <TableRow key={ds.date}>
                            <TableCell>{ds.date}</TableCell>
                            <TableCell align="right">{(ds.minWholesale / 100).toFixed(2)}</TableCell>
                            <TableCell align="right">{(ds.minRetail / 100).toFixed(2)}</TableCell>
                            <TableCell align="right">{(ds.maxWholesale / 100).toFixed(2)}</TableCell>
                            <TableCell align="right">{(ds.maxRetail / 100).toFixed(2)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </AccordionDetails>
            </Accordion>
          </Box>
        </Box>
      </Box>

      {/* Footer */}
      <Box
        component="footer"
        sx={{
          borderTop: '1px solid #CCC',
          p: 2,
          textAlign: 'center',
          mt: 'auto',
          backgroundColor: '#fff'
        }}
      >
        <Typography variant="body2" sx={{ mb: 1, color: '#444' }}>
          CC0 1.0 Universal |{' '}
          <Link href="/about" style={{ marginRight: 8 }}>
            About
          </Link>{' '}
          |{' '}
          <Link href="https://github.com/troykelly/costs-how-much" target="_blank" rel="noopener noreferrer" style={{ marginRight: 8 }}>
            GitHub
          </Link>
          | <Link href="https://troykelly.com/" target="_blank" rel="noopener noreferrer" style={{ marginRight: 8 }}>Troy Kelly</Link>
          |{' '}
          <Button variant="text" size="small" onClick={() => setLocationDialogOpen(true)}>
            My Location
          </Button>
        </Typography>
        <Typography variant="caption" display="block" sx={{ color: '#444' }}>
          Data sourced from{' '}
          <Link href="https://www.aemo.com.au" target="_blank" rel="noopener noreferrer">
            AEMO
          </Link>
        </Typography>
      </Box>

      {/* Location Dialog */}
      <Dialog open={locationDialogOpen} onClose={() => setLocationDialogOpen(false)}>
        <DialogTitle>Location Data Request</DialogTitle>
        <DialogContent>
          <Typography variant="body1">
            We are about to request your location data to determine the nearest region for pricing.
            This is voluntary – we do not store your location.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLocationDialogOpen(false)} color="error">
            Deny
          </Button>
          <Button
            onClick={() => {
              setLocationDialogOpen(false);
              localStorage.setItem('hasAskedLocation', 'true');
              if (!navigator.geolocation) {
                alert('Geolocation is not supported by your browser.');
                return;
              }
              navigator.geolocation.getCurrentPosition(
                pos => {
                  const lat = pos.coords.latitude;
                  const lon = pos.coords.longitude;
                  const stName = getStateNameForLatLon(lat, lon);
                  if (!stName) {
                    alert('It appears you are outside of the serviced area. Defaulting to NSW.');
                    handleRegionClick('nsw');
                    return;
                  }
                  const mapped = mapStateNameToRegionKey(stName);
                  if (mapped && regionMapping[mapped]) {
                    handleRegionClick(mapped);
                  } else {
                    alert('Your location is not in a supported region. Defaulting to NSW.');
                    handleRegionClick('nsw');
                  }
                },
                () => alert('Unable to retrieve location. Check permissions.')
              );
            }}
            color="primary"
          >
            Allow
          </Button>
        </DialogActions>
      </Dialog>
      {error && (
        <Box sx={{ position: 'fixed', bottom: '1rem', left: '50%', transform: 'translateX(-50%)' }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      )}
    </Box>
  );
};

export default App;