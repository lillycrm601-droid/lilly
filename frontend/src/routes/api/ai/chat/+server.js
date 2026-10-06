import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { apiRequest } from '$lib/api-helpers.js';

const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = env.OPENROUTER_MODEL || 'openrouter/free';
const GEMINI_API_KEY = env.GEMINI_API_KEY || '';
const GEMINI_MODEL = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

function cleanSpeechText(text) {
  if (!text) return '';
  return text
    .replace(/\[(.*?)\]\(.*?\)/g, '$1') // markdown links -> label only
    .replace(/`{1,3}[^`]*`{1,3}/g, '') // code blocks
    .replace(/[*#_~>]/g, '') // markdown formatting
    .replace(/<[^>]*>/g, '') // HTML tags
    .replace(/https?:\/\/\S+/g, '') // URLs
    .replace(/\/[\w\-\?=&]+/g, '') // paths e.g. /leads
    .replace(/\s+/g, ' ')
    .trim();
}

// System prompt explaining the AI's identity, live navigation, and tool capabilities
const SYSTEM_PROMPT = `You are LillyCRM AI Copilot, an active, autonomous CRM assistant integrated directly into LillyCRM.
You have real-time access to the user's CRM and perform live actions in their browser as they chat!

YOUR CORE RESPONSIBILITIES & RULES:
1. ACTIONS OVER TALK:
   - When the user asks to update, create, or modify a task, lead, deal, or contact, ALWAYS execute the appropriate tool (e.g. \`update_task\`, \`create_task\`, \`create_lead\`, \`update_lead\`).
   - DO NOT just search and stop! If the user says "update a task called X to keep active because ads are running", call \`update_task\` with \`search_query="X"\`, \`title="X"\`, \`status="In Progress"\`, \`priority="High"\`, \`description="Campaign ads running"\`.
   - \`update_task\` will automatically search for the task and update it, or create it if it doesn't exist yet!
   - Clearly state what was created or updated: state the title, status, priority, and provide a clickable link [View Tasks](/tasks).

2. LIVE IN-APP NAVIGATION:
   - When the user says "take me to...", "go to...", "open leads", "show tasks", "view deals", "open settings", "let's look at contacts", etc., ALWAYS call the \`navigate_to\` tool!
   - You can also navigate with deep-links:
     - \`/leads?action=create\` (opens new lead creation drawer live!)
     - \`/tasks?action=create\` (opens new task creation drawer live!)
     - \`/contacts?action=create\` (opens new contact drawer live!)
     - \`/accounts?action=create\` (opens new account drawer live!)
     - \`/opportunities?action=create\` (opens new opportunity drawer live!)
     - \`/tasks/board\` (opens tasks Kanban board!)
     - \`/leads/<id>\`, \`/opportunities/<id>\`, \`/accounts/<id>\`, \`/invoices/<id>\` (opens specific record!)
   - DO NOT use navigate_to to answer questions about data or records. Use search tools for data!

3. LIVE RECORD CREATION & UPDATES:
   - Status choices for Tasks: "New", "In Progress", "Completed". If user says "keep active", use "In Progress".
   - Priority choices for Tasks: "Low", "Medium", "High". If user mentions "urgent", use "High".
   - Status choices for Leads: "assigned", "in process", "converted", "recycled", "dead".

4. SEARCH & REPORTING:
   - When asked about existing leads, tasks, contacts, or opportunities, use search tools and present clear, bulleted summaries with clickable links.

5. CONFIRMATION FOR DELETIONS:
   - Never delete records without explicit confirmation from the user.

Format links in markdown using standard CRM routes:
- Tasks: [Task Title](/tasks) or [Task Board](/tasks/board)
- Leads: [Lead Name](/leads) or [Lead Detail](/leads/<id>)
- Deals / Opportunities: [Opportunity](/opportunities) or [Deal Detail](/opportunities/<id>)
- Contacts: [Contact Name](/contacts)
- Accounts: [Account Name](/accounts) or [Account Detail](/accounts/<id>)
- Invoices: [Invoice](/invoices)`;

// Tool definitions for OpenAI / Gemini function calling
const CRM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate_to',
      description:
        'Navigate the user’s browser in real-time to any page or drawer in LillyCRM. Call this whenever the user wants to go to, open, see, or view a page (e.g. /leads, /tasks, /contacts, /opportunities, /accounts, /invoices, /settings). DO NOT use this for querying database records.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The app route path, e.g. "/leads", "/leads?action=create", "/tasks", "/tasks?action=create", "/tasks/board", "/contacts", "/contacts?action=create", "/opportunities", "/opportunities?action=create", "/accounts", "/accounts?action=create", "/invoices", "/settings", "/"'
          },
          label: {
            type: 'string',
            description: 'Friendly name of the destination, e.g. "Leads Pipeline", "Tasks Board", "Contacts", "Opportunities"'
          },
          reason: {
            type: 'string',
            description: 'Brief reason for navigation, e.g. "Opening leads"'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description: 'Search, list, and query tasks in the CRM database by keyword or status. Use when user asks what tasks they have or to find a task.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Task title or keyword' },
          status: { type: 'string', description: 'Status filter: New, In Progress, Completed' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task in the CRM.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          status: { type: 'string', enum: ['New', 'In Progress', 'Completed'] },
          priority: { type: 'string', enum: ['Low', 'Medium', 'High'] },
          description: { type: 'string', description: 'Description or notes for the task' },
          due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description:
        'Update an existing task in the CRM, or create it if it does not exist yet. Use this when the user asks to update, modify, keep active, or change a task.',
      parameters: {
        type: 'object',
        properties: {
          search_query: { type: 'string', description: 'Keywords or current title to find the task' },
          task_id: { type: 'string', description: 'ID or UUID of the task if known' },
          title: { type: 'string', description: 'Updated or target task title' },
          status: { type: 'string', enum: ['New', 'In Progress', 'Completed'], description: 'Status of the task' },
          priority: { type: 'string', enum: ['Low', 'Medium', 'High'], description: 'Priority level' },
          description: { type: 'string', description: 'Task notes or reason for update' },
          due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_leads',
      description: 'Search and query leads in the CRM database by name, company, email, or query string. Use when user asks to find, list, or check existing leads.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term (name, company, email)' },
          limit: { type: 'number', description: 'Max results to return (default 10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_lead',
      description: 'Create a new lead in the CRM.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Lead title or interest description' },
          first_name: { type: 'string', description: 'First name of the lead' },
          last_name: { type: 'string', description: 'Last name of the lead' },
          email: { type: 'string', description: 'Email address' },
          phone: { type: 'string', description: 'Phone number' },
          status: {
            type: 'string',
            description: 'Status: assigned, in process, converted, recycled, dead',
            enum: ['assigned', 'in process', 'converted', 'recycled', 'dead']
          }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_lead',
      description: 'Update an existing lead in the CRM.',
      parameters: {
        type: 'object',
        properties: {
          search_query: { type: 'string', description: 'Lead title or name to find the lead' },
          lead_id: { type: 'string', description: 'UUID or ID of the lead if known' },
          title: { type: 'string', description: 'Updated lead title' },
          status: {
            type: 'string',
            enum: ['assigned', 'in process', 'converted', 'recycled', 'dead']
          },
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_contacts',
      description: 'Search and query customer contacts in the CRM database.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term (name, email, phone)' },
          limit: { type: 'number', description: 'Max results to return (default 10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_contact',
      description: 'Create a new contact in the CRM.',
      parameters: {
        type: 'object',
        properties: {
          first_name: { type: 'string', description: 'First name' },
          last_name: { type: 'string', description: 'Last name' },
          email: { type: 'string', description: 'Email address' },
          phone: { type: 'string', description: 'Phone number' }
        },
        required: ['first_name', 'email']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_accounts',
      description: 'Search and query accounts / client companies in the CRM database.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Account/company name' },
          limit: { type: 'number', description: 'Max results to return (default 10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_account',
      description: 'Create a new account / company in the CRM.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Company or account name' },
          email: { type: 'string', description: 'Company email' },
          phone: { type: 'string', description: 'Company phone' },
          website: { type: 'string', description: 'Website URL' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_opportunities',
      description: 'Search and query opportunities / deals in the sales pipeline.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Deal / opportunity name' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_opportunity',
      description: 'Create a new opportunity / deal in the CRM pipeline.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Opportunity name' },
          amount: { type: 'number', description: 'Estimated value / amount' },
          stage: {
            type: 'string',
            enum: [
              'QUALIFICATION',
              'NEEDS ANALYSIS',
              'VALUE PROPOSITION',
              'ID.DECISION MAKERS',
              'PERCEPTION ANALYSIS',
              'PROPOSAL/PRICE QUOTE',
              'NEGOTIATION/REVIEW',
              'CLOSED WON',
              'CLOSED LOST'
            ]
          }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_invoices',
      description: 'Search and query invoices in the CRM database.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Invoice number or client name' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_record',
      description: 'Delete a record from the CRM. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          entity: {
            type: 'string',
            enum: ['leads', 'contacts', 'accounts', 'tasks', 'opportunities']
          },
          id: { type: 'string', description: 'UUID or ID of the record to delete' },
          confirm: {
            type: 'boolean',
            description: 'Set to true ONLY if the user explicitly agreed to delete this record'
          }
        },
        required: ['entity', 'id', 'confirm']
      }
    }
  }
];

