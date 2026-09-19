import { fail } from '@sveltejs/kit';
import { apiRequest } from '$lib/api-helpers.js';

const apiBaseUrl = "http://127.0.0.1:8000";

/** @type {import('./$types').PageServerLoad} */
export async function load({ cookies, url, locals }) {
  const queryApikey = url.searchParams.get('apikey') || '';
  
  let apiSettings = [];
  try {
    const data = await apiRequest('/api-settings/', {}, { cookies, org: locals?.org });
    apiSettings = data.api_settings || [];
  } catch (err) {
    // Ignore if not logged in
  }

  return {
    apiSettings,
    queryApikey
  };
}

/** @type {import('./$types').Actions} */
export const actions = {
  submit: async ({ request, cookies }) => {
    const form = await request.formData();
    const apikey = String(form.get('apikey') || '').trim();
    const first_name = String(form.get('first_name') || '').trim();
    const last_name = String(form.get('last_name') || '').trim();
    const email = String(form.get('email') || '').trim();
    const phone = String(form.get('phone') || '').trim();
    const company_name = String(form.get('company_name') || '').trim();
    const message = String(form.get('message') || '').trim();

    if (!apikey) return fail(400, { error: 'Integration API Key is required.' });
    if (!first_name) return fail(400, { error: 'First Name is required.' });
    if (!email) return fail(400, { error: 'Email is required.' });
    if (!phone) return fail(400, { error: 'Phone number is required for AI qualification call.' });

    const body = {
      apikey,
      first_name,
      last_name,
      email,
      phone,
      company_name,
      message
    };

    try {
      const response = await apiRequest('/leads/create-from-site/', {
        method: 'POST',
        body
      }, { cookies });
      return { success: true, lead_id: response.lead_id, message: response.message };
    } catch (err) {
      console.error('Failed to submit lead via public api:', err);
      return fail(400, { error: err?.message || 'Failed to submit lead. Check your API key.' });
    }
  }
};
