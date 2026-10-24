import { useEffect, useState } from "react";
import { Clay } from "./Clay";
import orb from "../assets/orb.json";

export function Brand() {
  return (
    <span className="brand">
      <Clay doc={orb} width={30} height={30} fallback={<span className="brand-dot" />} />
      <span>
        JustAsk <span className="brand-sub">for helpers</span>
      </span>
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spin" aria-hidden="true" />
      {label}
    </span>
  );
}

/** "3 min ago", "Yesterday", "Mar 4". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function useNow(everyMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(iv);
  }, [everyMs]);
  return now;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
