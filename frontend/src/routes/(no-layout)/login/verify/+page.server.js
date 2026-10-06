/**
 * Magic Link Verification Page
 *
 * Handles the magic link callback:
 * 1. Extract token from URL query params
 * 2. POST to backend to verify token
 * 3. Set JWT cookies on success
 * 4. Redirect to /org
 *
 * Security: Token is consumed server-side before any HTML is rendered.
 */

import axios from 'axios';
import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

/** @type {import('@sveltejs/kit').ServerLoad} */
export async function load({ url, cookies }) {
  const token = url.searchParams.get('token');

  if (!token) {
    return { error: 'Missing verification token.' };
  }

  try {
    const apiUrl = publicEnv.PUBLIC_DJANGO_API_URL || 'http://127.0.0.1:8000';
    const response = await axios.post(
      `${apiUrl}/api/auth/magic-link/verify/`,
      { token },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    const { access_token, refresh_token } = response.data;

    // Store JWT tokens in secure httpOnly cookies (same as Google OAuth flow)
    const secure = env.NODE_ENV === 'production';
    cookies.set('jwt_access', access_token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 60 * 60 * 24 // 1 day
    });
    cookies.set('jwt_refresh', refresh_token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 60 * 60 * 24 * 365 // 1 year
    });
    // If token already has an org bound to it, set org cookie and redirect to app
    try {
      const parts = access_token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        );
        if (payload.org_id) {
          cookies.set('org', payload.org_id, {
            path: '/',
            httpOnly: false,
            sameSite: 'lax',
            secure,
            maxAge: 60 * 60 * 24 * 365
          });
          const next = url.searchParams.get('next') || '/';
          throw redirect(303, next);
        }
      }
    } catch (e) {
      if (e.status === 303 || e.status === 307) throw e;
    }
  } catch (error) {
    if (error.status === 303 || error.status === 307) throw error;
    const errorMessage = error.response?.data?.error || 'Verification failed';
    return { error: errorMessage };
  }

  // Success - redirect to org selection (same as Google OAuth)
  throw redirect(307, '/org');
}

