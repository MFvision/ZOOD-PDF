import { describe, expect, it } from 'vitest';
import { ABOUT, openSourceNotices, supportMail } from './about';

describe('Settings › About', () => {
  it('names the original builder and the copyright holder', () => {
    expect(ABOUT.builder.en).toBe('Muhammad Alghammas');
    expect(ABOUT.copyright).toBe('ZOOD');
    expect(ABOUT.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists every component in the notices with its licence', () => {
    const notices = openSourceNotices('| Component | License | Use |\n|---|---|---|\n| [EmbedPDF](x) (`viewer`) | MIT | view |\n| lopdf | MIT | model |\n');
    expect(notices).toEqual([
      { component: 'EmbedPDF (viewer)', licence: 'MIT' },
      { component: 'lopdf', licence: 'MIT' },
    ]);
    expect(openSourceNotices().length).toBeGreaterThan(10);
  });

  it('writes a support mail with the version in it', () => {
    const mail = supportMail('ZOOD PDF', 'Windows');
    expect(mail.startsWith(`mailto:${ABOUT.email}?subject=`)).toBe(true);
    expect(decodeURIComponent(mail)).toContain(`ZOOD PDF ${ABOUT.version}`);
  });
});
