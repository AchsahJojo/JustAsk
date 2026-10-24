import { useEffect, useRef, useState } from "react";
import { createPlayer, type PlayerHandle } from "@clayzo/webgl-player";
import type { AnimationDocument } from "@clayzo/animation";

/**
 * A Clayzo animation on a canvas, driven by numeric state-machine inputs.
 * `fallback` shows if WebGL2 is unavailable; reduced motion holds each state's last frame.
 */
export function Clay({
  doc,
  inputs,
  width,
  height,
  label,
  fallback,
  className,
}: {
  doc: unknown;
  inputs?: Record<string, number>;
  width: number;
  height: number;
  label?: string;
  fallback?: React.ReactNode;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<PlayerHandle | null>(null);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const [failed, setFailed] = useState(false);
  const d = doc as { canvas: { width: number; height: number } };

  useEffect(() => {
    let disposed = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    createPlayer({ canvas, document: doc as AnimationDocument, interactive: false, onError: () => {} })
      .then((p) => {
        if (disposed) return p.dispose();
        playerRef.current = p;
        p.setReducedMotion(matchMedia("(prefers-reduced-motion: reduce)").matches);
        for (const [k, v] of Object.entries(inputsRef.current ?? {})) p.setInput(k, v);
        p.play();
        canvas.dataset.ready = "1";
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, [doc]);

  const key = JSON.stringify(inputs ?? {});
  useEffect(() => {
    for (const [k, v] of Object.entries(inputs ?? {})) playerRef.current?.setInput(k, v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <span className={`clay ${className ?? ""}`} style={{ width, height }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {failed ? (fallback ?? null) : <canvas ref={canvasRef} width={d.canvas.width * 2} height={d.canvas.height * 2} style={{ width, height }} />}
    </span>
  );
}
