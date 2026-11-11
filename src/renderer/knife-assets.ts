/// <reference types="vite/client" />

import type { ActiveActionData, SkinState } from '../shared/ipc';

/**
 * Asset discovery for the cursor art.
 *
 * Put the real files here (paths are relative to this file):
 *   assets/cursor/butterfly/idle.png
 *   assets/cursor/butterfly/inspect/frame_000.png ... frame_023.png
 *
 * The glob is eager so Vite fingerprints the images at build time. The
 * generated SVG fallback keeps `npm start` useful before any art exists.
 */

const idleModules = import.meta.glob<string>(
  './assets/cursor/butterfly/idle.png',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
);

const inspectModules = import.meta.glob<string>(
  './assets/cursor/butterfly/inspect/frame_*.png',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
);

/**
 * The rendered size is a runtime setting (`knifeDisplaySize` in config.json),
 * so it deliberately is not baked into this module.
 */

/** Number of generated SVG frames used only when no real PNGs are present. */
export const FALLBACK_FRAME_COUNT = 24;

export interface KnifeAssets {
  idleUrl: string;
  inspectFrameUrls: readonly string[];
  usingFallbackFrames: boolean;
  realFrameCount: number;
  source: 'files' | 'fallback' | 'mixed' | 'custom';
}

function numberFromFrameKey(key: string): number {
  const match = /frame_(\d+)\.png$/i.exec(key);
  return match === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * A small balisong silhouette. The frame index rotates the whole knife and
 * flips it around the vertical axis, so the generated fallback exercises the
 * same frame player as real artwork.
 */
function fallbackSvg(angleDegrees: number, scaleX: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="blade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7fafc"/>
      <stop offset="0.48" stop-color="#aebbc9"/>
      <stop offset="1" stop-color="#e8eef5"/>
    </linearGradient>
    <linearGradient id="handle" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4b5563"/>
      <stop offset="0.5" stop-color="#20252d"/>
      <stop offset="1" stop-color="#596273"/>
    </linearGradient>
    <filter id="shadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="3" stdDeviation="2.4" flood-color="#000000" flood-opacity="0.38"/>
    </filter>
  </defs>
  <g filter="url(#shadow)" transform="translate(48 48) rotate(${angleDegrees.toFixed(2)}) scale(${scaleX.toFixed(3)} 1) translate(-48 -48)">
    <path d="M48 7 C54 13 58 23 57 35 L54 61 L48 68 L42 61 L39 35 C38 23 42 13 48 7 Z"
      fill="url(#blade)" stroke="#dbe4ee" stroke-width="1"/>
    <path d="M48 11 L52 33 L49 57 L48 62 L47 57 L44 33 Z" fill="#ffffff" opacity="0.42"/>
    <path d="M42 63 L46 63 L45 88 L40 88 Z" fill="url(#handle)" stroke="#8a6b3f" stroke-width="1"/>
    <path d="M50 63 L54 63 L56 88 L51 88 Z" fill="url(#handle)" stroke="#8a6b3f" stroke-width="1"/>
    <circle cx="44" cy="67" r="1.7" fill="#e0c58a"/>
    <circle cx="52" cy="67" r="1.7" fill="#e0c58a"/>
    <path d="M40 88 L56 88" stroke="#c9a96a" stroke-width="2" stroke-linecap="round"/>
  </g>
</svg>`;
}

function makeFallbackFrames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const progress = count > 1 ? index / count : 0;
    const angle = progress * 360;
    const flip = Math.cos(progress * Math.PI * 2);
    const scaleX = Math.sign(flip || 1) * Math.max(0.22, Math.abs(flip));

    return svgDataUrl(fallbackSvg(angle, scaleX));
  });
}

export function loadKnifeAssets(skin?: SkinState | null): KnifeAssets {
  if (
    skin?.mode === 'custom' &&
    skin.idleUrl !== null &&
    skin.frameUrls.length > 0
  ) {
    return {
      idleUrl: skin.idleUrl,
      inspectFrameUrls: skin.frameUrls,
      usingFallbackFrames: false,
      realFrameCount: skin.frameCount,
      source: 'custom',
    };
  }

  const realFrames = Object.entries(inspectModules)
    .sort(([keyA], [keyB]) => {
      const numberDelta = numberFromFrameKey(keyA) - numberFromFrameKey(keyB);
      return numberDelta !== 0 ? numberDelta : keyA.localeCompare(keyB);
    })
    .map(([, url]) => url);

  const realIdleUrl = Object.values(idleModules)[0];
  const fallbackFrames = makeFallbackFrames(FALLBACK_FRAME_COUNT);
  const fallbackIdleUrl = svgDataUrl(fallbackSvg(-14, 1));

  const usingFallbackFrames = realFrames.length === 0;
  const inspectFrameUrls = usingFallbackFrames ? fallbackFrames : realFrames;

  let idleUrl = realIdleUrl;
  if (idleUrl === undefined) {
    // Partial asset drops are common while iterating. Prefer a real inspect
    // frame over the placeholder, but never leave the <img> without a URL.
    idleUrl = inspectFrameUrls[0] ?? fallbackIdleUrl;
  }

  const source: KnifeAssets['source'] =
    usingFallbackFrames && realIdleUrl === undefined
      ? 'fallback'
      : usingFallbackFrames || realIdleUrl === undefined
        ? 'mixed'
        : 'files';

  return {
    idleUrl,
    inspectFrameUrls,
    usingFallbackFrames,
    realFrameCount: realFrames.length,
    source,
  };
}

/**
 * Decode every image once before it is needed. A failed decode is not fatal:
 * the player falls back to the browser's normal per-frame loading.
 */
export async function preloadKnifeAssets(assets: KnifeAssets): Promise<void> {
  const urls = [...new Set([assets.idleUrl, ...assets.inspectFrameUrls])];

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      await image.decode();
    }),
  );

  const failedCount = results.filter(
    (result) => result.status === 'rejected',
  ).length;

  if (failedCount > 0) {
    console.warn(
      `[assets] preload failed for ${failedCount}/${urls.length} images; ` +
        'the frame player will continue with on-demand decoding.',
    );
  }
}

/**
 * V2.0 action activation: wrap the ActiveActionData sent by the main process
 * into a KnifeAssets snapshot so the frame player can consume it immediately.
 *
 * The main process already resolved the absolute folder paths into
 * `knife-asset://action/<id>/...` URLs, so no path computation happens here.
 */
export function createActionAssets(
  activeData: ActiveActionData,
): KnifeAssets {
  return {
    idleUrl: activeData.idleUrl,
    inspectFrameUrls: activeData.frameUrls,
    usingFallbackFrames: activeData.frameCount === 0,
    realFrameCount: activeData.frameCount,
    source: 'custom',
  };
}