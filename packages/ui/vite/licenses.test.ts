// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOWED, shippedPackages } from './licenses.ts';

const notices = fs.readFileSync(path.resolve(__dirname, '../../../THIRD-PARTY-NOTICES.md'), 'utf8');

describe('shipped npm packages', () => {
  const pkgs = shippedPackages();

  it('are all under permissive licences and carry their licence text', () => {
    for (const p of pkgs) {
      expect(p.license, p.name).toMatch(ALLOWED);
      expect(p.files.length, `${p.name} licence file`).toBeGreaterThan(0);
    }
  });

  it('are all listed in THIRD-PARTY-NOTICES.md with their exact version', () => {
    for (const p of pkgs) {
      expect(notices, p.name).toContain(`| ${p.name} | ${p.version} |`);
    }
  });

  it('EmbedPDF is pinned to exactly 2.15.1', () => {
    const ui = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    expect(ui.dependencies['@embedpdf/snippet']).toBe('2.15.1');
    expect(ui.dependencies['@embedpdf/react-pdf-viewer']).toBe('2.15.1');
    expect(pkgs.find((p) => p.name === '@embedpdf/snippet')?.version).toBe('2.15.1');
  });
});
