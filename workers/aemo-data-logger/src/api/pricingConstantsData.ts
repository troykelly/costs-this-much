/**
 * @fileoverview Pricing constants data for each provider and region.
 *
 * This file defines a nested record: top-level keys are providers, each containing
 * a record mapping region IDs to arrays of "pricing constants."
 *
 * Usage:
 *   Import the pricingConstants object wherever needed to retrieve cost items by provider & region:
 *
 *     import { pricingConstants } from "./pricingConstantsData";
 *
 *     const provider = "AEMO";
 *     const region = "NSW1";
 *     const constants = pricingConstants[provider]?.[region] || [];
 *     // Now you have an array of cost items with name, rate, percent, type, etc.
 *
 * Data structure:
 *   Record<provider, Record<region, CostItem[]>>
 *
 * Where:
 *   CostItem has:
 *     - name: string
 *     - rate: number|null (flat AUD cost if not null)
 *     - percent: number|null (percentage if not null)
 *     - type: "flat" | "kWh"
 *     - calendar: optional date constraints (array of objects)
 *     - hour: optional hourly constraints (array of objects)
 *
 * Below, "AEMO" is used as a sample provider. Additional providers can be added as needed.
 *
 * Example fields:
 *   - "Network Charges" at a rate of 0.10 AUD
 *   - "Environmental Costs" at 10% (0.10 as fraction)
 *
 * Modify or expand these values as cost structures evolve.
 */

export const pricingConstants: Record<
  string,  // provider
  Record<
    string, // region
    {
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
    }[]
  >
> = {
  "AEMO": {
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
  }
};