<script>
  import '../../app.css';
  import { AppShell } from '$lib/components/layout/index.js';
  import { Toaster } from '$lib/components/ui/sonner/index.js';
  import { initOrgSettings } from '$lib/stores/org.js';
  import AiCopilot from '$lib/components/ai/AiCopilot.svelte';
  import { isCopilotOpen, isCopilotExpanded } from '$lib/stores/ai-copilot.js';

  let { data, children } = $props();

  // Initialize org settings store from server data
  $effect(() => {
    if (data.org_settings) {
      initOrgSettings(data.org_settings);
    }
  });
</script>

<div
  class="relative min-h-screen w-full transition-[width] duration-300 ease-in-out {$isCopilotOpen
    ? $isCopilotExpanded
      ? 'xl:w-[calc(100%-720px)]'
      : 'xl:w-[calc(100%-460px)]'
    : 'w-full'}"
>
  <AppShell user={data.user} org_name={data.org_name} org_settings={data.org_settings}>
    <main class="relative flex-1">
      {@render children()}
    </main>
  </AppShell>
</div>

<AiCopilot />

<Toaster
  richColors
  closeButton
  position="bottom-right"
  style={$isCopilotOpen ? ($isCopilotExpanded ? 'right: 730px;' : 'right: 470px;') : ''}
/>

