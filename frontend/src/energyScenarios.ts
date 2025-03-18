/**
 * @fileoverview energyScenarios.ts - A TypeScript library/class to hold
 * multiple everyday energy usage examples (e.g., boiling water, charging phone,
 * running a washing machine), rather than hardcoding "toast" into the system.
 *
 * Provides key assumptions (wattage, duration, typical kWh used, etc.)
 * for each example scenario, and calculates a total cost for that scenario
 * given a retail rate in cents/kWh.
 *
 * This allows the frontend to select an example by ID (e.g., "toast")
 * and retrieve:
 *   - The scenario's details (for display)
 *   - The approximate cost for the scenario at the current electricity rate
 *
 * Author: Troy Kelly <troy@troykelly.com>
 * Date: 16 March 2025
 *
 * Usage Example:
 *   import { EnergyScenarios } from './energyScenarios';
 *
 *   const scenarios = EnergyScenarios.getAllScenarios();
 *   console.log(scenarios); // Show all possible scenarios
 *
 *   const costOfToast = EnergyScenarios.getCostForScenario('toast', 30.0);
 *   console.log(`Cost to toast bread at 30 c/kWh: $${costOfToast.toFixed(4)}`);
 */

export interface EnergyScenario {
  /**
   * A short, unique identifier for this usage scenario (e.g., "toast").
   */
  id: string;

  /**
   * A more descriptive name for the scenario (e.g., "Toasting a Slice of Bread").
   */
  name: string;

  /**
   * A short textual description of what this scenario involves.
   */
  description: string;

  /**
   * (Optional) Device wattage in watts if relevant (e.g., 1000 for a toaster).
   */
  wattage?: number;

  /**
   * (Optional) Duration in hours if relevant (e.g., 0.05 hours for 3 minutes).
   */
  durationHours?: number;

  /**
   * Approximate total energy usage in kWh for this scenario (e.g., 0.05).
   */
  approximateKWhUsed: number;

  /**
   * (Optional) The name of the MUI icon to represent this scenario in the UI.
   */
  iconName?: string;

  /**
   * (Optional) A set of detailed calculation assumptions or notes to display.
   */
  assumptions?: string[];
}

/**
 * A class to manage everyday scenario data (energy usage) and perform
 * cost calculations based on a provided retail electricity rate.
 */
