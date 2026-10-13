import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Draggable divider hook
 * @param initial  initial width (px)
 * @param min      minimum width (px)
 * @param max      maximum width (px)
 * @param side     drag edge: 'left' means the left panel width is adjustable, 'right' means the right panel width is adjustable
 */
export function useResizable(initial: number, min: number, max: number, side: 'left' | 'right' = 'left') {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newW = side === 'left'
        ? Math.max(min, Math.min(max, startW.current + delta))
        : Math.max(min, Math.min(max, startW.current - delta));
      setWidth(newW);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [min, max, side]);

  return { width, onMouseDown };
}
