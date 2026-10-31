/**
 * A small XML reader for the parts of Office files (`word/document.xml`,
 * `xl/worksheets/sheet1.xml`…): elements with their namespace resolved,
 * attributes, text, entities and CDATA. The same code runs in every host and
 * in the unit tests, where there is no `DOMParser`.
 *
 * The files come from a person's disk, so this never throws on bad input and
 * never recurses: what it cannot read it skips, and nesting is bounded.
 */

export interface XmlElement {
  /** The namespace the element is in, resolved from `xmlns` declarations; '' for none. */
  ns: string;
  /** The name without its prefix: `p` for `w:p`. */
  local: string;
  /** Attributes by their name as written (`w:val`), and by namespace + local name (`{ns}val`). */
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const MAX_DEPTH = 256;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `&amp;`, `&#1575;`, `&#x627;`: unknown entities stay as they are. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? whole;
  });
}

interface Open {
  element: XmlElement;
  /** Prefix → namespace in scope here. */
  scope: Map<string, string>;
  /** The element's name as written, for matching its end tag. */
  name: string;
}

function splitName(name: string): [string, string] {
  const colon = name.indexOf(':');
  return colon < 0 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)];
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/**
 * `name="value"` pairs of a tag's body, in one pass. A regular expression
 * here took minutes on a tag left open with a long value (`<a b="xxx…`): it
 * tried again from every letter of it.
 */
export function readAttributes(body: string): [string, string][] {
  const out: [string, string][] = [];
  const n = body.length;
  let k = 0;
  while (k < n) {
    while (k < n && isSpace(body[k])) k += 1;
    const start = k;
    while (k < n && !isSpace(body[k]) && body[k] !== '=' && body[k] !== '/' && body[k] !== '>') k += 1;
    if (k === start) {
      k += 1;
      continue;
    }
    const name = body.slice(start, k);
    while (k < n && isSpace(body[k])) k += 1;
    if (body[k] !== '=') continue;
    k += 1;
    while (k < n && isSpace(body[k])) k += 1;
    const quote = body[k];
    if (quote !== '"' && quote !== "'") continue;
    const end = body.indexOf(quote, k + 1);
    // A value never closed: the rest of the tag is no attributes.
    if (end < 0) break;
    out.push([name, decodeEntities(body.slice(k + 1, end))]);
    k = end + 1;
  }
  return out;
}

/**
 * The most elements one part is read into: past it the rest is left out and
 * the root says `truncated`. A worksheet of a million rows would otherwise
 * take gigabytes as a tree, from a file of a few megabytes.
 */
export const MAX_ELEMENTS = 1_000_000;

/**
 * The root element of `source`, or null if it has none that can be read.
 * Past `maxElements` elements the rest is not read, and the root has
 * `truncated` set.
 */
