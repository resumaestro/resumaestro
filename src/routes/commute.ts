import commuteConfig from '../../config/commute-distances.json';

import type { Env } from '../types';

const GEOAPIFY_ROUTING_URL = 'https://api.geoapify.com/v1/routing';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_USER_AGENT =
  'DistanceToJob/1.0 (contact: hi@cameronaziz.com)';
const START_LOCATION = {
  latitude: 34.010466,
  longitude: -118.484926,
} as const;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
} as const;

type Coordinate = {
  latitude: number;
  longitude: number;
};

type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: unknown;
  [key: string]: unknown;
};

type GeoapifyRoute = {
  distance?: number;
  time?: number;
  [key: string]: unknown;
};

type GeoapifyResponse = {
  results?: GeoapifyRoute[];
  [key: string]: unknown;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleCommute(
  request: Request,
  env: Pick<Env, 'GEOAPIFY_API_KEY'>,
): Promise<Response> {
  try {
    return await routeCommuteRequest(request, env);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }

    console.error(
      JSON.stringify({
        event: 'commute_unhandled_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    );

    return json({ error: 'Internal server error' }, 500);
  }
}

async function routeCommuteRequest(
  request: Request,
  env: Pick<Env, 'GEOAPIFY_API_KEY'>,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/commute/config') {
    return json({
      startLocation: START_LOCATION,
      ...commuteConfig,
    });
  }

  if (
    request.method === 'POST' &&
    url.pathname === '/commute/route/coordinates'
  ) {
    const body = await parseJsonObject(request);
    const destination = parseCoordinate(body.destination, 'destination');

    return json(await buildRouteResponse(destination, env));
  }

  if (
    request.method === 'POST' &&
    url.pathname === '/commute/route/address'
  ) {
    const body = await parseJsonObject(request);

    if (typeof body.address !== 'string' || body.address.trim().length === 0) {
      throw new HttpError(400, 'address must be a non-empty string');
    }

    const query = body.address.trim();
    const geocoded = await geocodeAddress(query);
    const response = await buildRouteResponse(geocoded.destination, env);

    return json({
      ...response,
      geocoding: {
        query,
        displayName: geocoded.displayName,
        address: geocoded.address,
      },
    });
  }

  return json(
    {
      error: 'Not found',
      endpoints: [
        'GET /commute/config',
        'POST /commute/route/coordinates',
        'POST /commute/route/address',
      ],
    },
    404,
  );
}

async function parseJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }

  if (!isRecord(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }

  return body;
}

function parseCoordinate(value: unknown, fieldName: string): Coordinate {
  if (
    !isRecord(value) ||
    typeof value.latitude !== 'number' ||
    typeof value.longitude !== 'number' ||
    !Number.isFinite(value.latitude) ||
    !Number.isFinite(value.longitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    value.longitude < -180 ||
    value.longitude > 180
  ) {
    throw new HttpError(
      400,
      `${fieldName} must contain valid latitude and longitude numbers`,
    );
  }

  return {
    latitude: value.latitude,
    longitude: value.longitude,
  };
}

async function fetchGeoapifyRoute(
  destination: Coordinate,
  mode: string,
  env: Pick<Env, 'GEOAPIFY_API_KEY'>,
): Promise<GeoapifyRoute> {
  if (!env.GEOAPIFY_API_KEY) {
    throw new HttpError(500, 'GEOAPIFY_API_KEY is not configured');
  }

  const url = new URL(GEOAPIFY_ROUTING_URL);
  url.searchParams.set(
    'waypoints',
    `${formatCoordinate(START_LOCATION)}|${formatCoordinate(destination)}`,
  );
  url.searchParams.set('mode', mode);
  url.searchParams.set('format', 'json');
  url.searchParams.set('units', 'metric');
  url.searchParams.set('apiKey', env.GEOAPIFY_API_KEY);

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: 'geoapify_error',
        status: response.status,
      }),
    );
    throw new HttpError(502, `Geoapify request failed (${response.status})`);
  }

  const data = (await response.json()) as GeoapifyResponse;
  const route = data.results?.[0];

  if (!route) {
    throw new HttpError(404, 'Geoapify did not find a route');
  }

  return route;
}

async function geocodeAddress(address: string): Promise<{
  destination: Coordinate;
  displayName: string | null;
  address: unknown;
}> {
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '1');
  url.searchParams.set('polygon_svg', '1');

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': NOMINATIM_USER_AGENT,
    },
  });

  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: 'nominatim_error',
        status: response.status,
      }),
    );
    throw new HttpError(502, `Nominatim request failed (${response.status})`);
  }

  const results = (await response.json()) as NominatimResult[];
  const result = results[0];
  const latitude = Number(result?.lat);
  const longitude = Number(result?.lon);

  if (!result || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new HttpError(404, 'Nominatim did not find the address');
  }

  return {
    destination: {
      latitude,
      longitude,
    },
    displayName:
      typeof result.display_name === 'string' ? result.display_name : null,
    address: result.address ?? null,
  };
}

async function evaluateCommute(
  destination: Coordinate,
  commuteType: 'drive' | 'transit',
  env: Pick<Env, 'GEOAPIFY_API_KEY'>,
) {
  const policy = commuteConfig.commuteTypes[commuteType];
  const route = await fetchGeoapifyRoute(
    destination,
    policy.geoapifyMode,
    env,
  );
  const distanceMeters = route.distance;

  if (typeof distanceMeters !== 'number') {
    throw new HttpError(502, 'Geoapify returned a route without a distance');
  }

  const maxDistanceMeters = policy.maxDistance * 1_000;

  return {
    commuteType,
    geoapifyMode: policy.geoapifyMode,
    distanceMeters,
    durationSeconds: route.time ?? null,
    maxDistanceMeters,
    withinConfiguredDistance: distanceMeters <= maxDistanceMeters,
    route,
  };
}

async function buildRouteResponse(
  destination: Coordinate,
  env: Pick<Env, 'GEOAPIFY_API_KEY'>,
) {
  const [drive, transit] = await Promise.all([
    evaluateCommute(destination, 'drive', env),
    evaluateCommute(destination, 'transit', env),
  ]);

  return {
    origin: START_LOCATION,
    destination,
    routes: {
      drive,
      transit,
    },
  };
}

function formatCoordinate(coordinate: Coordinate): string {
  return `${coordinate.latitude},${coordinate.longitude}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}
