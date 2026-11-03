import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

/** Background of the app icon, matching the manifest background so a maskable crop blends in. */
const ICON_BACKGROUND = '#18181c';

/**
 * Share of a maskable icon's side that holds the artwork. The platform may crop to a circle of 80% of the side, so everything that matters must sit inside it.
 */
const MASKABLE_SAFE_ZONE = 0.8;

export interface IconSpec {
  readonly file: string;
  readonly size: number;
  readonly purpose: 'any' | 'maskable';
}

/** PNG icons rendered from the source SVG at build time. The 192 and 512 sizes are the installability minimum; 180 is the iOS touch icon. */
export const ICON_SPECS: readonly IconSpec[] = [
  { file: 'icon-192.png', size: 192, purpose: 'any' },
  { file: 'icon-512.png', size: 512, purpose: 'any' },
  { file: 'icon-maskable-512.png', size: 512, purpose: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, purpose: 'any' },
];

function innerMarkup(svg: string): string {
  const match = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(svg);
  if (match?.[1] === undefined) {
    throw new Error('icon source is not an SVG document');
  }

  return match[1];
}

function maskableSvg(svg: string): string {
  const inset = ((1 - MASKABLE_SAFE_ZONE) / 2) * 100;
  const side = MASKABLE_SAFE_ZONE * 100;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${ICON_BACKGROUND}"/><svg x="${String(inset)}" y="${String(inset)}" width="${String(side)}" height="${String(side)}" viewBox="0 0 100 100">${innerMarkup(svg)}</svg></svg>`;
}

/**
 * Rasterises the source SVG into every PNG icon the manifest and the HTML head name.
 * @param outDir - Built site directory the files are written to.
 * @param svg - Source SVG document of the app icon.
 */
export function writeIcons(outDir: string, svg: string): void {
  for (const spec of ICON_SPECS) {
    const source = spec.purpose === 'maskable' ? maskableSvg(svg) : svg;
    const png = new Resvg(source, { fitTo: { mode: 'width', value: spec.size } }).render().asPng();
    writeFileSync(join(outDir, spec.file), png);
  }
}
