/**
 * @fileoverview pricingCalculator.ts - A TypeScript library to compute the current
 * retail electricity rate (in cents/kWh) for Australian NEM regions based on:
 *   - The latest 5-minute AEMO wholesale data (RRP in $/MWh).
 *   - Region-based time-of-use (TOU) periods (peak, shoulder, off-peak), including
 *     any simple seasonal or daily definitions.
 *   - Negative wholesale prices treated as zero.
 *   - Approximate network and environmental charges for peak/shoulder/off-peak.
 *   - Retail overheads and margin.
 *   - Optional handling for business vs residential load, noting that demand-based
 *     tariffs are not fully addressed here.
 *
 * The aim is to provide a flexible calculation engine: pass the current
 * AEMO interval data (for a single 5-min period), a region, and get back
 * an approximate retail rate in cents per kWh (either ex-GST or inc-GST).
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Created: 16 March 2025
 *
 * Usage Example:
 *   import { AemoInterval, getRetailRateFromInterval } from './pricingCalculator';
 *
 *   async function exampleUsage() {
 *     // Suppose we have fetched the latest AEMO interval for NSW
 *     const interval: AemoInterval = {
 *       SETTLEMENTDATE: '2025-03-16T14:05:00',
 *       REGIONID: 'NSW1',
 *       RRP: -2.50,  // negative price
 *       // ...other fields
 *     };
 *     const retailRateIncGst = getRetailRateFromInterval(interval, 'nsw', false, true);
 *     console.log(`Current NSW rate: ${retailRateIncGst.toFixed(3)} c/kWh (inc GST)`);
 *   }
 *
 * Notes & Limitations:
 *   - This library focuses on single-interval calculations: for real usage, you
 *     would likely call it every interval or fetch the latest to find a current cost.
 *   - Time-of-use definitions are typical or illustrative per region—real networks
 *     (VIC’s 5 distributors, NSW’s Ausgrid vs Endeavour, etc.) may differ.
 *   - Seasonal variations in certain networks are simplified here; for a production
 *     system, you would consult each distributor’s detailed tariff table.
 *   - Negative wholesale RRP is floored to zero unless you have a pass-through product
 *     that truly credits negative prices.
 *   - Demand or business capacity charges are not comprehensively implemented; we only
 *     apply a small business surcharge to overhead if isBusiness = true.
 *   - Environmental charges, network tariffs, overhead, and margin are approximate.
 *   - If real accuracy is required, replace with up-to-date data from each distribution
 *     zone, environmental scheme certificates, and your retailer’s actual cost stack.
 */

/** Represents one entry of the 5-minute data set returned by the AEMO endpoint. */
export interface AemoInterval {
  SETTLEMENTDATE: string;  // e.g. "2025-03-16T14:05:00"
  REGIONID: string;        // e.g. "NSW1", "QLD1", "SA1", "TAS1", "VIC1"
  RRP: number;             // wholesale price in $/MWh (can be negative)
  // Other fields from the AEMO data can be added, but are not strictly required
  // for this calculation library.
}

/**
 * Available region codes for simplification in this library.
 * Actual regionIDs in AEMO data are typically "NSW1","QLD1","SA1","TAS1","VIC1".
 * We allow a simplified 2–3 letter identifier as well for function calls.
 */
export type SupportedRegion = 'nsw' | 'qld' | 'vic' | 'sa' | 'tas';

/** Simple enumerations for time-of-use categories in a day. */
enum TouPeriod {
  PEAK = 'peak',
  SHOULDER = 'shoulder',
  OFFPEAK = 'offpeak'
}

/** Common interface for region-based cost configuration. */
interface RegionTimeOfUseRates {
  /** c/kWh for network portion at PEAK times (ex-GST). */
  peakNetworkCents: number;
  /** c/kWh for network portion at SHOULDER times (ex-GST). */
  shoulderNetworkCents: number;
  /** c/kWh for network portion at OFF-PEAK times (ex-GST). */
  offpeakNetworkCents: number;

  /** c/kWh for environment & certificate costs (RET, SRES, etc.). */
  envCents: number;

  /**
   * c/kWh for typical retailer overhead & operating costs. 
   * We will also add a small business surcharge if isBusiness=true.
   */
  retailOpsCents: number;

  /**
   * c/kWh for typical retailer margin. For business we might apply
   * a different approach (or add to retailOps).
   */
  marginCents: number;

  /**
   * Additional c/kWh for small business usage if isBusiness=true.
   * This is a placeholder for the difference between residential
   * overhead and small business overhead. 
   */
  businessSurchargeCents?: number;
}

/**
 * Typical region-based cost data for a single-rate usage. We'll expand it
 * to reflect peak/shoulder/offpeak differences as per the doc. These figures
 * are purely illustrative—real networks differ. The doc references that
 * each region can have its own varied structure, so we define typical values.
 */
