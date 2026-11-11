import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Trash2 } from 'lucide-react';
import { useEditor } from '../store';
import { buildBoneRows, prettyBoneName } from '../lib/humanoid';
import { HIPS_TRACK_ID } from '../store';
import { PanelResizeHandle } from './PanelResize';

interface Row {
  name: string;
  depth: number;
  hasChildren: boolean;
}

export function BoneTree() {
  const vrm = useEditor((s) => s.vrm);
  const selectedBone = useEditor((s) => s.selectedBone);
  const selectedBones = useEditor((s) => s.selectedBones);
  const rotTracks = useEditor((s) => s.rotTracks);
  const hipsTrack = useEditor((s) => s.hipsTrack);
  const leftW = useEditor((s) => s.leftW);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const rows = useMemo<Row[]>(() => {
    if (!vrm?.humanoid) return [];
    const flat = buildBoneRows(Object.keys(vrm.humanoid.humanBones));
    return flat.map((row, i) => ({
      ...row,
      hasChildren: i + 1 < flat.length && flat[i + 1].depth > row.depth,
    }));
  }, [vrm]);

  // Accordion: hide rows under a collapsed ancestor. A parent's subtree runs
  // until a row at equal-or-shallower depth appears.
  const visibleRows = useMemo(() => {
    const out: Row[] = [];
    let blockDepth = Infinity;
    for (const row of rows) {
      if (row.depth <= blockDepth) blockDepth = Infinity;
      if (row.depth > blockDepth) continue;
      out.push(row);
      if (row.hasChildren && collapsed.has(row.name)) blockDepth = row.depth;
    }
    return out;
  }, [rows, collapsed]);

  const parents = useMemo(() => rows.filter((r) => r.hasChildren).map((r) => r.name), [rows]);
  const allCollapsed = parents.length > 0 && parents.every((p) => collapsed.has(p));

  const toggleFold = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    setCollapsed(allCollapsed ? new Set() : new Set(parents));
  };

  const hasKeys = (bone: string) =>
    bone === HIPS_TRACK_ID
      ? hipsTrack.length > 0
      : (rotTracks[bone]?.length ?? 0) > 0;

  const onBoneClick = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    const st = useEditor.getState();
    if (e.shiftKey) st.selectBoneRange(name);
    else if (e.ctrlKey || e.metaKey) st.toggleBoneSelection(name);
    else st.selectBone(name);
  };

  return (
    <div className="panel bone-tree" style={{ width: leftW }}>
      <PanelResizeHandle edge="right" />
      <div className="panel-title">
        <span>
          Humanoid bones
          {selectedBones.length > 1 && <span className="sel-count"> · {selectedBones.length} selected</span>}
        </span>
        {parents.length > 0 && (
          <button
            className="title-btn"
            title={allCollapsed ? 'Expand all bone groups' : 'Collapse all bone groups'}
            onClick={toggleAll}
          >
            {allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </button>
        )}
        <button
          className="title-btn"
          title="Remove all keyframes of the selected bones (Shift+Del)"
          onClick={() => useEditor.getState().deleteSelectedBonesKeys()}
        >
          <Trash2 size={14} />
        </button>
        <button
          className="title-btn"
          title="Hide panel (toolbar toggle brings it back)"
          onClick={() => useEditor.getState().setLeftOpen(false)}
        >
          <ChevronLeft size={14} />
        </button>
      </div>
      <div className="panel-body">
        {rows.length === 0 && <div className="muted pad">Load a VRM model to list its bones.</div>}
        {visibleRows.map((row) => (
          <div
            key={row.name}
            className={`bone-item ${selectedBones.includes(row.name) ? 'selected' : ''} ${selectedBone === row.name ? 'primary' : ''}`}
            style={{ paddingLeft: 10 + row.depth * 14 }}
            onClick={(e) => onBoneClick(e, row.name)}
            title={`${row.name}\nClick: select · Ctrl/Cmd+click: multi-select · Shift+click: range${row.hasChildren ? '\nChevron: fold/unfold' : ''}`}
          >
            <span className="bone-row-left">
              {row.hasChildren ? (
                <button
                  className={`bone-caret ${collapsed.has(row.name) ? '' : 'open'}`}
                  title={collapsed.has(row.name) ? 'Expand children' : 'Collapse children'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFold(row.name);
                  }}
                >
                  <ChevronRight size={12} />
                </button>
              ) : (
                <span className="bone-caret-spacer" />
              )}
              <span className="bone-name">{prettyBoneName(row.name)}</span>
            </span>
            {hasKeys(row.name) && <span className="key-dot" />}
          </div>
        ))}
      </div>
    </div>
  );
}
