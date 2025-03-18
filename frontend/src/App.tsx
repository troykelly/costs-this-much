/**
 * @fileoverview App.tsx - A simple React application that retrieves the current AEMO
 * network price for a selected region and computes an approximate cost for a chosen
 * energy scenario (toast, EV charge, phone charge, etc.).
 *
 * Major UI update to present a more modern interface, taking inspiration from the
 * ASCII layout provided by the user while preserving existing functionality and logic.
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Original Date: 16 March 2025
 * Updated: 18 March 2025 (UI overhaul)
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
  Grid,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Alert
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoIcon from '@mui/icons-material/Info';
import MenuIcon from '@mui/icons-material/Menu';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOn';
import RefreshIcon from '@mui/icons-material/Refresh';
import StarIcon from '@mui/icons-material/Star';
import WarningIcon from '@mui/icons-material/Warning';
import BreakfastDiningIcon from '@mui/icons-material/BreakfastDining';
import ElectricBoltIcon from '@mui/icons-material/ElectricBolt';
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
  return `${startTime} to ${endTime}`;
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

// Ray-casting and state determination functions (unmodified, minimal impact):
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
 * SparklineChart for the last 24+24 hours. We keep name & logic, just visually used in "Last 48 hours" area.
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
  const viewBoxWidth = 500;
  const svgHeight = 60;
  const padding = 5;

  // First, compute overall maximum cost for both datasets
  const overallAllCosts = [...todayIntervals, ...yesterdayIntervals].map(iv =>
    EnergyScenarios.getCostForScenario(scenarioKey, getRetailRateFromInterval(iv, region, false, true))
  );
  const overallMaxCost = overallAllCosts.length > 0 ? Math.max(...overallAllCosts) : 0;
  const useLogScale = overallMaxCost > 1; 
  const offset = 1; // offset to avoid log(0)
  let overallMaxScaled = overallMaxCost;
  if (useLogScale) {
    overallMaxScaled = Math.max(...overallAllCosts.map(c => Math.log(c + offset)));
  }

  // X coordinate as fraction of the last 24-hour or previous 24-hour periods
  const computeX = (dt: Date, base: Date): number => {
    const diff = dt.getTime() - base.getTime();
    const fraction = diff / (24 * 60 * 60 * 1000);
    return padding + fraction * (viewBoxWidth - 2 * padding);
  };

  function computePointsAndData(intervals: AemoInterval[], base: Date): { polyline: string, data: DataPoint[] } {
    const dataPoints: DataPoint[] = [];
    const polyline = intervals.map(iv => {
      const dt = new Date(iv.SETTLEMENTDATE + '+10:00');
      const retailRate = getRetailRateFromInterval(iv, region, false, true);
      const cost = EnergyScenarios.getCostForScenario(scenarioKey, retailRate);
      const x = computeX(dt, base);
      let scaledValue = cost;
      if (useLogScale) {
        scaledValue = Math.log(cost + offset);
      }
      const y = svgHeight - padding - ((scaledValue / (useLogScale ? overallMaxScaled : (overallMaxCost || 1))) * (svgHeight - 2 * padding));
      dataPoints.push({ x, y, cost, date: iv.SETTLEMENTDATE, dt });
      return `${x},${y}`;
    }).join(' ');
    return { polyline, data: dataPoints };
  }

  // Base times
  const recentPeriodBase = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);
  const previousPeriodBase = new Date(new Date().getTime() - 48 * 60 * 60 * 1000);

  const todayData = computePointsAndData(todayIntervals, recentPeriodBase);
  const yesterdayData = computePointsAndData(yesterdayIntervals, previousPeriodBase);

  // y ref line for max
  const yRef = svgHeight - padding - (((useLogScale ? Math.log(overallMaxCost + offset) : overallMaxCost) / (useLogScale ? overallMaxScaled : (overallMaxCost || 1))) * (svgHeight - 2 * padding));

  const [hoveredPoint, setHoveredPoint] = useState<DataPoint | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * viewBoxWidth;
    if (todayData.data.length === 0) return;
    let nearest = todayData.data[0];
    let minDist = Math.abs(nearest.x - mouseX);
    todayData.data.forEach(pt => {
      const dist = Math.abs(pt.x - mouseX);
      if (dist < minDist) {
        minDist = dist;
        nearest = pt;
      }
    });
    setHoveredPoint(nearest);
  };
  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  return (
    <Box mt={2}>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
        Last 48 Hours
      </Typography>
      <Box position="relative" sx={{ border: '1px solid #ccc', borderRadius: 1, p: 1, maxWidth: '100%', overflow: 'auto' }}>
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${viewBoxWidth} ${svgHeight}`}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          aria-label="48-hour cost trend"
        >
          {yesterdayIntervals.length > 0 && (
            <polyline fill="none" stroke="#888888" strokeWidth="2" points={yesterdayData.polyline} />
          )}
          {todayIntervals.length > 0 && (
            <polyline fill="none" stroke="#1976d2" strokeWidth="2" points={todayData.polyline} />
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
          <text
            x={padding + 2}
            y={yRef - 2}
            fill="#ff0000"
            fontSize="10"
          >
            Max: {formatCurrency(overallMaxCost)}
          </text>
          {hoveredPoint && (
            <>
              <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="3" fill="#000" stroke="#fff" strokeWidth="1" />
              <text x={hoveredPoint.x + 5} y={hoveredPoint.y - 5} fill="#000" fontSize="10" style={{ pointerEvents: 'none' }}>
                {new Date(hoveredPoint.date + '+10:00').toLocaleTimeString('en-AU', {
                  timeZone: 'Australia/Brisbane',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
                {": "}
                {formatCurrency(hoveredPoint.cost)}
              </text>
            </>
          )}
        </svg>
        <Typography variant="caption" display="block" textAlign="center" mt={1}>
          (Mon 11:00 to Wed 11:00 example range)
        </Typography>
      </Box>
    </Box>
  );
};

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
 * About Page - separate component.
 */
