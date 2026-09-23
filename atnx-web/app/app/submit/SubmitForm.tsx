"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// Client-side resize before upload: 1080 px long edge, JPEG at 0.85. Keeps
// uploads small and matches what the extension sends.
const MAX_EDGE = 1080;
const JPEG_QUALITY = 0.85;
// When the browser cannot decode the picked file at all, it is sent as-is
// and the server-side model gets to try. Vercel rejects bodies over 4.5 MB.
const MAX_RAW_BYTES = 4 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic|heif|avif|bmp)$/i;

type Outcome = "matched" | "linked" | "created" | "created_review" | "dedup";

interface SuccessResponse {
  success: true;
  marketId: string | null;
  entityName: string | null;
  isNew: boolean;
  outcome: Outcome;
  review: boolean;
}

interface FailureResponse {
  success: false;
  outcome?: "rejected" | "needs_image";
  reason?: string;
  error: string;
}

type Result = SuccessResponse | FailureResponse;

function drawScaled(
  source: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas encode failed"))),
      "image/jpeg",
      JPEG_QUALITY,
    ),
  );
}

// createImageBitmap is the fast path. Some Android builds refuse files the
// <img> decoder is fine with (the gallery hands over odd JPEG variants and
// files with a stale MIME type), so that is the second try.
async function resizeViaBitmap(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    return await drawScaled(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function resizeViaImageElement(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      drawScaled(img, img.naturalWidth, img.naturalHeight)
        .then(resolve, reject)
        .finally(() => URL.revokeObjectURL(objectUrl));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Image element could not decode the file"));
    };
    img.src = objectUrl;
  });
}

// The upload for a picked file: resized JPEG when the browser can decode
// it, the untouched file when it cannot but the size allows, else an error
// the person can act on.
async function prepareUpload(file: File): Promise<{ blob: Blob; name: string }> {
  try {
    return { blob: await resizeViaBitmap(file), name: "upload.jpg" };
  } catch {
    // fall through
  }
  try {
    return { blob: await resizeViaImageElement(file), name: "upload.jpg" };
  } catch {
    // fall through
  }
  if (file.size <= MAX_RAW_BYTES) {
    return { blob: file, name: file.name || "upload" };
  }
  throw new Error(
    "This image could not be read by the browser and is too large to send as-is. Take a screenshot of it and try again.",
  );
}

function outcomeLine(r: SuccessResponse): string {
  switch (r.outcome) {
    case "created":
      return "New market created";
    case "created_review":
      return "New market created (flagged for a second look)";
    case "dedup":
      return "Already submitted; same answer as before";
    default:
      return "Linked to an existing market";
  }
}

interface SubmitFormProps {
  // Prefill from the Android share target when it could not finish on its
  // own; see app/share/route.ts.
  initialUrl?: string;
  initialText?: string;
  notice?: string;
}

