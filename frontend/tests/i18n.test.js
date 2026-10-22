// Ensure centralized English labels are present.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.js';

describe('English interface strings', () => {
  it('includes the navigation and service status labels', () => {
    expect(en.appName).toBe('SmartHotel Ethiopia');
    expect(en.overview).toBeTruthy();
    expect(en.healthOnline).toBeTruthy();
  });
});
