import { writable } from 'svelte/store';

export const isCopilotOpen = writable(false);
export const isCopilotExpanded = writable(false);

export function toggleCopilot() {
  isCopilotOpen.update((open) => !open);
}

export function openCopilot() {
  isCopilotOpen.set(true);
}

export function closeCopilot() {
  isCopilotOpen.set(false);
}

export function toggleCopilotExpanded() {
  isCopilotExpanded.update((exp) => !exp);
}