interface AboutPageProps {
  // We still keep it, though the new design just references a link at the bottom.
}
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
    <Box display="flex" flexDirection="column" minHeight="100vh" p={2}>
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
        For more details, visit our{" "}
        <Link href="https://github.com/troykelly/costs-how-much" target="_blank" rel="noopener noreferrer">
          GitHub repository
        </Link>.
      </Typography>
    </Box>
  );
}

/**
 * Main App - modernised layout.
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

  // Region is from path
  const pathParts = window.location.pathname.split('/');
  const regionKey = pathParts[1]?.toLowerCase() || 'nsw';

  // If about page
  if (regionKey === 'about') {
    return <AboutPage />;
  }

  // If no scenario, redirect to default scenario
  const scenarioKeyStr = getScenarioKey().trim();
  if (!scenarioKeyStr) {
    window.location.href = '/nsw?s=toast';
    return null;
  }

  // If scenario not found, show 404
  const scenarioData = EnergyScenarios.getScenarioById(scenarioKeyStr);
  if (!scenarioData) {
    return <ScenarioNotFound scenarioKey={scenarioKeyStr} />;
  }

  // Map region to AEMO region
  const regionMapping: Record<string, string> = {
    nsw: 'NSW1',
    qld: 'QLD1',
    sa: 'SA1',
    tas: 'TAS1',
    vic: 'VIC1'
  };
  const regionFilter = regionMapping[regionKey] ?? 'NSW1';

  // Setup meta tags for scenario
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

  /**
   * AEMO data fetch
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
  };

  useEffect(() => {
    fetchAemoData();
    const intervalId = setInterval(fetchAemoData, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [regionFilter, scenarioKeyStr]);

  // For last 24/24 intervals
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

  // Compute daily summaries to maintain existing functionality
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

  // Compute lowest/highest scenario cost across regionIntervals
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

  // For the "other region references"
  const otherRegions = Object.keys(regionMapping).filter(r => r !== regionKey);

  // Render
  return (
    <Box display="flex" flexDirection="column" minHeight="100vh" bgcolor="#fafafa">
      {/* Header */}
      <Box
        sx={{
          backgroundColor: '#EEE',
          padding: 2,
          textAlign: 'center',
          borderBottom: '1px solid #CCC'
        }}
      >
        <Typography variant="h5" sx={{ display: 'inline-flex', alignItems: 'center', fontWeight: 'bold' }}>
          <ElectricBoltIcon fontSize="large" sx={{ marginRight: 1 }} />
          Power Costs This Much!
        </Typography>
      </Box>

      {/* Quick Region Info Table (like ASCII mockup) */}
      <Box sx={{ p: 2, borderBottom: '1px solid #CCC' }}>
        <Grid container spacing={2}>
          {/* Left side region & map placeholder */}
          <Grid item xs={12} md={2}>
            <Box
              sx={{
                border: '1px solid #CCC',
                minHeight: 100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Typography variant="subtitle2">MAP IMAGE<br />({regionKey.toUpperCase()})</Typography>
            </Box>
          </Grid>
          {/* Right side info */}
          <Grid item xs={12} md={10}>
            <Grid container>
              <Grid item xs={6} sm={3}>
                <Typography variant="subtitle2">Current Wholesale</Typography>
                <Typography variant="body2">
                  {loading ? <CircularProgress size="1rem" /> : `${(rrpCentsPerKWh / 100).toFixed(3)} $/kWh`}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Typography variant="subtitle2">Current Retail</Typography>
                <Typography variant="body2">
                  {loading ? <CircularProgress size="1rem" /> : `${(finalRateCents / 100).toFixed(3)} $/kWh`}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Typography variant="subtitle2">Cheapest Rate</Typography>
                <Typography variant="body2">
                  {lowestScenario.cost > 0 ? formatCurrency(lowestScenario.cost) : '$0.00'}
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3}>
                <Typography variant="subtitle2">Most Expensive</Typography>
                <Typography variant="body2">
                  {highestScenario.cost > 0 ? formatCurrency(highestScenario.cost) : '$0.00'}
                </Typography>
              </Grid>
            </Grid>
            <Typography variant="caption" display="block" sx={{ mt: 1 }}>
              {usedIntervalDate
                ? `Timestamp: ${formatIntervalDate(usedIntervalDate)}`
                : 'No interval data'}
            </Typography>
          </Grid>
        </Grid>
        <Box mt={1}>
          <Tooltip title="Refresh Data">
            <IconButton onClick={fetchAemoData}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Main Content Area */}
      <Box sx={{ p: 2, flexGrow: 1 }}>
        {error && (
          <Alert severity="error" action={<Button color="inherit" size="small" onClick={fetchAemoData}>Retry</Button>}>
            {error}
          </Alert>
        )}

        {/* Big cost in the center - "A piece of toast currently costs" style */}
        <Box textAlign="center" mt={2}>
          <Typography variant="h6" gutterBottom>
            A {scenarioData.name.toLowerCase()} currently costs
          </Typography>
          {loading ? (
            <Box display="inline-flex" flexDirection="column" alignItems="center" mt={2}>
              <CircularProgress />
              <Typography variant="body2" mt={1}>Loading…</Typography>
            </Box>
          ) : (
            <Typography variant="h2" sx={{ fontWeight: 'bold', lineHeight: 1 }}>
              {formatCurrency(toastCostDollars)}
            </Typography>
          )}
          <Typography variant="body2" mt={1}>
            {usedIntervalDate ? `@ ${formatIntervalDate(usedIntervalDate)}` : ''}
          </Typography>
        </Box>

        {/* CHEAPEST / MOST EXPENSIVE boxes */}
        <Box mt={3} display="flex" justifyContent="center" flexWrap="wrap" gap={2}>
          <Card sx={{ width: 140, textAlign: 'center' }}>
            <CardContent>
              <Typography variant="subtitle2">CHEAPEST</Typography>
              <Typography variant="h6">
                {lowestScenario.cost > 0 ? formatCurrency(lowestScenario.cost) : '$0.00'}
              </Typography>
              <Typography variant="body2">
                {lowestScenario.timestamp ? formatIntervalDate(lowestScenario.timestamp) : null}
              </Typography>
            </CardContent>
          </Card>
          <Card sx={{ width: 140, textAlign: 'center' }}>
            <CardContent>
              <Typography variant="subtitle2">EXPENSIVE</Typography>
              <Typography variant="h6">
                {highestScenario.cost > 0 ? formatCurrency(highestScenario.cost) : '$0.00'}
              </Typography>
              <Typography variant="body2">
                {highestScenario.timestamp ? formatIntervalDate(highestScenario.timestamp) : null}
              </Typography>
            </CardContent>
          </Card>
        </Box>

        {/* Other Regions row */}
        <Box mt={3}>
          <Typography variant="subtitle1" gutterBottom>
            Other Regions
          </Typography>
          <Grid container spacing={2} sx={{ maxWidth: 480 }}>
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
              // find min & max among references + our cost 
              const allCosts = [toastCostDollars, ...references.map(x => x.cost)];
              const minVal = Math.min(...allCosts);
              const maxVal = Math.max(...allCosts);

              return references.map(item => {
                const cost = item.cost;
                let tag: ReactNode = null;
                if (cost === minVal && minVal === maxVal) {
                  tag = <Chip label="Cheapest & Most Exp" icon={<StarIcon />} color="warning" size="small" sx={{ mt: 1 }} />;
                } else if (cost === minVal) {
                  tag = <Chip label="CHEAP" icon={<StarIcon />} color="success" size="small" sx={{ mt: 1 }} />;
                } else if (cost === maxVal) {
                  tag = <Chip label="EXP" icon={<WarningIcon />} color="error" size="small" sx={{ mt: 1 }} />;
                }
                return (
                  <Grid item xs={6} sm={3} key={item.region}>
                    <Card
                      sx={{ cursor: 'pointer' }}
                      onClick={() => handleRegionClick(item.region.toLowerCase())}
                    >
                      <CardContent sx={{ textAlign: 'center' }}>
                        <Typography variant="body1" sx={{ fontWeight: 'bold' }}>{item.region}</Typography>
                        <Typography variant="body2">{formatCurrency(item.cost)}</Typography>
                        {tag}
                      </CardContent>
                    </Card>
                  </Grid>
                );
              });
            })()}
          </Grid>
        </Box>

        {/* Scenario Dropdown */}
        <Box mt={3} sx={{ maxWidth: 480 }}>
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

        {/* Assumptions */}
        {scenarioData.assumptions && scenarioData.assumptions.length > 0 && (
          <Box mt={3} sx={{ maxWidth: 480 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                  Assumptions
                </Typography>
                <ul>
                  {scenarioData.assumptions.map((ass, idx) => (
                    <li key={idx}>
                      <Typography variant="body2">{ass}</Typography>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </Box>
        )}

        {/* Last 48 hours chart */}
        {!loading && regionIntervals.length > 0 && (
          <SparklineChart
            todayIntervals={recent24Intervals}
            yesterdayIntervals={previous24Intervals}
            region={regionKey as SupportedRegion}
            scenarioKey={scenarioKeyStr}
          />
        )}

        {/* Collapsible daily summary to preserve existing functionality */}
        <Box mt={3} sx={{ maxWidth: 480 }}>
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                Daily Summaries
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              {dailySummaries.length === 0 ? (
                <Typography variant="body2">No daily summary data available.</Typography>
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
            </AccordionDetails>
          </Accordion>
        </Box>
      </Box>

      {/* Footer */}
      <Box
        component="footer"
        sx={{
          borderTop: '1px solid #CCC',
          p: 2,
          textAlign: 'center',
          mt: 'auto'
        }}
      >
        <Typography variant="body2">
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
        <Typography variant="caption" display="block">
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
                position => {
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
                    alert('It appears your location is not in a supported region. Defaulting to NSW.');
                    handleRegionClick('nsw');
                  }
                },
                () => {
                  alert('Unable to retrieve your location. Please check permissions.');
                }
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