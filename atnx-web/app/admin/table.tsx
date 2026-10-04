"use client";

import { useState } from "react";

// Client-side sorting for the admin tables. Each tab already holds its
// whole list, so a header click reorders what is loaded, no refetch.
export type SortDir = "asc" | "desc";
export type SortValue = string | number | null;
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

export function useSort<R, K extends string>(
  rows: R[],
  columns: Record<K, (row: R) => SortValue>,
  initial: SortState<NoInfer<K>>
) {
  const [sort, setSort] = useState(initial);
  const get = columns[sort.key];
  const sorted = [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    // Empty values sink to the bottom whichever way the column runs.
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const cmp =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return sort.dir === "asc" ? cmp : -cmp;
  });

  function toggle(key: K) {
    setSort((s) => {
      if (s.key === key) return { key, dir: s.dir === "asc" ? "desc" : "asc" };
      // Text starts A to Z; numbers and dates start largest or newest.
      const sample = rows.map(columns[key]).find((v) => v !== null);
      return { key, dir: typeof sample === "string" ? "asc" : "desc" };
    });
  }

  return { sorted, sort, toggle };
}

export function SortTh<K extends string>({
  column,
  sort,
  onSort,
  align = "left",
  children,
}: {
  column: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const active = sort.key === column;
  return (
    <th
      className={`py-2 px-2 ${align === "right" ? "text-right" : "text-left"}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`uppercase tracking-wider cursor-pointer link-quiet transition-colors ${
          active ? "text-primary" : ""
        }`}
      >
        {children}
        {active && (sort.dir === "asc" ? " ▴" : " ▾")}
      </button>
    </th>
  );
}
