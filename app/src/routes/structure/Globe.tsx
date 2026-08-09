/**
 * SimilarityGlobe — the 3D shape-family cloud.
 *
 * Renders anatomy.similarity.layout3d as a point cloud in react-three-fiber:
 * every landing page is a point, colored by its shape family (golden-ratio-spaced
 * hues so the ~7 families read as clearly separate lobes), near-unique pages are a
 * dim neutral so the colored families pop. Faint lines connect only genuinely-alike
 * pairs (neighbour distance < threshold) so edges trace families instead of hazing
 * everything. Floating <Html> labels name each family at its centroid. Hover or pin
 * a point to fill the side panel; when nothing is active the panel is a legend.
 *
 * No third-party network request: fonts/colors come from CSS tokens, the point
 * sprite is drawn on a runtime canvas, labels are plain DOM (drei <Html>, never the
 * CDN-font <Text>). WebGL and reduced-motion both degrade gracefully.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import type { Anatomy, Cluster, Company, LayoutNode } from '../../lib/types';
import { useAnatomy } from '../../lib/data';
import { ErrorNote, Loading } from '../../components/ui';
import './globe.css';

const GOLDEN = 0.61803398875;

// ---- theme tokens (read from CSS so three materials match the app) ----------
interface Tokens { accent: string; ink3: string; rule: string; bg: string }
function readTokens(): Tokens {
  const s = getComputedStyle(document.documentElement);
  const g = (n: string) => s.getPropertyValue(n).trim() || '#888888';
  return { accent: g('--accent'), ink3: g('--ink-3'), rule: g('--rule'), bg: g('--bg') };
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Human label for a family from its characteristic section types. */
function familyLabel(sections: string[], labels: Record<string, string>): string {
  if (!sections.length) return 'Hero only';
  return sections.map((t) => labels[t] ?? t).join(' + ');
}

