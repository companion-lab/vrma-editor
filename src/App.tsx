import { useEffect } from 'react';
import { Toolbar } from './components/Toolbar';
import { BoneTree } from './components/BoneTree';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline';
import { Viewport } from './components/Viewport';
import { useEditor } from './store';

export default function App() {
  const leftOpen = useEditor((s) => s.leftOpen);
  const rightOpen = useEditor((s) => s.rightOpen);

  // Confirm before refresh/close when there are keyframes to lose.
  // Browsers only allow their native dialog on unload — a custom modal
  // cannot be shown here, so we trigger the browser's own confirmation.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const st = useEditor.getState();
      const hasWork =
        Object.values(st.rotTracks).some((k) => (k?.length ?? 0) > 0) ||
        st.hipsTrack.length > 0;
      if (!hasWork) return;
      e.preventDefault();
      e.returnValue = ''; // required by Chrome/Edge to show the dialog
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if (inInput) return;

      const st = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (e.code === 'Space') {
        e.preventDefault();
        st.togglePlay();
      } else if (e.key.toLowerCase() === 'k') {
        st.keySelectedBone();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.shiftKey) st.deleteSelectedBonesKeys();
        else st.deleteSelectedKey();
      } else if (e.key === 'Home') {
        st.setTime(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        {leftOpen && <BoneTree />}
        <Viewport />
        {rightOpen && <Inspector />}
      </div>
      <Timeline />
    </div>
  );
}
