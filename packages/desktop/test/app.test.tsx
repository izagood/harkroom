import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import App from '../src/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows connect screen without a stored session', async () => {
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();
  });
});
