/**
 * ParticleWaveBackground — Bright-style dot-matrix wave animated background (pure Canvas, zero external dependencies).
 *
 * Visually inspired by React Bits' Particles / DotGrid: a dot grid whose rise and fall is driven by multiple layered sine waves,
 * dot radius and opacity vary with the wave crest, producing soft ripples with a "breathing" feel.
 *
 * Why not install the React Bits package directly:
 *   Its Particles / DotGrid / Aurora depend on ogl / gsap / three respectively, none of which is installed in this project.
 *   Implemented the manual way recommended officially by React Bits (copying the source into the project), avoiding new runtime dependencies
 *   and build risks while keeping fully controllable visual tuning.
 *
 * Implementation notes:
 *   - devicePixelRatio handling, to avoid blurriness on high-DPI screens;
 *   - ResizeObserver tracks the container size; does not listen on window so multiple instances do not interfere with each other;
 *   - Respect prefers-reduced-motion: when reduced motion is preferred, render one static frame and do not start rAF;
 *   - Cancel rAF and the observer on unmount; no memory leaks.
 */
import { useEffect, useRef } from 'react';

export interface ParticleWaveBackgroundProps {
  /** Dot grid spacing (px); smaller is denser. Default 26 26 */
  gap?: number;
  /** Base dot radius (px). Default 1.5 1.5 */
  dotRadius?: number;
  /** Dot color, must be in `r, g, b` form (opacity is computed internally from the wave crest). Default dark gray-blue */
  color?: string;
  /** Animation speed factor, default 1 1 */
  speed?: number;
  /** Additional class name */
  className?: string;
}

export default function ParticleWaveBackground({
  gap = 26,
  dotRadius = 1.5,
  color = '100, 116, 139',
  speed = 1,
  className,
}: ParticleWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let width = 0;
    let height = 0;
    let disposed = false;

    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      // Use setTransform instead of scale to avoid the scale factor accumulating after repeated resizes
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Render one frame. Three sine waves with different frequencies/phases are summed to get an intensity field in [-1, 1];
     * intensity is mapped to dot radius and opacity, producing a dot-matrix ripple with light/dark variation.
     *
     * Parameter notes: the time factor determines "how fast it looks like it moves". When too small (<0.5), a single wave period can last
     * a dozen-plus seconds, so the eye can barely tell it is moving and it looks like a static image; here 0.65~1.15 gives the main wave a period of about 5
     * seconds, which clearly conveys flow without being dazzling.
     */
    function draw(elapsedMs: number) {
      if (width <= 0 || height <= 0) return;
      const t = (elapsedMs / 1000) * speed;
      ctx!.clearRect(0, 0, width, height);

      const cols = Math.ceil(width / gap) + 1;
      const rows = Math.ceil(height / gap) + 1;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * gap;
          const y = row * gap;
          // Normalized coordinates keep the waveform from distorting with canvas size
          const nx = x / Math.max(width, 1);
          const ny = y / Math.max(height, 1);

          // The main wave flows right to left, with two other layers at different angles added, to avoid regular stripes
          const wave =
            Math.sin(nx * 7.5 - t * 1.15) * 0.45 +
            Math.sin(ny * 5.5 + t * 0.75) * 0.28 +
            Math.sin((nx * 3.2 + ny * 4.1) + t * 0.95) * 0.27;

          // wave ∈ roughly [-1, 1] → intensity ∈ [0, 1]
          const intensity = (wave + 1) / 2;
          // Power-curve compression of the dark areas makes crests stand out and troughs cleaner, giving clearer contrast
          const shaped = Math.pow(intensity, 1.4);
          // Slightly lighter at the top and more solid at the bottom, reinforcing the bright "light from above" feel
          const depth = 0.6 + ny * 0.4;
          const alpha = (0.08 + shaped * 0.5) * depth;
          const radius = dotRadius * (0.45 + shaped * 1.15);
          if (alpha <= 0.01 || radius <= 0.05) continue;

          ctx!.beginPath();
          ctx!.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
          ctx!.arc(x, y, radius, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    function loop(now: number) {
      if (disposed) return;
      draw(now);
      rafId = window.requestAnimationFrame(loop);
    }

    resize();

    const observer = new ResizeObserver(() => {
      resize();
      // When reduced motion is preferred, rAF does not run; after a resize one frame must be redrawn manually
      if (reduceMotion) draw(0);
    });
    const parent = canvas.parentElement;
    if (parent) observer.observe(parent);

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = window.requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [gap, dotRadius, color, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
