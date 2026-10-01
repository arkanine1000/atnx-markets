"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  MAX_SEARCH_LENGTH,
  marketsHref,
  normalizeSearch,
  parseMarketsQuery,
} from "@/lib/markets-query";

// Market search in the top nav. At rest it is a magnifying glass; pressed,
// it grows into a text field. On the markets page the listing follows the
// text as it is typed (debounced, via the q parameter the page already
// reads); anywhere else, Enter takes the person to the markets page with
// the term. Escape clears and collapses it.
const LIVE_DELAY_MS = 300;

export function SearchIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0"
    >
      <circle
        cx="10.5"
        cy="10.5"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M15.5 15.5L20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

// What the boundary shows while the URL is not yet readable: the same
// button, inert, so nothing shifts when the real one mounts.
export function NavSearchFallback({ className = "" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center h-8 w-9 ${className}`}>
      <span className="h-8 w-9 inline-flex items-center justify-center text-secondary">
        <SearchIcon />
      </span>
    </div>
  );
}

export function NavSearch({
  className = "",
  restClassName = "",
  expandedWidth = "w-44 lg:w-60",
}: {
  className?: string;
  /** Classes for the closed state only, e.g. a fill outside the nav pill. */
  restClassName?: string;
  /** Width classes for the open field; the closed button is one icon wide. */
  expandedWidth?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onMarkets = pathname === "/app";
  const { sort, categories, q: urlQ } = parseMarketsQuery(searchParams);
  // A term in the URL only means anything on the markets page.
  const activeQ = onMarkets ? urlQ : "";

  const [open, setOpen] = useState(activeQ !== "");
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useState(activeQ);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The field follows the URL (back button, the page's own Clear link)
  // except while someone is typing in it, when the field is the truth and
  // the URL is catching up.
  const [prevActiveQ, setPrevActiveQ] = useState(activeQ);
  if (activeQ !== prevActiveQ) {
    setPrevActiveQ(activeQ);
    if (!focused) {
      setValue(activeQ);
      if (activeQ === "") setOpen(false);
    }
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const expanded = open || activeQ !== "";

  const cancelPending = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Navigate to the listing for a term. replace keeps the history clean
  // while typing; a submit from another page pushes so back returns there.
  const go = (term: string, mode: "replace" | "push") => {
    cancelPending();
    // On the markets page a search keeps the order and category filter.
    const href = marketsHref(onMarkets ? { sort, categories, q: term } : { q: term });
    if (mode === "push") router.push(href);
    else router.replace(href, { scroll: false });
  };

  const onChange = (next: string) => {
    setValue(next);
    if (!onMarkets) return;
    cancelPending();
    const term = normalizeSearch(next);
    if (term === urlQ) return;
    timer.current = setTimeout(() => go(term, "replace"), LIVE_DELAY_MS);
  };

  const clear = () => {
    setValue("");
    if (activeQ) go("", "replace");
    else cancelPending();
  };

  const close = () => {
    clear();
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const term = normalizeSearch(value);
        if (!term && !activeQ) {
          close();
          return;
        }
        go(term, onMarkets ? "replace" : "push");
      }}
      // The motion lives in globals.css (.nav-search and friends): the
      // pill widens while the field's contents fade in a beat later.
      data-open={expanded ? "" : undefined}
      className={`nav-search inline-flex items-center h-8 rounded-full overflow-hidden ${
        expanded ? `${expandedWidth} bg-elevated` : `w-9 ${restClassName}`
      } ${className}`}
    >
      <button
        type="button"
        aria-label="Search markets"
        aria-expanded={expanded}
        title="Search markets"
        onClick={() => {
          if (!expanded) setOpen(true);
          inputRef.current?.focus();
        }}
        className={`h-8 w-9 shrink-0 inline-flex items-center justify-center rounded-full transition-colors cursor-pointer ${
          expanded ? "text-primary" : "text-secondary link-quiet"
        }`}
      >
        <SearchIcon />
      </button>
      {/* Always mounted so it can animate; inert while folded away. */}
      <input
        ref={inputRef}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={MAX_SEARCH_LENGTH}
        aria-label="Search markets"
        aria-hidden={!expanded}
        tabIndex={expanded ? 0 : -1}
        placeholder="Search markets"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          // Nothing typed and nothing searched: fold back to the icon.
          if (!normalizeSearch(value) && !activeQ) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className={`nav-search-field flex-1 min-w-0 h-full bg-transparent outline-none text-sm font-medium text-primary placeholder:text-tertiary placeholder:font-normal motion-reduce:transform-none ${
          expanded
            ? "opacity-100 translate-x-0"
            : "opacity-0 -translate-x-2 pointer-events-none"
        }`}
      />
      <button
        type="button"
        aria-label="Clear search"
        title="Clear"
        aria-hidden={!(expanded && value)}
        tabIndex={expanded && value ? 0 : -1}
        // Keep the field focused so the box stays open.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          clear();
          inputRef.current?.focus();
        }}
        className={`nav-search-clear h-6 shrink-0 overflow-hidden rounded-full inline-flex items-center justify-center text-tertiary link-quiet hover-sink cursor-pointer text-xs ${
          expanded && value
            ? "w-6 mr-1 opacity-100"
            : "w-0 mr-0 opacity-0 pointer-events-none"
        }`}
      >
        {"✕"}
      </button>
    </form>
  );
}
