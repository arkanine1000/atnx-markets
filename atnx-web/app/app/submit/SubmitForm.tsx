"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// Client-side resize before upload: 1080 px long edge, JPEG at 0.85. Keeps
// uploads small and matches what the extension sends.
const MAX_EDGE = 1080;
const JPEG_QUALITY = 0.85;

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

async function resizeImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
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

export function SubmitForm() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const takeFile = useCallback((f: File | null | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
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
        const blob = await resizeImage(file);
        form.set("image", blob, "upload.jpg");
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
            <div className="text-sm font-bold text-primary">Drop a screenshot</div>
            <div className="text-xs text-tertiary mt-1">
              or click to choose, or paste an image anywhere on this page
            </div>
          </>
        )}
      </div>

      <label className="block">
        <span className="text-xs uppercase tracking-wider text-tertiary">Link</span>
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
          X, TikTok and Instagram block link previews. For those, paste a screenshot.
        </span>
      </label>

      <label className="block">
        <span className="text-xs uppercase tracking-wider text-tertiary">Text</span>
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
