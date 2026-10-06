import { redirect } from '@sveltejs/kit';
import axios from 'axios';
import { env as publicEnv } from '$env/dynamic/public';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';

export async function GET({ url, cookies }) {
  if (!dev && env.NODE_ENV === 'production') {
    return new Response('Not allowed in production', { status: 403 });
  }

  const apiUrl = publicEnv.PUBLIC_DJANGO_API_URL || 'http://127.0.0.1:8000';

  try {
    const res = await axios.get(`${apiUrl}/api/auth/dev-login/`, { timeout: 5000 });
    const { access_token, refresh_token, org_id } = res.data;

    cookies.set('jwt_access', access_token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 60 * 60 * 24
    });

    cookies.set('jwt_refresh', refresh_token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 60 * 60 * 24 * 365
    });

    if (org_id) {
      cookies.set('org', org_id, {
        path: '/',
        httpOnly: false,
        sameSite: 'lax',
        secure: false,
        maxAge: 60 * 60 * 24 * 365
      });
    }

    const next = url.searchParams.get('next') || '/';
    throw redirect(303, next);
  } catch (err) {
    if (err.status === 303 || err.status === 307) {
      throw err;
    }
    console.error('dev-login error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
