import { describe, expect, it } from 'vitest';
import { MOVIE_BITRATE, movieBytes, movieProblem, openProblem } from './advice';
import { RESERVE } from './device';

describe('movie size', () => {
  it('grows with the length of the animation', () => {
    expect(movieBytes(12, 12)).toBe(MOVIE_BITRATE / 8);
    expect(movieBytes(240, 12)).toBe((20 * MOVIE_BITRATE) / 8);
  });

  it('lets through what fits in memory and says how long would fit otherwise', () => {
    const limit = (60 * MOVIE_BITRATE) / 8;
    expect(movieProblem(60 * 12, 12, limit)).toBe('');
    const text = movieProblem(61 * 12, 12, limit);
    expect(text).toContain('too long to make into one video');
    expect(text).toContain('Up to 60 seconds');
  });
});

describe('opening a project file', () => {
  it('allows a file that fits in memory and in storage', () => {
    expect(openProblem(10e6, null, 30e6)).toBe('');
    expect(openProblem(10e6, 10e6 + RESERVE, 30e6)).toBe('');
  });

  it('refuses one too large for memory', () => {
    expect(openProblem(11e6, null, 30e6)).toContain('more than this device can open safely');
  });

  it('refuses one with no room in storage', () => {
    expect(openProblem(10e6, 5e6, 30e6)).toContain('not enough storage left');
  });
});
