"use client";

import { useState, useEffect } from "react";

export function useFakeTicker(
  initialDataPoints: { date: string; value: number }[],
  enabled: boolean = true
) {
  const [dataPoints, setDataPoints] = useState(initialDataPoints);

  // Reset when initial data changes
  useEffect(() => {
    setDataPoints(initialDataPoints);
  }, [initialDataPoints]);

  useEffect(() => {
    if (!enabled || initialDataPoints.length === 0) return;

    const interval = setInterval(() => {
      setDataPoints((prev) => {
        const lastValue = prev[prev.length - 1]?.value ?? 50;
        // Random walk with slight upward bias
        const change = (Math.random() - 0.45) * 8;
        const newValue = Math.max(0, Math.min(100, lastValue + change));

        const newPoint = {
          date: new Date().toISOString(),
          value: Math.round(newValue),
        };

        const updated = [...prev, newPoint];
        if (updated.length > 168) updated.shift();
        return updated;
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [enabled, initialDataPoints.length]);

  return dataPoints;
}
