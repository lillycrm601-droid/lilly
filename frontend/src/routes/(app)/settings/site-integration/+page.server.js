import { fail } from '@sveltejs/kit';
import { apiRequest } from '$lib/api-helpers.js';

const apiBaseUrl = "http://127.0.0.1:8000";

/** @type {import('./$types').PageServerLoad} */
export async function load({ cookies, locals }) {
  try {
    const data = await apiRequest('/api-settings/', {}, { cookies, org: locals?.org });
    return {
      apiSettings: data.api_settings || [],
      users: data.users || [],
      baseUrl: apiBaseUrl
    };
  } catch (err) {
    console.error('Failed to load API settings:', err);
    return {
      apiSettings: [],
      users: [],
      baseUrl: apiBaseUrl,
      loadError: err?.message || 'Failed to load site integrations'
    };
  }
}

/** @type {import('./$types').Actions} */
export const actions = {
  create: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const title = String(form.get('title') || '').trim();
    let website = String(form.get('website') || '').trim();
    
    if (!title) return fail(400, { error: 'Title is required' });
    if (!website) return fail(400, { error: 'Website is required' });

    // Validate website schema as required by serializer
    if (!website.startsWith('http://') && !website.startsWith('https://')) {
      website = 'https://' + website;
    }

    const assignedToRaw = form.getAll('lead_assigned_to');
    const lead_assigned_to = assignedToRaw.map(id => parseInt(String(id), 10)).filter(Boolean);

    const tagsRaw = String(form.get('tags') || '').trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    const body = {
      title,
      website,
      lead_assigned_to,
      tags
    };

    try {
      await apiRequest(
        '/api-settings/',
        { method: 'POST', body },
        { cookies, org: locals?.org }
      );
      return { success: true };
    } catch (err) {
      console.error('Failed to create integration:', err);
      return fail(400, { error: err?.message || 'Failed to create site integration' });
    }
  },

  delete: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const id = String(form.get('id') || '');
    if (!id) return fail(400, { error: 'Missing integration id' });

    try {
      await apiRequest(
        `/api-settings/${id}/`,
        { method: 'DELETE' },
        { cookies, org: locals?.org }
      );
      return { success: true };
    } catch (err) {
      console.error('Failed to delete integration:', err);
      return fail(400, { error: err?.message || 'Failed to delete integration' });
    }
  }
};