export class EnergyScenarios {
  /**
   * Internal record of predefined usage scenarios.
   */
  private static readonly scenarioData: EnergyScenario[] = [
    {
      id: 'toast',
      name: 'Toasting an average slice of bread',
      description:
        'A typical pop-up toaster draws ~1,000 W for about 3 minutes (0.05 hours).',
      wattage: 1000,
      durationHours: 0.05,
      approximateKWhUsed: 0.05,
      iconName: 'BreakfastDining',
      assumptions: [
        'Appliance wattage ~1,000W',
        'Duration ~3 minutes (0.05 hours)',
        'Hence ~0.05 kWh total usage'
      ]
    },
    {
      id: 'boilWater',
      name: 'Boiling 1 litre of water',
      description:
        'Raises water from ~20 °C to 100 °C, considering ~80–90% kettle efficiency.',
      approximateKWhUsed: 0.11,
      iconName: 'LocalCafe',
      assumptions: [
        'Kettle power ~2,000–2,400W (typical)',
        'Energy usage ~0.11kWh per boil (1 L water)'
      ]
    },
    {
      id: 'phoneCharge',
      name: 'Charging a typical smartphone (0%→100%)',
      description:
        'Modern phone batteries ~3,000–4,500 mAh at ~3.7 V, plus ~10–20% charging losses.',
      approximateKWhUsed: 0.02,
      iconName: 'Smartphone',
      assumptions: [
        'Fine for phone capacity of ~3000–4500 mAh @3.7V + overhead/losses',
        '~0.02 kWh typical usage'
      ]
    },
    {
      id: 'bulbHour',
      name: 'Running a 60 W incandescent bulb for 1 hour',
      description: '60 W × 1 hour = 0.06 kWh.',
      approximateKWhUsed: 0.06,
      iconName: 'Lightbulb',
      assumptions: [
        '60W x 1 hour = 0.06 kWh'
      ]
    },
    {
      id: 'laptop',
      name: 'Charging a typical laptop from near-empty to full',
      description:
        'Batteries often 50–70 Wh; factoring some losses ~0.06–0.08 kWh.',
      approximateKWhUsed: 0.07,
      iconName: 'Laptop',
      assumptions: [
        'Laptop battery capacity ~50–70Wh, factoring in losses ~0.06–0.08 kWh',
        'Hence ~0.07 kWh typical usage'
      ]
    },
    {
      id: 'washingMachine',
      name: 'One standard washing machine cycle (warm wash)',
      description:
        'Typically 0.5–1.0 kWh per cycle. Using 0.75 as an example average.',
      approximateKWhUsed: 0.75,
      iconName: 'LocalLaundryService',
      assumptions: [
        'Typically 0.5–1.0 kWh/cycle, mid range used here as 0.75 kWh'
      ]
    },
    {
      id: 'dishwasher',
      name: 'One dishwasher cycle',
      description:
        'Usually 1.0–1.5 kWh, assuming heated water. Using 1.25 as typical.',
      approximateKWhUsed: 1.25,
      iconName: 'LocalDining',
      assumptions: [
        'Generally 1.0–1.5 kWh with heated water',
        'Using 1.25 kWh typical usage'
      ]
    },
    {
      id: 'microwave5min',
      name: 'Microwaving for 5 minutes at ~1,000 W',
      description: '1,000 W × (5 min ÷ 60 min/h) = 0.08 kWh.',
      approximateKWhUsed: 0.08,
      iconName: 'Microwave',
      assumptions: [
        '5 minutes at 1,000W => 5/60 hours => ~0.08 kWh'
      ]
    },
    {
      id: 'shower10min',
      name: 'Taking a ~10-minute shower with electric water heater',
      description:
        'Highly variable. Typically 3–5 kWh depending on flow rate & heater power. Using 4 kWh.',
      approximateKWhUsed: 4.0,
      iconName: 'Shower',
      assumptions: [
        'Shower with electric water heating over 10 min => ~3–5 kWh typical usage',
        'Using 4 kWh as a middle ground figure.'
      ]
    },
    {
      id: 'evcharge',
      name: 'Charging an electric vehicle from ~0% to ~80%',
      description:
        'Smaller EV ~40 kWh battery; 80% = 32 kWh. Larger EV can be 60+ kWh for 80%. Using 40kWh as reference.',
      approximateKWhUsed: 40,
      iconName: 'ElectricCar',
      assumptions: [
        'Smaller EV battery ~40 kWh total capacity => 80% ~32 kWh, or up to 40 for near full charge',
        'Hence we use ~40 kWh usage as example if near empty to near full'
      ]
    }
  ];

  public static getAllScenarios(): EnergyScenario[] {
    return this.scenarioData;
  }

  public static getScenarioById(scenarioId: string): EnergyScenario | null {
    const lowerId = scenarioId.toLowerCase();
    const scenario = this.scenarioData.find(
      (s) => s.id.toLowerCase() === lowerId
    );
    return scenario || null;
  }

  /**
   * Calculates the approximate cost in dollars for a given scenario,
   * given a retail electricity rate in cents/kWh.
   *
   * @param {string} scenarioId - The unique ID of the scenario (e.g. "toast").
   * @param {number} retailRateCents - The retail electricity rate in cents per kWh (c/kWh).
   * @return {number} The calculated cost in dollars. Returns 0 if scenario not found.
   */
  public static getCostForScenario(scenarioId: string, retailRateCents: number): number {
    const scenario = this.getScenarioById(scenarioId);
    if (!scenario) {
      return 0;
    }
    // Convert the rate from c/kWh to $/kWh
    const rateDollarsPerKWh = retailRateCents / 100;
    return scenario.approximateKWhUsed * rateDollarsPerKWh;
  }
}