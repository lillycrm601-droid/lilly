<script>
  import { enhance } from '$app/forms';
  import { toast } from 'svelte-sonner';
  import {
    Sparkles,
    CheckCircle2,
    Globe,
    PhoneCall,
    Terminal,
    ArrowRight,
    Play,
    Building2,
    Info
  } from '@lucide/svelte';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { Button } from '$lib/components/ui/button/index.js';

  /** @type {{ data: any, form: any }} */
  let { data, form } = $props();

  const apiSettings = $derived(data.apiSettings || []);
  const queryApikey = $derived(data.queryApikey || '');

  let selectedApikey = $state(queryApikey || (apiSettings[0]?.apikey || ''));
  let customApikey = $state('');

  let firstName = $state('Alex');
  let lastName = $state('Johnson');
  let email = $state('alex.johnson@example.com');
  let phone = $state('+1234567890');
  let companyName = $state('Stripe');
  let message = $state('Hi, we are looking for a customized CRM solution for our enterprise sales team of 25 people. We need custom fields, RLS security, and an automated voice call to qualify our leads. Please call me back!');

  let submitting = $state(false);

  const activeApikey = $derived(selectedApikey === 'custom' ? customApikey : selectedApikey);

  $effect(() => {
    if (form?.success) {
      toast.success('Form submitted successfully!');
    } else if (form?.error) {
      toast.error(form.error);
    }
  });
</script>

