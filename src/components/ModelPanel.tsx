// VRM Studio-style model editor: materials, expressions, meta and proportions.
// Everything edits the live three.js model for instant preview and records the
// edit in the store; "Save model" (toolbar) bakes it into the original file.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderOpen, Image as ImageIcon, Paintbrush, Plus, RotateCcw, Shirt, X } from 'lucide-react';
import { useEditor, type ModelEdits, type OutfitPreset } from '../store';
import { getDonor, loadDonor, WEARABLE_CATEGORIES, type DonorSource } from '../lib/wardrobe/sources';
import {
  applyAllBoneScales,
  applyFaceShape,
  applyExpressionWeight,
  applyMaterialEdit,
  applyTextureReplacement,
  boneHasNode,
  collectMaterials,
  expressionNames,
  materialsFor,
  resetMaterialLive,
  textureThumbDataUrl,
} from '../lib/vrmedit/live';
import {
  applyAssetVisibilityAll,
  collectParts,
  collectWholeMeshes,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  classifyAsset,
  type AssetPart,
} from '../lib/vrmedit/parts';
import { TexturePainter } from './TexturePainter';
import {
  BODY_SHAPE_MAX,
  BODY_SHAPE_MIN,
  BODY_SHAPE_PARAMS,
  PROPORTION_GROUPS,
  PROPORTION_MAX,
  PROPORTION_MIN,
} from '../lib/vrmedit/proportions';
import {
  BROW_SWATCHES,
  COLOR_GROUPS,
  EYE_ADJ_BONES,
  EYE_SWATCHES,
  HAIR_SWATCHES,
  SKIN_SWATCHES,
  materialGroup,
} from '../lib/vrmedit/appearance';

const COLOR_SPACE = THREE.SRGBColorSpace;

function linearToHex(rgb: [number, number, number]): string {
  const c = new THREE.Color();
  c.setRGB(rgb[0], rgb[1], rgb[2]);
  return `#${c.getHexString(COLOR_SPACE)}`;
}

