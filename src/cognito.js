import { timed } from './util.js';

const COGNITO_REGION = 'ap-south-1';
export const COGNITO_CLIENT_ID = '3fqhvm22ea8pjsr2spbnv484pr';
export const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
const COGNITO_CLIENT_METADATA = { myCustomKey: 'myCustomValue' };

export function jwtExpMs(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return Number(exp) * 1000;
  } catch {
    return 0;
  }
}

export async function cognitoInitiateAuth({ username, password, refreshToken, fetchImpl } = {}) {
  const fetchFn = fetchImpl || fetch;
  const body = refreshToken
    ? {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
      ClientMetadata: COGNITO_CLIENT_METADATA,
    }
    : {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
      ClientMetadata: COGNITO_CLIENT_METADATA,
    };
  const res = await fetchFn(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`cognito non-json ${res.status}`);
  }
  if (!res.ok || data.__type || data.message) {
    const msg = data.message || data.__type || `HTTP ${res.status}`;
    throw new Error(`cognito auth failed: ${msg}`);
  }
  if (data.ChallengeName) {
    throw new Error(`cognito extra challenge: ${data.ChallengeName}`);
  }
  const ar = data.AuthenticationResult || {};
  if (!ar.IdToken) throw new Error('cognito auth failed: no IdToken');
  return {
    idToken: ar.IdToken,
    accessToken: ar.AccessToken || '',
    refreshToken: ar.RefreshToken || refreshToken || '',
    expiresIn: Number(ar.ExpiresIn || 0),
    expMs: jwtExpMs(ar.IdToken),
  };
}

export function buildWsUrl(wsHost, idToken, tag) {
  return `${wsHost}?token=${encodeURIComponent(idToken)}&tag=${encodeURIComponent(tag)}`;
}

export class AuthSession {
  constructor({ log, cognito = cognitoInitiateAuth, tokenRefreshMs = 45 * 60_000 } = {}) {
    this.log = log;
    this.cognito = cognito;
    this.tokenRefreshMs = tokenRefreshMs;
    this.email = '';
    this.password = '';
    this.tokens = null;
    this.lastAuthAt = 0;
  }

  getSecrets() {
    return [this.email, this.password, this.tokens?.idToken, this.tokens?.refreshToken, this.tokens?.accessToken];
  }

  stale(nowMs = Date.now()) {
    if (!this.tokens?.idToken) return true;
    if (this.tokens.expMs && this.tokens.expMs - nowMs < 5 * 60_000) return true;
    if (nowMs - this.lastAuthAt >= this.tokenRefreshMs) return true;
    return false;
  }

  async login(email, password) {
    const next = await timed(
      () => this.cognito({ username: email, password }),
      { log: this.log, label: 'cognito login' },
    );
    this.email = email;
    this.password = password;
    this.tokens = next;
    this.lastAuthAt = Date.now();
    return next;
  }

  async refresh() {
    if (!this.tokens?.refreshToken && !(this.email && this.password)) {
      throw new Error('no credentials to refresh');
    }
    let next;
    try {
      if (this.tokens?.refreshToken) {
        next = await timed(
          () => this.cognito({ refreshToken: this.tokens.refreshToken }),
          { log: this.log, label: 'cognito refresh' },
        );
      } else {
        next = await timed(
          () => this.cognito({ username: this.email, password: this.password }),
          { log: this.log, label: 'cognito login' },
        );
      }
    } catch (err) {
      if (this.email && this.password) {
        this.log?.warn('refresh token failed; logging in again');
        next = await timed(
          () => this.cognito({ username: this.email, password: this.password }),
          { log: this.log, label: 'cognito login' },
        );
      } else {
        throw err;
      }
    }
    this.tokens = next;
    this.lastAuthAt = Date.now();
    return next;
  }

  /**
   * Apply sheet credentials. New email/password are authenticated first;
   * on failure the previous working session is kept.
   */
  async ensure(email, password, { force = false } = {}) {
    const credsChanged = email !== this.email || password !== this.password;
    if (credsChanged && email && password) {
      try {
        await this.login(email, password);
        return { changed: true, tokens: this.tokens };
      } catch (err) {
        if (this.tokens) {
          this.log?.error('new GoCharting credentials failed; keeping previous session', err);
          return { changed: false, tokens: this.tokens, error: err };
        }
        throw err;
      }
    }
    if (!this.tokens || force || this.stale()) {
      if (!this.email || !this.password) throw new Error('missing GoCharting email/password');
      await this.refresh();
      return { changed: true, tokens: this.tokens };
    }
    return { changed: false, tokens: this.tokens };
  }
}
