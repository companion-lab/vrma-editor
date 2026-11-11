import { useCallback } from 'react';
import { useEditor } from '../store';

/**
 * Sidebar resize handle: drag the panel's inner edge to change its width,
 * double-click to reset. Mirrors the timeline footer's top handle —
 * window-level listeners so the drag keeps working over the viewport.
 */
export function PanelResizeHandle({ edge }: { edge: 'right' | 'left' }) {
  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const st = useEditor.getState();
      const startW = edge === 'right' ? st.leftW : st.rightW;
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      const onMove = (ev: PointerEvent) => {
        const w = edge === 'right' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX);
        const s = useEditor.getState();
        if (edge === 'right') s.setLeftW(w);
        else s.setRightW(w);
      };
      const onUp = () => {
        document.body.style.userSelect = prevSelect;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [edge],
  );

  return (
    <div
      className={`panel-resize ${edge}`}
      title="Drag to resize · double-click to reset"
      onPointerDown={onResizeDown}
      onDoubleClick={() => {
        const st = useEditor.getState();
        if (edge === 'right') st.setLeftW(220);
        else st.setRightW(270);
      }}
    />
  );
}
