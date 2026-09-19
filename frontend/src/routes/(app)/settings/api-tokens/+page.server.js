import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { apiRequest } from '$lib/api-helpers.js';

// The MCP server runs on the user's own machine, so LCRM_BASE_URL must be the
// PUBLIC API host (e.g. https://api.lillycrm.io) — the same base the browser
// talks to. PUBLIC_DJANGO_API_URL is that host with no /api suffix, which is
// exactly what the MCP client expects (it appends /api/... itself).
const apiBaseUrl = "http://127.0.0.1:8000" || 'https://api.lillycrm.io';

/** @type {import('./$types').PageServerLoad} */
export async function load({ cookies, locals }) {
  try {
    const data = await apiRequest('/profile/tokens/', {}, { cookies, org: locals?.org });
    return { tokens: data.tokens || [], baseUrl: apiBaseUrl };
  } catch (err) {
    console.error('Failed to load API tokens:', err);
    return { tokens: [], baseUrl: apiBaseUrl, loadError: err?.message || 'Failed to load tokens' };
  }
}

/** @type {import('./$types').Actions} */
export const actions = {
  create: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const name = String(form.get('name') || '').trim();
    if (!name) return fail(400, { error: 'Name is required' });

    const expiresRaw = String(form.get('expires_at') || '').trim();
    /** @type {{ name: string, expires_at?: string }} */
    const body = { name };
    if (expiresRaw) body.expires_at = expiresRaw;

    try {
      const created = await apiRequest(
        '/profile/tokens/',
        { method: 'POST', body },
        { cookies, org: locals?.org }
      );
      // Return the raw token ONCE so the page can show a copy-once panel.
      return { created: { token: created.token, name: created.name } };
    } catch (err) {
      console.error('Failed to create API token:', err);
      return fail(400, { error: err?.message || 'Failed to create token' });
    }
  },

  revoke: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const id = String(form.get('id') || '');
    if (!id) return fail(400, { error: 'Missing token id' });
    try {
      await apiRequest(
        `/profile/tokens/${id}/`,
        { method: 'DELETE' },
        { cookies, org: locals?.org }
      );
      return { revoked: id };
    } catch (err) {
      console.error('Failed to revoke API token:', err);
      return fail(400, { error: err?.message || 'Failed to revoke token' });
    }
  }
};
