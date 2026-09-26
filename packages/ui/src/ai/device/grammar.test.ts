import { describe, expect, it } from 'vitest';
import { FILL_SCHEMA } from '../extras/formFill';
import { OCR_FIX_SCHEMA } from '../extras/ocrFix';
import { PII_SCHEMA } from '../extras/pii';
import { TABLES_SCHEMA } from '../extras/tables';
import { GrammarError, schemaToGrammar } from './grammar';

/** The rule names a grammar refers to, so a grammar that names a rule it never defines is caught here, not by llama.cpp at run time. */
function referenced(grammar: string): { defined: Set<string>; used: Set<string> } {
  const defined = new Set<string>();
  const used = new Set<string>();
  for (const line of grammar.split('\n')) {
    const [name, body] = line.split(' ::= ');
    defined.add(name!);
    // Rule names outside string literals and character classes, which both may hold quotes and brackets.
    let bare = '';
    let inside: '"' | ']' | null = null;
    for (let i = 0; i < body!.length; i += 1) {
      const ch = body![i]!;
      if (inside) {
        if (ch === '\\') i += 1;
        else if (ch === inside) inside = null;
        continue;
      }
      if (ch === '"') inside = '"';
      else if (ch === '[') inside = ']';
      else bare += ch;
    }
    for (const match of bare.matchAll(/[a-zA-Z][a-zA-Z0-9-]*/g)) used.add(match[0]);
  }
  return { defined, used };
}

describe('schemaToGrammar', () => {
  it.each([
    ['form values', FILL_SCHEMA],
    ['OCR corrections', OCR_FIX_SCHEMA],
    ['personal information', PII_SCHEMA],
    ['tables', TABLES_SCHEMA],
  ])('writes a closed grammar for the %s schema', (_, schema) => {
    const grammar = schemaToGrammar(schema);
    expect(grammar.startsWith('root ::= ')).toBe(true);
    const { defined, used } = referenced(grammar);
    for (const name of used) expect(defined.has(name), `${name} is used but never defined`).toBe(true);
  });

  it('holds the object to its keys, in order, all required', () => {
    const grammar = schemaToGrammar(FILL_SCHEMA);
    expect(grammar).toContain('"\\"values\\"" space ":" space');
    expect(grammar).toContain('"\\"field\\"" space ":" space string "," space "\\"value\\"" space ":" space string');
  });

  it('writes an enum as its literals only', () => {
    const grammar = schemaToGrammar(PII_SCHEMA);
    expect(grammar).toMatch(/kind-enum\d+ ::= \("\\"name\\"" \| "\\"address\\""/);
  });

  it('refuses what it cannot constrain, rather than half-constraining it', () => {
    expect(() => schemaToGrammar({ type: 'object', properties: { a: { type: 'string' } } })).toThrow(GrammarError);
    expect(() => schemaToGrammar({ type: 'array' })).toThrow(GrammarError);
    expect(() => schemaToGrammar({ type: 'object', properties: { a: { oneOf: [] } }, required: ['a'] })).toThrow(GrammarError);
  });
});
