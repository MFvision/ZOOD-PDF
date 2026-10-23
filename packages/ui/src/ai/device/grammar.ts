/**
 * A JSON Schema as a GBNF grammar, the form llama.cpp constrains its
 * sampling with: the on-device model then cannot answer a data task (OCR
 * corrections, form values, personal information, tables) with anything but
 * JSON of the shape asked — the way Claude's structured outputs and Ollama's
 * `format` hold the other providers to it. The answer is still checked
 * field by field when it comes back (`extras/json.ts`): the grammar keeps
 * the shape, not the sense.
 *
 * Only what the panel's schemas use is covered: objects with fixed,
 * required properties, arrays, strings, integers, numbers, booleans and
 * string enums. Anything else is refused rather than half-constrained.
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
  /** How many items an array holds, when it says: both are needed for a bound. */
  minItems?: number;
  maxItems?: number;
  enum?: readonly string[];
};

/** A JSON string literal as a GBNF literal: `"…"` with `"` and `\` escaped. */
function literal(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const PRIMITIVES: Record<string, string> = {
  space: '" "?',
  string: '"\\"" ( [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt] | "u" [0-9a-fA-F]{4}) )* "\\"" space',
  integer: '("-"? ([0-9] | [1-9] [0-9]{0,15})) space',
  number: '("-"? ([0-9] | [1-9] [0-9]{0,15})) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? space',
  boolean: '("true" | "false") space',
  null: '"null" space',
};

export class GrammarError extends Error {}

export function schemaToGrammar(schema: object): string {
  const rules = new Map<string, string>();
  const used = new Set<string>();
  const primitive = (name: string): string => {
    used.add(name);
    return name;
  };
  let count = 0;
  const define = (base: string, body: string): string => {
    const name = `${base}${count++}`;
    rules.set(name, body);
    return name;
  };

  const visit = (node: Schema, base: string): string => {
    if (node.enum) {
      if (!node.enum.every((value) => typeof value === 'string')) throw new GrammarError('enum of strings only');
      const alternatives = node.enum.map((value) => literal(JSON.stringify(value))).join(' | ');
      return define(`${base}-enum`, `(${alternatives}) ${primitive('space')}`);
    }
    switch (node.type) {
      case 'string':
      case 'integer':
      case 'number':
      case 'boolean':
      case 'null':
        return primitive(node.type);
      case 'array': {
        if (!node.items) throw new GrammarError('array without items');
        const item = visit(node.items, `${base}-item`);
        const { minItems: least, maxItems: most } = node;
        if (least !== undefined && most !== undefined) {
          if (!Number.isInteger(least) || !Number.isInteger(most) || least < 1 || most < least || most > 100)
            throw new GrammarError('minItems and maxItems: 1 to 100');
          return define(
            `${base}-array`,
            `"[" ${primitive('space')} ${item} ("," ${primitive('space')} ${item}){${least - 1},${most - 1}} "]" ${primitive('space')}`,
          );
        }
        return define(`${base}-array`, `"[" ${primitive('space')} (${item} ("," ${primitive('space')} ${item})*)? "]" ${primitive('space')}`);
      }
      case 'object': {
        const properties = Object.entries(node.properties ?? {});
        const required = new Set(node.required ?? []);
        if (properties.length === 0) throw new GrammarError('object without properties');
        if (!properties.every(([key]) => required.has(key))) throw new GrammarError('every property must be required');
        const parts = properties.map(([key, value]) => {
          const rule = visit(value, `${base}-${key.replace(/[^a-zA-Z0-9]/g, '-')}`);
          return `${literal(JSON.stringify(key))} ${primitive('space')} ":" ${primitive('space')} ${rule}`;
        });
        return define(`${base}-object`, `"{" ${primitive('space')} ${parts.join(` "," ${primitive('space')} `)} "}" ${primitive('space')}`);
      }
      default:
        throw new GrammarError(`unsupported schema type ${String(node.type)}`);
    }
  };

  const root = visit(schema as Schema, 'root');
  const lines = [`root ::= ${root}`];
  for (const [name, body] of rules) lines.push(`${name} ::= ${body}`);
  for (const name of used) lines.push(`${name} ::= ${PRIMITIVES[name]}`);
  return lines.join('\n');
}