/** Soft round sprite for points — drawn once on a canvas, no network. */
function makeSprite(): THREE.CanvasTexture {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

interface Family {
  id: number;
  label: string;
  size: number;
  hex: string;
  centroid: [number, number, number];
}

interface Derived {
  familyGeom: THREE.BufferGeometry;
  familyNodes: LayoutNode[];
  uniqueGeom: THREE.BufferGeometry;
  uniqueNodes: LayoutNode[];
  edgesGeom: THREE.BufferGeometry;
  families: Family[];
  colorBySlug: Map<string, string>;
  nodeBySlug: Map<string, LayoutNode>;
  companyBySlug: Map<string, Company>;
  nameBySlug: Map<string, string>;
  clusterById: Map<number, Cluster>;
  uniqueHex: string;
  edgeHex: string;
  bgHex: string;
  accentHex: string;
  neighbours: Anatomy['similarity']['neighbours'];
  labelOf: (t: string) => string;
  threshold: number;
}

function buildDerived(a: Anatomy, tokens: Tokens): Derived {
  const sim = a.similarity;
  const labels = a.labels;
  const nodes = sim.layout3d.nodes;

  const nodeBySlug = new Map<string, LayoutNode>(nodes.map((n) => [n.slug, n]));
  const companyBySlug = new Map<string, Company>(a.companies.map((c) => [c.slug, c]));
  const nameBySlug = new Map<string, string>(a.companies.map((c) => [c.slug, c.name]));
  for (const n of nodes) if (!nameBySlug.has(n.slug)) nameBySlug.set(n.slug, n.name);
  const clusterById = new Map<number, Cluster>(sim.clusters.clusters.map((c) => [c.id, c]));

  // per-family color from golden-ratio hue
  const familyColor = new Map<number, THREE.Color>();
  const colorBySlug = new Map<string, string>();
  for (const c of sim.clusters.clusters) {
    const hue = (c.id * GOLDEN) % 1;
    familyColor.set(c.id, new THREE.Color().setHSL(hue, 0.72, 0.62));
  }

  // split nodes into family / near-unique
  const familyNodes = nodes.filter((n) => n.cluster !== -1);
  const uniqueNodes = nodes.filter((n) => n.cluster === -1);

  const fPos = new Float32Array(familyNodes.length * 3);
  const fCol = new Float32Array(familyNodes.length * 3);
  familyNodes.forEach((n, i) => {
    fPos[i * 3] = n.x; fPos[i * 3 + 1] = n.y; fPos[i * 3 + 2] = n.z;
    const col = familyColor.get(n.cluster) ?? new THREE.Color(tokens.accent);
    fCol[i * 3] = col.r; fCol[i * 3 + 1] = col.g; fCol[i * 3 + 2] = col.b;
    colorBySlug.set(n.slug, col.getStyle());
  });
  const familyGeom = new THREE.BufferGeometry();
  familyGeom.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
  familyGeom.setAttribute('color', new THREE.BufferAttribute(fCol, 3));

  const uPos = new Float32Array(uniqueNodes.length * 3);
  uniqueNodes.forEach((n, i) => { uPos[i * 3] = n.x; uPos[i * 3 + 1] = n.y; uPos[i * 3 + 2] = n.z; });
  const uniqueGeom = new THREE.BufferGeometry();
  uniqueGeom.setAttribute('position', new THREE.BufferAttribute(uPos, 3));

  // edges: only genuinely-alike pairs (distance < threshold), de-duped
  const threshold = sim.clusters.threshold;
  const seen = new Set<string>();
  const edgeVerts: number[] = [];
  for (const [slug, list] of Object.entries(sim.neighbours)) {
    const a0 = nodeBySlug.get(slug);
    if (!a0) continue;
    for (const nb of list) {
      if (nb.distance >= threshold) continue;
      const b0 = nodeBySlug.get(nb.slug);
      if (!b0) continue;
      const key = slug < nb.slug ? `${slug}|${nb.slug}` : `${nb.slug}|${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edgeVerts.push(a0.x, a0.y, a0.z, b0.x, b0.y, b0.z);
    }
  }
  const edgesGeom = new THREE.BufferGeometry();
  edgesGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeVerts), 3));

  // families with centroids (only present members)
  const families: Family[] = sim.clusters.clusters.map((c) => {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const m of c.members) {
      const nd = nodeBySlug.get(m.slug);
      if (!nd) continue;
      sx += nd.x; sy += nd.y; sz += nd.z; n += 1;
    }
    const centroid: [number, number, number] = n ? [sx / n, sy / n, sz / n] : [0, 0, 0];
    return {
      id: c.id,
      label: familyLabel(c.sections, labels),
      size: c.size,
      hex: (familyColor.get(c.id) ?? new THREE.Color(tokens.accent)).getStyle(),
      centroid,
    };
  });

  return {
    familyGeom, familyNodes, uniqueGeom, uniqueNodes, edgesGeom, families,
    colorBySlug, nodeBySlug, companyBySlug, nameBySlug, clusterById,
    uniqueHex: new THREE.Color(tokens.ink3).getStyle(),
    edgeHex: new THREE.Color(tokens.rule).getStyle(),
    bgHex: tokens.bg,
    accentHex: new THREE.Color(tokens.accent).getStyle(),
    neighbours: sim.neighbours,
    labelOf: (t: string) => labels[t] ?? t,
    threshold,
  };
}

// ---- highlight marker for the active node -----------------------------------
function Highlight({ pos, hex, reduced }: { pos: [number, number, number]; hex: string; reduced: boolean }) {
  const halo = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (reduced || !halo.current) return;
    const s = 1 + Math.sin(state.clock.elapsedTime * 3) * 0.14;
    halo.current.scale.setScalar(s);
  });
  return (
    <group position={pos}>
      <mesh>
        <sphereGeometry args={[2.2, 20, 20]} />
        <meshBasicMaterial color={hex} toneMapped={false} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[5.2, 24, 24]} />
        <meshBasicMaterial
          color={hex} transparent opacity={0.28} depthWrite={false}
          blending={THREE.AdditiveBlending} toneMapped={false}
        />
      </mesh>
    </group>
  );
}

// ---- the 3D scene -----------------------------------------------------------
function Scene({ d, sprite, reduced, activeSlug, onHover, onPick }: {
  d: Derived;
  sprite: THREE.CanvasTexture;
  reduced: boolean;
  activeSlug: string | null;
  onHover: (slug: string | null) => void;
  onPick: (slug: string) => void;
}) {
  const activeNode = activeSlug ? d.nodeBySlug.get(activeSlug) ?? null : null;

  const onFamilyMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.index != null) onHover(d.familyNodes[e.index]?.slug ?? null);
  };
  const onUniqueMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.index != null) onHover(d.uniqueNodes[e.index]?.slug ?? null);
  };

  return (
    <>
      <fog attach="fog" args={[d.bgHex, 210, 500]} />

      {/* faint bounding sphere — a globe frame for depth */}
      <mesh>
        <sphereGeometry args={[112, 28, 18]} />
        <meshBasicMaterial color={d.edgeHex} wireframe transparent opacity={0.05} depthWrite={false} />
      </mesh>

      {/* alike-pair edges */}
      <lineSegments geometry={d.edgesGeom}>
        <lineBasicMaterial color={d.edgeHex} transparent opacity={0.22} depthWrite={false} />
      </lineSegments>

      {/* near-unique cloud: dim, small, so families pop */}
      <points
        geometry={d.uniqueGeom}
        onPointerMove={onUniqueMove}
        onPointerOut={() => onHover(null)}
        onClick={(e) => { e.stopPropagation(); if (e.index != null) onPick(d.uniqueNodes[e.index]!.slug); }}
      >
        <pointsMaterial
          color={d.uniqueHex} map={sprite} size={2.0} sizeAttenuation
          transparent opacity={0.5} depthWrite={false} alphaTest={0.01} toneMapped={false}
        />
      </points>

      {/* family cloud: vivid, larger */}
      <points
        geometry={d.familyGeom}
        onPointerMove={onFamilyMove}
        onPointerOut={() => onHover(null)}
        onClick={(e) => { e.stopPropagation(); if (e.index != null) onPick(d.familyNodes[e.index]!.slug); }}
      >
        <pointsMaterial
          vertexColors map={sprite} size={3.6} sizeAttenuation
          transparent opacity={1} depthWrite={false} alphaTest={0.01} toneMapped={false}
        />
      </points>

      {activeNode && (
        <Highlight
          pos={[activeNode.x, activeNode.y, activeNode.z]}
          hex={d.colorBySlug.get(activeNode.slug) ?? d.accentHex}
          reduced={reduced}
        />
      )}

      {/* floating family labels */}
      {d.families.map((f) => (
        <Html
          key={f.id}
          position={[f.centroid[0], f.centroid[1] + 7, f.centroid[2]]}
          center
          zIndexRange={[20, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="globe-fam">
            <span className="dot" style={{ background: f.hex }} />
            {f.label}
            <span className="n">· {f.size}</span>
          </div>
        </Html>
      ))}

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        autoRotate={!reduced}
        autoRotateSpeed={0.5}
        minDistance={130}
        maxDistance={420}
      />
    </>
  );
}

// ---- side panel -------------------------------------------------------------
function Panel({ d, activeSlug, pinned, onUnpin, accuracyPct, nearUnique }: {
  d: Derived;
  activeSlug: string | null;
  pinned: boolean;
  onUnpin: () => void;
  accuracyPct: number;
  nearUnique: number;
}) {
  const caveat = (
    <p className="globe-caveat">
      Position is a readable arrangement, not a measurement. Families come from the
      section-shape classifier, which is right about {accuracyPct}% of the time off the hero.
    </p>
  );

  const node = activeSlug ? d.nodeBySlug.get(activeSlug) ?? null : null;
  if (!node) {
    // legend
    return (
      <aside className="globe-panel">
        <p className="eyebrow">Shape families</p>
        <ul className="globe-legend">
          {d.families.map((f) => (
            <li key={f.id}>
              <span className="dot" style={{ color: f.hex, background: f.hex }} />
              <span className="txt"><span className="nm">{f.label}</span><span className="n">{f.size}</span></span>
            </li>
          ))}
          <li>
            <span className="swatch-unique" />
            <span className="txt"><span className="nm">Near-unique</span><span className="n">{nearUnique}</span></span>
          </li>
        </ul>
        {caveat}
      </aside>
    );
  }

  const family = node.cluster !== -1 ? d.clusterById.get(node.cluster) ?? null : null;
  const familyHex = d.colorBySlug.get(node.slug);
  const company = d.companyBySlug.get(node.slug);
  const shape = company
    ? [...company.sections].sort((a, b) => a.position - b.position).map((s) => s.type)
    : [];
  const neighbours = (d.neighbours[node.slug] ?? []).slice(0, 6);

  return (
    <aside className="globe-panel">
      <p className="eyebrow">Landing page</p>
      <h3>{node.name}</h3>
      <div className="globe-fam-line">
        {family ? (
          <>
            <span className="dot" style={{ background: familyHex }} />
            <span>{familyLabelFromCluster(family, d)} <span className="of">· family of {family.size}</span></span>
          </>
        ) : (
          <><span className="dot" style={{ background: d.uniqueHex }} /><span>Near-unique shape</span></>
        )}
      </div>

      {shape.length > 0 && (
        <div className="globe-block">
          <p className="lbl">Section shape</p>
          <p className="globe-shape">
            {shape.map((t, i) => (
              <span key={i}>
                {i > 0 && <span className="sep">›</span>}
                {d.labelOf(t)}
              </span>
            ))}
          </p>
        </div>
      )}

      <div className="globe-block">
        <p className="lbl">Closest shapes</p>
        {neighbours.length ? (
          <ul className="globe-neigh">
            {neighbours.map((nb) => (
              <li key={nb.slug}>
                <span className="nm">{d.nameBySlug.get(nb.slug) ?? nb.slug}</span>
                <span className={`d ${nb.distance < d.threshold ? 'alike' : ''}`}>
                  {nb.distance.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="globe-shape">No close neighbours recorded.</p>}
      </div>

      {pinned && <button className="globe-pinned" onClick={onUnpin}>✕ unpin</button>}
      {caveat}
    </aside>
  );
}

function familyLabelFromCluster(c: Cluster, d: Derived): string {
  const f = d.families.find((x) => x.id === c.id);
  return f?.label ?? '';
}

// ---- root export ------------------------------------------------------------
export function SimilarityGlobe(): JSX.Element {
  const { data, error } = useAnatomy();
  const [tokens] = useState<Tokens>(readTokens);
  const reduced = usePrefersReducedMotion();
  const webgl = useMemo(hasWebGL, []);
  const [hover, setHover] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);

  const sprite = useMemo(makeSprite, []);
  useEffect(() => () => sprite.dispose(), [sprite]);

  const d = useMemo<Derived | null>(() => (data ? buildDerived(data, tokens) : null), [data, tokens]);

  useEffect(() => {
    if (!d) return;
    return () => { d.familyGeom.dispose(); d.uniqueGeom.dispose(); d.edgesGeom.dispose(); };
  }, [d]);

  if (error) return <ErrorNote>Could not load the similarity map: {error}</ErrorNote>;
  if (!data || !d) return <Loading label="Building the shape map…" />;

  const accuracyPct = Math.round(data.accuracy.nonHero * 100);
  const nearUnique = data.similarity.clusters.near_unique;
  const active = pin ?? hover;

  // ---- WebGL fallback: legend list, never a blank canvas ----
  if (!webgl) {
    return (
      <div className="globe">
        <aside className="globe-panel globe-fallback">
          <p className="eyebrow">Shape families</p>
          <p className="note">
            Your browser can’t render the 3D map (WebGL unavailable). Here are the
            shape families the classifier found across {data.similarity.clusters.of} pages.
          </p>
          <ul className="globe-legend">
            {d.families.map((f) => (
              <li key={f.id}>
                <span className="dot" style={{ color: f.hex, background: f.hex }} />
                <span className="txt"><span className="nm">{f.label}</span><span className="n">{f.size}</span></span>
              </li>
            ))}
            <li>
              <span className="swatch-unique" />
              <span className="txt"><span className="nm">Near-unique</span><span className="n">{nearUnique}</span></span>
            </li>
          </ul>
          <p className="globe-caveat">
            Position is a readable arrangement, not a measurement. Families come from the
            section-shape classifier, which is right about {accuracyPct}% of the time off the hero.
          </p>
        </aside>
      </div>
    );
  }

  return (
    <div className="globe">
      <div className={`globe-stage ${hover ? 'is-hover' : ''}`}>
        <Canvas
          camera={{ position: [70, 40, 250], fov: 50, near: 1, far: 1200 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          raycaster={{ params: { Points: { threshold: 3.4 } } as unknown as THREE.Raycaster['params'] }}
          onPointerMissed={() => setPin(null)}
        >
          <Scene
            d={d}
            sprite={sprite}
            reduced={reduced}
            activeSlug={active}
            onHover={setHover}
            onPick={(slug) => setPin((prev) => (prev === slug ? null : slug))}
          />
        </Canvas>
        <div className="globe-hint">
          {reduced ? 'Drag to rotate · hover a point' : 'Drag to rotate · hover or click a point'}
        </div>
      </div>

      <Panel
        d={d}
        activeSlug={active}
        pinned={pin != null && pin === active}
        onUnpin={() => setPin(null)}
        accuracyPct={accuracyPct}
        nearUnique={nearUnique}
      />
    </div>
  );
}
