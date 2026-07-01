import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import TavernFeed from './TavernFeed';
import { flattenScreenText } from '../utils/test-render';

// Mock EventSource globally
const mockEventSource = {
  onmessage: null as any,
  onopen: null as any,
  onerror: null as any,
  close: jest.fn(),
};

(global as any).EventSource = jest.fn(() => mockEventSource);

// Mock fetch
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function collectText(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join('');
  return collectText(node.props?.children);
}

describe('TavernFeed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEventSource.close.mockClear();
    mockEventSource.onmessage = null;
    mockEventSource.onopen = null;
    mockEventSource.onerror = null;
  });

  it('renders loading state initially', async () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    await render(<TavernFeed />);
    const text = flattenScreenText();

    expect(text).toContain('The Tavern');
  });

  it('renders events after feed loads', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        events: [
          { id: '1', type: 'PROOF_VERIFIED', message: 'User proved gym visit', timestamp: new Date().toISOString() },
          { id: '2', type: 'CONTRACT_FAILED', message: 'Contract expired', timestamp: new Date().toISOString() },
        ],
      }),
    });

    await render(<TavernFeed />);

    await waitFor(() => {
      const text = flattenScreenText();
      expect(text).toContain('User proved gym visit');
      expect(text).toContain('Contract expired');
    });
  });

  it('renders correct event type icons', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({
        events: [
          { id: '1', type: 'PROOF_VERIFIED', message: 'Verified', timestamp: new Date().toISOString() },
        ],
      }),
    });

    await render(<TavernFeed />);

    await waitFor(() => {
      const text = flattenScreenText();
      expect(text).toContain('PROOF VERIFIED');
    });
  });

  it('renders empty state when no events', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ events: [] }),
    });

    await render(<TavernFeed />);

    await waitFor(() => {
      const text = flattenScreenText();
      expect(text).toContain('No events yet');
    });
  });

  it('renders Live Activity Feed subheader after loading', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ events: [] }),
    });

    await render(<TavernFeed />);

    await waitFor(() => {
      const text = flattenScreenText();
      expect(text).toContain('Live Activity Feed');
    });
  });

  it('creates EventSource connection for SSE', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ events: [] }),
    });

    await render(<TavernFeed />);

    expect(EventSource).toHaveBeenCalledWith(
      expect.stringContaining('/feed/stream'),
    );
  });

  it('handles fetch error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await render(<TavernFeed />);

    await waitFor(() => {
      const text = flattenScreenText();
      // Should still render — just with no events
      expect(text).toContain('The Tavern');
    });
  });
});
