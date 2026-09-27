"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@/lib/categories";

// The markets listing's category filter: a pill the height of the sort
// control beside it, opening a checklist. Ticks apply at once and the menu
// stays open, so picking three categories is three clicks, not three trips.

const FilterIcon = (
  <svg
    viewBox="0 0 16 16"
    width="13"
    height="13"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="1" y="2.5" width="14" height="2" rx="1" />
    <rect x="3.5" y="7" width="9" height="2" rx="1" />
    <rect x="6" y="11.5" width="4" height="2" rx="1" />
  </svg>
);

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    viewBox="0 0 12 12"
    width="10"
    height="10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
  >
    <path d="M2.5 4.5 6 8l3.5-3.5" />
  </svg>
);

const Tick = (
  <svg
    viewBox="0 0 12 12"
    width="10"
    height="10"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 6.2 5 8.5l4.5-5" />
  </svg>
);

function summary(selected: readonly Category[]): string {
  if (selected.length === 0) return "All";
  if (selected.length === 1) return CATEGORY_LABELS[selected[0]];
  return `${selected.length} categories`;
}

export function CategoryFilter({
  selected,
  counts,
  onChange,
}: {
  // Empty means every category.
  selected: readonly Category[];
  counts: Partial<Record<Category, number>>;
  onChange: (next: Category[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const active = selected.length > 0;

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (c: Category) => {
    const next = selected.includes(c)
      ? selected.filter((s) => s !== c)
      : [...selected, c];
    // In the menu's order, so the URL does not depend on the click order.
    onChange(CATEGORIES.filter((k) => next.includes(k)));
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={menuId}
        className={`inline-flex items-center gap-2 rounded-full border bg-surface hover-lift pl-3.5 pr-3 py-2.5 text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ${
          active || open
            ? "border-atnx-magenta/50 text-primary"
            : "border-surface text-secondary"
        }`}
      >
        <span className={active ? "text-atnx-magenta light:text-atnx-magenta-light" : ""}>
          {FilterIcon}
        </span>
        <span className="sr-only">Category: </span>
        {summary(selected)}
        <Chevron open={open} />
      </button>

      {open && (
        <div
          id={menuId}
          role="group"
          aria-label="Filter by category"
          className="absolute left-0 sm:left-auto sm:right-0 top-full mt-2 w-45 z-40 rounded-2xl bg-surface border border-surface shadow-2xl p-1.5"
        >
          <div className="flex items-center justify-between px-2.5 pt-1.5 pb-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-tertiary">
              Categories
            </span>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={!active}
              className="text-[11px] font-bold text-atnx-magenta light:text-atnx-magenta-light hover:opacity-75 disabled:opacity-0 disabled:pointer-events-none cursor-pointer transition-opacity"
            >
              Clear
            </button>
          </div>
          <ul className="max-h-[min(22rem,60svh)] overflow-y-auto">
            {CATEGORIES.map((c) => {
              const checked = selected.includes(c);
              const n = counts[c] ?? 0;
              return (
                <li key={c}>
                  <label
                    className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 cursor-pointer hover-lift ${
                      n === 0 && !checked ? "opacity-45" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(c)}
                      className="peer sr-only"
                    />
                    <span
                      className={`h-4 w-4 shrink-0 rounded-[5px] border inline-flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-atnx-magenta/60 ${
                        checked
                          ? "bg-atnx-magenta border-atnx-magenta text-white"
                          : "border-surface bg-elevated text-transparent"
                      }`}
                    >
                      {Tick}
                    </span>
                    <span
                      className={`flex-1 text-xs ${checked ? "font-bold text-primary" : "text-secondary"}`}
                    >
                      {CATEGORY_LABELS[c]}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-tertiary">
                      {n}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