function hexToLinear(hex: string): [number, number, number] {
  const c = new THREE.Color();
  c.setStyle(hex, COLOR_SPACE);
  return [c.r, c.g, c.b];
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="panel-body-inner">
      <button className="section-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {title}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

// --- Materials ---

type AlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

function readAlphaMode(m: THREE.Material | undefined): AlphaMode {
  if (!m) return 'OPAQUE';
  if (m.transparent) return 'BLEND';
  if (m.alphaTest > 0) return 'MASK';
  return 'OPAQUE';
}

function MaterialRow({ name, edits, onPaint }: { name: string; edits: ModelEdits; onPaint: (name: string) => void }) {
  const vrm = useEditor((s) => s.vrm);
  const textureLibrary = useEditor((s) => s.textureLibrary);
  const [open, setOpen] = useState(false);
  const edit = edits.materials[name];
  const [textureBusy, setTextureBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textureInputRef = useRef<HTMLInputElement>(null);

  const live = useMemo(
    () =>
      (vrm
        ? (materialsFor(vrm, name)[0] as THREE.Material & {
            color?: THREE.Color;
            emissive?: THREE.Color;
          })
        : undefined),
    [vrm, name],
  );
  const thumb = useMemo(() => (vrm ? textureThumbDataUrl(vrm, name, 44) : null), [vrm, name, edit?.textureFile]);

  if (!vrm) return null;
  const color = edit?.color ?? (live?.color ? ([live.color.r, live.color.g, live.color.b] as [number, number, number]) : null);
  const opacity = edit?.opacity ?? live?.opacity ?? 1;
  const alphaMode = edit?.alphaMode ?? readAlphaMode(live);
  const emissive = edit?.emissive ?? (live?.emissive ? ([live.emissive.r, live.emissive.g, live.emissive.b] as [number, number, number]) : null);
  const doubleSided = edit?.doubleSided ?? live?.side === THREE.DoubleSide;
  const edited = edit != null;

  const patch = (p: Parameters<typeof applyMaterialEdit>[2]) => {
    // Record the edit, then apply the merged result live so preview always
    // matches what "Save model" will bake in.
    const merged = { ...edit, ...p };
    useEditor.getState().setMaterialEdit(name, p);
    applyMaterialEdit(vrm, name, merged);
  };

  const replaceTexture = async (file: File) => {
    setTextureBusy(true);
    try {
      await applyTextureReplacement(vrm, name, file);
      useEditor.getState().setMaterialEdit(name, { textureFile: file, textureName: file.name });
    } catch (err) {
      console.error(err);
      useEditor.getState().setStatus('error', `Texture load failed: ${(err as Error).message}`);
    } finally {
      setTextureBusy(false);
    }
  };

  const useLibraryTexture = async (tex: { name: string; url: string }) => {
    setPickerOpen(false);
    setTextureBusy(true);
    try {
      const blob = await (await fetch(tex.url)).blob();
      await replaceTexture(new File([blob], tex.name, { type: blob.type || 'image/png' }));
    } catch (err) {
      console.error(err);
      useEditor.getState().setStatus('error', `Texture load failed: ${(err as Error).message}`);
      setTextureBusy(false);
    }
  };

  const openPicker = () => {
    if (textureLibrary.length === 0) useEditor.getState().fetchTextureLibrary();
    setPickerOpen((v) => !v);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = [...(e.dataTransfer.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) replaceTexture(file);
  };

  return (
    <div
      className={`mat-row ${edited ? 'edited' : ''} ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <button className="mat-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {thumb ? (
          <img className="tex-thumb" src={thumb} alt="" draggable={false} />
        ) : (
          color && <span className="color-dot" style={{ background: linearToHex(color) }} />
        )}
        <span className="mat-name" title={name}>{name}</span>
        {edited && <span className="edit-badge">edited</span>}
      </button>
      {open && (
        <div className="mat-controls">
          {color && (
            <label className="ctl-row">
              <span>Color</span>
              <input
                type="color"
                value={linearToHex(color)}
                onChange={(e) => patch({ color: hexToLinear(e.target.value) })}
              />
            </label>
          )}
          {emissive && (
            <label className="ctl-row">
              <span>Emissive</span>
              <input
                type="color"
                value={linearToHex(emissive)}
                onChange={(e) => patch({ emissive: hexToLinear(e.target.value) })}
              />
            </label>
          )}
          <div className="ctl-row">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity}
              onChange={(e) => patch({ opacity: parseFloat(e.target.value) })}
            />
            <span className="ctl-val">{opacity.toFixed(2)}</span>
          </div>
          <label className="ctl-row">
            <span>Transparency</span>
            <select
              value={alphaMode}
              onChange={(e) => patch({ alphaMode: e.target.value as AlphaMode })}
            >
              <option value="OPAQUE">Opaque</option>
              <option value="MASK">Cutout</option>
              <option value="BLEND">Blend</option>
            </select>
          </label>
          <label className="ctl-row">
            <span>Double-sided</span>
            <input
              type="checkbox"
              checked={doubleSided}
              onChange={(e) => patch({ doubleSided: e.target.checked })}
            />
          </label>
          <div className="ctl-row texture-row">
            <span>Texture</span>
            {thumb && (
              <img
                className="tex-thumb tex-thumb-btn"
                src={thumb}
                alt=""
                draggable={false}
                title="Open texture painter"
                onClick={() => onPaint(name)}
              />
            )}
            <span className="tex-name" title={edit?.textureName ?? ''}>
              {textureBusy ? 'loading…' : (edit?.textureName ?? 'model texture')}
            </span>
          </div>
          <div className="btn-row">
            <button className={`btn small ${pickerOpen ? 'active' : ''}`} onClick={openPicker}>
              <ImageIcon size={12} /> Library
            </button>
            <button className="btn small" onClick={() => textureInputRef.current?.click()}>
              <FolderOpen size={12} /> File…
            </button>
            <button className="btn small" onClick={() => onPaint(name)} title="Paint this texture manually">
              <Paintbrush size={12} /> Paint
            </button>
            <input
              ref={textureInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp"
              hidden
              onChange={(e) => e.target.files?.[0] && replaceTexture(e.target.files[0])}
            />
          </div>
          <div className="muted small-note">or drop an image anywhere on this row</div>
          {pickerOpen && (
            <div className="tex-picker">
              {textureLibrary.length === 0 && (
                <div className="muted pad">
                  Library is empty — drop .png/.jpg files into <b>assets/textures/</b>
                </div>
              )}
              <div className="tex-grid">
                {textureLibrary.map((t) => (
                  <button
                    key={t.url}
                    className="tex-cell"
                    title={t.name}
                    onClick={() => useLibraryTexture(t)}
                  >
                    <img src={t.url} alt={t.name} loading="lazy" draggable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            className="btn small"
            onClick={() => {
              useEditor.getState().resetMaterialEdit(name);
              resetMaterialLive(vrm, name);
            }}
            title="Drop all edits on this material and restore the original look"
          >
            <RotateCcw size={12} /> Reset edits
          </button>
        </div>
      )}
    </div>
  );
}

function MaterialsSection({ edits, onPaint }: { edits: ModelEdits; onPaint: (name: string) => void }) {
  const vrm = useEditor((s) => s.vrm);
  const names = useMemo(() => {
    if (!vrm) return [];
    const seen = new Set<string>();
    for (const m of collectMaterials(vrm)) {
      const base = m.name.replace(/ \(Outline\)$/, '');
      seen.add(base);
    }
    return [...seen];
  }, [vrm]);
  if (names.length === 0) return <div className="muted pad">No materials.</div>;
  return (
    <>
      {names.map((n) => (
        <MaterialRow key={n} name={n} edits={edits} onPaint={onPaint} />
      ))}
    </>
  );
}

// --- Wardrobe (wear parts from other VRM files) ---

function wornLabel(donor: string, id: string): string {
  return getDonor(donor)?.parts.find((p) => p.id === id)?.label ?? id;
}

function WardrobeSection() {
  const worn = useEditor((s) => s.worn);
  const library = useEditor((s) => s.wardrobeLibrary);
  const [donorState, setDonorState] = useState<Record<string, 'loading' | 'ready' | 'error'>>({});
  const [donorParts, setDonorParts] = useState<{ donor: string; parts: AssetPart[] }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    useEditor.getState().fetchWardrobeLibrary();
  }, []);

  const addDonor = (donor: DonorSource) => {
    setDonorParts((list) => [
      ...list.filter((e) => e.donor !== donor.name),
      { donor: donor.name, parts: donor.parts.filter((p) => WEARABLE_CATEGORIES.includes(p.category)) },
    ]);
  };

  // Load every library donor in the background so the list below covers all
  // available styles without the user picking a donor first.
  useEffect(() => {
    let alive = true;
    (async () => {
      const selfName = useEditor.getState().modelName;
      for (const d of library) {
        // The current model is not its own wardrobe donor — its pieces are the
        // Assets section's toggles, and self-wear would be a no-op.
        if (d.name === selfName) continue;
        const cached = getDonor(d.name);
        if (cached) {
          addDonor(cached);
          continue;
        }
        setDonorState((s) => ({ ...s, [d.name]: 'loading' }));
        try {
          const donor = await loadDonor(d.name, d.url);
          if (!alive) return;
          addDonor(donor);
          setDonorState((s) => ({ ...s, [d.name]: 'ready' }));
        } catch (err) {
          console.error(err);
          if (!alive) return;
          setDonorState((s) => ({ ...s, [d.name]: 'error' }));
          useEditor.getState().setStatus('error', `Wardrobe load failed: ${(err as Error).message}`);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [library]);

  const loadFile = async (file: File) => {
    setDonorState((s) => ({ ...s, [file.name]: 'loading' }));
    try {
      const donor = await loadDonor(file.name, URL.createObjectURL(file));
      addDonor(donor);
      setDonorState((s) => ({ ...s, [file.name]: 'ready' }));
      useEditor.getState().setStatus('ok', `Wardrobe "${file.name}" loaded`);
    } catch (err) {
      console.error(err);
      setDonorState((s) => ({ ...s, [file.name]: 'error' }));
      useEditor.getState().setStatus('error', `Wardrobe load failed: ${(err as Error).message}`);
    }
  };

  // All donors' wearable parts in one list, grouped by category (top → … → other).
  const blocks = useMemo(() => {
    const list = donorParts
      .flatMap(({ donor, parts }) => parts.map((p) => ({ donor, p })))
      .sort(
        (a, b) =>
          CATEGORY_ORDER.indexOf(a.p.category) - CATEGORY_ORDER.indexOf(b.p.category) ||
          a.p.label.localeCompare(b.p.label) ||
          a.donor.localeCompare(b.donor),
      );
    const out: { category: AssetPart['category']; rows: { donor: string; p: AssetPart }[] }[] = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last?.category === r.p.category) last.rows.push(r);
      else out.push({ category: r.p.category, rows: [r] });
    }
    return out;
  }, [donorParts]);

  const isWorn = (donor: string, id: string) => worn.some((w) => w.donor === donor && w.id === id);
  const loadingCount = Object.values(donorState).filter((s) => s === 'loading').length;
  const errorCount = Object.values(donorState).filter((s) => s === 'error').length;

  return (
    <div className="assets-body">
      {library.length > 0 && (
        <div className="outfit-chips">
          {library.map((d) => (
            <span
              key={d.url}
              className={`outfit-chip static ${donorState[d.name] === 'error' ? 'donor-error' : ''}`}
              title={
                donorState[d.name] === 'error'
                  ? `Failed to load "${d.name}"`
                  : `Style source: ${d.name}`
              }
            >
              <Shirt size={11} /> {donorState[d.name] === 'loading' ? `${d.name} (loading…)` : d.name}
            </span>
          ))}
        </div>
      )}
      <div className="outfit-save">
        <button className="btn small" onClick={() => fileRef.current?.click()}>
          <Plus size={12} /> Load file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".vrm,.glb,.gltf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.target.value = '';
          }}
        />
        {worn.length > 0 && (
          <button
            className="btn small"
            title="Take off everything worn from wardrobe donors"
            onClick={() => useEditor.getState().clearWorn()}
          >
            <X size={12} /> Clear all
          </button>
        )}
      </div>

      {worn.length > 0 && (
        <div className="outfit-chips">
          {worn.map((w) => (
            <span key={`${w.donor}:${w.id}`} className="outfit-chip active">
              <button
                className="outfit-apply"
                title="Take this part off"
                onClick={() => useEditor.getState().unwearPart(w.donor, w.id)}
              >
                {wornLabel(w.donor, w.id)}
              </button>
              <button
                className="outfit-del"
                title={`Take off "${wornLabel(w.donor, w.id)}"`}
                onClick={() => useEditor.getState().unwearPart(w.donor, w.id)}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mesh-list-wrap">
        <div className="mesh-list">
          {blocks.length === 0 &&
            (donorParts.length === 0 ? (
              <div className="muted pad">
                {loadingCount > 0 || (library.length > 0 && errorCount === 0)
                  ? 'Loading style donors…'
                  : errorCount > 0
                    ? 'Couldn’t load the donor styles — check the status bar.'
                    : 'No donor styles yet — click “Load file…” to open a .vrm with hair / clothes, or drop files into assets/wardrobe/.'}
              </div>
            ) : (
              <div className="muted pad">No wearable parts in these files.</div>
            ))}
          {blocks.map((b) => (
            <div key={b.category} className="asset-cat">
              <div className="asset-cat-head">{CATEGORY_LABEL[b.category]}</div>
              {b.rows.map(({ donor, p }) => {
                const on = isWorn(donor, p.id);
                return (
                  <button
                    key={`${donor}:${p.id}`}
                    className={`mesh-row ${on ? 'worn-part' : ''}`}
                    title={
                      on
                        ? 'Take this part off'
                        : `Wear this part from "${donor}" (hides your model’s own pieces of this kind)`
                    }
                    onClick={() =>
                      on
                        ? useEditor.getState().unwearPart(donor, p.id)
                        : useEditor.getState().wearPart(donor, p.id, p.category)
                    }
                  >
                    {on ? <Eye size={12} /> : <Shirt size={12} />}
                    <span className="mesh-name" title={p.label}>{p.label}</span>
                    <span className="asset-owner" title={`From "${donor}"`}>{donor}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {blocks.length > 0 && (
          <div className="muted small-note">
            wearing a donor part hides your model’s own pieces of the same kind · the look bakes into “Save model”
          </div>
        )}
      </div>
    </div>
  );
}

// --- Assets (clothes / hair / parts visibility + outfits) ---

interface AssetEntry {
  kind: 'part' | 'mesh';
  id: string;
  label: string;
  category: (typeof CATEGORY_ORDER)[number];
  meshName: string;
}

function sameVisibility(p: OutfitPreset, edits: ModelEdits): boolean {
  const eq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v) => b.includes(v));
  return eq(p.hiddenMeshes, edits.hiddenMeshes) && eq(p.hiddenParts, edits.hiddenParts);
}

function OutfitsBar() {
  const vrm = useEditor((s) => s.vrm);
  const edits = useEditor((s) => s.modelEdits);
  const forModel = useEditor((s) => s.outfits[s.modelName]);
  const presets = useMemo(() => forModel?.presets ?? [], [forModel]);
  const [name, setName] = useState('');

  const save = () => {
    if (!name.trim()) return;
    useEditor.getState().saveOutfit(name);
    useEditor.getState().setStatus('ok', `Saved outfit "${name.trim()}"`);
    setName('');
  };

  const apply = (preset: OutfitPreset) => {
    if (!useEditor.getState().applyOutfit(preset.name)) return;
    if (vrm) applyAssetVisibilityAll(vrm, preset.hiddenMeshes, preset.hiddenParts);
  };

  return (
    <div className="outfit-bar">
      {presets.length > 0 && (
        <div className="outfit-chips">
          {presets.map((p) => (
            <span key={p.name} className={`outfit-chip ${sameVisibility(p, edits) ? 'active' : ''}`}>
              <button className="outfit-apply" title={`Switch to outfit "${p.name}"`} onClick={() => apply(p)}>
                {p.name}
              </button>
              <button
                className="outfit-del"
                title={`Delete outfit "${p.name}"`}
                onClick={() => useEditor.getState().deleteOutfit(p.name)}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="outfit-save">
        <input
          value={name}
          placeholder="Save current as…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button className="btn small" onClick={save} disabled={!name.trim()}>
          Save outfit
        </button>
      </div>
    </div>
  );
}

function AssetRow({ entry, edits }: { entry: AssetEntry; edits: ModelEdits }) {
  const vrm = useEditor((s) => s.vrm);
  const worn = useEditor((s) => s.worn);
  if (!vrm) return null;
  const hiddenList = entry.kind === 'part' ? edits.hiddenParts : edits.hiddenMeshes;
  const isHidden = hiddenList.includes(entry.id);
  // Same-category originals are hidden because a wardrobe donor part is worn.
  const wornCategory = worn.some((w) => w.category === entry.category);

  const toggle = () => {
    const st = useEditor.getState();
    if (entry.kind === 'part') st.setPartHidden(entry.id, !isHidden);
    else st.setMeshHidden(entry.id, !isHidden);
    const next = useEditor.getState().modelEdits;
    applyAssetVisibilityAll(vrm, next.hiddenMeshes, next.hiddenParts);
  };

  return (
    <button
      className={`mesh-row ${isHidden ? 'hidden-mesh' : ''}`}
      title={isHidden ? 'Show this piece' : 'Hide this piece'}
      onClick={toggle}
    >
      {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
      <span className="mesh-name" title={entry.meshName && entry.meshName !== entry.label ? `${entry.label} — ${entry.meshName}` : entry.label}>
        {entry.label}
      </span>
      {entry.meshName && entry.meshName !== entry.label && (
        <span className="asset-owner">{entry.meshName}</span>
      )}
      {isHidden && wornCategory && <span className="asset-owner" title="Hidden because a wardrobe part is worn">worn</span>}
    </button>
  );
}

function AssetsSection({ edits }: { edits: ModelEdits }) {
  const vrm = useEditor((s) => s.vrm);
  const entries = useMemo(() => {
    if (!vrm) return [];
    const list: AssetEntry[] = [
      ...collectParts(vrm).map((p: AssetPart) => ({
        kind: 'part' as const,
        id: p.id,
        label: p.label,
        category: p.category,
        meshName: p.meshName,
      })),
      ...collectWholeMeshes(vrm).map((m: AssetPart) => ({
        kind: 'mesh' as const,
        id: m.id,
        label: m.label,
        category: m.category !== 'other' ? m.category : classifyAsset(m.id),
        meshName: '',
      })),
    ];
    return list.sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        a.label.localeCompare(b.label),
    );
  }, [vrm]);

  if (entries.length === 0) return <div className="muted pad">No asset parts in this model.</div>;

  // Group into category blocks, keeping the CATEGORY_ORDER display order.
  const blocks: { category: AssetEntry['category']; rows: AssetEntry[] }[] = [];
  for (const e of entries) {
    const last = blocks[blocks.length - 1];
    if (last?.category === e.category) last.rows.push(e);
    else blocks.push({ category: e.category, rows: [e] });
  }

  return (
    <div className="assets-body">
      <OutfitsBar />
      <div className="mesh-list-wrap">
        <div className="mesh-list">
          {blocks.map((b) => (
            <div key={b.category} className="asset-cat">
              <div className="asset-cat-head">{CATEGORY_LABEL[b.category]}</div>
              {b.rows.map((e) => (
                <AssetRow key={`${e.kind}:${e.id}`} entry={e} edits={edits} />
              ))}
            </div>
          ))}
        </div>
        <div className="muted small-note">
          toggle clothes / hair / face pieces · hide all of a merged mesh and Save model removes it
        </div>
      </div>
    </div>
  );
}

// --- Expressions ---

function ExpressionsSection({ edits }: { edits: ModelEdits }) {
  const vrm = useEditor((s) => s.vrm);
  const baked = useEditor((s) => s.modelBakedExpressions);
  const exprTracks = useEditor((s) => s.exprTracks);
  const names = useMemo(() => (vrm ? expressionNames(vrm) : []), [vrm]);
  if (names.length === 0) return <div className="muted pad">This model has no expressions.</div>;
  return (
    <>
      <div className="btn-row">
        <button
          className="btn small"
          onClick={() => {
            if (!vrm) return;
            for (const n of names) {
              applyExpressionWeight(vrm, n, baked[n] ?? 0);
            }
            useEditor.getState().resetAllExpressionEdits();
          }}
          title="Restore the weights baked into the model file"
        >
          <RotateCcw size={12} /> Reset all
        </button>
        <span className="muted small-note">saved into the model on export</span>
      </div>
      {names.map((n) => {
        const w = edits.expressions[n] ?? baked[n] ?? 0;
        const keyed = (exprTracks[n]?.length ?? 0) > 0;
        return (
          <div className="ctl-row" key={n}>
            <span className="expr-name" title={keyed ? `${n} — animated on the timeline` : n}>
              {n}
              {keyed && <span className="edit-badge" title="This expression has animation keyframes (Pose tab)">anim</span>}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={w}
              onChange={(e) => {
                const nw = parseFloat(e.target.value);
                if (vrm) applyExpressionWeight(vrm, n, nw);
                useEditor.getState().setExpressionEdit(n, nw);
              }}
            />
            <span className="ctl-val">{w.toFixed(2)}</span>
          </div>
        );
      })}
    </>
  );
}

// --- Meta ---

function MetaSection({ edits }: { edits: ModelEdits }) {
  const modelMeta = useEditor((s) => s.modelMeta);
  if (!modelMeta) return <div className="muted pad">No meta info in this model.</div>;
  return (
    <>
      {modelMeta.fields.map((field) => (
        <label className="ctl-row meta-row" key={field}>
          <span>{field}</span>
          <input
            value={edits.meta[field] ?? modelMeta.values[field] ?? ''}
            placeholder={modelMeta.values[field] != null ? undefined : '—'}
            onChange={(e) => useEditor.getState().setMetaEdit(field, e.target.value)}
          />
        </label>
      ))}
      <div className="muted small-note">stored in the model file on save</div>
    </>
  );
}

// --- Proportions ---

function ProportionsSection({ edits }: { edits: ModelEdits }) {
  const vrm = useEditor((s) => s.vrm);
  const groups = useMemo(
    () =>
      PROPORTION_GROUPS.filter((g) => g.bones.some((b) => (vrm ? boneHasNode(vrm, b) : false))),
    [vrm],
  );
  if (!vrm) return null;
  if (groups.length === 0) return <div className="muted pad">No humanoid bones found.</div>;

  // Pair groups scale both sides; scalar groups drive every listed bone that
  // exists (e.g. Chest thickens chest AND upperChest — the child compensation
  // cancels the double-scale, so the whole chest region gets one even factor).
  const targetsOf = (g: { bones: string[]; pair?: boolean }) => {
    const existing = g.bones.filter((b) => boneHasNode(vrm, b));
    return existing.length ? existing : g.bones.slice(0, 1);
  };

  const apply = (bones: string[], factor: number) => {
    for (const b of bones) useEditor.getState().setBoneScale(b, factor);
    // Recompute every bone from the edit map (reset + parents-first apply).
    applyAllBoneScales(vrm, useEditor.getState().modelEdits.boneScale, useEditor.getState().modelEdits.bodyShape);
  };

  return (
    <>
      <div className="btn-row">
        <button
          className="btn small"
          onClick={() => {
            for (const g of groups) apply(targetsOf(g), 1);
          }}
        >
          <RotateCcw size={12} /> Reset all
        </button>
        <span className="muted small-note">
          torso &amp; limbs thicken in place · head/hands/hips scale the whole part
        </span>
      </div>
      {groups.map((g) => {
        const targets = targetsOf(g);
        const factor = edits.boneScale[targets[0]] ?? 1;
        return (
          <div className="ctl-row" key={g.label}>
            <span className="expr-name">{g.label}</span>
            <input
              type="range"
              min={PROPORTION_MIN}
              max={PROPORTION_MAX}
              step={0.01}
              value={factor}
              onChange={(e) => apply(targets, parseFloat(e.target.value))}
            />
            <span className="ctl-val">×{factor.toFixed(2)}</span>
            <button
              className="btn small"
              title={`Reset ${g.label} to ×1.00`}
              aria-label={`Reset ${g.label}`}
              disabled={Math.abs(factor - 1) < 0.005}
              onClick={() => apply(targets, 1)}
            >
              <RotateCcw size={11} />
            </button>
          </div>
        );
      })}
    </>
  );
}

// --- Body shape (VRoid-style) ---

function BodyShapeSection({ edits }: { edits: ModelEdits }) {
  const vrm = useEditor((s) => s.vrm);
  if (!vrm) return null;

  const apply = (param: string, factor: number) => {
    useEditor.getState().setBodyShape(param, factor);
    // Recompute every bone from both edit maps (reset + parents-first apply).
    const e = useEditor.getState().modelEdits;
    applyAllBoneScales(vrm, e.boneScale, e.bodyShape);
  };

  const isDefault = Object.keys(edits.bodyShape).length === 0;

  return (
    <>
      <div className="btn-row">
        <button className="btn small" disabled={isDefault} onClick={() => useEditor.getState().resetBodyShape()}>
          <RotateCcw size={12} /> Reset all
        </button>
        <span className="muted small-note">
          VRoid-style body sliders — height &amp; limb length keep the feet on the ground
        </span>
      </div>
      {BODY_SHAPE_PARAMS.map(({ param, label }) => {
        const factor = edits.bodyShape[param] ?? 1;
        return (
          <div className="ctl-row" key={param}>
            <span className="expr-name">{label}</span>
            <input
              type="range"
              min={BODY_SHAPE_MIN}
              max={BODY_SHAPE_MAX}
              step={0.01}
              value={factor}
              onChange={(e) => apply(param, parseFloat(e.target.value))}
            />
            <span className="ctl-val">×{factor.toFixed(2)}</span>
            <button
              className="btn small"
              title={`Reset ${label} to ×1.00`}
              aria-label={`Reset ${label}`}
              disabled={Math.abs(factor - 1) < 0.005}
              onClick={() => apply(param, 1)}
            >
              <RotateCcw size={11} />
            </button>
          </div>
        );
      })}
    </>
  );
}

// --- Face (VRoid eye sliders) ---

const FACE_SLIDERS: { param: string; label: string; min: number; max: number }[] = [
  { param: 'eyeSize', label: 'Eye size', min: 0.5, max: 1.5 },
  { param: 'eyeHeight', label: 'Eye height', min: -1, max: 1 },
  { param: 'eyeSpacing', label: 'Eye spacing', min: -1, max: 1 },
];

function FaceSection({ edits }: { edits: ModelEdits }) {
  const vrm = useEditor((s) => s.vrm);
  if (!vrm) return null;
  // VRoid eye-adjust bones only exist on VRoid-exported rigs.
  if (!EYE_ADJ_BONES.every((b) => vrm.scene.getObjectByName(b))) {
    return <div className="muted pad">This model has no adjustable face bones.</div>;
  }

  const apply = (param: string, value: number) => {
    useEditor.getState().setFaceShape(param, value);
    applyFaceShape(vrm, useEditor.getState().modelEdits.face);
  };

  return (
    <>
      <div className="btn-row">
        <button
          className="btn small"
          disabled={Object.keys(edits.face).length === 0}
          onClick={() => {
            useEditor.getState().resetFaceShape();
            applyFaceShape(vrm, useEditor.getState().modelEdits.face);
          }}
        >
          <RotateCcw size={12} /> Reset all
        </button>
        <span className="muted small-note">VRoid eye-adjust bones reshape the eye region</span>
      </div>
      {FACE_SLIDERS.map(({ param, label, min, max }) => {
        const value = edits.face[param] ?? (param === 'eyeSize' ? 1 : 0);
        return (
          <div className="ctl-row" key={param}>
            <span className="expr-name">{label}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={0.01}
              value={value}
              onChange={(e) => apply(param, parseFloat(e.target.value))}
            />
            <span className="ctl-val">{param === 'eyeSize' ? `\u00d7${value.toFixed(2)}` : value.toFixed(2)}</span>
            <button
              className="btn small"
              title={`Reset ${label}`}
              aria-label={`Reset ${label}`}
              disabled={Math.abs(value - (param === 'eyeSize' ? 1 : 0)) < 0.005}
              onClick={() => apply(param, param === 'eyeSize' ? 1 : 0)}
            >
              <RotateCcw size={11} />
            </button>
          </div>
        );
      })}
    </>
  );
}

// --- Colors (semantic material groups) ---

function ColorGroupRow({
  group,
  swatches,
  vrm,
  edits,
}: {
  group: { key: string; label: string };
  swatches: string[];
  vrm: THREE.Object3D extends never ? never : any;
  edits: ModelEdits;
}) {
  if (!vrm) return null;
  const materials = collectMaterials(vrm).filter((m) => materialGroup(m.name) === group.key);
  if (materials.length === 0) return null;
  const names = materials.map((m) => m.name.replace(/ \(Outline\)$/, ''));
  const asColorMat = (m: any) => m as { color?: THREE.Color };

  const edited = names.some((n) => edits.materials[n]?.color);
  const liveColor = (() => {
    const editedColor = names.map((n) => edits.materials[n]?.color).find(Boolean);
    if (editedColor) return linearToHex(editedColor);
    const withColor = materials.find((m) => asColorMat(m).color);
    if (!withColor) return '#ffffff';
    const c = asColorMat(withColor).color;
    if (!c) return '#ffffff';
    return linearToHex([c.r, c.g, c.b]);
  })();

  const apply = (hex: string) => {
    const linear = hexToLinear(hex);
    for (const n of names) {
      useEditor.getState().setMaterialEdit(n, { color: linear });
      applyMaterialEdit(vrm, n, { color: linear });
    }
  };
  const reset = () => {
    for (const n of names) {
      useEditor.getState().resetMaterialEdit(n);
      for (const m of materialsFor(vrm, n)) applyMaterialEdit(vrm, n, {});
    }
  };

  return (
    <div className="ctl-row" style={{ flexWrap: 'wrap' }}>
      <span className="expr-name" style={{ minWidth: 44 }}>{group.label}</span>
      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1, alignItems: 'center' }}>
        {swatches.map((hex) => (
          <button
            key={hex}
            title={`${group.label} ${hex}`}
            aria-label={`${group.label} ${hex}`}
            onClick={() => apply(hex)}
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: hex,
              cursor: 'pointer',
              padding: 0,
            }}
          />
        ))}
        <input
          type="color"
          title={`Custom ${group.label.toLowerCase()} color`}
          value={liveColor}
          onChange={(e) => apply(e.target.value)}
          style={{ width: 24, height: 20, padding: 0, border: '1px solid var(--border)', background: 'none' }}
        />
        <button
          className="btn small"
          title={`Reset ${group.label} to the model's original color`}
          aria-label={`Reset ${group.label}`}
          disabled={!edited}
          onClick={reset}
        >
          <RotateCcw size={11} />
        </button>
      </span>
    </div>
  );
}

function ColorsSection({ edits }: { edits: ModelEdits }) {
  const vrm = useEditor((s) => s.vrm);
  if (!vrm) return null;
  const groups = [
    { group: COLOR_GROUPS[0], swatches: SKIN_SWATCHES },
    { group: COLOR_GROUPS[1], swatches: HAIR_SWATCHES },
    { group: COLOR_GROUPS[2], swatches: EYE_SWATCHES },
    { group: COLOR_GROUPS[3], swatches: BROW_SWATCHES },
  ];
  return (
    <>
      <div className="btn-row">
        <span className="muted small-note">tints every material of the part · baked into Save model</span>
      </div>
      {groups.map(({ group, swatches }) => (
        <ColorGroupRow key={group.key} group={group} swatches={swatches} vrm={vrm} edits={edits} />
      ))}
    </>
  );
}

// --- Panel ---

export function ModelPanel() {
  const vrm = useEditor((s) => s.vrm);
  const edits = useEditor((s) => s.modelEdits);
  const modelName = useEditor((s) => s.modelName);
  const [painting, setPainting] = useState<string | null>(null);

  if (!vrm) return <div className="panel-body"><div className="muted pad">Load a model first.</div></div>;

  return (
    <div className="panel-body model-body">
      <div className="model-hint">
        Editing <b title={modelName}>{modelName}</b> — changes preview live; use
        <b> Save model</b> (toolbar) to download an edited .vrm.
      </div>
      <Section title="Wardrobe">
        <WardrobeSection />
      </Section>
      <Section title="Materials">
        <MaterialsSection edits={edits} onPaint={setPainting} />
      </Section>
      <Section title="Assets">
        <AssetsSection edits={edits} />
      </Section>
      <Section title="Expressions">
        <ExpressionsSection edits={edits} />
      </Section>
      <Section title="Meta">
        <MetaSection edits={edits} />
      </Section>
      <Section title="Face">
        <FaceSection edits={edits} />
      </Section>
      <Section title="Colors">
        <ColorsSection edits={edits} />
      </Section>
      <Section title="Body shape">
        <BodyShapeSection edits={edits} />
      </Section>
      <Section title="Proportions">
        <ProportionsSection edits={edits} />
      </Section>
      {painting && <TexturePainter matName={painting} onClose={() => setPainting(null)} />}
    </div>
  );
}
