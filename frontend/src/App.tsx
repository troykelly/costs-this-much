/**
 * @fileoverview App.tsx - A React application that retrieves current energy data
 * from our own CostsThisMuch API (instead of direct AEMO), using the provided
 * CostsThisMuch library for session handling, local caching (IndexedDB), and
 * partial offline usage.
 *
 * Updated (19 March 2025):
 * • Switched from direct AEMO fetch to our own CostsThisMuch API by integrating
 *   the library from frontend/src/CostsThisMuch.ts.
 * • On mount, we now:
 *    1) Initialise and log in with a known client_id.
 *    2) Preload the last 7 days of data into local storage.
 *    3) Fetch local data for display.
 *    4) Start a 5-minute interval to refresh the latest data from the API,
 *       then reload from local storage.
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Original: 16 March 2025
 * Last Updated: 19 March 2025
 */

import React, { useEffect, useState, ReactNode, useRef } from 'react';
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
 * Now importing IntervalRecord and the CostsThisMuch library
 * for fetching/storing data from our actual API.
 */
import { CostsThisMuch, IntervalRecord } from './CostsThisMuch';

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
 * Formats a short "weekday + 24 hour AEMO TIME" string.
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

/**
 * Convert an IntervalRecord from the CostsThisMuch library into the old AemoInterval shape
 * used throughout the UI. This helps us keep the rest of the code minimal.
 */
function transformIntervalRecordToAemoInterval(rec: IntervalRecord): AemoInterval {
  return {
    SETTLEMENTDATE: rec.settlement ?? '',
    REGIONID: rec.regionid ?? '',
    RRP: rec.rrp ?? 0,
    TOTALDEMAND: rec.totaldemand ?? 0,
    PERIODTYPE: rec.periodtype ?? 'ENERGY',
    NETINTERCHANGE: rec.netinterchange ?? 0,
    SCHEDULEDGENERATION: rec.scheduledgeneration ?? 0,
    SEMISCHEDULEDGENERATION: rec.semischeduledgeneration ?? 0,
    APCFLAG: rec.apcflag ?? 0
  };
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

  // We'll store an instance of the "CostsThisMuch" client in a ref so we only create it once.
  const ctmClientRef = useRef<CostsThisMuch | null>(null);

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

  /**
   * After we fetch local data from the last 48 hours (or so), we transform and
   * run the same logic that filters by region, sets the scenario cost, etc.
   */
  async function loadAndProcessLocalData(): Promise<void> {
    try {
      // Let's say we load the last 48 hours from local IDB for now - enough for display.
      const now = Date.now();
      const fortyEightAgo = now - 48 * 60 * 60 * 1000;
      const ctm = ctmClientRef.current;
      if (!ctm) return;

      const records = await ctm.getLocalDataInRange(fortyEightAgo, now);
      const intervals: AemoInterval[] = records.map(transformIntervalRecordToAemoInterval);

      setAllIntervals(intervals);

      // Filter for region
      const regData = intervals.filter(iv => iv.REGIONID === regionFilter);
      regData.sort((a, b) => new Date(a.SETTLEMENTDATE).getTime() - new Date(b.SETTLEMENTDATE).getTime());
      setRegionIntervals(regData);

      // Calculate "current" interval
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

      // Find min/max retail rate in region
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

      // Scenario cost min/max in region
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

      setLoading(false);
    } catch (err: any) {
      setError(err.message || 'Failed to retrieve local data.');
      setLoading(false);
      setRrpCentsPerKWh(0);
      setFinalRateCents(0);
      setToastCostDollars(0);
      setLowestRetailRate(0);
      setHighestRetailRate(0);
      setLowestScenarioCost(0);
      setHighestScenarioCost(0);
    }
  }

  /**
   * On mount, create the CostsThisMuch client, login, fetch last week, then load local data.
   * Then set an interval to keep data fresh every 5 min (fetchAndStoreLatest).
   */
  useEffect(() => {
    let intervalId: number | null = null;
    (async () => {
      try {
        // Create the client using environment variables
        ctmClientRef.current = new CostsThisMuch({
          apiBaseUrl: import.meta.env.VITE_API_URL
        });
        setLoading(true);

        // init & login using environment variable client ID
        await ctmClientRef.current.initialize();
        await ctmClientRef.current.login(import.meta.env.VITE_APP_CLIENT_ID);

        // fetch last 7 days
        await ctmClientRef.current.fetchAndStoreLastWeek();
        // load
        await loadAndProcessLocalData();

        // every 5 min, fetch new intervals (2h) & reload
        intervalId = window.setInterval(async () => {
          try {
            await ctmClientRef.current?.fetchAndStoreLatest(7200);
            await loadAndProcessLocalData();
          } catch (e) {
            console.error('Auto refresh error:', e);
          }
        }, 5 * 60 * 1000);

      } catch (err: any) {
        setError(err.message || 'Failed to initialise data from our API.');
        setLoading(false);
      }
    })();

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [regionKey, scenarioKeyStr]);

  interface DailySummary {
    date: string;
    minWholesale: number;
    minRetail: number;
    maxWholesale: number;
    maxRetail: number;
  }

  /**
   * Compute a daily summary from regionIntervals for display in the table below.
   */
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
     d="m 402.68219,327.7504 ... (NSW path omitted for brevity) ... z"
     title="New South Wales"
     id="AU-NSW" />
</svg>
                  `,
                  qld: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
    d="m 402.68219,140.4104 ... (QLD path omitted) ... z"
     title="Queensland"
     id="AU-QLD" />
</svg>
                  `,
                  sa: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
    d="m 254.26219,283.5504 ... (SA path omitted) ... z"
     title="South Australia"
     id="AU-SA" />
</svg>
                  `,
                  tas: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
    d="m 369.45219,414.7604 ... (TAS path omitted) ... z"
     title="Tasmania"
      id="AU-TAS"/>
</svg>
                  `,
                  vic: `
<svg width="80" height="60" viewBox="0 0 442.48889 415.55103" xmlns="http://www.w3.org/2000/svg">
  <path fill="lightblue" stroke="#333" stroke-width="2"
    d="m 398.35219,330.7904 ... (VIC path omitted) ... z"
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
          Data now fetched from our own API with local caching.
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