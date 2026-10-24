import { useEffect, useRef, useState } from "react";
import { createPlayer, type PlayerHandle } from "@clayzo/webgl-player";
import type { AnimationDocument } from "@clayzo/animation";
import orbDoc from "../assets/orb.json";

export type OrbMode = "idle" | "listening" | "thinking" | "speaking" | "done";
const MODE_INPUT: Record<OrbMode, number> = { idle: 0, listening: 1, thinking: 2, speaking: 3, done: 4 };

/** The Clayzo-animated orb. Falls back to a plain CSS disc if WebGL2 is unavailable. */
export function Orb({ mode, size }: { mode: OrbMode; size: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<PlayerHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    let disposed = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    createPlayer({
      canvas,
      document: orbDoc as unknown as AnimationDocument,
      interactive: false,
      releaseWhenOffscreen: false,
      onError: () => {},
    })
      .then((p) => {
        if (disposed) return p.dispose();
        playerRef.current = p;
        const reduce = matchMedia("(prefers-reduced-motion: reduce)");
        p.setReducedMotion(reduce.matches);
        p.setInput("mode", MODE_INPUT[modeRef.current]);
        p.play();
        canvas.dataset.ready = "1";
      })
      .catch((e) => {
        console.warn("[orb] player failed", e);
        setFailed(true);
      });
    return () => {
      disposed = true;
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    playerRef.current?.setInput("mode", MODE_INPUT[mode]);
  }, [mode]);

  return (
    <span className={`orb orb-${mode}`} style={{ width: size, height: size }} data-mode={mode} aria-hidden="true">
      {failed ? <span className="orb-fallback" /> : <canvas ref={canvasRef} width={240} height={240} style={{ width: size, height: size }} />}
    </span>
  );
}