export function SubmitForm({ initialUrl = "", initialText = "", notice = "" }: SubmitFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [url, setUrl] = useState(initialUrl);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Second picker that opens the camera directly on phones.
  const cameraRef = useRef<HTMLInputElement>(null);
  const showNotice = Boolean(notice) && !noticeDismissed && !result;

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  // Android pickers sometimes hand over a file with an empty MIME type; the
  // extension is the tie-breaker there.
  const takeFile = useCallback((f: File | null | undefined) => {
    if (!f) return;
    const looksLikeImage =
      f.type.startsWith("image/") || (!f.type && IMAGE_EXT.test(f.name));
    if (!looksLikeImage) return;
    setFile(f);
    setResult(null);
  }, []);

  // Paste anywhere on the page.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/"),
      );
      if (item) {
        e.preventDefault();
        takeFile(item.getAsFile());
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [takeFile]);

  const canSubmit = !busy && (file !== null || url.trim() !== "" || text.trim() !== "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      if (file) {
        const { blob, name } = await prepareUpload(file);
        form.set("image", blob, name);
        if (text.trim()) form.set("pageContext", text.trim());
        if (url.trim()) form.set("sourceUrl", url.trim());
      } else if (url.trim()) {
        form.set("url", url.trim());
        if (text.trim()) form.set("text", text.trim());
      } else {
        form.set("text", text.trim());
      }
      const res = await fetch("/api/captures", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as Result | null;
      setResult(body ?? { success: false, error: `Request failed (${res.status})` });
    } catch (err) {
      setResult({ success: false, error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setUrl("");
    setText("");
    setResult(null);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {showNotice && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-atnx-cyan/40 bg-atnx-cyan/10 px-4 py-3 text-sm text-primary"
        >
          <span className="flex-1 break-words">{notice}</span>
          <button
            type="button"
            onClick={() => setNoticeDismissed(true)}
            className="text-secondary hover:text-primary shrink-0 cursor-pointer"
            aria-label="Dismiss"
          >
            {"✕"}
          </button>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          takeFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        className={`rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
          dragging ? "border-atnx-cyan bg-atnx-cyan/5" : "border-surface bg-surface"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => takeFile(e.target.files?.[0])}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => takeFile(e.target.files?.[0])}
        />
        {preview ? (
          <div className="flex items-center gap-4 text-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt=""
              className="w-24 h-24 rounded-xl object-cover border border-surface bg-black shrink-0"
            />
            <div className="min-w-0">
              <div className="text-sm font-bold text-primary truncate">{file?.name}</div>
              <div className="text-xs text-tertiary">
                {file ? `${Math.round(file.size / 1024)} KB` : ""}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="mt-2 text-xs text-secondary hover:text-primary cursor-pointer"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-sm font-bold text-primary">
              {showNotice ? "Add a screenshot" : "Drop a screenshot"}
            </div>
            <div className="text-xs text-tertiary mt-1">
              or tap to choose, or paste an image anywhere on this page
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                cameraRef.current?.click();
              }}
              className="sm:hidden mt-3 inline-flex items-center gap-1.5 rounded-full border border-surface bg-elevated px-3 py-1.5 text-xs font-bold text-secondary hover:text-primary cursor-pointer"
            >
              <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
                <path
                  d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="12.5" r="3.5" fill="none" stroke="currentColor" strokeWidth={2} />
              </svg>
              Take a photo
            </button>
          </>
        )}
      </div>

      <label className="block">
        <span className="text-xs font-mono uppercase tracking-wider text-tertiary">Link</span>
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setResult(null);
          }}
          placeholder="https://"
          className="mt-1 w-full rounded-xl border border-surface bg-surface px-3 py-2 text-sm text-primary placeholder:text-tertiary focus:outline-none focus:border-atnx-cyan"
        />
        <span className="block text-xs text-tertiary mt-1">
          X, TikTok, Instagram and Facebook usually block link previews. For those, add a screenshot.
        </span>
      </label>

      <label className="block">
        <span className="text-xs font-mono uppercase tracking-wider text-tertiary">Text</span>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          rows={2}
          maxLength={1000}
          placeholder="What is it? A caption, a name, a line from the post."
          className="mt-1 w-full rounded-xl border border-surface bg-surface px-3 py-2 text-sm text-primary placeholder:text-tertiary focus:outline-none focus:border-atnx-cyan resize-y"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-xl bg-atnx-cyan px-4 py-2 text-sm font-bold text-black disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy ? "Working…" : "Submit"}
        </button>
        {(file || url || text) && !busy && (
          <button
            type="button"
            onClick={reset}
            className="text-sm text-secondary hover:text-primary cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>

      {result && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm ${
            result.success
              ? "border-atnx-cyan/40 bg-atnx-cyan/10 text-primary"
              : "border-atnx-magenta/40 bg-atnx-magenta/10 text-atnx-magenta"
          }`}
        >
          {result.success ? (
            <>
              <div className="font-bold">{result.entityName ?? "Market"}</div>
              <div className="text-secondary">{outcomeLine(result)}</div>
              {result.marketId && (
                <Link
                  href={`/app/markets/${result.marketId}`}
                  className="inline-block mt-2 text-atnx-cyan hover:underline"
                >
                  Open market
                </Link>
              )}
            </>
          ) : (
            <div>{result.error}</div>
          )}
        </div>
      )}
    </form>
  );
}
