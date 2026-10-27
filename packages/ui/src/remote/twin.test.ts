import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import { nearestSide, realSide, sideForKey, twinError } from './twin';

describe('two computers, one mouse', () => {
  it('puts the other screen on the right when Auto', () => {
    expect(realSide('auto')).toBe('right');
    expect(realSide('top')).toBe('top');
  });

  it('lands the dragged screen on the side nearest the pointer', () => {
    expect(nearestSide(0.9, 0.1)).toBe('right');
    expect(nearestSide(-0.9, 0.3)).toBe('left');
    expect(nearestSide(0.2, -0.8)).toBe('top');
    expect(nearestSide(-0.1, 0.7)).toBe('bottom');
  });

  it('moves it with the arrow keys only', () => {
    expect(sideForKey('ArrowLeft')).toBe('left');
    expect(sideForKey('ArrowUp')).toBe('top');
    expect(sideForKey('Enter')).toBeNull();
  });

  it('says each pairing error in words', () => {
    expect(twinError('E_TWIN_DENIED')).toBe('twin.error.denied');
    expect(twinError(new Error('E_TWIN_NOT_OPEN'))).toBe('twin.error.not_open');
    expect(twinError('E_TWIN_UNREACHABLE')).toBe('twin.error.unreachable');
    expect(twinError('something else')).toBe('twin.error.other');
    for (const code of [
      'E_TWIN_DENIED',
      'E_TWIN_NOT_OPEN',
      'E_TWIN_TIMEOUT',
      'E_TWIN_UNREACHABLE',
      'x',
    ]) {
      expect(en[twinError(code)]).toBeTruthy();
    }
  });
});
