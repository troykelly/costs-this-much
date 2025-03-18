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
 * an approximate retail rate in cents/kWh (either ex-GST or inc-GST).
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Created: 16 March 2025
 */

export interface AemoInterval {
  SETTLEMENTDATE: string;
  REGIONID: string;
  RRP: number;
}

export type SupportedRegion = 'nsw' | 'qld' | 'vic' | 'sa' | 'tas';

enum TouPeriod {
  PEAK = 'peak',
  SHOULDER = 'shoulder',
  OFFPEAK = 'offpeak'
}

interface RegionTimeOfUseRates {
  peakNetworkCents: number;
  shoulderNetworkCents: number;
  offpeakNetworkCents: number;
  envCents: number;
  retailOpsCents: number;
  marginCents: number;
  businessSurchargeCents?: number;
}

const REGION_RATE_DATA: Record<SupportedRegion, RegionTimeOfUseRates> = {
  nsw: {
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
    peakNetworkCents: 14.0,
    shoulderNetworkCents: 10.0,
    offpeakNetworkCents: 5.0,
    envCents: 1.0,
    retailOpsCents: 2.0,
    marginCents: 1.0,
    businessSurchargeCents: 1.0
  }
};

function isWeekend(date: Date): boolean {
  const day = date.getDay(); 
  return day === 0 || day === 6;
}

function getTimeOfUsePeriodForRegion(date: Date, region: SupportedRegion): TouPeriod {
  const hour = date.getHours();
  const dayIsWeekend = isWeekend(date);

  switch (region) {
    case 'nsw': {
      if (!dayIsWeekend) {
        if (hour >= 14 && hour < 20) {
          return TouPeriod.PEAK;
        } else if ((hour >= 7 && hour < 14) || (hour >= 20 && hour < 22)) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      } else {
        if (hour >= 7 && hour < 22) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      }
    }

    case 'qld': {
      if (!dayIsWeekend) {
        if (hour >= 16 && hour < 20) {
          return TouPeriod.PEAK;
        } else if ((hour >= 7 && hour < 16) || (hour >= 20 && hour < 22)) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      } else {
        if (hour >= 7 && hour < 22) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      }
    }

    case 'vic': {
      if (!dayIsWeekend) {
        if (hour >= 15 && hour < 21) {
          return TouPeriod.PEAK;
        } else if ((hour >= 7 && hour < 15) || (hour >= 21 && hour < 22)) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      } else {
        if (hour >= 7 && hour < 22) {
          return TouPeriod.SHOULDER;
        } else {
          return TouPeriod.OFFPEAK;
        }
      }
    }

    case 'sa': {
      const totalMinutes = hour * 60 + date.getMinutes();
      if (hour >= 1 && hour < 6) {
        return TouPeriod.OFFPEAK;
      }
      if ((hour >= 6 && hour < 10) || (hour >= 15 && hour <= 23) || hour === 0) {
        return TouPeriod.PEAK;
      }
      return TouPeriod.SHOULDER;
    }

    case 'tas': {
      if (!dayIsWeekend) {
        const isMorningPeak = hour >= 7 && hour < 10; 
        const isEveningPeak = hour >= 16 && hour < 21;
        if (isMorningPeak || isEveningPeak) {
          return TouPeriod.PEAK;
        }
        return TouPeriod.OFFPEAK; 
      } else {
        return TouPeriod.OFFPEAK;
      }
    }
  }
}

function convertRrpToWholesaleCents(rrpInDollarsMWh: number): number {
  const rawCents = rrpInDollarsMWh * 0.1;
  return rawCents < 0 ? 0 : rawCents;
}

export function getRetailRateFromInterval(
  interval: AemoInterval,
  region: SupportedRegion,
  isBusiness: boolean = false,
  includeGst: boolean = true
): number {
  const intervalDate = new Date(interval.SETTLEMENTDATE);
  const timeOfUse = getTimeOfUsePeriodForRegion(intervalDate, region);

  const wholesaleCents = convertRrpToWholesaleCents(interval.RRP);

  const regionConfig = REGION_RATE_DATA[region];

  let networkCents: number;
  switch (timeOfUse) {
    case TouPeriod.PEAK:
      networkCents = regionConfig.peakNetworkCents;
      break;
    case TouPeriod.SHOULDER:
      networkCents = regionConfig.shoulderNetworkCents;
      break;
    default:
      networkCents = regionConfig.offpeakNetworkCents;
      break;
  }

  let rateExGst =
    wholesaleCents +
    networkCents +
    regionConfig.envCents +
    regionConfig.retailOpsCents +
    regionConfig.marginCents;

  if (isBusiness && regionConfig.businessSurchargeCents) {
    rateExGst += regionConfig.businessSurchargeCents;
  }

  return includeGst ? rateExGst * 1.1 : rateExGst;
}