//******************************************************************************
// * @fileoverview App.tsx - A simple React application that retrieves the current AEMO
// * network price for a selected region and computes an approximate cost for a chosen
// * energy scenario (toast, EV charge, phone charge, etc.).
// *
// * Uses MUI for a basic design and iconography. Polls the AEMO "5MIN" endpoint
// * every five minutes to retrieve the latest wholesale cost.
// *
// * Automatically determines region (NSW, QLD, SA, TAS, VIC) based on the path:
// *   hostname/nsw, hostname/qld, hostname/sa, hostname/tas, hostname/vic.
// * When requesting the root of the site, automatically redirects to /nsw.
// *
// * Also determines the scenario via:
// *   1) Subdomain (e.g., "toast.coststhismuch.au" => toast), or
// *   2) Query string (e.g., "?s=toast"), falling back to default scenario "toast" if not provided.
// *
// * Voluntary Location Feature:
// *   A "My Location" link is included in the footer that allows the user to share their
// *   geolocation. This is only done if the user explicitly opts in via a popup div.
// *   Once approved, the app attempts to find what state they are in by referencing
// *   au-states.json. If outside the supported states (NSW, QLD, SA, TAS, VIC),
// *   the user is informed and directed to NSW by default.
// *   Their location preference is stored in localStorage to avoid repeat prompts.
// *
// * Author: Troy Kelly <troy@troykelly.com>
// * Original Date: 16 March 2025
// ******************************************************************************
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
  DialogActions
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

import {
  AemoInterval,
  getRetailRateFromInterval,
  SupportedRegion
} from './pricingCalculator';
import { EnergyScenarios } from './energyScenarios';

// Importing AU states GeoJSON
import statesData from '../data/au-states.json';

// Import react-calendar and its styles
import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';

/**
 * Formats a date string (ISO8601) into a more readable local string,
 * assuming NEM time (Australia/Brisbane) without daylight savings.
 *
 * @param {string} dateString The ISO8601 date/time string (e.g., "2025-03-16T14:20:00")
 * @return {string} A more user-friendly date/time format (day, month, year, HH:mm:ss)
 */
