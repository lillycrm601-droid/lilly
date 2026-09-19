<script>
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import {
    Plus,
    Copy,
    Check,
    Trash2,
    Globe,
    ExternalLink,
    Shield,
    Users,
    Tag,
    ChevronDown,
    ArrowRight
  } from '@lucide/svelte';
  import { PageHeader } from '$lib/components/layout';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import * as Table from '$lib/components/ui/table/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';

  /** @type {{ data: any, form: any }} */
  let { data, form } = $props();

  const apiSettings = $derived(data.apiSettings || []);
  const users = $derived(data.users || []);
  const loadError = $derived(data.loadError);

  let formTitle = $state('');
  let formWebsite = $state('');
  let formTags = $state('');
  /** @type {number[]} */
  let selectedUsers = $state([]);
  
  let creating = $state(false);
  let deletingId = $state('');
  
  // State for copying api key feedback
  /** @type {Record<string, boolean>} */
  let copiedState = $state({});

  $effect(() => {
    if (form?.success) {
      formTitle = '';
      formWebsite = '';
      formTags = '';
      selectedUsers = [];
      creating = false;
      deletingId = '';
      toast.success('Site integration saved successfully');
      invalidateAll();
    } else if (form?.error) {
      creating = false;
      deletingId = '';
      toast.error(form.error);
    }
  });

  /** @param {string} apikey @param {string} id */
  async function copyApiKey(apikey, id) {
    try {
      await navigator.clipboard.writeText(apikey);
      copiedState = { ...copiedState, [id]: true };
      toast.success('API Key copied to clipboard');
      setTimeout(() => {
        copiedState = { ...copiedState, [id]: false };
      }, 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }

  function toggleUserSelection(/** @type {number} */ userId) {
    if (selectedUsers.includes(userId)) {
      selectedUsers = selectedUsers.filter(id => id !== userId);
    } else {
      selectedUsers = [...selectedUsers, userId];
    }
  }
</script>

<svelte:head>
  <title>Website Integrations - Settings · LillyCRM</title>
</svelte:head>

<PageHeader
  title="Website Integrations"
  subtitle="Generate API keys for your external websites and landing pages to automatically qualify inbound leads."
/>

<div class="flex-1 p-6 md:p-8">
  <div class="mx-auto max-w-5xl space-y-8">
    {#if loadError}
      <div class="rounded-[var(--radius-lg)] border border-[var(--color-negative-default)]/20 bg-[var(--color-negative-light)]/10 p-4 text-sm text-[var(--color-negative-default)]">
        {loadError}
      </div>
    {/if}

    <div class="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px]">
      <!-- Integrations List -->
      <div class="space-y-4">
        <h2 class="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
          Active Integrations ({apiSettings.length})
        </h2>

        {#if apiSettings.length === 0}
          <div class="flex flex-col items-center justify-center rounded-[var(--radius-xl)] border border-dashed border-[var(--border-default)] p-12 text-center bg-[var(--surface-raised)]/20 dark:bg-transparent">
            <Globe class="size-8 text-[var(--text-tertiary)] mb-3 animate-pulse" />
            <h3 class="text-sm font-medium text-[var(--text-primary)]">No website integrations</h3>
            <p class="text-xs text-[var(--text-tertiary)] mt-1 max-w-xs">
              Generate an integration key to connect your public landing page, contact form, or WordPress site.
            </p>
          </div>
        {:else}
          <div class="overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-default)] bg-[var(--surface-raised)] shadow-sm dark:bg-[var(--surface-raised)]/30 backdrop-blur-sm">
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Integration</Table.Head>
                  <Table.Head>API Key (apikey)</Table.Head>
                  <Table.Head>Assigned To / Tags</Table.Head>
                  <Table.Head class="text-right">Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each apiSettings as item}
                  <Table.Row>
                    <Table.Cell>
                      <div class="font-medium text-[var(--text-primary)]">{item.title}</div>
                      <a
                        href={item.website}
                        target="_blank"
                        rel="noreferrer noopener"
                        class="inline-flex items-center gap-1 text-[11px] text-[var(--color-primary-default)] hover:underline mt-0.5"
                      >
                        {item.website}
                        <ExternalLink class="size-2.5" />
                      </a>
                    </Table.Cell>
                    <Table.Cell class="font-mono text-[11px] text-[var(--text-muted)]">
                      <div class="flex items-center gap-2">
                        <code class="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 border border-[var(--border-default)]">
                          {item.apikey.substring(0, 8)}...{item.apikey.substring(item.apikey.length - 8)}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="size-6"
                          onclick={() => copyApiKey(item.apikey, item.id)}
                          aria-label="Copy API Key"
                        >
                          {#if copiedState[item.id]}
                            <Check class="size-3.5 text-green-500" />
                          {:else}
                            <Copy class="size-3.5" />
                          {/if}
                        </Button>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div class="space-y-1.5">
                        {#if item.lead_assigned_to && item.lead_assigned_to.length > 0}
                          <div class="flex flex-wrap gap-1 items-center">
                            <Users class="size-3 text-[var(--text-subtle)] mr-1" />
                            {#each item.lead_assigned_to as user}
                              <Badge variant="secondary" class="text-[10px] px-1 py-0 h-4">
                                {user.user_details?.email || user.user?.email || 'User'}
                              </Badge>
                            {/each}
                          </div>
                        {/if}
                        {#if item.tags && item.tags.length > 0}
                          <div class="flex flex-wrap gap-1 items-center">
                            <Tag class="size-3 text-[var(--text-subtle)] mr-1" />
                            {#each item.tags as tag}
                              <Badge variant="outline" class="text-[10px] px-1 py-0 h-4 border-[var(--color-primary-default)]/20 text-[var(--color-primary-default)]">
                                {tag.name || tag}
                              </Badge>
                            {/each}
                          </div>
                        {/if}
                        {#if (!item.tags || item.tags.length === 0) && (!item.lead_assigned_to || item.lead_assigned_to.length === 0)}
                          <span class="text-[11px] italic text-[var(--text-subtle)]">No custom rules</span>
                        {/if}
                      </div>
                    </Table.Cell>
                    <Table.Cell class="text-right">
                      <div class="flex justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          class="h-8 gap-1 text-[11px]"
                          href="/demo-landing?apikey={item.apikey}"
                          target="_blank"
                        >
                          Try Flow <ArrowRight class="size-3" />
                        </Button>
                        <form method="POST" action="?/delete" use:enhance={() => {
                          deletingId = item.id;
                          return async ({ update }) => {
                            deletingId = '';
                            update();
                          };
                        }}>
                          <input type="hidden" name="id" value={item.id} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="icon"
                            class="size-8 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
                            disabled={deletingId === item.id}
                            aria-label="Delete Integration"
                          >
                            <Trash2 class="size-4" />
                          </Button>
                        </form>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}
      </div>

      <!-- Add Integration Card -->
      <div class="rounded-[var(--radius-xl)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-5 shadow-sm space-y-5 dark:bg-[var(--surface-raised)]/30 backdrop-blur-sm h-fit">
        <div>
          <h2 class="text-sm font-semibold tracking-tight text-[var(--text-primary)]">
            Create Integration
          </h2>
          <p class="text-xs text-[var(--text-tertiary)] mt-1">
            Configure rules for leads captured via this external form.
          </p>
        </div>

        <form method="POST" action="?/create" use:enhance={() => {
          creating = true;
          return async ({ update }) => {
            creating = false;
            update();
          };
        }} class="space-y-4">
          <div class="space-y-1.5">
            <Label for="title" class="text-xs">Integration Name</Label>
            <Input
              id="title"
              name="title"
              placeholder="e.g. Enterprise Landing Page"
              bind:value={formTitle}
              required
            />
          </div>

          <div class="space-y-1.5">
            <Label for="website" class="text-xs">Website URL</Label>
            <Input
              id="website"
              name="website"
              placeholder="e.g. enterprise.mysite.com"
              bind:value={formWebsite}
              required
            />
          </div>

          <div class="space-y-1.5">
            <Label for="tags" class="text-xs">Auto Tags (comma separated)</Label>
            <Input
              id="tags"
              name="tags"
              placeholder="e.g. inbound, bolna-ai, saas-lead"
              bind:value={formTags}
            />
          </div>

          <div class="space-y-2">
            <Label class="text-xs flex items-center gap-1">
              <Users class="size-3.5" /> Assign Inbound Leads To
            </Label>
            <div class="max-h-[140px] overflow-y-auto rounded-md border border-[var(--border-default)] bg-white p-2.5 space-y-2 dark:bg-[var(--bg-elevated)]">
              {#each users as u}
                <label class="flex items-center gap-2 text-xs text-[var(--text-muted)] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    name="lead_assigned_to"
                    value={u.id}
                    checked={selectedUsers.includes(u.id)}
                    onchange={() => toggleUserSelection(u.id)}
                    class="rounded border-[var(--border-default)] text-[var(--color-primary-default)] focus:ring-0 size-3.5"
                  />
                  <span class="truncate">{u.user_details?.email || u.user?.email || 'User'}</span>
                </label>
              {/each}
            </div>
          </div>

          <Button type="submit" class="w-full h-9 font-medium text-xs mt-2" disabled={creating}>
            {creating ? 'Generating API Key...' : 'Generate API Key'}
          </Button>
        </form>
      </div>
    </div>
  </div>
</div>
