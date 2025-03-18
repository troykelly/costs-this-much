/**
 * @fileoverview App.tsx - A React application that retrieves the current AEMO
 * network price for a selected region and computes an approximate cost for a chosen
 * energy scenario (toast, EV charge, phone charge, etc.).
 *
 * Updated (18 March 2025):
 * • Production-ready interface (no example placeholders/timeframes).  
 * • Modern layout changes for the header and info boxes as requested:
 *   - Full-width heading in a modern shade of blue, no margins.  
 *   - Region name in the heading’s background colour, bold.  
 *   - Other text in dark grey, numeric values in bold black with a larger font size.  
 *   - The info boxes do not fill the entire width; a vertical line separates each. No box borders.  
 *   - White background for the main area.  
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
  Tooltip,
  IconButton,
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
import InfoIcon from '@mui/icons-material/Info';
import RefreshIcon from '@mui/icons-material/Refresh';
import StarIcon from '@mui/icons-material/Star';
import WarningIcon from '@mui/icons-material/Warning';
import ElectricBoltIcon from '@mui/icons-material/ElectricBolt';
import { AemoInterval, getRetailRateFromInterval, SupportedRegion } from './pricingCalculator';
import { EnergyScenarios } from './energyScenarios';
import statesData from '../data/au-states.json';

/**
 * Maps region keys to a more descriptive string for display.
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
 * Returns the scenario key from the subdomain (preferred) or query string (dev).
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

function setMetaTag(attrName: string, attrValue: string, content: string): void {
  let element = document.querySelector(`meta[${attrName}="${attrValue}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attrName, attrValue);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

// -------------- Minimal Ray-casting + state mapping code --------------
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
 * Minimal inline region map icons (placeholder shapes for each region).
 */
function getRegionSvg(region: string): string {
  const svgs: Record<string, string> = {
    nsw: '<svg width="80" height="60" viewBox="0 0 80 60" xmlns="http://www.w3.org/2000/svg"><path d="M10 10 L70 10 L70 30 L50 50 L10 40 Z" fill="lightblue" stroke="#333" stroke-width="2"/></svg>',
    qld: '<svg width="80" height="60" viewBox="0 0 80 60" xmlns="http://www.w3.org/2000/svg"><path d="M20 5 L60 15 L75 35 L35 55 L15 35 Z" fill="lightblue" stroke="#333" stroke-width="2"/></svg>',
    sa:  '<svg width="80" height="60" viewBox="0 0 80 60" xmlns="http://www.w3.org/2000/svg"><path d="M5 10 L30 20 L50 35 L40 55 L10 45 Z" fill="lightblue" stroke="#333" stroke-width="2"/></svg>',
    tas: '<svg width="80" height="60" viewBox="0 0 80 60" xmlns="http://www.w3.org/2000/svg"><path d="M30 15 L50 20 L50 40 L30 45 L25 30 Z" fill="lightblue" stroke="#333" stroke-width="2"/></svg>',
    vic: '<svg width="80" height="60" viewBox="0 0 80 60" xmlns="http://www.w3.org/2000/svg"><path d="M15 10 L65 10 L75 25 L60 50 L15 40 Z" fill="lightblue" stroke="#333" stroke-width="2"/></svg>'
  };
  return svgs[region] || '<svg width="80" height="60"></svg>';
}

/**
 * Simple 48-hour sparkline for the scenario cost.
 */
