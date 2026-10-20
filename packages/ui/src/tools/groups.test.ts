import { describe, expect, it } from 'vitest';
import { TOOL_GROUPS } from './groups';
import { TOOLS } from './tools';

describe('the tools under eight headings', () => {
  it('has every tool under exactly one heading', () => {
    const grouped = TOOL_GROUPS.flatMap((group) => group.tools);
    expect(TOOL_GROUPS).toHaveLength(8);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(TOOLS.map((tool) => tool.id).sort());
  });
});
