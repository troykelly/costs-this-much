/**
 * @fileoverview Pricing constants data for each AEMO region.
 *
 * This file defines a record of region IDs mapping to an array of "pricing constants."
 * Each constant represents a cost component used in retail price calculations.
 *
 * Usage:
 *   Import the pricingConstants object wherever needed to retrieve cost items by region:
 *
 *     import { pricingConstants } from "./pricingConstantsData";
 *
 *     const region = "NSW1";
 *     const constants = pricingConstants[region] || [];
 *     // Now you have an array of cost items with name, rate, percent, type, etc.
 *
 * Data structure:
 *   Record<string, {
 *     name: string;
 *     rate: number|null;
 *     percent: number|null;
 *     type: "flat"|"kWh";
 *     calendar: {startDay: number; startMonth: number; endDay: number; endMonth: number;}[];
 *     hour:     {startHour: number; endHour: number;}[];
 *   }[]>
 *
 *  - "rate" is a flat AUD amount if not null.
 *  - "percent" is a percentage (like 10 => 10%) if not null.
 *  - "type" indicates how the item is applied: "flat" or "kWh".
 *  - "calendar" is an array of date ranges (start/end day/month) for more specific application windows.
 *  - "hour" is an array of hourly ranges (startHour, endHour) to refine time-based charges.
 *
 * Important:
 *   Each region (e.g., "NSW1", "QLD1", etc.) should have an array of cost items.
 *   Update or add new items as needed for the region's pricing structure.
 *
 * This file is intended to be edited for new or changing cost structures,
 * without needing to modify the core API functionality.
 */

export const pricingConstants: Record<string, {
  name: string;
  rate: number|null;
  percent: number|null;
  type: "flat"|"kWh";
  calendar: {
    startDay: number;
    startMonth: number;
    endDay: number;
    endMonth: number;
  }[];
  hour: {
    startHour: number;
    endHour: number;
  }[];
}[]> = {
  "NSW1": [
    {
      name: "Network Charges",
      rate: 0.10,
      percent: null,
      type: "flat",
      calendar: [],
      hour: []
    },
    {
      name: "Environmental Costs",
      rate: null,
      percent: 10,
      type: "kWh",
      calendar: [],
      hour: []
    }
  ],
  "QLD1": [
    {
      name: "Network Charges",
      rate: 0.11,
      percent: null,
      type: "flat",
      calendar: [],
      hour: []
    },
    {
      name: "Environmental Costs",
      rate: null,
      percent: 8,
      type: "kWh",
      calendar: [],
      hour: []
    }
  ],
  "VIC1": [
    {
      name: "Network Charges",
      rate: 0.09,
      percent: null,
      type: "flat",
      calendar: [],
      hour: []
    },
    {
      name: "Environmental Costs",
      rate: null,
      percent: 7,
      type: "kWh",
      calendar: [],
      hour: []
    }
  ],
  "SA1": [
    {
      name: "Network Charges",
      rate: 0.12,
      percent: null,
      type: "flat",
      calendar: [],
      hour: []
    },
    {
      name: "Environmental Costs",
      rate: null,
      percent: 12,
      type: "kWh",
      calendar: [],
      hour: []
    }
  ],
  "TAS1": [
    {
      name: "Network Charges",
      rate: 0.13,
      percent: null,
      type: "flat",
      calendar: [],
      hour: []
    },
    {
      name: "Environmental Costs",
      rate: null,
      percent: 6,
      type: "kWh",
      calendar: [],
      hour: []
    }
  ]
};