export function parseXml(source: string, maxElements = MAX_ELEMENTS): (XmlElement & { truncated?: boolean }) | null {
  let elements = 0;
  let truncated = false;
  const root: XmlElement = { ns: '', local: '#document', attrs: {}, children: [] };
  const stack: Open[] = [{ element: root, scope: new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]), name: '' }];
  let at = 0;
  const top = () => stack[stack.length - 1]!;
  while (at < source.length) {
    const lt = source.indexOf('<', at);
    if (lt < 0) {
      const text = source.slice(at);
      if (stack.length > 1 && text.length > 0) top().element.children.push(decodeEntities(text));
      break;
    }
    if (lt > at && stack.length > 1) top().element.children.push(decodeEntities(source.slice(at, lt)));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const text = source.slice(lt + 9, end < 0 ? source.length : end);
      if (stack.length > 1) top().element.children.push(text);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      at = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      // A doctype: skipped, with any internal subset.
      let depth = 0;
      let k = lt + 2;
      for (; k < source.length; k += 1) {
        const c = source[k];
        if (c === '[') depth += 1;
        else if (c === ']') depth -= 1;
        else if (c === '>' && depth <= 0) break;
      }
      at = k + 1;
      continue;
    }
    // A tag: find its end outside quotes.
    let k = lt + 1;
    let quote: string | null = null;
    for (; k < source.length; k += 1) {
      const c = source[k];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const tag = source.slice(lt + 1, k);
    at = k + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      // Close up to the matching element; a stray end tag is ignored.
      const index = stack.map((o) => o.name).lastIndexOf(name);
      if (index > 0) stack.length = index;
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameEnd = body.search(/[\s/]|$/);
    const name = body.slice(0, nameEnd);
    if (!name) continue;
    if (elements >= maxElements) {
      truncated = true;
      break;
    }
    elements += 1;
    const written = readAttributes(body.slice(nameEnd));
    // The scope is copied only where the element declares a namespace: a
    // copy for every element was quadratic under a root declaring many.
    const declares = written.some(([key]) => key === 'xmlns' || key.startsWith('xmlns:'));
    const scope = declares ? new Map(top().scope) : top().scope;
    for (const [key, value] of written) {
      if (key === 'xmlns') scope.set('', value);
      else if (key.startsWith('xmlns:')) scope.set(key.slice(6), value);
    }
    const [prefix, local] = splitName(name);
    const attrs: Record<string, string> = {};
    for (const [key, value] of written) {
      attrs[key] = value;
      const [p, l] = splitName(key);
      if (p && p !== 'xmlns') attrs[`{${scope.get(p) ?? ''}}${l}`] = value;
    }
    const element: XmlElement = { ns: scope.get(prefix) ?? '', local, attrs, children: [] };
    top().element.children.push(element);
    if (!selfClosing && stack.length < MAX_DEPTH) stack.push({ element, scope, name });
  }
  const first: (XmlElement & { truncated?: boolean }) | null = root.children.find((c): c is XmlElement => typeof c !== 'string') ?? null;
  if (first && truncated) first.truncated = true;
  return first;
}

/** The element's children that are elements, optionally only those called `local` (in `ns`). */
export function childElements(element: XmlElement | null | undefined, local?: string, ns?: string): XmlElement[] {
  if (!element) return [];
  return element.children.filter(
    (c): c is XmlElement => typeof c !== 'string' && (local === undefined || c.local === local) && (ns === undefined || c.ns === ns),
  );
}

export function firstChild(element: XmlElement | null | undefined, local: string, ns?: string): XmlElement | null {
  return childElements(element, local, ns)[0] ?? null;
}

/** Every element under `element` called `local`, in document order, without recursion. */
export function descendants(element: XmlElement | null | undefined, local: string, ns?: string): XmlElement[] {
  const out: XmlElement[] = [];
  if (!element) return out;
  const todo: XmlElement[] = [element];
  while (todo.length > 0) {
    const next = todo.pop()!;
    const kids = childElements(next);
    for (let i = kids.length - 1; i >= 0; i -= 1) todo.push(kids[i]!);
    if (next !== element && next.local === local && (ns === undefined || next.ns === ns)) out.push(next);
  }
  return out;
}

/** All the text inside `element`. */
export function textOf(element: XmlElement | null | undefined): string {
  if (!element) return '';
  let out = '';
  const todo: XmlNode[] = [element];
  while (todo.length > 0) {
    const next = todo.pop()!;
    if (typeof next === 'string') out += next;
    else for (let i = next.children.length - 1; i >= 0; i -= 1) todo.push(next.children[i]!);
  }
  return out;
}

/** An attribute by local name in `ns`, or as written with any prefix. */
export function attr(element: XmlElement | null | undefined, local: string, ns?: string): string | undefined {
  if (!element) return undefined;
  if (ns !== undefined) {
    const qualified = element.attrs[`{${ns}}${local}`];
    if (qualified !== undefined) return qualified;
  }
  if (element.attrs[local] !== undefined) return element.attrs[local];
  const key = Object.keys(element.attrs).find((k) => !k.startsWith('{') && k.endsWith(`:${local}`));
  return key === undefined ? undefined : element.attrs[key];
}
