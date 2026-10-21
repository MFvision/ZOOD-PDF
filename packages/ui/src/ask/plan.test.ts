import { describe, expect, it } from 'vitest';
import { newProfile } from '../ai/profile/wallet';
import type { WalletProfile } from '../ai/profile/wallet';
import { decisionGrammar, filledTargets, languageOf, readDecision, systemPrompt } from './plan';
import type { Moment } from './plan';

function me(): WalletProfile {
  const profile = newProfile('Me');
  profile.details.nameEn = 'Mohammed Ali';
  profile.details.nationalId = '1012345678';
  profile.details.phone = '0500000000';
  profile.custom.push({ label: 'Membership', value: 'M-77' });
  return profile;
}

const withFiles: Moment = {
  files: ['Contract.pdf', 'Invoice.pdf'],
  screen: false,
  profiles: [me()],
};
const seeing: Moment = { ...withFiles, screen: true };
const nothing: Moment = { files: [], screen: false, profiles: [] };

describe('what Ask ZOOD decides', () => {
  it('runs a tool on the selected files', () => {
    const decision = readDecision(
      '{"say":"Compressing them.","act":"tool","tool":"compress","query":"","fields":[],"profile":"Me"}',
      withFiles,
    );
    expect(decision).toMatchObject({ act: 'tool', tool: 'compress', say: 'Compressing them.' });
  });

  it('says what is missing instead of running a tool on nothing', () => {
    const decision = readDecision(
      '{"say":"Select the files first.","act":"tool","tool":"compress","query":"","fields":[],"profile":"none"}',
      nothing,
    );
    expect(decision).toMatchObject({ act: 'answer', tool: null });
  });

  it('types only details that have a value, in the order asked', () => {
    const decision = readDecision(
      '{"say":"Typing them.","act":"fill","tool":"none","query":"","fields":["nationalId","email","phone","custom.Membership"],"profile":"Me"}',
      withFiles,
    );
    expect(decision?.act).toBe('fill');
    expect(decision?.fields).toEqual(['nationalId', 'phone', 'custom.Membership']);
  });

  it('points only with a picture of the screen, and only on it', () => {
    const point =
      '{"say":"Click Save.","act":"point","tool":"none","query":"","fields":[],"profile":"Me","x":1500,"y":420}';
    expect(readDecision(point, seeing)).toMatchObject({ act: 'point', x: 1000, y: 420 });
    expect(readDecision(point, withFiles)).toMatchObject({ act: 'answer' });
  });

  it('finds with words, and answers without them', () => {
    expect(
      readDecision(
        '{"say":"Looking.","act":"find","tool":"none","query":"عقد الإيجار","fields":[],"profile":"Me"}',
        withFiles,
      ),
    ).toMatchObject({ act: 'find', query: 'عقد الإيجار' });
    expect(
      readDecision(
        '{"say":"What should I look for?","act":"find","tool":"none","query":"  ","fields":[],"profile":"Me"}',
        withFiles,
      ),
    ).toMatchObject({ act: 'answer' });
  });

  it('writes where the cursor is, and shows a longer answer to read', () => {
    const write =
      '{"say":"Here is your reply.","act":"write","tool":"none","query":"","fields":[],"profile":"Me","text":"Hi Sara,\\nThursday works for me."}';
    expect(readDecision(write, withFiles)).toMatchObject({
      act: 'write',
      text: 'Hi Sara,\nThursday works for me.',
    });
    expect(
      readDecision(
        '{"say":"What should I write?","act":"write","tool":"none","query":"","fields":[],"profile":"Me","text":""}',
        withFiles,
      ),
    ).toMatchObject({ act: 'answer', text: '' });
    expect(
      readDecision(
        '{"say":"A summary.","act":"answer","tool":"none","query":"","fields":[],"profile":"Me","text":"Three points."}',
        withFiles,
      ),
    ).toMatchObject({ act: 'answer', text: 'Three points.' });
    expect(
      readDecision(
        '{"say":"Compressing.","act":"tool","tool":"compress","query":"","fields":[],"profile":"Me","text":"stray"}',
        withFiles,
      ),
    ).toMatchObject({ text: '' });
  });

  it('refuses what is not a decision', () => {
    expect(readDecision('not json', withFiles)).toBeNull();
    expect(readDecision('[1,2]', withFiles)).toBeNull();
    expect(readDecision('{"act":"answer","say":""}', withFiles)).toBeNull();
    expect(readDecision('{"act":"format the disk","say":"No."}', withFiles)).toMatchObject({
      act: 'answer',
      say: 'No.',
    });
  });
});

describe('how the model is asked', () => {
  it('holds the answer to the shape, with a point only when it sees', () => {
    const grammar = decisionGrammar(withFiles);
    expect(grammar).toContain('"\\"compress\\""');
    expect(grammar).toContain('"\\"nationalId\\""');
    expect(grammar).toContain('"\\"custom.Membership\\""');
    expect(grammar).not.toContain('"\\"point\\""');
    expect(grammar).not.toContain('"\\"email\\""');
    expect(decisionGrammar(seeing)).toContain('"\\"point\\""');
    // With nothing saved, the list of details can only be empty.
    expect(decisionGrammar(nothing)).toContain('root');
  });

  it('tells the model the files and the details by name, never their values', () => {
    const prompt = systemPrompt(withFiles);
    expect(prompt).toContain('Contract.pdf');
    expect(prompt).toContain('nationalId');
    expect(prompt).not.toContain('1012345678');
    expect(prompt).not.toContain('Mohammed Ali');
    expect(prompt).not.toContain('"point"');
    expect(systemPrompt(seeing)).toContain('"point"');
    expect(systemPrompt(nothing)).toContain('no files are selected');
  });

  it('tells the model the window it was asked in, and how the person writes', () => {
    const prompt = systemPrompt({
      ...withFiles,
      window: { app: 'Outlook', title: 'RE: Rent', text: 'When will you pay?' },
      style: { about: 'I sign as Mohammed.', examples: '' },
    });
    expect(prompt).toContain('Outlook — RE: Rent');
    expect(prompt).toContain('When will you pay?');
    expect(prompt).toContain('I sign as Mohammed.');
    expect(prompt).toContain('"write"');
    expect(decisionGrammar(withFiles)).toContain('"\\"write\\""');
  });

  it('knows which details a profile can fill', () => {
    expect(filledTargets(me())).toEqual(['nameEn', 'nationalId', 'phone', 'custom.Membership']);
    expect(filledTargets(undefined)).toEqual([]);
  });

  it('speaks in the language the person used', () => {
    expect(languageOf('ضغط الملفات من فضلك')).toBe('ar');
    expect(languageOf('compress these please')).toBe('en');
    expect(languageOf('افتح Contract')).toBe('ar');
    expect(languageOf('123')).toBe('en');
  });
});
