import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../src/App';

describe('App', () => {
  it('shows connect screen without a stored session', async () => {
    render(<App />);
    expect(await screen.findByText('Server URL')).toBeTruthy();
  });
});