<svelte:head>
  <title>Request Enterprise Demo · SaaSify</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<div class="min-h-screen bg-slate-950 font-['Outfit'] text-slate-100 flex flex-col justify-between selection:bg-indigo-500/30 selection:text-indigo-200">
  
  <!-- Glowing Background Orbs -->
  <div class="absolute inset-0 overflow-hidden pointer-events-none">
    <div class="absolute -top-[40%] -left-[20%] w-[80%] h-[80%] rounded-full bg-indigo-900/10 blur-[120px] animate-pulse"></div>
    <div class="absolute -bottom-[20%] -right-[10%] w-[60%] h-[60%] rounded-full bg-purple-900/10 blur-[120px]"></div>
  </div>

  <!-- Header -->
  <header class="relative z-10 border-b border-slate-900/80 bg-slate-950/50 backdrop-blur-md px-6 py-4">
    <div class="max-w-7xl mx-auto flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="size-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <Sparkles class="size-4.5 text-white" />
        </div>
        <span class="font-bold text-lg tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">SaaSify</span>
      </div>
      <div class="flex items-center gap-4 text-xs text-slate-400">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-slate-800">
          <span class="size-1.5 rounded-full bg-indigo-400 animate-ping"></span>
          Website Integration Test Flow
        </span>
      </div>
    </div>
  </header>

  <!-- Main Body -->
  <main class="relative z-10 max-w-7xl mx-auto px-6 py-12 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-12 items-start w-full">
    
    <!-- Left Column: Marketing + Contact Form -->
    <div class="space-y-8">
      {#if form?.success}
        <!-- Success State -->
        <div class="rounded-2xl border border-indigo-500/20 bg-indigo-950/20 p-8 md:p-12 text-center max-w-2xl mx-auto shadow-2xl backdrop-blur-md space-y-6">
          <div class="size-16 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center mx-auto text-indigo-400 shadow-inner">
            <CheckCircle2 class="size-8" />
          </div>
          <div class="space-y-2">
            <h1 class="text-2xl font-bold tracking-tight text-white">Thank you, {firstName}!</h1>
            <p class="text-slate-400 text-sm max-w-md mx-auto">
              Your inquiry has been successfully sent to LillyCRM. Since you provided a phone number, our automated **Bolna Voice AI Caller** is initiating a qualification call right now!
            </p>
          </div>

          <div class="rounded-xl bg-slate-900/60 border border-slate-800 p-5 max-w-md mx-auto text-left space-y-4">
            <div class="flex gap-3">
              <PhoneCall class="size-5 text-indigo-400 shrink-0 mt-0.5" />
              <div>
                <h4 class="text-xs font-semibold text-white">Automated Qualification Triggered</h4>
                <p class="text-[11px] text-slate-400 mt-0.5">
                  Bolna AI will call your test phone <span class="text-slate-200">{phone}</span> to qualify the lead (check interest level, size, timeline) and instantly sync the transcript.
                </p>
              </div>
            </div>
          </div>

          <div class="flex flex-col sm:flex-row gap-3 justify-center pt-2">
            <Button
              variant="default"
              class="h-10 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs px-6 gap-1.5 shadow-lg shadow-indigo-600/20"
              href="/leads/{form.lead_id}"
              target="_blank"
            >
              Watch Call Live in CRM <ArrowRight class="size-3.5" />
            </Button>
            <Button
              variant="outline"
              class="h-10 border-slate-800 hover:bg-slate-900 text-slate-300 text-xs px-6"
              onclick={() => window.location.reload()}
            >
              Submit Another Lead
            </Button>
          </div>
        </div>
      {:else}
        <!-- Form State -->
        <div class="space-y-3">
          <h1 class="text-4xl font-extrabold tracking-tight text-white md:text-5xl bg-clip-text text-transparent bg-gradient-to-b from-white to-slate-400">
            Request an Enterprise Demo
          </h1>
          <p class="text-slate-400 text-sm max-w-xl leading-relaxed">
            Discover how SaaSify can streamline your engineering and product cycles. Enter your contact details below, and our team (or our AI Qualification assistant) will contact you immediately.
          </p>
        </div>

        <form method="POST" action="?/submit" use:enhance={() => {
          submitting = true;
          return async ({ update }) => {
            submitting = false;
            update();
          };
        }} class="rounded-2xl border border-slate-900 bg-slate-950 p-6 md:p-8 space-y-6 shadow-2xl max-w-3xl">
          
          <!-- Hidden apikey input, populated from selected value -->
          <input type="hidden" name="apikey" value={activeApikey} />

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <Label for="first_name" class="text-xs text-slate-400 font-medium">First Name</Label>
              <Input
                id="first_name"
                name="first_name"
                bind:value={firstName}
                required
                class="bg-slate-900/60 border-slate-800 text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:ring-indigo-500/20"
              />
            </div>
            <div class="space-y-1.5">
              <Label for="last_name" class="text-xs text-slate-400 font-medium">Last Name</Label>
              <Input
                id="last_name"
                name="last_name"
                bind:value={lastName}
                class="bg-slate-900/60 border-slate-800 text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:ring-indigo-500/20"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <Label for="email" class="text-xs text-slate-400 font-medium">Work Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                bind:value={email}
                required
                class="bg-slate-900/60 border-slate-800 text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:ring-indigo-500/20"
              />
            </div>
            <div class="space-y-1.5">
              <Label for="phone" class="text-xs text-slate-400 font-medium flex items-center gap-1">
                Phone Number <span class="text-[10px] text-indigo-400 font-normal">(Required for AI qualification call)</span>
              </Label>
              <Input
                id="phone"
                name="phone"
                type="tel"
                bind:value={phone}
                required
                placeholder="+1234567890"
                class="bg-slate-900/60 border-slate-800 text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:ring-indigo-500/20 font-mono"
              />
            </div>
          </div>

          <div class="space-y-1.5">
            <Label for="company_name" class="text-xs text-slate-400 font-medium">Company Name</Label>
            <Input
              id="company_name"
              name="company_name"
              bind:value={companyName}
              class="bg-slate-900/60 border-slate-800 text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:ring-indigo-500/20"
            />
          </div>

          <div class="space-y-1.5">
            <Label for="message" class="text-xs text-slate-400 font-medium">What challenges are you trying to solve?</Label>
            <textarea
              id="message"
              name="message"
              rows="4"
              bind:value={message}
              class="flex w-full rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/20 focus:border-indigo-500"
            ></textarea>
          </div>

          <Button
            type="submit"
            disabled={submitting || !activeApikey}
            class="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs tracking-wide shadow-lg shadow-indigo-600/10 flex items-center justify-center gap-2"
          >
            {#if submitting}
              Submitting lead...
            {:else}
              Request Enterprise Demo <ArrowRight class="size-4" />
            {/if}
          </Button>

          {#if !activeApikey}
            <p class="text-center text-[11px] text-red-400 flex items-center justify-center gap-1">
              <Info class="size-3 shrink-0" /> Please select or input an API Integration Key in the control panel to submit.
            </p>
          {/if}
        </form>
      {/if}
    </div>

    <!-- Right Column: Developer Control Panel -->
    <div class="rounded-2xl border border-slate-900 bg-slate-950/80 p-5 shadow-2xl space-y-6 backdrop-blur-sm lg:sticky lg:top-24">
      <div class="flex items-center gap-2 border-b border-slate-900 pb-3">
        <Terminal class="size-4 text-indigo-400" />
        <h3 class="font-bold text-sm tracking-tight text-white">Developer Sandbox</h3>
      </div>

      <div class="space-y-4">
        <div class="space-y-2">
          <Label class="text-xs text-slate-400 font-semibold">Select Integration API Key</Label>
          <select
            bind:value={selectedApikey}
            class="flex w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            {#each apiSettings as item}
              <option value={item.apikey}>{item.title} ({item.website})</option>
            {/each}
            <option value="custom">-- Use Custom API Key --</option>
          </select>
        </div>

        {#if selectedApikey === 'custom'}
          <div class="space-y-1.5 animate-fadeIn">
            <Label for="custom_apikey" class="text-[11px] text-slate-400">Enter API Key manually</Label>
            <Input
              id="custom_apikey"
              placeholder="apikey generated from Site Integrations settings"
              bind:value={customApikey}
              class="bg-slate-900 border-slate-800 text-xs text-slate-200 font-mono h-8 placeholder:text-slate-700"
            />
          </div>
        {/if}

        <div class="rounded-xl border border-slate-900 bg-slate-900/20 p-4 space-y-3.5 text-xs text-slate-400">
          <div>
            <h4 class="font-semibold text-slate-300 text-[11px]">How the Site Flow works:</h4>
            <ul class="list-disc pl-4 space-y-1.5 mt-2 text-[11px] leading-relaxed">
              <li>Form submits data anonymously with the <code class="text-indigo-400 font-mono">apikey</code>.</li>
              <li>LillyCRM verifies the key, matches it to the org, and creates a new Lead.</li>
              <li>A <code class="text-indigo-400 font-mono">post_save</code> DB signal intercepts the creation.</li>
              <li>Celery triggers a request to **Bolna.ai** using the designated Voice Agent.</li>
              <li>Bolna calls the lead instantly to qualify them.</li>
              <li>Once called, Bolna POSTs a webhook to update the lead with the transcript and rating.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

  </main>

  <!-- Footer -->
  <footer class="border-t border-slate-900/60 bg-slate-950 py-6 px-6 text-center text-xs text-slate-600">
    <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
      <p>&copy; 2026 SaaSify Enterprise. Integrated Demo with Bolna Voice AI and LillyCRM.</p>
      <div class="flex gap-4">
        <a href="/settings/site-integration" class="hover:text-slate-400 hover:underline">CRM Integration Settings</a>
        <a href="/leads" class="hover:text-slate-400 hover:underline">View Leads in CRM</a>
      </div>
    </div>
  </footer>

</div>

<style>
  :global(body) {
    background-color: rgb(2 6 23);
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-fadeIn {
    animation: fadeIn 0.2s ease-out forwards;
  }
</style>