const REGION_RATE_DATA: Record<SupportedRegion, RegionTimeOfUseRates> = {
  nsw: {
    // Example from the doc or placeholders:
    peakNetworkCents: 12.0,
    shoulderNetworkCents: 7.0,
    offpeakNetworkCents: 3.7,

    envCents: 3.0,
    retailOpsCents: 2.0,
    marginCents: 2.0,
    businessSurchargeCents: 1.0
  },
  qld: {
    peakNetworkCents: 11.0,
    shoulderNetworkCents: 6.0,
    offpeakNetworkCents: 3.3,

    envCents: 2.5,
    retailOpsCents: 2.0,
    marginCents: 1.5,
    businessSurchargeCents: 1.0
  },
  vic: {
    peakNetworkCents: 10.0,
    shoulderNetworkCents: 6.0,
    offpeakNetworkCents: 3.0,

    envCents: 2.0,
    retailOpsCents: 2.5,
    marginCents: 1.5,
    businessSurchargeCents: 1.0
  },
  sa: {
    peakNetworkCents: 20.0,
    shoulderNetworkCents: 12.0,
    offpeakNetworkCents: 8.0,

    envCents: 1.5,
    retailOpsCents: 2.5,
    marginCents: 2.0,
    businessSurchargeCents: 1.5
  },
  tas: {
    // TAS often has only peak vs offpeak (T93) but let's define a partial shoulder = offpeak 
    peakNetworkCents: 14.0,
    shoulderNetworkCents: 10.0,
    offpeakNetworkCents: 5.0,

    envCents: 1.0,
    retailOpsCents: 2.0,
    marginCents: 1.0,
    businessSurchargeCents: 1.0
  }
};

/**
 * Determine if a given date/time is a weekend (Saturday or Sunday).
 *
 * @param {Date} date Date/time to evaluate
 * @return {boolean} True if Saturday or Sunday
 */
function isWeekend(date: Date): boolean {
  const day = date.getDay(); // 0=Sunday,1=Mon,...,6=Sat
  return day === 0 || day === 6;
}

/**
 * Finds which time-of-use period (PEAK, SHOULDER, or OFFPEAK)
 * applies for a given date/time in a specified region. 
 *
 * This function is a simplified or typical approach for each region,
 * based on the documented schedules. Real networks might differ.
 *
 * ─────────────────────────────────────────────────────────────────
 *   NSW (Ausgrid typical):
 *   - Weekdays:
 *       • PEAK = 2pm–8pm
 *       • SHOULDER = 7am–2pm, 8pm–10pm
 *       • OFFPEAK = 10pm–7am
 *   - Weekends:
 *       • SHOULDER = 7am–10pm
 *       • OFFPEAK = 10pm–7am
 *
 * ─────────────────────────────────────────────────────────────────
 *   QLD (Energex typical):
 *   - Weekdays:
 *       • PEAK = 4pm–8pm
 *       • SHOULDER = 7am–4pm, 8pm–10pm
 *       • OFFPEAK = 10pm–7am
 *   - Weekends:
 *       • SHOULDER = 7am–10pm
 *       • OFFPEAK = 10pm–7am
 *
 * ─────────────────────────────────────────────────────────────────
 *   VIC (example typical):
 *   - Weekdays:
 *       • PEAK = 3pm–9pm
 *       • SHOULDER = 7am–3pm, 9pm–10pm
 *       • OFFPEAK = 10pm–7am
 *   - Weekends:
 *       • OFFPEAK = 10pm–7am
 *       • SHOULDER = 7am–10pm
 *     (No explicit weekend peak in this example.)
 *
 * ─────────────────────────────────────────────────────────────────
 *   SA (SAPN typical):
 *   - All days:
 *       • PEAK = 6am–10am, 3pm–1am
 *       • SHOULDER = 10am–3pm
 *       • OFFPEAK = 1am–6am
 *
 *   (No weekend distinction in this simplified approach.)
 *
 * ─────────────────────────────────────────────────────────────────
 *   TAS (Tariff 93 style):
 *   - Weekdays:
 *       • PEAK = 7am–10am, 4pm–9pm
 *       • OFFPEAK = all other times
 *       (We define SHOULDER = OFFPEAK in code for simplicity.)
 *   - Weekends:
 *       • OFFPEAK all day
 *
 * @param {Date} date The date/time to evaluate
 * @param {SupportedRegion} region The region code
 * @return {TouPeriod} 'peak','shoulder','offpeak'
 */
