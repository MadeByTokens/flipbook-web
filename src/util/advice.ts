// The words shown when something is more than this device can take.

import { fits, megabytes } from './device';

/** Bits per second the movie encoder is asked for: the most a movie can come to. */
export const MOVIE_BITRATE = 12_000_000;

/** The most bytes an MP4 of this many frames can take. Drawings usually need far less. */
export function movieBytes(frames: number, fps: number): number {
  return Math.ceil(((frames / Math.max(1, fps)) * MOVIE_BITRATE) / 8);
}

/** Why a movie this long cannot be made here, or '' when it can. Movies are built in memory. */
export function movieProblem(frames: number, fps: number, memoryLimit: number): string {
  const bytes = movieBytes(frames, fps);
  if (bytes <= memoryLimit) return '';
  const seconds = Math.floor((memoryLimit * 8) / MOVIE_BITRATE);
  return `This animation is too long to make into one video on this device: it could need ${megabytes(bytes)} of memory, and about ${megabytes(memoryLimit)} is safe here. Up to ${seconds} seconds will work.`;
}

/**
 * Why a project file of this size cannot be opened here, or ''. It is read
 * whole and unpacked in memory, about three times its size while that lasts,
 * and what it holds then has to fit in storage.
 */
export function openProblem(bytes: number, free: number | null, memoryLimit: number): string {
  if (bytes * 3 > memoryLimit) {
    return `This project file is ${megabytes(bytes)}, more than this device can open safely (about ${megabytes(memoryLimit / 3)}).`;
  }
  if (!fits(bytes, free)) return `There is not enough storage left to open this project file: it is ${megabytes(bytes)} and ${megabytes(free ?? 0)} is free.`;
  return '';
}