const SEARCH_TOOLS = new Set([
  'search_tasks',
  'search_leads',
  'search_contacts',
  'search_accounts',
  'search_opportunities',
  'search_invoices'
]);

/**
 * Execute a CRM tool function on behalf of the authenticated user
 */
async function executeTool(name, args, { cookies, locals }) {
  try {
    switch (name) {
      case 'navigate_to': {
        const path = args.path || '/';
        const label = args.label || path;
        return {
          success: true,
          navigated: true,
          path,
          label,
          reason: args.reason || `Navigated to ${label}`
        };
      }

      case 'search_tasks': {
        const query = args.query || '';
        const res = await apiRequest(`/tasks/?search=${encodeURIComponent(query)}`, {}, { cookies, org: locals?.org });
        const list = res?.tasks || res?.results || (Array.isArray(res) ? res : []);
        return { count: list.length, results: list };
      }

      case 'create_task': {
        const body = {
          title: args.title,
          status: args.status || 'New',
          priority: args.priority || 'Medium',
          due_date: args.due_date || null,
          description: args.description || null
        };
        const res = await apiRequest('/tasks/', { method: 'POST', body }, { cookies, org: locals?.org });
        return {
          success: true,
          message: `Task "${args.title}" created successfully (Priority: ${body.priority}).`,
          task: { title: args.title, ...body, ...res }
        };
      }

      case 'update_task': {
        let taskId = args.task_id;
        let existingTask = null;

        if (!taskId && (args.search_query || args.title)) {
          const searchParam = args.search_query || args.title;
          const searchRes = await apiRequest(
            `/tasks/?search=${encodeURIComponent(searchParam)}`,
            {},
            { cookies, org: locals?.org }
          );
          const tasks = searchRes?.tasks || searchRes?.results || (Array.isArray(searchRes) ? searchRes : []);
          if (tasks.length > 0) {
            existingTask = tasks[0];
            taskId = existingTask.id;
          }
        }

        if (!taskId) {
          const newTitle = args.title || args.search_query || 'New Task';
          const createBody = {
            title: newTitle,
            status: args.status || 'In Progress',
            priority: args.priority || 'High',
            due_date: args.due_date || null,
            description: args.description || null
          };
          const createRes = await apiRequest('/tasks/', { method: 'POST', body: createBody }, { cookies, org: locals?.org });
          return {
            success: true,
            created: true,
            message: `Task "${newTitle}" created and set to "${createBody.status}" with priority "${createBody.priority}".`,
            task: { title: newTitle, ...createBody, ...createRes }
          };
        }

        /** @type {Record<string, any>} */
        const patchBody = {};
        if (args.title) patchBody.title = args.title;
        if (args.status) patchBody.status = args.status;
        if (args.priority) patchBody.priority = args.priority;
        if (args.due_date !== undefined) patchBody.due_date = args.due_date;
        if (args.description !== undefined) patchBody.description = args.description;

        const updateRes = await apiRequest(
          `/tasks/${taskId}/`,
          { method: 'PATCH', body: patchBody },
          { cookies, org: locals?.org }
        );
        const resolvedTitle = args.title || existingTask?.title || 'Task';
        return {
          success: true,
          updated: true,
          message: `Task "${resolvedTitle}" updated to "${args.status || existingTask?.status || 'In Progress'}".`,
          task: { id: taskId, title: resolvedTitle, ...patchBody, ...updateRes }
        };
      }

      case 'search_leads': {
        const query = args.query || '';
        const limit = args.limit || 10;
        const res = await apiRequest(
          `/leads/?search=${encodeURIComponent(query)}&limit=${limit}`,
          {},
          { cookies, org: locals?.org }
        );
        const list = res?.leads || res?.results || (Array.isArray(res) ? res : []);
        return { count: list.length, results: list };
      }

      case 'create_lead': {
        const body = {
          title: args.title,
          first_name: args.first_name || '',
          last_name: args.last_name || '',
          email: args.email || '',
          phone: args.phone || '',
          status: args.status || 'assigned'
        };
        const res = await apiRequest('/leads/', { method: 'POST', body }, { cookies, org: locals?.org });
        return { success: true, message: `Lead "${args.title}" created successfully.`, lead: { title: args.title, ...body, ...res } };
      }

      case 'update_lead': {
        let leadId = args.lead_id;
        let existingLead = null;

        if (!leadId && (args.search_query || args.title)) {
          const searchParam = args.search_query || args.title;
          const searchRes = await apiRequest(
            `/leads/?search=${encodeURIComponent(searchParam)}`,
            {},
            { cookies, org: locals?.org }
          );
          const leads = searchRes?.leads || searchRes?.results || (Array.isArray(searchRes) ? searchRes : []);
          if (leads.length > 0) {
            existingLead = leads[0];
            leadId = existingLead.id;
          }
        }

        if (!leadId) {
          return { error: `Could not find a lead matching "${args.search_query || args.title}".` };
        }

        /** @type {Record<string, any>} */
        const patchBody = {};
        if (args.title) patchBody.title = args.title;
        if (args.status) patchBody.status = args.status;
        if (args.first_name) patchBody.first_name = args.first_name;
        if (args.last_name) patchBody.last_name = args.last_name;
        if (args.email) patchBody.email = args.email;
        if (args.phone) patchBody.phone = args.phone;

        const res = await apiRequest(`/leads/${leadId}/`, { method: 'PATCH', body: patchBody }, { cookies, org: locals?.org });
        return {
          success: true,
          updated: true,
          message: `Lead "${args.title || existingLead?.title}" updated successfully.`,
          lead: { id: leadId, title: args.title || existingLead?.title, ...patchBody, ...res }
        };
      }

      case 'search_contacts': {
        const query = args.query || '';
        const limit = args.limit || 10;
        const res = await apiRequest(
          `/contacts/?search=${encodeURIComponent(query)}&limit=${limit}`,
          {},
          { cookies, org: locals?.org }
        );
        const list = res?.contact_obj_list || res?.results || (Array.isArray(res) ? res : []);
        return { count: list.length, results: list };
      }

      case 'create_contact': {
        const body = {
          first_name: args.first_name,
          last_name: args.last_name || '',
          email: args.email,
          phone: args.phone || ''
        };
        const res = await apiRequest('/contacts/', { method: 'POST', body }, { cookies, org: locals?.org });
        return { success: true, message: `Contact "${args.first_name}" created successfully.`, contact: res };
      }

      case 'search_accounts': {
        const query = args.query || '';
        const limit = args.limit || 10;
        const res = await apiRequest(
          `/accounts/?search=${encodeURIComponent(query)}&limit=${limit}`,
          {},
          { cookies, org: locals?.org }
        );
        const list = res?.active_accounts?.open_accounts || res?.results || (Array.isArray(res) ? res : []);
        return { count: list.length, results: list };
      }

      case 'create_account': {
        const body = {
          name: args.name,
          email: args.email || '',
          phone: args.phone || '',
          website: args.website || ''
        };
        const res = await apiRequest('/accounts/', { method: 'POST', body }, { cookies, org: locals?.org });
        return { success: true, message: `Account "${args.name}" created successfully.`, account: res };
      }

      case 'search_opportunities': {
        const query = args.query || '';
        const res = await apiRequest(
          `/opportunities/?search=${encodeURIComponent(query)}`,
          {},
          { cookies, org: locals?.org }
        );
        const list = res?.opportunities || res?.results || (Array.isArray(res) ? res : []);
        return { count: list.length, results: list };
      }

      case 'create_opportunity': {
        const body = {
          name: args.name,
          amount: args.amount || 0,
          stage: args.stage || 'QUALIFICATION'
        };
        const res = await apiRequest('/opportunities/', { method: 'POST', body }, { cookies, org: locals?.org });
        return { success: true, message: `Opportunity "${args.name}" created successfully.`, opportunity: res };
      }

      case 'search_invoices': {
        const query = args.query || '';
        const res = await apiRequest(
          `/invoices/?search=${encodeURIComponent(query)}`,
          {},
          { cookies, org: locals?.org }
        );
        const list = res?.invoices || res?.results || (Array.isArray(res) ? res : []);
        return { count: list.length, results: list };
      }

      case 'delete_record': {
        if (!args.confirm) {
          return {
            requires_confirmation: true,
            warning: `Deleting this ${args.entity} record (ID: ${args.id}) is permanent. Please ask the user to confirm.`
          };
        }
        await apiRequest(`/${args.entity}/${args.id}/`, { method: 'DELETE' }, { cookies, org: locals?.org });
        return { success: true, message: `${args.entity} record deleted successfully.` };
      }

      default:
        return { error: `Tool ${name} is not implemented.` };
    }
  } catch (err) {
    return { error: err.message || 'Operation failed' };
  }
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, cookies, locals }) {
  // Verify user is authenticated
  const jwtAccess = cookies.get('jwt_access');
  if (!jwtAccess) {
    return json({ error: 'You must be logged in to use the AI assistant.' }, { status: 401 });
  }

  const { messages = [], is_voice = false, voice_engine = 'neural' } = await request.json();

  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'Invalid message payload' }, { status: 400 });
  }

  // Live Voice Mode instruction for ultra-fast, natural spoken responses
  const voiceInstruction = is_voice
    ? `\n\nCRITICAL LIVE VOICE INSTRUCTION:
The user is speaking with you in real-time voice mode.
- Speak in ONE single short, conversational sentence (maximum 12 words).
- DO NOT output any markdown tags (no asterisks, backticks, or brackets).
- DO NOT speak URLs or paths (e.g. say "Opening leads now." instead of "Navigated to /leads").
- Always be direct, snappy, and clear so the voice can speak immediately without delay.`
    : '';

  // Prepend system prompt
  const conversationMessages = [
    { role: 'system', content: SYSTEM_PROMPT + voiceInstruction },
    ...messages.slice(-8) // Keep recent context
  ];

  try {
    let currentMessages = [...conversationMessages];
    let navigatedTo = null;
    let navigatedLabel = null;
    const recordsCreated = [];
    const recordsFound = [];
    const allToolsExecuted = [];
    let finalContent = '';
    let allowFurtherTools = true;

    const MAX_TURNS = 2;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let llmResponse = null;

      const toolsPayload = allowFurtherTools
        ? { tools: CRM_TOOLS, tool_choice: 'auto' }
        : {};

      // 1. Try Gemini first (fast, native function calling)
      if (GEMINI_API_KEY) {
        try {
          const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${GEMINI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: GEMINI_MODEL,
              messages: currentMessages,
              ...toolsPayload
            })
          });

          if (res.ok) {
            llmResponse = res;
          } else {
            const errBody = await res.text().catch(() => '');
            console.warn('Gemini endpoint returned error, falling back to OpenRouter:', res.status, errBody.slice(0, 200));
          }
        } catch (fetchErr) {
          console.warn('Gemini fetch exception:', fetchErr.message);
        }
      }

      // 2. Fallback to OpenRouter
      if (!llmResponse && OPENROUTER_API_KEY) {
        try {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://lillycrm.io',
              'X-Title': 'LillyCRM Copilot'
            },
            body: JSON.stringify({
              model: OPENROUTER_MODEL,
              messages: currentMessages,
              ...toolsPayload
            })
          });
          if (res.ok) {
            llmResponse = res;
          } else {
            const errBody = await res.text().catch(() => '');
            console.error('OpenRouter fallback error:', res.status, errBody.slice(0, 200));
          }
        } catch (e) {
          console.error('OpenRouter exception:', e.message);
        }
      }

      if (!llmResponse) {
        return json({ error: 'AI provider temporarily unavailable. Please try again.' }, { status: 502 });
      }

      const data = await llmResponse.json();
      const choice = data.choices?.[0];
      const assistantMsg = choice?.message;

      if (!assistantMsg) {
        break;
      }

      const toolCalls = assistantMsg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        let hasSearchTool = false;
        let lastActionResult = null;
        currentMessages.push(assistantMsg);

        for (const tc of toolCalls) {
          let args = {};
          try {
            args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
          } catch {
            args = {};
          }

          const result = await executeTool(tc.function.name, args, { cookies, locals });
          allToolsExecuted.push(tc.function.name);
          lastActionResult = { tool: tc.function.name, args, result };

          if (SEARCH_TOOLS.has(tc.function.name)) {
            hasSearchTool = true;
          }

          if (tc.function.name === 'navigate_to' && result.path) {
            navigatedTo = result.path;
            navigatedLabel = result.label || result.path;
          }

          if (result.task) {
            const taskId = result.task?.id || result.task?.task?.id;
            recordsCreated.push({
              type: 'task',
              title: result.task?.title || args.title || args.search_query || 'Task',
              id: taskId,
              path: '/tasks'
            });
            if (!navigatedTo) navigatedTo = '/tasks';
          }

          if (result.lead) {
            const leadId = result.lead?.id || result.lead?.lead?.id;
            recordsCreated.push({
              type: 'lead',
              title: result.lead?.title || args.title || 'Lead',
              id: leadId,
              path: leadId ? `/leads/${leadId}` : '/leads'
            });
            if (!navigatedTo) navigatedTo = leadId ? `/leads/${leadId}` : '/leads';
          }

          if (result.contact) {
            const contactId = result.contact?.id || result.contact?.contact?.id;
            recordsCreated.push({
              type: 'contact',
              title: `${result.contact?.first_name || args.first_name || ''} ${result.contact?.last_name || args.last_name || ''}`.trim() || 'Contact',
              id: contactId,
              path: '/contacts'
            });
            if (!navigatedTo) navigatedTo = '/contacts';
          }

          if (result.opportunity) {
            const oppId = result.opportunity?.id || result.opportunity?.opportunity?.id;
            recordsCreated.push({
              type: 'opportunity',
              title: result.opportunity?.name || args.name || 'Opportunity',
              id: oppId,
              path: oppId ? `/opportunities/${oppId}` : '/opportunities'
            });
            if (!navigatedTo) navigatedTo = oppId ? `/opportunities/${oppId}` : '/opportunities';
          }

          if (result.account) {
            const accId = result.account?.id || result.account?.account?.id;
            recordsCreated.push({
              type: 'account',
              title: result.account?.name || args.name || 'Account',
              id: accId,
              path: accId ? `/accounts/${accId}` : '/accounts'
            });
            if (!navigatedTo) navigatedTo = accId ? `/accounts/${accId}` : '/accounts';
          }

          if (result.results && Array.isArray(result.results)) {
            recordsFound.push({
              entity: tc.function.name.replace('search_', ''),
              count: result.count || result.results.length,
              items: result.results.slice(0, 5)
            });
          }

          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result)
          });
        }

        // FAST TERMINATION: If NO search tools were called, and only action/nav tools were executed:
        // We synthesize the message immediately and break! No 2nd LLM roundtrip, no lag, no confusion!
        if (!hasSearchTool && allToolsExecuted.length > 0) {
          if (recordsCreated.length > 0) {
            const item = recordsCreated[0];
            const msg = lastActionResult?.result?.message;
            if (is_voice) {
              finalContent = msg
                ? cleanSpeechText(msg)
                : `Successfully processed ${item.type} ${item.title}.`;
            } else {
              finalContent = msg
                ? `${msg} View it in [${item.path}](${item.path}).`
                : `Successfully processed ${item.type} **${item.title}**! You can view it in the app at [${item.path}](${item.path}).`;
            }
          } else if (navigatedTo) {
            const destination = navigatedLabel || navigatedTo;
            if (is_voice) {
              finalContent = `Opening ${destination} now.`;
            } else {
              finalContent = `Navigating to [${destination}](${navigatedTo}) now.`;
            }
          } else if (lastActionResult?.result?.message) {
            finalContent = is_voice ? cleanSpeechText(lastActionResult.result.message) : lastActionResult.result.message;
          } else {
            finalContent = is_voice ? 'Action completed.' : 'Action executed successfully.';
          }
          break; // Exit agentic loop immediately!
        }

        // If search tools WERE called, proceed to Turn 1 to let the LLM summarize the results.
        // Forbid further tools in Turn 1 to prevent endless loops or tool confusion.
        allowFurtherTools = false;
        continue;
      }

      // No tool calls; final assistant text message
      finalContent = assistantMsg.content || '';
      break;
    }

    // Fallback if finalContent was null/empty after tool execution
    if (!finalContent && recordsCreated.length > 0) {
      const item = recordsCreated[0];
      finalContent = is_voice
        ? `Successfully saved ${item.title}.`
        : `Successfully processed ${item.type} **${item.title}**! You can view it in the app at [${item.path}](${item.path}).`;
    } else if (!finalContent && allToolsExecuted.length > 0) {
      finalContent = is_voice ? 'Actions completed.' : `Done. Actions executed: ${allToolsExecuted.join(', ')}.`;
    } else if (!finalContent) {
      finalContent = "I'm ready to help with your CRM tasks. What would you like to do?";
    }

    let audioBase64 = null;
    let audioMime = null;

    // Direct high-quality speech generation for voice mode
    if (is_voice) {
      const cleanSpoken = cleanSpeechText(finalContent);
      if (cleanSpoken) {
        // 1. If Gemini Studio engine requested
        if (voice_engine === 'gemini' && GEMINI_API_KEY) {
          try {
            const ttsRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent?key=${GEMINI_API_KEY}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: cleanSpoken.slice(0, 300) }] }],
                  generationConfig: {
                    speechConfig: {
                      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }
                    }
                  }
                })
              }
            );

            if (ttsRes.ok) {
              const ttsData = await ttsRes.json();
              const part = ttsData.candidates?.[0]?.content?.parts?.[0];
              if (part?.inlineData?.data) {
                audioBase64 = part.inlineData.data;
                audioMime = part.inlineData.mimeType || 'audio/wav';
              }
            } else {
              console.warn('Gemini Studio TTS returned error, falling back to Neural:', ttsRes.status);
            }
          } catch (ttsErr) {
            console.warn('Gemini Studio TTS exception, falling back to Neural:', ttsErr.message);
          }
        }

        // 2. Default: Google Neural Audio MP3 (~350ms, natural, warm tone, no rate limits)
        if (!audioBase64) {
          try {
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanSpoken.slice(0, 300))}&tl=en&client=tw-ob`;
            const ttsRes = await fetch(url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
            if (ttsRes.ok) {
              const ab = await ttsRes.arrayBuffer();
              audioBase64 = Buffer.from(ab).toString('base64');
              audioMime = 'audio/mpeg';
            }
          } catch (neuralErr) {
            console.warn('Google Neural TTS generation error:', neuralErr.message);
          }
        }
      }
    }

    return json({
      message: finalContent,
      audio: audioBase64,
      mimeType: audioMime,
      tools_executed: allToolsExecuted,
      navigated_to: navigatedTo,
      navigated_label: navigatedLabel,
      records_created: recordsCreated,
      records_found: recordsFound
    });
  } catch (error) {
    console.error('AI chat endpoint failure:', error);
    return json({ error: error.message || 'Failed to process AI request' }, { status: 500 });
  }
}
