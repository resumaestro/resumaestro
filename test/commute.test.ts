import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCommute } from '../src/routes/commute';

const env = {
  GEOAPIFY_API_KEY: 'test-key',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Resumaestro commute routes', () => {
  it('returns the commute configuration', async () => {
    const response = await handleCommute(
      new Request('https://worker.test/commute/config'),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      startLocation: {
        latitude: 34.010466,
        longitude: -118.484926,
      },
      commuteTypes: {
        drive: {
          geoapifyMode: 'drive',
          maxDistance: 80,
        },
        transit: {
          geoapifyMode: 'transit',
          maxDistance: 50,
        },
      },
    });
  });

  it('routes a coordinate destination', async () => {
    const fetchMock = createRoutingFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleCommute(
      new Request('https://worker.test/commute/route/coordinates', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          destination: {
            latitude: 34.052235,
            longitude: -118.243683,
          },
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      origin: {
        latitude: 34.010466,
        longitude: -118.484926,
      },
      destination: {
        latitude: 34.052235,
        longitude: -118.243683,
      },
      routes: {
        drive: {
          commuteType: 'drive',
          distanceMeters: 31_000,
          maxDistanceMeters: 80_000,
          withinConfiguredDistance: true,
        },
        transit: {
          commuteType: 'transit',
          distanceMeters: 33_000,
          maxDistanceMeters: 50_000,
          withinConfiguredDistance: true,
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calledUrls = fetchMock.mock.calls.map(([input]) => new URL(input));
    expect(calledUrls.map((url) => url.searchParams.get('mode')).sort()).toEqual(
      ['drive', 'transit'],
    );
    for (const calledUrl of calledUrls) {
      expect(calledUrl.origin + calledUrl.pathname).toBe(
        'https://api.geoapify.com/v1/routing',
      );
      expect(calledUrl.searchParams.get('waypoints')).toBe(
        '34.010466,-118.484926|34.052235,-118.243683',
      );
      expect(calledUrl.searchParams.get('apiKey')).toBe('test-key');
    }
  });

  it('geocodes an address before routing', async () => {
    const fetchMock = createRoutingFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleCommute(
      new Request('https://worker.test/commute/route/address', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          address: '1920 6th street, Santa Monica, CA, 90405 USA',
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      destination: {
        latitude: 34.0106,
        longitude: -118.488,
      },
      geocoding: {
        query: '1920 6th street, Santa Monica, CA, 90405 USA',
        displayName: '1920, 6th Street, Santa Monica, California',
      },
      routes: {
        drive: {
          commuteType: 'drive',
        },
        transit: {
          commuteType: 'transit',
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const nominatimCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith('https://nominatim.openstreetmap.org/search'),
    );
    expect(nominatimCall).toBeDefined();

    const nominatimHeaders = new Headers(nominatimCall![1]?.headers);
    expect(nominatimHeaders.get('user-agent')).toBe(
      'DistanceToJob/1.0 (contact: hi@cameronaziz.com)',
    );
  });
});

function createRoutingFetchMock() {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.hostname === 'nominatim.openstreetmap.org') {
      return Promise.resolve(
        Response.json([
          {
            lat: '34.0106',
            lon: '-118.4880',
            display_name: '1920, 6th Street, Santa Monica, California',
            address: {
              house_number: '1920',
              road: '6th Street',
              city: 'Santa Monica',
            },
          },
        ]),
      );
    }

    const mode = url.searchParams.get('mode');
    return Promise.resolve(
      Response.json({
        results: [
          {
            distance: mode === 'drive' ? 31_000 : 33_000,
            time: mode === 'drive' ? 2_400 : 4_200,
          },
        ],
      }),
    );
  });
}
