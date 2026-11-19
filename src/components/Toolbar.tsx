import { useEffect, useRef, useState } from 'react';
import {
  Bone,
  Bot,
  ChevronDown,
  Check,
  Download,
  FilePlus2,
  FileInput,
  Film,
  FolderOpen,
  FolderSearch,
  PanelLeft,
  PanelRight,
  Redo2,
  Save,
  Sparkles,
  Sun,
  Moon,
  Undo2,
  X,
} from 'lucide-react';
import { useEditor, makeSampleData, countModelEdits } from '../store';
import { parseVRMA } from '../lib/vrma/parse';
import { buildVRMA } from '../lib/vrma/build';
import { exportEditedModel } from '../lib/vrmedit/exportModel';

export function Toolbar() {
  const modelName = useEditor((s) => s.modelName);
  const status = useEditor((s) => s.status);
  const animName = useEditor((s) => s.animName);
  const leftOpen = useEditor((s) => s.leftOpen);
  const rightOpen = useEditor((s) => s.rightOpen);
  const showSkeleton = useEditor((s) => s.showSkeleton);
  const modelLibrary = useEditor((s) => s.modelLibrary);
  const modelUrl = useEditor((s) => s.modelUrl);
  const motionVideoName = useEditor((s) => s.motionVideoName);
  const theme = useEditor((s) => s.theme);
  const editCount = useEditor((s) => countModelEdits(s.modelEdits));
  const modelInputRef = useRef<HTMLInputElement>(null);
  const vrmaInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const modelsWrapRef = useRef<HTMLDivElement>(null);

  // Auto-clear status messages.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => useEditor.setState({ status: null }), 5000);
    return () => clearTimeout(t);
  }, [status]);

  // Load the model library listing once.
  useEffect(() => {
    useEditor.getState().fetchModelLibrary();
  }, []);

  // Close the models dropdown on outside click.
  useEffect(() => {
    if (!modelsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!modelsWrapRef.current?.contains(e.target as Node)) setModelsOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [modelsOpen]);

  const openModel = async (file: File) => {
    const url = URL.createObjectURL(file);
    const prev = useEditor.getState().modelUrl;
    if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
    useEditor.getState().setModelUrl(url, file.name);
  };

  const openMotionVideo = (file: File) => {
    const url = URL.createObjectURL(file);
    const prev = useEditor.getState().motionVideoUrl;
    if (prev) URL.revokeObjectURL(prev);
    useEditor.getState().setMotionVideo(url, file.name);
    useEditor
      .getState()
      .setStatus('ok', `Motion video "${file.name}" loaded — open the Motion tab to track it into an animation`);
  };

  const clearMotionVideo = () => {
    const prev = useEditor.getState().motionVideoUrl;
    if (prev) URL.revokeObjectURL(prev);
    useEditor.getState().setMotionVideo(null, null);
  };

  const importVRMA = async (file: File) => {
    try {
      const data = parseVRMA(await file.arrayBuffer());
      useEditor.getState().importAnim(data);
      useEditor
        .getState()
        .setStatus('ok', `Imported "${data.name}" (${data.duration.toFixed(2)}s)`);
    } catch (err) {
      console.error(err);
      useEditor.getState().setStatus('error', `VRMA import failed: ${(err as Error).message}`);
    }
  };

  const exportVRMA = () => {
    const st = useEditor.getState();
    const keyCount =
      Object.values(st.rotTracks).reduce((n, k) => n + (k?.length ?? 0), 0) +
      st.hipsTrack.length +
      Object.values(st.exprTracks).reduce((n, k) => n + k.length, 0);
    if (keyCount === 0) {
      st.setStatus('info', 'Nothing to export — add some keyframes first');
      return;
    }
    setExporting(true);
    try {
      const buffer = buildVRMA(st.getAnimData());
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(animName || 'animation').replace(/[^\w\-]+/g, '_')}.vrma`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      st.setStatus('ok', `Exported ${(buffer.byteLength / 1024).toFixed(1)} KB VRMA`);
    } catch (err) {
      console.error(err);
      st.setStatus('error', `Export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const saveModel = async () => {
    const st = useEditor.getState();
    if (!st.modelUrl || !st.vrm) return;
    setSaving(true);
    try {
      const bytes = st.originalModelBytes ?? (await (await fetch(st.modelUrl)).arrayBuffer());
      // Re-read after the (possible) fetch so the newest edits go out.
      const cur = useEditor.getState();
      const out = await exportEditedModel(bytes, cur.modelEdits, cur.modelAssociations, cur.worn);
      const blob = new Blob([out], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${st.modelName.replace(/\.(vrm|glb|gltf)$/i, '')}-edited.vrm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      st.setStatus('ok', `Saved edited model (${(out.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.error(err);
      st.setStatus('error', `Save model failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const currentLibraryName = modelLibrary.find((m) => m.url === modelUrl)?.name;

  return (
    <div className="toolbar">
      <div className="brand">
        VRMA <span>Editor</span>
      </div>

      <div className="vsep" />

      <div className="dropdown-wrap" ref={modelsWrapRef}>
        <button
          className={`btn ${modelsOpen ? 'active' : ''}`}
          onClick={() => setModelsOpen((v) => !v)}
          title="Choose a model from the library (assets/models) or open a file"
        >
          <FolderSearch size={14} /> Models <ChevronDown size={12} />
        </button>
        {modelsOpen && (
          <div className="dropdown">
            {modelLibrary.length === 0 && <div className="dropdown-empty">Library is empty</div>}
            {modelLibrary.map((m) => (
              <button
                key={m.url}
                className={`dropdown-item ${m.url === modelUrl ? 'current' : ''}`}
                title={m.name}
                onClick={() => {
                  setModelsOpen(false);
                  if (m.url !== modelUrl) useEditor.getState().openLibraryModel(m.name);
                }}
              >
                <span className="dropdown-item-name">{m.name}</span>
                {m.url === modelUrl && <Check size={13} />}
              </button>
            ))}
            <div className="dropdown-sep" />
            <button
              className="dropdown-item"
              onClick={() => {
                setModelsOpen(false);
                modelInputRef.current?.click();
              }}
            >
              <FolderOpen size={13} /> Open file…
            </button>
          </div>
        )}
      </div>
      <input
        ref={modelInputRef}
        type="file"
        accept=".vrm,.glb,.gltf"
        hidden
        onChange={(e) => e.target.files?.[0] && openModel(e.target.files[0])}
      />
      <span className="model-name" title={modelName}>
        {currentLibraryName ?? modelName}
      </span>

      <div className="vsep" />

      <button className="btn" onClick={() => vrmaInputRef.current?.click()} title="Import a .vrma animation">
        <FileInput size={14} /> Import
      </button>
      <input
        ref={vrmaInputRef}
        type="file"
        accept=".vrma,.glb,.gltf"
        hidden
        onChange={(e) => e.target.files?.[0] && importVRMA(e.target.files[0])}
      />
      <button className="btn" onClick={exportVRMA} disabled={exporting} title="Export the animation as .vrma">
        <Download size={14} /> Export VRMA
      </button>

      <div className="vsep" />

      <button className="btn" onClick={() => useEditor.getState().newAnim()} title="Clear the animation">
        <FilePlus2 size={14} /> New
      </button>
      <button
        className="btn"
        onClick={() => useEditor.getState().importAnim(makeSampleData())}
        title="Load a built-in sample animation (a wave)"
      >
        <Sparkles size={14} /> Sample
      </button>

      <div className="vsep" />

      <button
        className={`btn ${motionVideoName ? 'active' : ''}`}
        onClick={() => videoInputRef.current?.click()}
        title={
          motionVideoName
            ? `Motion reference video: ${motionVideoName} — click to replace`
            : 'Load a motion-reference video — the AI can extract the person\u2019s motion from it'
        }
      >
        <Film size={14} /> Motion video
      </button>
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
        hidden
        onChange={(e) => e.target.files?.[0] && openMotionVideo(e.target.files[0])}
      />
      {motionVideoName && (
        <>
          <span className="model-name" title={motionVideoName}>
            {motionVideoName}
          </span>
          <button className="btn icon" onClick={clearMotionVideo} title="Remove the motion reference video">
            <X size={13} />
          </button>
        </>
      )}

      <div className="vsep" />

      <button
        className={`btn ${editCount > 0 ? 'accent' : ''}`}
        onClick={saveModel}
        disabled={saving || !modelUrl || editCount === 0}
        title={
          editCount === 0
            ? 'No model edits yet — edit the model in the Model tab'
            : 'Download the model with your edits baked in (.vrm)'
        }
      >
        <Save size={14} /> Save model{editCount > 0 ? ` (${editCount})` : ''}
      </button>

      <div className="spacer" />

      {status && <div className={`status ${status.kind}`}>{status.msg}</div>}

      <button
        className="btn icon"
        title="Open the AI assistant panel"
        onClick={() => {
          const st = useEditor.getState();
          st.setRightTab('ai');
          st.setRightOpen(true);
        }}
      >
        <Bot size={15} />
      </button>

      <button
        className={`btn icon ${showSkeleton ? 'active' : ''}`}
        title={showSkeleton ? 'Hide skeleton (x-ray)' : 'Show skeleton (x-ray) — click bones to select'}
        onClick={() => useEditor.getState().setShowSkeleton(!showSkeleton)}
      >
        <Bone size={15} />
      </button>

      <button
        className={`btn icon ${leftOpen ? 'active' : ''}`}
        title={leftOpen ? 'Hide bone tree panel' : 'Show bone tree panel'}
        onClick={() => useEditor.getState().setLeftOpen(!leftOpen)}
      >
        <PanelLeft size={15} />
      </button>
      <button
        className={`btn icon ${rightOpen ? 'active' : ''}`}
        title={rightOpen ? 'Hide inspector panel' : 'Show inspector panel'}
        onClick={() => useEditor.getState().setRightOpen(!rightOpen)}
      >
        <PanelRight size={15} />
      </button>

      <button
        className="btn icon"
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => useEditor.getState().setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>

      <button
        className="btn icon"
        title="Undo (Ctrl+Z)"
        onClick={() => useEditor.getState().undo()}
      >
        <Undo2 size={15} />
      </button>
      <button
        className="btn icon"
        title="Redo (Ctrl+Shift+Z)"
        onClick={() => useEditor.getState().redo()}
      >
        <Redo2 size={15} />
      </button>
    </div>
  );
}