function getTimeOfUsePeriodForRegion(date: Date, region: SupportedRegion): TouPeriod {
  const hour = date.getHours();
  const dayIsWeekend = isWeekend(date);

  switch (region) {
    case 'nsw': {
      // Ausgrid typical
      if (!dayIsWeekend) {
        // Weekday
        if (hour >= 14 && hour < 20) {
          return TouPeriod.PEAK;
        } else if ((hour >= 7 && hour < 14) || (hour >= 20 && hour < 22)) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK; // 10pm–7am
        }
      } else {
        // Weekend - no peak, just shoulder/offpeak
        if (hour >= 7 && hour < 22) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK; 
        }
      }
    }

    case 'qld': {
      // Energex typical
      if (!dayIsWeekend) {
        // Weekday
        if (hour >= 16 && hour < 20) {
          return TouPeriod.PEAK;
        } else if ((hour >= 7 && hour < 16) || (hour >= 20 && hour < 22)) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK; // 10pm–7am
        }
      } else {
        // Weekend
        if (hour >= 7 && hour < 22) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      }
    }

    case 'vic': {
      // Typical VIC example:
      if (!dayIsWeekend) {
        // Weekday
        if (hour >= 15 && hour < 21) {
          return TouPeriod.PEAK;
        } else if ((hour >= 7 && hour < 15) || (hour >= 21 && hour < 22)) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK; // 10pm–7am
        }
      } else {
        // Weekend
        if (hour >= 7 && hour < 22) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      }
    }

    case 'sa': {
      // SAPN typical, same for weekdays/weekends
      // Peak = 6am–10am & 3pm–1am, Shoulder = 10am–3pm, Offpeak =1am–6am
      const totalMinutes = hour * 60 + date.getMinutes();
      // For reference:
      //   6am = 360 min, 10am = 600, 1am =  60, 3pm=900, 1am next day=25h from prior day vantage but we treat single day
      // We'll do a direct check by ranges:
      // Offpeak if 1:00–6:00 => 1am–6am => hour from 1–6 (with 6 excluded)
      if (hour >= 1 && hour < 6) {
        return TouPeriod.OFFPEAK;
      }
      // Peak if 6–10 or 15–24 or 0–1
      // But 0–1 is the leftover from 12am–1am, which is (hour=0)
      // We'll handle that in code
      if ((hour >= 6 && hour < 10) || (hour >= 15 && hour <= 23) || hour === 0) {
        return TouPeriod.PEAK;
      }
      // Shoulder if 10–15
      return TouPeriod.SHOULDER;
    }

    case 'tas': {
      // Tariff 93 style
      // Weekdays: Peak 7–10am, 16–21 => 4–9pm
      // Offpeak all else
      if (!dayIsWeekend) {
        const isMorningPeak = hour >= 7 && hour < 10; 
        const isEveningPeak = hour >= 16 && hour < 21;
        if (isMorningPeak || isEveningPeak) {
          return TouPeriod.PEAK;
        }
        return TouPeriod.OFFPEAK; 
      } else {
        // Weekend entirely off-peak
        return TouPeriod.OFFPEAK;
      }
    }
  }
}

/**
 * Given the RRP in $/MWh (which may be negative), floors it to zero
 * if negative. Converts to cents/kWh by multiplying by 0.1:
 * - $1/MWh => 0.1 c/kWh
 * - e.g., RRP= $80 => 80 * 0.1=8 c/kWh
 *
 * @param {number} rrpInDollarsMWh RRP in $/MWh
 * @return {number} Wholesale price in cents/kWh (never negative)
 */
function convertRrpToWholesaleCents(rrpInDollarsMWh: number): number {
  const rawCents = rrpInDollarsMWh * 0.1;
  return rawCents < 0 ? 0 : rawCents;
}

/**
 * Computes an approximate total retail energy rate (cents/kWh) for a single
 * 5-minute interval, using region-based TOU definitions and typical cost stack.
 *
 * @param {AemoInterval} interval     - The 5-minute AEMO data (RRP in $/MWh).
 * @param {SupportedRegion} region    - One of 'nsw','qld','vic','sa','tas'.
 * @param {boolean} isBusiness        - If true, add a small business overhead.
 * @param {boolean} includeGst        - If true, returns rate inc. GST; otherwise ex. GST.
 * @return {number} The approximate retail rate in c/kWh for that interval.
 */
export function getRetailRateFromInterval(
  interval: AemoInterval,
  region: SupportedRegion,
  isBusiness: boolean = false,
  includeGst: boolean = true
): number {
  // Convert the settlement date to a JS Date to figure out TOU
  const intervalDate = new Date(interval.SETTLEMENTDATE);
  const timeOfUse = getTimeOfUsePeriodForRegion(intervalDate, region);

  // Convert wholesale RRP ($/MWh) to c/kWh (negative => zero).
  const wholesaleCents = convertRrpToWholesaleCents(interval.RRP);

  // Lookup region cost data
  const regionConfig = REGION_RATE_DATA[region];

  // Determine network cost based on timeOfUse
  let networkCents: number;
  switch (timeOfUse) {
    case TouPeriod.PEAK:
      networkCents = regionConfig.peakNetworkCents;
      break;
    case TouPeriod.SHOULDER:
      networkCents = regionConfig.shoulderNetworkCents;
      break;
    case TouPeriod.OFFPEAK:
    default:
      networkCents = regionConfig.offpeakNetworkCents;
      break;
  }

  // Sum base cost stack: wholesale + network + environmental
  // Then add overhead & margin. For business, add a small surcharge.
  let rateExGst =
    wholesaleCents +
    networkCents +
    regionConfig.envCents +
    regionConfig.retailOpsCents +
    regionConfig.marginCents;

  if (isBusiness && regionConfig.businessSurchargeCents) {
    rateExGst += regionConfig.businessSurchargeCents;
  }

  // If user wants inc. GST, multiply by 1.1
  return includeGst ? rateExGst * 1.1 : rateExGst;
}