function formatIntervalDate(dateString: string): string {
  if (!dateString) return '';
  // Force parse this AEMO timestamp as if it has an implicit '+10:00' offset
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
 * Formats a given interval’s start time into a time range.
 * Since each AEMO interval is 5 minutes long, returns "HH:MM -> HH:MM".
 *
 * @param {string} dateString The ISO8601 settlement date/time string.
 * @return {string} The time range as "start -> end" formatted in 24hr clock.
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
 * Retrieves a scenario ID by checking subdomain first, then query string 's',
 * returning the scenario ID string if found, or empty if not present.
 *
 * @return {string} A string that might map to a valid scenario in energyScenarios.
 */
function getScenarioKey(): string {
  const hostParts = window.location.hostname.split('.');
  if (hostParts.length > 2) {
    // e.g. subdomain.example.com => subdomain is hostParts[0]
    const subdomain = hostParts[0].toLowerCase();
    if (subdomain) {
      return subdomain;
    }
  }

  // Check query param 's'
  const params = new URLSearchParams(window.location.search);
  const paramScenario = params.get('s');
  if (paramScenario) {
    return paramScenario.toLowerCase();
  }

  // Return an empty string if not set
  return '';
}

/**
 * Given an icon name, map to a MUI icon component.
 * Returns a help icon if not recognised.
 *
 * @param {string | undefined} iconName Possibly undefined or the iconName from scenario
 * @return {JSX.Element} An icon element for display
 */
function getScenarioIcon(iconName?: string): JSX.Element {
  switch ((iconName || '').toLowerCase()) {
    case 'breakfastdining':
      return <BreakfastDiningIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'shower':
      return <ShowerIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'localcafe':
      return <LocalCafeIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'microwave':
      return <MicrowaveIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'lightbulb':
      return <LightbulbIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'smartphone':
      return <SmartphoneIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'laptop':
      return <LaptopIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'locallaundryservice':
      return <LocalLaundryServiceIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'localdining':
      return <LocalDiningIcon fontSize="large" style={{ marginRight: 8 }} />;
    case 'electriccar':
      return <ElectricCarIcon fontSize="large" style={{ marginRight: 8 }} />;
    default:
      return <HelpOutlineIcon fontSize="large" style={{ marginRight: 8 }} />;
  }
}

/**
 * A simple React functional component displayed when the requested scenario
 * is not found in energyScenarios.
 *
 * @param {object} props
 * @param {string} props.scenarioKey - The scenario requested that was not found.
 * @return {JSX.Element} A 404 message displayed to the user.
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
        The requested scenario &quot;{scenarioKey}&quot; does not exist.
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
 * Sets or creates a meta tag in the document head for dynamic metadata.
 *
 * @param {string} attrName The name of the meta attribute (e.g., "property", "name").
 * @param {string} attrValue The value for the attribute (e.g., "og:title", "DC.title").
 * @param {string} content The meta content to apply.
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
 * Checks whether a point (lat, lon) is inside a polygon using the ray-casting algorithm.
 *
 * @param {number[][]} polygon - Array of [longitude, latitude] pairs describing the polygon.
 * @param {number} lat - The latitude to test.
 * @param {number} lon - The longitude to test.
 * @return {boolean} True if inside, false otherwise.
 */
function isPointInPolygon(polygon: number[][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1], yi = polygon[i][0];
    const xj = polygon[j][1], yj = polygon[j][0];
    const intersect = ((yi > lon) !== (yj > lon))
      && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Determines which AU state name the given lat, lon belongs to, if any.
 * Returns the string from "STATE_NAME" or null if none found.
 *
 * @param {number} lat - The latitude of the point.
 * @param {number} lon - The longitude of the point.
 * @return {string | null} The state name, or null if not found.
 */
function getStateNameForLatLon(lat: number, lon: number): string | null {
  // GeoJSON typically is in [lon, lat], so we use that order carefully
  for (const feature of statesData.features) {
    const geometry = feature.geometry;
    if (geometry.type === 'Polygon') {
      const coords = geometry.coordinates;
      if (isPointInRingArray(coords, lat, lon)) {
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
 * Checks if a point is inside any ring of a polygon or multipolygon structure.
 * @param {number[][][]} ringArray - An array of rings (each ring is array of [lon, lat]).
 * @param {number} lat - The latitude to check.
 * @param {number} lon - The longitude to check.
 * @return {boolean} True if the point is inside, otherwise false.
 */
function isPointInRingArray(ringArray: number[][][], lat: number, lon: number): boolean {
  if (ringArray.length === 0) return false;
  const outerRing = ringArray[0];
  return isPointInPolygon(outerRing, lat, lon);
}

/**
 * Maps a known state name to one of the supported region keys (nsw, qld, sa, tas, vic).
 * If not mapped, returns null.
 *
 * @param {string} stateName The full state name from the GeoJSON.
 * @return {string | null} The short region name or null.
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

const App: React.FC = () => {
  const [loading, setLoading] = useState<boolean>(true);
  const [rrpCentsPerKWh, setRrpCentsPerKWh] = useState<number>(0);
  const [finalRateCents, setFinalRateCents] = useState<number>(0);
  const [toastCostDollars, setToastCostDollars] = useState<number>(0);
  const [usedIntervalDate, setUsedIntervalDate] = useState<string>('');
  // Store all intervals for the current region from the API (all data, not just last 24 hours)
  const [regionIntervals, setRegionIntervals] = useState<AemoInterval[]>([]);
  // Store all intervals for all regions, used for reference table (now grid)
  const [allIntervals, setAllIntervals] = useState<AemoInterval[]>([]);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [locationDialogOpen, setLocationDialogOpen] = useState<boolean>(false);

  /**
   * Toggles the navigation drawer open or closed.
   *
   * @param {boolean} open Whether the drawer should be open or closed.
   * @return {() => void} A function that sets the drawer state when executed.
   */
  const toggleDrawer = (open: boolean) => (): void => {
    setDrawerOpen(open);
  };

  // Determine which region is requested from the path, default to 'nsw'
  const pathParts = window.location.pathname.split('/');
  const regionKey = pathParts[1]?.toLowerCase() || 'nsw';

  // If the user navigates to /about, display the "About" page
  if (regionKey === 'about') {
    return <AboutPage drawerOpen={drawerOpen} toggleDrawer={toggleDrawer} />;
  }

  // Mapping from path-based region to AEMO region code
  const regionMapping: Record<string, string> = {
    nsw: 'NSW1',
    qld: 'QLD1',
    sa: 'SA1',
    tas: 'TAS1',
    vic: 'VIC1'
  };

  /**
   * Redirects to the given scenario, handling local/dev vs. production subdomain logic.
   *
   * @param {string} newScenario The scenario ID to switch to.
   */
  const handleScenarioChange = (newScenario: string): void => {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const isLocalDev =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.includes('192.168.');
    const regionPath = regionKey;
    let finalUrl = '';

    if (isLocalDev) {
      finalUrl =
        protocol + '//' + hostname + (port ? ':' + port : '') + '/' + regionPath + '?s=' + newScenario;
    } else {
      const domainParts = hostname.split('.');
      if (domainParts.length <= 1) {
        finalUrl =
          protocol + '//' + hostname + (port ? ':' + port : '') + '/' + regionPath + '?s=' + newScenario;
      } else {
        if (domainParts.length > 2) {
          domainParts.shift();
        }
        const baseDomain = domainParts.join('.');
        const newHost = newScenario + '.' + baseDomain;
        finalUrl =
          protocol + '//' + newHost + (port ? ':' + port : '') + '/' + regionPath;
      }
    }
    window.location.href = finalUrl;
  };

  /**
   * Redirects to a new region (same scenario) using local/dev or production logic.
   *
   * @param {string} newRegion The new region (e.g., 'nsw', 'vic') to switch to.
   */
  const handleRegionClick = (newRegion: string): void => {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const isLocalDev =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.includes('192.168.');

    const scenario = getScenarioKey();
    let finalUrl = '';

    if (isLocalDev) {
      finalUrl =
        protocol + '//' + hostname + (port ? ':' + port : '') + '/' + newRegion + '?s=' + scenario;
    } else {
      const domainParts = hostname.split('.');
      if (domainParts.length <= 1) {
        finalUrl =
          protocol + '//' + hostname + (port ? ':' + port : '') + '/' + newRegion + '?s=' + scenario;
      } else {
        if (domainParts.length > 2) {
          domainParts.shift();
        }
        const baseDomain = domainParts.join('.');
        const newHost = scenario + '.' + baseDomain;
        finalUrl =
          protocol + '//' + newHost + (port ? ':' + port : '') + '/' + newRegion;
      }
    }
    window.location.href = finalUrl;
  };

  // Validate region => fallback to NSW if not recognised
  const regionFilter = regionMapping[regionKey] ?? 'NSW1';

  // Scenario from subdomain or query param
  const scenarioKey = getScenarioKey().trim();

  // Redirect to default scenario if scenario not provided.
  if (!scenarioKey) {
    handleScenarioChange('toast');
    return null;
  }

  const scenarioData = EnergyScenarios.getScenarioById(scenarioKey);

  // Show 404 if scenario not found.
  if (!scenarioData) {
    return <ScenarioNotFound scenarioKey={scenarioKey} />;
  }

  /**
   * Fetches the current 5-minute AEMO data, filters for the selected region,
   * and updates state.
   */
  const fetchAemoData = async (): Promise<void> => {
    try {
      setLoading(true);
      const response = await fetch('https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ timeScale: ['5MIN'] })
      });
      if (!response.ok) {
        throw new Error(`Network response was not OK. Status: ${response.status}`);
      }
      const data: { '5MIN': AemoInterval[] } = await response.json();

      // Store all intervals for reference and region filtering.
      setAllIntervals(data['5MIN']);

      const regionData: AemoInterval[] = data['5MIN'].filter(
        (interval) => interval.REGIONID === regionFilter
      );

      regionData.sort(
        (a, b) =>
          new Date(a.SETTLEMENTDATE).getTime() -
          new Date(b.SETTLEMENTDATE).getTime()
      );

      if (regionData.length > 0) {
        const latest = regionData[regionData.length - 1];
        let wholesaleCents = latest.RRP * 0.1;
        if (wholesaleCents < 0) {
          wholesaleCents = 0;
        }
        setRrpCentsPerKWh(wholesaleCents);

        const computedRate = getRetailRateFromInterval(
          {
            SETTLEMENTDATE: latest.SETTLEMENTDATE,
            REGIONID: latest.REGIONID,
            RRP: latest.RRP
          },
          regionKey as SupportedRegion,
          false,
          true
        );
        setFinalRateCents(computedRate);

        const scenarioCost = EnergyScenarios.getCostForScenario(scenarioKey, computedRate);
        setToastCostDollars(scenarioCost);

        setUsedIntervalDate(latest.SETTLEMENTDATE);
      } else {
        setRrpCentsPerKWh(0);
        setFinalRateCents(0);
        setToastCostDollars(0);
      }

      // Instead of restricting to the last 24 hours, we now store all available intervals
      setRegionIntervals(regionData);
    } catch (err) {
      setRrpCentsPerKWh(0);
      setFinalRateCents(0);
      setToastCostDollars(0);
    } finally {
      setLoading(false);
    }
  };

  /**
   * On mount, fetch data immediately and then every 5 minutes.
   */
  useEffect(() => {
    fetchAemoData();
    const intervalId = setInterval(fetchAemoData, 5 * 60 * 1000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Instead of last 24 hours, use all intervals for current region
  const intervalsToConsider = regionIntervals;

  let cheapestCost: number | null = null;
  let cheapestInterval: AemoInterval | null = null;
  let expensiveCost: number | null = null;
  let expensiveInterval: AemoInterval | null = null;

  for (const interval of intervalsToConsider) {
    const intervalRate = getRetailRateFromInterval(
      interval,
      regionKey as SupportedRegion,
      false,
      true
    );
    const intervalScenarioCost = EnergyScenarios.getCostForScenario(scenarioKey, intervalRate);

    if (cheapestCost === null || intervalScenarioCost < cheapestCost) {
      cheapestCost = intervalScenarioCost;
      cheapestInterval = interval;
    }
    if (expensiveCost === null || intervalScenarioCost > expensiveCost) {
      expensiveCost = intervalScenarioCost;
      expensiveInterval = interval;
    }
  }

  // Precompute wholesale & retail rates for tooltips (if data available)
  let cheapestWholesaleCents = 0;
  let cheapestIntervalRate = 0;
  if (cheapestInterval) {
    let rawCents = cheapestInterval.RRP * 0.1;
    if (rawCents < 0) rawCents = 0;
    cheapestWholesaleCents = rawCents;
    cheapestIntervalRate = getRetailRateFromInterval(
      cheapestInterval,
      regionKey as SupportedRegion,
      false,
      true
    );
  }

  let expensiveWholesaleCents = 0;
  let expensiveIntervalRate = 0;
  if (expensiveInterval) {
    let rawCents = expensiveInterval.RRP * 0.1;
    if (rawCents < 0) rawCents = 0;
    expensiveWholesaleCents = rawCents;
    expensiveIntervalRate = getRetailRateFromInterval(
      expensiveInterval,
      regionKey as SupportedRegion,
      false,
      true
    );
  }

  // Scenario icon & text
  const scenarioIconElement = getScenarioIcon(scenarioData?.iconName);
  const scenarioName = scenarioData.name;
  const scenarioDescription = scenarioData.description;

  // Dynamically set Dublin Core & OpenGraph metadata for the current scenario
  useEffect(() => {
    if (!scenarioData) return;
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

  /**
   * Prepares reference costs for other regions.
   *
   * @return {Array} An array of objects, each containing the region name,
   * wholesale cents/kWh, scenario cost, and the relevant interval date.
   */
  function getReferenceCosts(): {
    region: string;
    wholesaleCents: number;
    scenarioCost: number;
    date: string;
  }[] {
    const otherRegions = Object.keys(regionMapping).filter((r) => r !== regionKey);
    const results: {
      region: string;
      wholesaleCents: number;
      scenarioCost: number;
      date: string;
    }[] = [];

    for (const r of otherRegions) {
      const filterKey = regionMapping[r];
      const intervalsForR = allIntervals.filter((int) => int.REGIONID === filterKey);
      intervalsForR.sort(
        (a, b) =>
          new Date(a.SETTLEMENTDATE).getTime() -
          new Date(b.SETTLEMENTDATE).getTime()
      );
      if (intervalsForR.length > 0) {
        const latest = intervalsForR[intervalsForR.length - 1];
        let wholesale = latest.RRP * 0.1;
        if (wholesale < 0) {
          wholesale = 0;
        }
        const finalRate = getRetailRateFromInterval(latest, r as SupportedRegion, false, true);
        const cost = EnergyScenarios.getCostForScenario(scenarioKey, finalRate);
        results.push({
          region: r.toUpperCase(),
          wholesaleCents: wholesale,
          scenarioCost: cost,
          date: latest.SETTLEMENTDATE
        });
      } else {
        results.push({
          region: r.toUpperCase(),
          wholesaleCents: 0,
          scenarioCost: 0,
          date: ''
        });
      }
    }
    return results;
  }

  const referenceCosts = getReferenceCosts();

  // Combine the current region's cost plus reference region costs.
  const allRegionCosts = [
    {
      region: regionKey.toUpperCase(),
      scenarioCost: toastCostDollars
    },
    ...referenceCosts
  ];

  const lowestCost = Math.min(...allRegionCosts.map((r) => r.scenarioCost));
  const highestCost = Math.max(...allRegionCosts.map((r) => r.scenarioCost));

  // Determine if current region is cheapest or most expensive.
  let currentRegionTag: ReactNode = null;
  if (toastCostDollars === lowestCost && toastCostDollars === highestCost) {
    currentRegionTag = (
      <Chip
        label="Cheapest & Most Expensive"
        icon={<StarIcon />}
        color="warning"
        sx={{ ml: 1 }}
      />
    );
  } else if (toastCostDollars === lowestCost) {
    currentRegionTag = (
      <Chip
        label="Cheapest"
        icon={<StarIcon />}
        color="success"
        sx={{ ml: 1 }}
      />
    );
  } else if (toastCostDollars === highestCost) {
    currentRegionTag = (
      <Chip
        label="Most Expensive"
        icon={<WarningIcon />}
        color="error"
        sx={{ ml: 1 }}
      />
    );
  }

  /**
   * Handle "My Location" link click: open the confirmation dialog.
   */
  const handleMyLocationClick = (): void => {
    setLocationDialogOpen(true);
  };

  /**
   * Called if user denies location sharing in the popup.
   */
  const handleDenyLocation = (): void => {
    setLocationDialogOpen(false);
  };

  /**
   * Called if user allows location sharing in the popup. Requests geolocation,
   * then maps the coordinates to a state/region.
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
      (error) => {
        alert('Unable to retrieve your location. Please check permissions.');
      }
    );
  };

  return (
    <Box display="flex" flexDirection="column" minHeight="100vh">
      <AppBar position="static" sx={{ marginBottom: 2 }}>
        <Toolbar>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="menu"
            onClick={toggleDrawer(true)}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Cost to {regionKey.toUpperCase()}
          </Typography>
        </Toolbar>
      </AppBar>

      <Drawer anchor="left" open={drawerOpen} onClose={toggleDrawer(false)}>
        <Box
          sx={{ width: 250 }}
          role="presentation"
          onClick={toggleDrawer(false)}
          onKeyDown={toggleDrawer(false)}
        >
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
                <ListItemIcon>
                  {getScenarioIcon(item.iconName)}
                </ListItemIcon>
                <ListItemText primary={item.name} />
              </ListItem>
            ))}
          </List>
        </Box>
      </Drawer>

      <Box
        component="main"
        flexGrow={1}
        display="flex"
        justifyContent="center"
        alignItems="flex-start"
        bgcolor="#fafafa"
      >
        <Box sx={{ marginBottom: 4 }}>
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
                  <MenuItem key={scn.id} value={scn.id}>
                    {scn.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          <Card sx={{ maxWidth: 480, width: '100%' }}>
            <CardHeader
              avatar={scenarioIconElement}
              title={`Cost for ${scenarioName}`}
            />
            <CardContent>
              {loading ? (
                <Box display="flex" justifyContent="center" mt={2}>
                  <CircularProgress />
                </Box>
              ) : (
                <>
                  <Box
                    display="flex"
                    flexDirection="column"
                    justifyContent="center"
                    alignItems="center"
                    mb={3}
                  >
                    <Box display="flex" alignItems="center" mb={1}>
                      <MonetizationOnIcon fontSize="large" sx={{ marginRight: 1 }} />
                      <Typography variant="h4" color="secondary">
                        {'$' + toastCostDollars.toFixed(6)}
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
                      <IconButton size="small">
                        <InfoIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Typography>
                  <Typography variant="body1" gutterBottom>
                    {'Final Price (incl. GST): ' + finalRateCents.toFixed(3)} c/kWh{' '}
                    <Tooltip title="This is the approximate retail rate, including wholesale, network, environment, overheads, margin, and GST.">
                      <IconButton size="small">
                        <InfoIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Typography>

                  {scenarioDescription && (
                    <Typography variant="body2" sx={{ marginTop: 2 }}>
                      {scenarioDescription}
                    </Typography>
                  )}
                  {scenarioData.assumptions && scenarioData.assumptions.length > 0 && (
                    <Box mt={2}>
                      <Typography variant="subtitle1">Assumptions:</Typography>
                      <ul>
                        {scenarioData.assumptions.map((assumption, index) => (
                          <li key={index}>
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
                Interval used for calculation: {formatIntervalDate(usedIntervalDate)}
                <Tooltip title="Note that AEMO operates on National Electricity Market (NEM) time, which does not align with daylight saving in some states.">
                  <IconButton size="small">
                    <InfoIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Typography>
            </CardActions>
          </Card>

          <Box
            display="flex"
            flexDirection="row"
            justifyContent="space-between"
            sx={{ maxWidth: 480, width: '100%', marginTop: 2 }}
          >
            <Card sx={{ width: '48%' }}>
              <CardHeader title="Cheapest" />
              <CardContent>
                {cheapestCost !== null && cheapestInterval ? (
                  <Tooltip
                    arrow
                    title={
                      `Wholesale: ${cheapestWholesaleCents.toFixed(3)} c/kWh\n` +
                      `Retail: ${cheapestIntervalRate.toFixed(3)} c/kWh`
                    }
                  >
                    <Box>
                      <Typography variant="h4" color="secondary">
                        {'$' + cheapestCost.toFixed(6)}
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
                  <Tooltip
                    arrow
                    title={
                      `Wholesale: ${expensiveWholesaleCents.toFixed(3)} c/kWh\n` +
                      `Retail: ${expensiveIntervalRate.toFixed(3)} c/kWh`
                    }
                  >
                    <Box>
                      <Typography variant="h4" color="secondary">
                        {'$' + expensiveCost.toFixed(6)}
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
          <Button variant="outlined" onClick={handleMyLocationClick}>My Location</Button>
        </Box>
      </Box>

      <Dialog open={locationDialogOpen} onClose={handleDenyLocation}>
        <DialogTitle>Location Data Request</DialogTitle>
        <DialogContent>
          <Typography variant="body1">
            We are about to request your location data. This is entirely voluntary and
            will only be used to help present regional pricing information based on your position.
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
 * AboutPage component - explains the purpose of the site in detail.
 *
 * @param {object} props
 * @param {boolean} props.drawerOpen - If the drawer is currently open.
 * @param {(open: boolean) => () => void} props.toggleDrawer - Function to toggle drawer.
 * @return {JSX.Element} The about page layout
 */
function AboutPage(props: {drawerOpen: boolean; toggleDrawer: (open: boolean) => () => void;}): JSX.Element {
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
          <IconButton
            edge="start"
            color="inherit"
            aria-label="menu"
            onClick={toggleDrawer(true)}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            About
          </Typography>
        </Toolbar>
      </AppBar>

      <Drawer anchor="left" open={drawerOpen} onClose={toggleDrawer(false)}>
        <Box
          sx={{ width: 250 }}
          role="presentation"
          onClick={toggleDrawer(false)}
          onKeyDown={toggleDrawer(false)}
        >
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
          every five minutes. By presenting near real-time estimates of how much it might
          cost to complete everyday tasks (such as toasting bread or charging a phone),
          we hope to demystify how shifts in wholesale prices, network fees,
          environmental charges, and retail margins come together to impact what you pay.
        </Typography>
        <Typography variant="body1" paragraph>
          We have used a variety of assumptions for each scenario: wattage, duration, and
          average consumption are approximate and will not exactly match individual usage.
          Everyone's circumstances differ based on device power ratings, usage habits,
          network region, and retail contracts, so the examples shown here are purely
          for general reference and educational discussion.
        </Typography>
        <Typography variant="body1" paragraph>
          Importantly, this site should not be used as a precise calculator for your
          electricity bill. It is for demonstration only, illustrating how small tasks
          can accumulate in cost depending on a range of market and regulatory factors.
          Actual costs may differ significantly from these estimates. Seek professional
          advice or consult your own retailer’s pricing documents for detailed figures.
        </Typography>
        <Typography variant="body1" paragraph>
          AEMO pricing represents the wholesale cost of electricity at a given time,
          expressed in $/MWh. We floor negative values to zero for convenience, noting
          that some specialised pass-through or feed-in tariffs might treat negative or
          high spot prices differently. We add typical network charges, environment and
          certificate costs, overheads, and margin to arrive at an indicative retail rate.
        </Typography>
        <Typography variant="body1" paragraph>
          Note that AEMO operates on National Electricity Market (NEM) time. This does
          not adjust for daylight saving in some Australian states, meaning the timestamps
          may not match local clocks in summer. All intervals here are tagged with their
          settlement time in NEM time.
        </Typography>
        <Typography variant="body1" paragraph>
          This project was created by Troy Kelly to highlight how dynamic wholesale pricing
          can influence everyday costs. It is licensed under CC0 1.0 Universal, meaning it is
          free for anyone to use or adapt without restriction. The source code for the project
          is available at:
          <Link href="https://github.com/troykelly/costs-this-much" target="_blank" rel="noopener noreferrer">
            {' '} https://github.com/troykelly/costs-this-much
          </Link>
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

export default App;