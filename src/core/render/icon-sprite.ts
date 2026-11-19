import { SaxesParser } from 'saxes';

export const CUSTOM_ICON_SPRITE_PATH = '/assets/custom-icons.svg';
export const MAX_ICON_SPRITE_BYTES = 64 * 1024;
export type CustomIconId = `custom-${string}`;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SOURCE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SHAPES = new Set(['g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect']);
const GEOMETRY = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'pathLength']);
const NUMERIC = /^[0-9eE.,+\-\s%]+$/;
const PATH = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/;
const PAINT = /^(?:#[\da-fA-F]{3}|#[\da-fA-F]{4}|#[\da-fA-F]{6}|#[\da-fA-F]{8}|[a-zA-Z]+)$/;
const TRANSFORM = /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE.,+\-\s]+\)[,\s]*)+$/;
const RULES: Record<string, RegExp | undefined> = {
  fill: PAINT, stroke: PAINT,
  'fill-rule': /^(?:nonzero|evenodd)$/,
  'clip-rule': /^(?:nonzero|evenodd)$/,
  'stroke-linecap': /^(?:butt|round|square)$/,
  'stroke-linejoin': /^(?:miter|round|bevel)$/,
  'stroke-dasharray': /^(?:none|[0-9eE.,+\-\s%]+)$/,
  'stroke-dashoffset': NUMERIC,
  'stroke-miterlimit': NUMERIC,
  'stroke-width': NUMERIC,
  'stroke-opacity': NUMERIC,
  'fill-opacity': NUMERIC,
  opacity: NUMERIC,
  transform: TRANSFORM,
  'vector-effect': /^(?:none|non-scaling-stroke)$/,
};

export interface CustomIconSprite {
  icons: CustomIconId[];
  svg: string;
}

export function isCustomIconId(value: string): value is CustomIconId {
  return value.startsWith('custom-') && SOURCE_ID.test(value.slice('custom-'.length));
}

export function customIconHref(value: string): string {
  return isCustomIconId(value) ? `${CUSTOM_ICON_SPRITE_PATH}#${value}` : '';
}

function invalidSprite(): never {
  throw new Error('Invalid icon sprite');
}

function viewBox(value: string): string {
  const parts = value.trim().split(/[\s,]+/);
  if (parts.length !== 4 || parts.some((part) => !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part) || !Number.isFinite(Number(part)))
    || Number(parts[2]) <= 0 || Number(parts[3]) <= 0) invalidSprite();
  return parts.join(' ');
}

function serializeAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes).map(([name, value]) => ` ${name}="${value}"`).join('');
}

/** Parse XML strictly and serialize only passive SVG elements and allowlisted values. */
export function parseIconSprite(source: string): CustomIconSprite {
  const icons = new Set<CustomIconId>();
  const svg = [`<svg xmlns="${SVG_NAMESPACE}">`];
  const stack: string[] = [];
  let rootViewBox = '0 0 24 24';
  let rootPresentation: Record<string, string> = {};
  let shapesInSymbol = 0;
  let elementCount = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', invalidSprite);
  parser.on('processinginstruction', invalidSprite);
  parser.on('error', invalidSprite);
  const checkText = (value: string) => {
    if (value.trim() && stack.at(-1) !== 'title' && stack.at(-1) !== 'desc') invalidSprite();
  };
  parser.on('text', checkText);
  parser.on('cdata', checkText);
  parser.on('opentag', (tag) => {
    const name = tag.local;
    const parent = stack.at(-1);
    if ((tag.uri && tag.uri !== SVG_NAMESPACE) || ++elementCount > 2000 || stack.length >= 16) invalidSprite();
    stack.push(name);

    const attributes: Record<string, string> = {};
    for (const { local, uri, value } of Object.values(tag.attributes)) {
      if (uri) continue;
      const rule = Object.hasOwn(RULES, local) ? RULES[local]
        : GEOMETRY.has(local) || local === 'points' ? NUMERIC
        : local === 'd' ? PATH : undefined;
      if (rule) {
        if (!rule.test(value)) invalidSprite();
        attributes[local] = value;
      }
    }

    if (!parent && name === 'svg') {
      if (tag.attributes.viewBox) rootViewBox = viewBox(tag.attributes.viewBox.value);
      rootPresentation = Object.fromEntries(Object.entries(attributes).filter(([key]) => Object.hasOwn(RULES, key)));
    } else if (parent === 'svg' && name === 'defs') {
      // Symbols in a root defs element are emitted as top-level symbols.
    } else if ((parent === 'svg' || parent === 'defs') && name === 'symbol') {
      const sourceId = tag.attributes.id?.value ?? '';
      if (!SOURCE_ID.test(sourceId) || icons.size >= 64) invalidSprite();
      const id: CustomIconId = `custom-${sourceId}`;
      if (icons.has(id)) invalidSprite();
      icons.add(id);
      shapesInSymbol = 0;
      const box = tag.attributes.viewBox ? viewBox(tag.attributes.viewBox.value) : rootViewBox;
      svg.push(`<symbol id="${id}" viewBox="${box}"${serializeAttributes({ fill: 'currentColor', stroke: 'none', ...rootPresentation, ...attributes })}>`);
    } else if ((name === 'title' || name === 'desc') && (parent === 'svg' || parent === 'symbol')) {
      // Metadata is unnecessary in the served sprite. Picker labels come from IDs.
    } else if ((parent === 'symbol' || parent === 'g') && SHAPES.has(name)) {
      if (name !== 'g') shapesInSymbol++;
      svg.push(`<${name}${serializeAttributes(attributes)}>`);
    } else {
      invalidSprite();
    }
  });
  parser.on('closetag', ({ local }) => {
    stack.pop();
    if (local === 'symbol' && !shapesInSymbol) invalidSprite();
    if (local === 'symbol' || SHAPES.has(local)) svg.push(`</${local}>`);
  });
  parser.write(source).close();
  if (!icons.size) invalidSprite();
  svg.push('</svg>');
  return { icons: [...icons], svg: svg.join('') };
}
