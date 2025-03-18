/**
 * SparklineChart.tsx
 *
 * A small 48-hour sparkline chart for scenario cost data, displayed as a polyline.
 * Shows both "today" (most recent 24h) and "yesterday" (previous 24h) lines,
 * highlighting approximate scenario costs at each interval.
 *
 * Author: Troy Kelly
 * Date: 16 March 2025
 */

import React, { useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { AemoInterval, getRetailRateFromInterval, SupportedRegion } from './pricingCalculator';
import { EnergyScenarios } from './energyScenarios';

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

const SparklineChart: React.FC<SparklineChartProps> = ({
  todayIntervals,
  yesterdayIntervals,
  region,
  scenarioKey
}) => {
  const [hoveredPoint, setHoveredPoint] = useState<DataPoint | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const viewBoxWidth = 500;
  const svgHeight = 60;
  const padding = 5;

  // Gather scenario cost data
  const allCosts = [...todayIntervals, ...yesterdayIntervals].map(iv => {
    const rate = getRetailRateFromInterval(iv, region, false, true);
    return EnergyScenarios.getCostForScenario(scenarioKey, rate);
  });
  const maxCost = allCosts.length > 0 ? Math.max(...allCosts) : 0;
  const useLogScale = maxCost > 1;
  let maxScaled = maxCost;
  if (useLogScale) {
    maxScaled = Math.max(...allCosts.map(c => Math.log(c + 1)));
  }

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
        scaledCost = Math.log(cost + 1);
      }
      const y = svgHeight - padding - ((scaledCost / (maxScaled || 1)) * (svgHeight - 2 * padding));
      dataPoints.push({ x, y, cost, date: iv.SETTLEMENTDATE, dt });
      return `${x},${y}`;
    }).join(' ');
    return { poly, dataPoints };
  }

  const yRef = svgHeight - padding - (((useLogScale ? Math.log(maxCost + 1) : maxCost) / (maxScaled || 1)) * (svgHeight - 2 * padding));

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
            Max: {maxCost.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}
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
                : {hoveredPoint.cost.toLocaleString('en-AU',{ style:'currency', currency:'AUD'})}
              </text>
            </>
          )}
        </svg>
      </Box>
    </Box>
  );
};

export default SparklineChart;