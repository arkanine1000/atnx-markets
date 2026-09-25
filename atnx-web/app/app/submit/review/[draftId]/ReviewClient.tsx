"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Chip } from "@/components/ui";
import type {
  CropRect,
  OfferedMarket,
  ReviewChoice,
  ReviewDraftView,
} from "@/lib/review";

// The review screen's client half. Every control is a bounded choice the
// server offered in `initial.choices`; nothing typed here reaches the
// server except a crop rectangle.

type Mode = "attach" | "create" | "create_subject";

interface FinalBody {
  success: true;
  final: true;
  marketId: string | null;
  entityName: string | null;
  outcome: string;
}
interface DraftBody {
  success: true;
  final: false;
  draft: ReviewDraftView;
}
interface ErrorBody {
  success: false;
  error: string;
  code?: string;
  outcome?: string;
}
type Body = FinalBody | DraftBody | ErrorBody;

const ENTITY_LABEL: Record<string, string> = {
  meme: "Meme",
  trend: "Trend",
  person: "Person",
  brand: "Brand",
  event: "Event",
  other: "Other",
};

function label(v: string): string {
  return ENTITY_LABEL[v] ?? v.replace(/_/g, " ");
}

function remaining(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function MarketCard({
  market,
  selected,
  onSelect,
  hint,
}: {
  market: OfferedMarket;
  selected: boolean;
  onSelect: () => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full text-left flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
        selected
          ? "border-atnx-cyan bg-atnx-cyan/10"
          : "border-surface hover:border-atnx-cyan/30"
      }`}
    >
      {market.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={market.thumbnailUrl}
          alt=""
          className="w-12 h-12 rounded-lg object-cover border border-surface bg-black shrink-0"
        />
      ) : (
        <div className="w-12 h-12 rounded-lg border border-surface bg-elevated shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-primary truncate">{market.name}</div>
        <div className="text-[11px] text-tertiary mt-0.5">
          {market.entityType ? label(market.entityType) : "market"}
          {" · "}
          {market.totalCaptures} capture{market.totalCaptures === 1 ? "" : "s"}
          {hint ? ` · ${hint}` : ""}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary">VI</div>
        <div className="font-bold text-atnx-yellow light:text-atnx-yellow-light tabular-nums">
          {market.currentVi}
        </div>
      </div>
    </button>
  );
}

// Drag a rectangle over the image. Coordinates are kept in original pixels
// so the server can crop its own copy; the overlay is scaled for display.
function CropTool({
  image,
  rect,
  onChange,
  disabled,
}: {
  image: NonNullable<ReviewDraftView["image"]>;
  rect: CropRect | null;
  onChange: (r: CropRect | null) => void;
  disabled: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [drawing, setDrawing] = useState(false);

  // Displayed-pixel position → original pixels, clamped to the image.
  function toOriginal(e: React.PointerEvent): { x: number; y: number } {
    const box = boxRef.current!.getBoundingClientRect();
    const sx = image.width / box.width;
    const sy = image.height / box.height;
    return {
      x: Math.max(0, Math.min(image.width, Math.round((e.clientX - box.left) * sx))),
      y: Math.max(0, Math.min(image.height, Math.round((e.clientY - box.top) * sy))),
    };
  }

  function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): CropRect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }

  // Always drawn on the original: the rectangle is in its pixels, and a
  // second crop starts from the whole image rather than the first crop.
  const shown = image.url;
  const style = rect
    ? {
        left: `${(rect.x / image.width) * 100}%`,
        top: `${(rect.y / image.height) * 100}%`,
        width: `${(rect.width / image.width) * 100}%`,
        height: `${(rect.height / image.height) * 100}%`,
      }
    : undefined;

  return (
    <div>
      <div
        ref={boxRef}
        className={`relative mx-auto w-fit max-w-full select-none rounded-xl overflow-hidden border border-surface bg-black ${
          disabled ? "" : "cursor-crosshair touch-none"
        }`}
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          start.current = toOriginal(e);
          setDrawing(true);
          onChange(null);
        }}
        onPointerMove={(e) => {
          if (!drawing || !start.current) return;
          onChange(rectFrom(start.current, toOriginal(e)));
        }}
        onPointerUp={(e) => {
          if (!drawing || !start.current) return;
          const r = rectFrom(start.current, toOriginal(e));
          setDrawing(false);
          start.current = null;
          onChange(r.width < 8 || r.height < 8 ? null : r);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={shown}
          alt=""
          className="block max-w-full max-h-[60dvh] w-auto h-auto pointer-events-none"
          draggable={false}
        />
        {rect && (
          <>
            <div className="absolute inset-0 bg-black/50 pointer-events-none" />
            <div
              className="absolute border-2 border-atnx-cyan pointer-events-none"
              style={{
                ...style,
                backgroundImage: `url(${image.url})`,
                backgroundSize: `${(image.width / rect.width) * 100}% ${(image.height / rect.height) * 100}%`,
                backgroundPosition: `${(rect.x / (image.width - rect.width || 1)) * 100}% ${(rect.y / (image.height - rect.height || 1)) * 100}%`,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

// The crop tool, full-screen. It lives behind a button so the review page
// scrolls normally on a phone: an inline drag surface swallows the swipe
// of anyone who did not mean to crop.
function CropModal({
  image,
  rect,
  onChange,
  onClose,
  onApply,
  busy,
  recropsLeft,
  disabled,
}: {
  image: NonNullable<ReviewDraftView["image"]>;
  rect: CropRect | null;
  onChange: (r: CropRect | null) => void;
  onClose: () => void;
  onApply: () => void;
  busy: boolean;
  recropsLeft: number;
  disabled: boolean;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
      onClick={() => !busy && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="crop-modal-title"
    >
      <div
        className="w-full max-w-lg max-h-full overflow-auto rounded-2xl border border-surface bg-surface p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="crop-modal-title" className="font-display text-lg font-bold text-primary">
              Crop image
            </h2>
            <p className="text-xs text-tertiary mt-0.5">
              {rect
                ? `${rect.width}×${rect.height} px selected`
                : "Drag over the part that is the subject."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-secondary hover:text-primary text-xl leading-none px-1 cursor-pointer disabled:opacity-40"
          >
            ×
          </button>
        </div>
        <CropTool image={image} rect={rect} onChange={onChange} disabled={disabled || busy} />
        <div className="flex items-center justify-end gap-3 text-sm">
          {rect && (
            <button
              type="button"
              onClick={() => onChange(null)}
              disabled={busy}
              className="text-secondary hover:text-primary cursor-pointer disabled:opacity-40"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            disabled={!rect || busy || disabled || recropsLeft === 0}
            onClick={onApply}
            className="rounded-xl bg-atnx-cyan px-4 py-2 font-bold text-black disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? "Analyzing…" : `Re-analyze crop (${recropsLeft} left)`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ReviewClient({ initial }: { initial: ReviewDraftView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const { nudge, choices, analysis } = view;

  const defaultMode: Mode = nudge.defaultChoice.kind;
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [marketId, setMarketId] = useState<string | null>(
    nudge.defaultChoice.kind === "attach" ? nudge.defaultChoice.marketId : null,
  );
  const [name, setName] = useState(choices.names[0] ?? "");
  const [entityType, setEntityType] = useState(analysis.entityType ?? "other");
  const [category, setCategory] = useState(analysis.category ?? "other");
  const [kept, setKept] = useState<Set<string>>(new Set(choices.aliases));
  const [withParent, setWithParent] = useState(Boolean(choices.parentMarketId));
  const [showOcr, setShowOcr] = useState(false);
  const [showCreate, setShowCreate] = useState(defaultMode === "create");

  const [crop, setCrop] = useState<CropRect | null>(null);
  const [cropping, setCropping] = useState(false);
  const [busy, setBusy] = useState<"commit" | "recrop" | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // A re-crop rewrites the proposal; start the choices over from it.
  function adopt(next: ReviewDraftView) {
    setView(next);
    const d = next.nudge.defaultChoice;
    setMode(d.kind);
    setMarketId(d.kind === "attach" ? d.marketId : null);
    setName(next.choices.names[0] ?? "");
    setEntityType(next.analysis.entityType ?? "other");
    setCategory(next.analysis.category ?? "other");
    setKept(new Set(next.choices.aliases));
    setWithParent(Boolean(next.choices.parentMarketId));
    setShowCreate(d.kind === "create");
    setCrop(null);
    setCropping(false);
  }

  const offered = useMemo(
    () => [...nudge.candidates, ...(nudge.subject ? [nudge.subject] : [])],
    [nudge],
  );
  const selectedMarket = offered.find((m) => m.id === marketId) ?? null;
  const strong = nudge.candidates.find((m) => m.id === choices.strongMatchId) ?? null;
  const expired = new Date(view.expiresAt).getTime() <= now;

  const choice: ReviewChoice | null = useMemo(() => {
    if (mode === "attach") return marketId ? { kind: "attach", marketId } : null;
    if (mode === "create_subject") return choices.createSubject ? { kind: "create_subject" } : null;
    if (!choices.canCreate || !name) return null;
    return {
      kind: "create",
      name,
      entityType,
      category,
      aliases: choices.aliases.filter((a) => kept.has(a)),
      parentMarketId: withParent && choices.parentMarketId ? choices.parentMarketId : null,
    };
  }, [mode, marketId, name, entityType, category, kept, withParent, choices]);

  async function post(path: string, body: unknown): Promise<Body> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return ((await res.json().catch(() => null)) as Body | null) ?? {
      success: false,
      error: `Request failed (${res.status})`,
    };
  }

  async function commit() {
    if (!choice || busy) return;
    setBusy("commit");
    setError(null);
    try {
      const body = await post("/api/captures/commit", { draftId: view.draftId, choice });
      if (!body.success) {
        setError({ message: body.error, code: body.code });
        return;
      }
      if (body.final) {
        router.push(
          body.marketId ? `/app/markets/${body.marketId}?shared=${body.outcome}` : "/app",
        );
      }
    } catch (err) {
      setError({ message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function recrop() {
    if (!crop || busy) return;
    setBusy("recrop");
    setError(null);
    try {
      const body = await post("/api/captures/recrop", { draftId: view.draftId, crop });
      if (!body.success) {
        setError({ message: body.error, code: body.code });
        return;
      }
      if (body.final) {
        router.push(
          body.marketId ? `/app/markets/${body.marketId}?shared=${body.outcome}` : "/app",
        );
        return;
      }
      adopt(body.draft);
    } catch (err) {
      setError({ message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const commitLabel =
    mode === "attach" && selectedMarket
      ? `Add to ${selectedMarket.name}`
      : mode === "create_subject" && choices.createSubject
        ? `Create ${choices.createSubject.name}`
        : name
          ? `Create ${name}`
          : "Choose an option";

  const headline =
    nudge.tier === "strong" && strong
      ? `This looks like ${strong.name}`
      : nudge.tier === "subject" && nudge.subject
        ? `This is about ${nudge.subject.name}`
        : nudge.tier === "ambiguous"
          ? "This could be one of these"
          : choices.canCreate
            ? "Nothing like this yet"
            : "Review";

  return (
    <div className="space-y-4">
      {view.image && (
        <Card className="p-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCropping(true)}
            aria-label="Open the image"
            className="shrink-0 cursor-pointer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={view.image.cropUrl ?? view.image.url}
              alt=""
              className="w-16 h-16 rounded-lg object-cover border border-surface bg-black"
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-primary">
              {view.image.cropUrl ? "Your crop" : "Captured image"}
            </div>
            <div className="text-[11px] text-tertiary mt-0.5">
              {view.recropsLeft > 0
                ? "Caught too much? Crop to the subject."
                : "No re-crops left."}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCropping(true)}
            disabled={busy !== null || expired || view.recropsLeft === 0}
            className="shrink-0 rounded-lg bg-elevated border border-surface px-3 py-1.5 text-xs font-bold text-primary hover:border-atnx-cyan/50 disabled:opacity-40 cursor-pointer"
          >
            Crop / resize
          </button>
        </Card>
      )}

      {view.image && cropping && (
        <CropModal
          image={view.image}
          rect={crop}
          onChange={setCrop}
          onClose={() => {
            setCrop(null);
            setCropping(false);
          }}
          onApply={recrop}
          busy={busy === "recrop"}
          recropsLeft={view.recropsLeft}
          disabled={expired}
        />
      )}

      <Card className="p-4 sm:p-5 space-y-4">
        <div>
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-primary">{headline}</h2>
            <span
              className={`text-[11px] font-mono tabular-nums shrink-0 ${expired ? "text-atnx-magenta" : "text-tertiary"}`}
              title="This review expires; submit again after that."
            >
              {remaining(view.expiresAt, now)}
            </span>
          </div>
          {analysis.description && (
            <p className="text-sm text-secondary mt-1 font-sans">{analysis.description}</p>
          )}
        </div>

        {/* Existing markets: identity candidates, then the subject. */}
        {offered.length > 0 && (
          <div className="space-y-2">
            {nudge.candidates.map((m) => (
              <MarketCard
                key={m.id}
                market={m}
                selected={mode === "attach" && marketId === m.id}
                onSelect={() => {
                  setMode("attach");
                  setMarketId(m.id);
                }}
                hint={
                  m.id === choices.strongMatchId
                    ? "same thing"
                    : m.similarity !== null
                      ? `${Math.round(m.similarity * 100)}% similar`
                      : undefined
                }
              />
            ))}
            {nudge.subject && (
              <MarketCard
                market={nudge.subject}
                selected={mode === "attach" && marketId === nudge.subject.id}
                onSelect={() => {
                  setMode("attach");
                  setMarketId(nudge.subject!.id);
                }}
                hint="what this is about"
              />
            )}
          </div>
        )}

        {/* The create option, quieter when there is something to attach to. */}
        {choices.canCreate && (
          <div className={offered.length > 0 ? "pt-2 border-t border-surface" : ""}>
            {offered.length > 0 && !showCreate ? (
              <button
                type="button"
                onClick={() => {
                  setShowCreate(true);
                  setMode("create");
                }}
                className="text-sm text-secondary hover:text-atnx-cyan cursor-pointer"
              >
                {nudge.tier === "strong"
                  ? "This is something else →"
                  : `Create “${choices.names[0]}” as its own market →`}
              </button>
            ) : (
              <div
                className={`rounded-xl border p-3 space-y-3 ${
                  mode === "create" ? "border-atnx-cyan bg-atnx-cyan/5" : "border-surface"
                }`}
                onClick={() => setMode("create")}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary">
                    New market
                  </div>
                  {choices.strongMatchId && (
                    <Chip tone="magenta">flagged for review</Chip>
                  )}
                </div>

                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary mb-1">Name</div>
                  <div className="flex flex-wrap gap-1.5">
                    {choices.names.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => {
                          setMode("create");
                          setName(n);
                        }}
                        aria-pressed={name === n}
                        className={`rounded-full border px-3 py-1 text-xs font-bold cursor-pointer ${
                          name === n
                            ? "border-atnx-cyan bg-atnx-cyan/10 text-primary"
                            : "border-surface text-secondary hover:text-primary"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-tertiary">Type</span>
                    <select
                      value={entityType}
                      onChange={(e) => setEntityType(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-surface bg-surface px-2 py-1.5 text-sm text-primary"
                    >
                      {choices.entityTypes.map((t) => (
                        <option key={t} value={t}>
                          {label(t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-tertiary">Category</span>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-surface bg-surface px-2 py-1.5 text-sm text-primary"
                    >
                      {choices.categories.map((c) => (
                        <option key={c} value={c}>
                          {label(c)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {choices.aliases.length > 0 && (
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary mb-1">
                      Also known as <span className="normal-case tracking-normal">(tap to drop)</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {choices.aliases.map((a) => {
                        const on = kept.has(a);
                        return (
                          <button
                            key={a}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setKept((prev) => {
                                const next = new Set(prev);
                                if (next.has(a)) next.delete(a);
                                else next.add(a);
                                return next;
                              })
                            }
                            className={`rounded-full border px-2.5 py-1 text-[11px] cursor-pointer ${
                              on
                                ? "border-surface bg-elevated text-primary"
                                : "border-dashed border-surface text-tertiary line-through"
                            }`}
                          >
                            {a}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {choices.parentMarketId && nudge.subject && (
                  <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={withParent}
                      onChange={(e) => setWithParent(e.target.checked)}
                      className="accent-atnx-cyan"
                    />
                    Mark it as about {nudge.subject.name}
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        {/* The subject has no market yet: offer to track it instead. */}
        {choices.createSubject && (
          <button
            type="button"
            onClick={() => setMode("create_subject")}
            aria-pressed={mode === "create_subject"}
            className={`w-full text-left rounded-xl border p-3 cursor-pointer ${
              mode === "create_subject" ? "border-atnx-cyan bg-atnx-cyan/5" : "border-surface hover:border-atnx-cyan/30"
            }`}
          >
            <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary">Or track what it is about</div>
            <div className="text-sm font-bold text-primary mt-0.5">
              {choices.createSubject.name}{" "}
              <span className="text-tertiary font-normal">· {label(choices.createSubject.entityType)}</span>
            </div>
          </button>
        )}

        {/* Read-only facts. */}
        <div className="text-xs text-tertiary space-y-1">
          {analysis.platforms.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {analysis.platforms.map((p) => (
                <Chip key={p}>{p}</Chip>
              ))}
            </div>
          )}
          {analysis.ocrText && (
            <div>
              <button
                type="button"
                onClick={() => setShowOcr((v) => !v)}
                className="text-secondary hover:text-atnx-cyan cursor-pointer"
              >
                {showOcr ? "▾" : "▸"} Text read from the image
              </button>
              {showOcr && (
                <pre className="mt-1 rounded-xl border border-surface bg-elevated p-3 text-[11px] text-secondary whitespace-pre-wrap break-words max-h-40 overflow-auto font-sans">
                  {analysis.ocrText}
                </pre>
              )}
            </div>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-atnx-magenta/40 bg-atnx-magenta/10 px-4 py-3 text-sm text-atnx-magenta"
          >
            {error.message}
            {error.code === "draft_gone" && (
              <>
                {" "}
                <Link href="/app/submit" className="underline">
                  Submit again
                </Link>
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={commit}
            disabled={!choice || busy !== null || expired}
            className="rounded-xl bg-atnx-cyan px-4 py-2 text-sm font-bold text-black disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy === "commit" ? "Saving…" : commitLabel}
          </button>
          <Link href="/app/submit" className="text-sm text-secondary hover:text-primary">
            Discard
          </Link>
        </div>
      </Card>
    </div>
  );
}
