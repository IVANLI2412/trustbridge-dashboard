import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const VUS = Math.max(1, Number(__ENV.VUS || 5));
const DURATION = __ENV.DURATION || '30s';
const CONTRIBUTOR_SESSION = __ENV.TEST_SESSION_COOKIE || '';
const MAINTAINER_SESSION = __ENV.TEST_MAINTAINER_SESSION_COOKIE || CONTRIBUTOR_SESSION;
const CSRF_ORIGIN = __ENV.TEST_CSRF_ORIGIN || BASE_URL;
const CSRF_REFERER = __ENV.TEST_CSRF_REFERER || `${CSRF_ORIGIN}/register`;
const CONTRIBUTORS_LIMIT = Number(__ENV.CONTRIBUTORS_LIMIT || 25);

const registrationAccepted = new Rate('registration_accepted');
const registrationConflict = new Rate('registration_conflict');
const registrationRateLimited = new Rate('registration_rate_limited');
const contributorsReadOk = new Rate('contributors_read_ok');

export const options = {
  scenarios: {
    registration_spike: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'registrationSpike',
    },
    contributors_paginated: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'contributorsPaginated',
    },
  },
  thresholds: {
    'http_req_failed{scenario:registration_spike}': ['rate<0.05'],
    'http_req_duration{scenario:registration_spike}': ['p(95)<3000'],
    'registration_accepted{scenario:registration_spike}': ['rate>0.90'],
    'registration_conflict{scenario:registration_spike}': ['rate<0.50'],
    'registration_rate_limited{scenario:registration_spike}': ['rate<0.50'],
    'http_req_failed{scenario:contributors_paginated}': ['rate<0.02'],
    'http_req_duration{scenario:contributors_paginated}': ['p(95)<1500'],
    'contributors_read_ok{scenario:contributors_paginated}': ['rate>0.95'],
    checks: ['rate>0.95'],
  },
};

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let addressCounter = 0;

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) encoded += BASE32[(value << (5 - bits)) & 31];
  return encoded;
}

function uniqueStellarAddress() {
  addressCounter += 1;
  const seed = `${Date.now()}-${__VU}-${__ITER}-${addressCounter}`;
  let state = 2166136261;
  for (const char of seed) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  const key = [];
  for (let index = 0; index < 32; index += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    key.push(state & 0xff);
  }
  const payload = [48, ...key];
  const crc = crc16(payload);
  return base32Encode(payload.concat([crc & 0xff, (crc >> 8) & 0xff]));
}

export function registrationSpike() {
  const tags = { scenario: 'registration_spike', name: 'registration-post' };
  check(null, {
    'registration: contributor session cookie configured': () => Boolean(CONTRIBUTOR_SESSION),
  });

  const res = http.post(
    `${BASE_URL}/api/register`,
    JSON.stringify({ stellarAddress: uniqueStellarAddress() }),
    {
      headers: {
        'Content-Type': 'application/json',
        Cookie: `next-auth.session-token=${CONTRIBUTOR_SESSION}`,
        Origin: CSRF_ORIGIN,
        Referer: CSRF_REFERER,
      },
      tags,
      responseCallback: http.expectedStatuses(200, 201, 409, 429),
      timeout: '10s',
    }
  );

  const created = res.status >= 200 && res.status < 300;
  registrationAccepted.add(created, tags);
  registrationConflict.add(res.status === 409, tags);
  registrationRateLimited.add(res.status === 429, tags);

  check(res, {
    'registration: status is 2xx, 409 or 429': (r) =>
      created || r.status === 409 || r.status === 429,
    'registration: 429 includes Retry-After': (r) =>
      r.status !== 429 || Boolean(r.headers['Retry-After']),
  });
  sleep(0.2);
}

export function contributorsPaginated() {
  const tags = { scenario: 'contributors_paginated', name: 'contributors-paginated' };
  check(null, {
    'contributors: maintainer session cookie configured': () => Boolean(MAINTAINER_SESSION),
  });

  const res = http.get(
    `${BASE_URL}/api/contributors/paginated?limit=${CONTRIBUTORS_LIMIT}`,
    {
      headers: {
        Cookie: `next-auth.session-token=${MAINTAINER_SESSION}`,
        Origin: CSRF_ORIGIN,
      },
      tags,
      responseCallback: http.expectedStatuses(200, 429),
      timeout: '10s',
    }
  );

  const ok = res.status === 200;
  contributorsReadOk.add(ok, tags);
  check(res, {
    'contributors: status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'contributors: 200 returns a contributors array': (r) => {
      if (r.status !== 200) return true;
      try {
        return Array.isArray(JSON.parse(r.body).contributors);
      } catch {
        return false;
      }
    },
  });
  sleep(0.5);
}