interface SparklineChartProps {
  todayIntervals: AemoInterval[];
  yesterdayIntervals: AemoInterval[];
  region: SupportedRegion;
  scenarioKey: string;
}
interface DataPoint {
  x: number;
  y: number;
  cost: number;
  date: string;
  dt: Date;
}
const SparklineChart: React.FC<SparklineChartProps> = ({ todayIntervals, yesterdayIntervals, region, scenarioKey }) => {
  const [hoveredPoint, setHoveredPoint] = useState<DataPoint | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);

  const viewBoxWidth = 500;
  const svgHeight = 60;
  const padding = 5;

  // Gather costs
  const allCosts = [...todayIntervals, ...yesterdayIntervals].map(iv =>
    EnergyScenarios.getCostForScenario(scenarioKey, getRetailRateFromInterval(iv, region, false, true))
  );
  const maxCost = allCosts.length > 0 ? Math.max(...allCosts) : 0;
  const useLogScale = maxCost > 1;
  const offset = 1;
  let maxScaled = maxCost;
  if (useLogScale) {
    maxScaled = Math.max(...allCosts.map(c => Math.log(c + offset)));
  }

  // For the 24h referencing
  function getBrisbaneNow(): Date {
    const now = new Date();
    const brisbaneOffsetMinutes = 10 * 60;
    const localOffsetMinutes = now.getTimezoneOffset();
    return new Date(now.getTime() + (brisbaneOffsetMinutes + localOffsetMinutes) * 60000);
  }
  const brisbaneNow = getBrisbaneNow();
  const recentPeriodBase = new Date(brisbaneNow.getTime() - 24 * 60 * 60 * 1000);
  const previousPeriodBase = new Date(brisbaneNow.getTime() - 48 * 60 * 60 * 1000);

  const computeX = (dt: Date, base: Date) => {
    const diff = dt.getTime() - base.getTime();
    const fraction = diff / (24 * 60 * 60 * 1000);
    return padding + fraction * (viewBoxWidth - 2 * padding);
  };

  function computePoints(intervals: AemoInterval[], base: Date) {
    const dataPoints: DataPoint[] = [];
    const poly = intervals.map(iv => {
      const dt = new Date(iv.SETTLEMENTDATE + '+10:00');
      const rate = getRetailRateFromInterval(iv, region, false, true);
      const cost = EnergyScenarios.getCostForScenario(scenarioKey, rate);
      const x = computeX(dt, base);
      let scaledCost = cost;
      if (useLogScale) {
        scaledCost = Math.log(cost + offset);
      }
      const y = svgHeight - padding - ((scaledCost / (maxScaled || 1)) * (svgHeight - 2 * padding));
      dataPoints.push({ x, y, cost, date: iv.SETTLEMENTDATE, dt });
      return `${x},${y}`;
    }).join(' ');
    return { poly, dataPoints };
  }
  const yRef = svgHeight - padding - (((useLogScale ? Math.log(maxCost + offset) : maxCost) / (maxScaled || 1)) * (svgHeight - 2 * padding));

  const todayData = computePoints(todayIntervals, recentPeriodBase);
  const yestData = computePoints(yesterdayIntervals, previousPeriodBase);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * viewBoxWidth;
    if (todayData.dataPoints.length === 0) return;
    let nearest = todayData.dataPoints[0];
    let minDist = Math.abs(nearest.x - mouseX);
    todayData.dataPoints.forEach(pt => {
      const dist = Math.abs(pt.x - mouseX);
      if (dist < minDist) {
        minDist = dist;
        nearest = pt;
      }
    });
    setHoveredPoint(nearest);
  };
  const handleMouseLeave = () => setHoveredPoint(null);

  return (
    <Box textAlign="center" mt={4}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
        Last 48 Hours
      </Typography>
      <Box
        position="relative"
        sx={{
          border: '1px solid #ccc',
          borderRadius: 1,
          p: 1,
          maxWidth: '100%',
          margin: '0 auto',
          display: 'inline-block',
          backgroundColor: '#fff'
        }}
      >
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${viewBoxWidth} ${svgHeight}`}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {yesterdayIntervals.length > 0 && (
            <polyline fill="none" stroke="#888888" strokeWidth="2" points={yestData.poly} />
          )}
          {todayIntervals.length > 0 && (
            <polyline fill="none" stroke="#1976d2" strokeWidth="2" points={todayData.poly} />
          )}
          <line
            x1={padding}
            y1={yRef}
            x2={viewBoxWidth - padding}
            y2={yRef}
            stroke="#ff0000"
            strokeDasharray="4"
            strokeWidth="1"
          />
          <text x={padding + 2} y={yRef - 2} fill="#ff0000" fontSize="10">
            Max: {formatCurrency(maxCost)}
          </text>
          {hoveredPoint && (
            <>
              <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r={3} fill="#000" stroke="#fff" strokeWidth={1} />
              <text
                x={hoveredPoint.x + 5}
                y={hoveredPoint.y - 5}
                fill="#000"
                fontSize="10"
                style={{ pointerEvents: 'none' }}
              >
                {new Date(hoveredPoint.date + '+10:00').toLocaleTimeString('en-AU',{
                  timeZone: 'Australia/Brisbane',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
                : {formatCurrency(hoveredPoint.cost)}
              </text>
            </>
          )}
        </svg>
      </Box>
    </Box>
  );
};

/**
 * Show a 404 if scenario is missing.
 */
function ScenarioNotFound({ scenarioKey }: { scenarioKey: string }): JSX.Element {
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
}

/**
 * AboutPage
 */
interface AboutPageProps {}
export function AboutPage(_: AboutPageProps): JSX.Element {
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
}

/**
 * Main App
 */
const App: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [rrpCentsPerKWh, setRrpCentsPerKWh] = useState<number>(0);
  const [finalRateCents, setFinalRateCents] = useState<number>(0);
  const [toastCostDollars, setToastCostDollars] = useState<number>(0);
  const [usedIntervalDate, setUsedIntervalDate] = useState<string>('');
  const [regionIntervals, setRegionIntervals] = useState<AemoInterval[]>([]);
  const [allIntervals, setAllIntervals] = useState<AemoInterval[]>([]);
  const [locationDialogOpen, setLocationDialogOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const isDevMode = window.location.hostname.includes('localhost') || window.location.hostname.includes('127.');

  // Determine region from path
  const pathParts = window.location.pathname.split('/');
  const regionKey = pathParts[1]?.toLowerCase() || 'nsw';

  // If about page
  if (regionKey === 'about') {
    return <AboutPage />;
  }

  // Scenario
  const scenarioKeyStr = getScenarioKey().trim();
  if (!scenarioKeyStr) {
    window.location.href = '/nsw?s=toast';
    return null;
  }
  const scenarioData = EnergyScenarios.getScenarioById(scenarioKeyStr);
  if (!scenarioData) {
    return <ScenarioNotFound scenarioKey={scenarioKeyStr} />;
  }

  // Region mapping for the AEMO intervals
  const regionMapping: Record<string, string> = {
    nsw: 'NSW1',
    qld: 'QLD1',
    sa: 'SA1',
    tas: 'TAS1',
    vic: 'VIC1'
  };
  const regionFilter = regionMapping[regionKey] ?? 'NSW1';

  // Page meta tags
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
    } catch (err: any) {
      setError(err.message || 'Failed to fetch AEMO data.');
      setRrpCentsPerKWh(0);
      setFinalRateCents(0);
      setToastCostDollars(0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAemoData();
    const intervalId = setInterval(fetchAemoData, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [regionFilter, scenarioKeyStr]);

  // For last 48 hours usage
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

  // Summaries
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

  // cheapest / most expensive scenario cost
  type PriceInfo = { cost: number; timestamp: string };
  let lowestScenario: PriceInfo = { cost: 0, timestamp: '' };
  let highestScenario: PriceInfo = { cost: 0, timestamp: '' };
  if (regionIntervals.length > 0) {
    let minCost = Number.MAX_VALUE;
    let maxCost = -Infinity;
    let minInterval: AemoInterval | null = null;
    let maxInterval: AemoInterval | null = null;
    regionIntervals.forEach(iv => {
      const retailRate = getRetailRateFromInterval(iv, regionKey as SupportedRegion, false, true);
      const cost = EnergyScenarios.getCostForScenario(scenarioKeyStr, retailRate);
      if (cost < minCost) {
        minCost = cost;
        minInterval = iv;
      }
      if (cost > maxCost) {
        maxCost = cost;
        maxInterval = iv;
      }
    });
    if (minInterval) {
      lowestScenario = { cost: minCost, timestamp: minInterval.SETTLEMENTDATE };
    }
    if (maxInterval) {
      highestScenario = { cost: maxCost, timestamp: maxInterval.SETTLEMENTDATE };
    }
  }

  const otherRegions = Object.keys(regionMapping).filter(r => r !== regionKey);

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh" bgcolor="#ffffff">
      {/* Top header bar: modern blue, no margins */}
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

      {/* Info boxes area */}
      <Box sx={{ borderBottom: '1px solid #CCC', backgroundColor: '#fff', padding: '1rem' }}>
        <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          {/* Region + map box with right border */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              borderRight: '1px solid #CCC',
              paddingRight: '1rem',
              marginRight: '1rem'
            }}
          >
            {/* Full region name in the heading color, bold */}
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
              dangerouslySetInnerHTML={{ __html: getRegionSvg(regionKey) }}
            />

            {usedIntervalDate && (
              <Typography variant="caption" sx={{ mt: 1, color: '#555' }}>
                Last interval: {formatIntervalDate(usedIntervalDate)}
              </Typography>
            )}
          </Box>

          {/* Additional items in row */}
          <Box sx={{ display: 'flex', flexDirection: 'row' }}>
            {/* 1) Current Wholesale */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid #CCC',
                marginRight: '1rem',
                paddingRight: '1rem'
              }}
            >
              <Typography sx={{ color: '#666' }}>Current< br/>Wholesale</Typography>
              {loading ? (
                <CircularProgress size="1rem" />
              ) : (
                <Typography sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.5rem' }}>
                  {(rrpCentsPerKWh / 100).toFixed(2)} $/kWh
                </Typography>
              )}
            </Box>

            {/* 2) Current Retail */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid #CCC',
                marginRight: '1rem',
                paddingRight: '1rem'
              }}
            >
              <Typography sx={{ color: '#666' }}>Current< br/>Retail</Typography>
              {loading ? (
                <CircularProgress size="1rem" />
              ) : (
                <Typography sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.5rem' }}>
                  {(finalRateCents / 100).toFixed(2)} $/kWh
                </Typography>
              )}
            </Box>

            {/* 3) Cheapest Rate */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                borderRight: '1px solid #CCC',
                marginRight: '1rem',
                paddingRight: '1rem'
              }}
            >
              <Typography sx={{ color: '#666' }}>Cheapest</Typography>
              <Typography sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.5rem' }}>
                {lowestScenario.cost > 0
                  ? formatCurrency(lowestScenario.cost)
                  : '$0.00'}
              </Typography>
            </Box>

            {/* 4) Most Expensive */}
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography sx={{ color: '#666' }}>Most< br/>Expensive</Typography>
              <Typography sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.5rem' }}>
                {highestScenario.cost > 0
                  ? formatCurrency(highestScenario.cost)
                  : '$0.00'}
              </Typography>
            </Box>
          </Box>
        </Box>

        {/* Refresh button */}
        {/* <Box mt={1}>
          <Tooltip title="Refresh Data">
            <IconButton onClick={fetchAemoData}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          {error && (
            <Alert
              severity="error"
              action={<Button color="inherit" size="small" onClick={fetchAemoData}>Retry</Button>}
              sx={{ mt: 1 }}
            >
              {error}
            </Alert>
          )}
        </Box> */}
      </Box>

      {/* Body main content */}
      <Box sx={{ p: 2, flexGrow: 1, backgroundColor: '#fff' }}>
        {/* Big cost in centre */}
        <Box textAlign="center" mt={2}>
          <Typography variant="h6" gutterBottom sx={{ color: '#444' }}>
            A {scenarioData.name.toLowerCase()} currently costs
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

        {/* Other regions (centered) */}
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
                  // only if everything is same
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

        {/* Scenario dropdown (centered) */}
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

        {/* Assumptions (centered) */}
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

        {/* Sparkline for last 48h (centered) */}
        {!loading && regionIntervals.length > 0 && (
          <SparklineChart
            todayIntervals={recent24Intervals}
            yesterdayIntervals={previous24Intervals}
            region={regionKey as SupportedRegion}
            scenarioKey={scenarioKeyStr}
          />
        )}

        {/* Daily summaries (centered) */}
        <Box mt={3} textAlign="center">
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
          <Button onClick={() => setLocationDialogOpen(false)} color="error">Deny</Button>
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
    </Box>
  );
};

export default App;