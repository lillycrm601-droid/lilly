<script>
  import {
    Sparkles,
    X,
    Send,
    Bot,
    User,
    Trash2,
    ArrowRight,
    CheckCircle2,
    Search,
    PlusCircle,
    Maximize2,
    Minimize2,
    PanelRightClose,
    ExternalLink,
    Plus,
    Target,
    CheckSquare,
    Briefcase,
    Users,
    Building,
    Compass,
    Mic,
    MicOff,
    Phone,
    PhoneOff,
    Volume2,
    VolumeX,
    Radio,
    MessageSquare,
    RotateCcw,
    Zap,
    Sliders,
    Layers,
    Activity
  } from '@lucide/svelte';
  import { tick, onMount, onDestroy } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { isCopilotOpen, isCopilotExpanded } from '$lib/stores/ai-copilot.js';

  let isOpen = $derived($isCopilotOpen);
  let isExpanded = $derived($isCopilotExpanded);
  let input = $state('');
  let isLoading = $state(false);
  let chatContainer = $state(null);
  let inputElement = $state(null);

  // ChatGPT-style Live Voice Call States
  let isCallMode = $state(false);
  let callViewMode = $state('voice'); // 'voice' | 'transcript'
  let voiceEngine = $state('neural'); // 'neural' (Google Neural MP3) | 'gemini' (Puck studio)
  let isListening = $state(false);
  let isSpeaking = $state(false);
  let isMuted = $state(false);
  let speechSupported = $state(true);
  let callTranscript = $state('');
  let aiSpokenText = $state('');
  let volumeLevel = $state(0); // 0 to 1 audio volume intensity for orb
  let lastAction = $state(null); // { label: string, path: string, type: string }

  let recognition = null;
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let micSource = null;
  let animationFrameId = null;
  let currentAudio = null;
  let currentSource = null;
  let speechSilenceTimer = null;
  let availableVoices = $state([]);
  let preferredVoice = $state(null);

  /**
   * @typedef {Object} ChatMessage
   * @property {'user' | 'assistant' | 'system'} role
   * @property {string} content
   * @property {string[]} [tools_executed]
   * @property {string | null} [navigated_to]
   * @property {string | null} [navigated_label]
   * @property {any[]} [records_created]
   * @property {any[]} [records_found]
   */

  /** @type {ChatMessage[]} */
  let messages = $state([
    {
      role: 'assistant',
      content:
        '👋 Welcome! I am your **LillyCRM AI Copilot**.\n\nI can navigate pages in real-time, open forms, search records, and execute tasks hands-free using voice.',
      tools_executed: [],
      navigated_to: null,
      navigated_label: null,
      records_created: [],
      records_found: []
    }
  ]);

  const QUICK_NAV = [
    { label: 'Leads', path: '/leads', icon: Target },
    { label: '+ Lead', path: '/leads?action=create', icon: Plus },
    { label: 'Tasks', path: '/tasks', icon: CheckSquare },
    { label: '+ Task', path: '/tasks?action=create', icon: Plus },
    { label: 'Deals', path: '/opportunities', icon: Briefcase },
    { label: 'Contacts', path: '/contacts', icon: Users }
  ];

  const SUGGESTIONS = [
    { text: 'Take me to my leads pipeline', icon: '→' },
    { text: 'Open the new lead form', icon: '+' },
    { text: 'Show tasks in progress', icon: '✓' },
    { text: 'Create a task for campaign ads', icon: '+' },
    { text: 'Show all open deals', icon: '→' },
    { text: 'Search contacts for Sarah', icon: '🔍' }
  ];

  function toggleOpen() {
    isCopilotOpen.update((open) => {
      const next = !open;
      if (next) {
        scrollToBottom();
        setTimeout(() => inputElement?.focus(), 150);
      } else if (isCallMode) {
        endCallMode();
      }
      return next;
    });
  }

  function toggleExpanded() {
    isCopilotExpanded.update((exp) => !exp);
  }

  async function scrollToBottom() {
    await tick();
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }

  function clearHistory() {
    messages = [
      {
        role: 'assistant',
        content: 'Chat history cleared. What would you like to do in LillyCRM?',
        tools_executed: [],
        navigated_to: null,
        navigated_label: null,
        records_created: [],
        records_found: []
      }
    ];
    lastAction = null;
    callTranscript = '';
    aiSpokenText = '';
  }

  function navigateTo(path) {
    if (!path) return;
    if (typeof window !== 'undefined' && window.innerWidth < 1280 && path.includes('action=')) {
      isCopilotOpen.set(false);
    }
    goto(path);
  }

  // Soft browser audio tone cues
  function playAudioTone(freq1, freq2) {
    try {
      const AudioCtx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.04, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.frequency.setValueAtTime(freq1, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq2, ctx.currentTime + 0.1);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch {}
  }

  // Clean text before sending to speech synthesis - strips markdown, URLs, and code
  function cleanSpeechText(text) {
    if (!text) return '';
    return text
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // remove markdown links, keep label
      .replace(/`{1,3}[^`]*`{1,3}/g, '') // remove code
      .replace(/[*#_~>]/g, '') // remove markdown markers
      .replace(/https?:\/\/\S+/g, '') // remove URLs
      .replace(/\/[\w\-\?=&]+/g, '') // remove path strings like /leads?action=create
      .replace(/<[^>]*>/g, '') // remove HTML tags
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Load High-Quality Neural Voices (avoids 1990s robotic Microsoft David)
  function loadVoices() {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      availableVoices = voices;
      const english = voices.filter((v) => v.lang.startsWith('en'));
      // 1. Natural / Online Neural voices (Windows 11 / Edge / Chrome)
      const edgeNatural = english.find(
        (v) =>
          v.name.includes('Natural') || v.name.includes('Online') || v.name.includes('Neural')
      );
      // 2. Google streaming natural voices (Chrome)
      const google = english.find((v) => v.name.includes('Google'));
      // 3. Apple Siri / Natural voices (macOS / iOS / Safari)
      const appleNatural = english.find(
        (v) =>
          v.name.includes('Samantha') || v.name.includes('Siri') || v.name.includes('Ava')
      );
      // 4. Named premium voices
      const named = english.find(
        (v) =>
          v.name.includes('Jenny') ||
          v.name.includes('Daniel') ||
          v.name.includes('Christopher') ||
          v.name.includes('Aria') ||
          v.name.includes('Guy')
      );
      // 5. Explicitly reject David and Zira desktop if any other voice exists
      const nonRobotic = english.find(
        (v) =>
          !v.name.toLowerCase().includes('david') &&
          !v.name.toLowerCase().includes('zira') &&
          !v.name.toLowerCase().includes('desktop')
      );

      preferredVoice = edgeNatural || google || appleNatural || named || nonRobotic || english[0] || voices[0];
    }
  }

  // Real-time Microphone Audio Analysis for the Voice Orb
  async function startAudioAnalysis() {
    try {
      if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioCtx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      audioCtx = new AudioCtx();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      function analyze() {
        if (!isCallMode) return;
        if (analyser && isListening && !isMuted) {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const avg = sum / dataArray.length;
          const target = Math.min(1, avg / 70);
          volumeLevel = volumeLevel * 0.7 + target * 0.3;
        } else if (analyser && isSpeaking) {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
          }
          const avg = sum / dataArray.length;
          if (avg > 3) {
            const target = Math.min(1, avg / 65);
            volumeLevel = volumeLevel * 0.65 + target * 0.35;
          } else {
            const t = Date.now() / 140;
            volumeLevel = 0.35 + Math.sin(t) * 0.2 + Math.sin(t * 2.2) * 0.12;
          }
        } else {
          volumeLevel = volumeLevel * 0.8;
        }
        animationFrameId = requestAnimationFrame(analyze);
      }
      analyze();
    } catch (err) {
      console.warn('Audio analysis setup note:', err.message);
      function fallbackLoop() {
        if (!isCallMode) return;
        if (isSpeaking) {
          const t = Date.now() / 140;
          volumeLevel = 0.4 + Math.sin(t) * 0.25;
        } else if (isListening) {
          volumeLevel = 0.12 + Math.sin(Date.now() / 400) * 0.08;
        } else {
          volumeLevel = 0;
        }
        animationFrameId = requestAnimationFrame(fallbackLoop);
      }
      fallbackLoop();
    }
  }

  function stopAudioAnalysis() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (micSource) {
      try { micSource.disconnect(); } catch {}
      micSource = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
    volumeLevel = 0;
  }

  // Interruption: instantly stop playback when user speaks
  function interruptPlayback() {
    if (currentSource) {
      try { currentSource.stop(0); } catch {}
      currentSource = null;
    }
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.currentTime = 0; } catch {}
      currentAudio = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    isSpeaking = false;
  }

  // Play Neural MP3 or Gemini WAV Audio via Web Audio API (Hardware Accelerated, No Stutter)
  async function playAudioStream(base64Data, mimeType, onComplete) {
    try {
      const AudioCtx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      if (!audioCtx) audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const binaryString = window.atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;

      if (analyser) {
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
      } else {
        source.connect(audioCtx.destination);
      }

      currentSource = source;
      isSpeaking = true;
      source.onended = () => {
        isSpeaking = false;
        currentSource = null;
        if (onComplete) onComplete();
      };

      source.start(0);
    } catch (err) {
      console.warn('Web Audio decode failed, falling back to Web Speech:', err);
      fallbackSpeak(aiSpokenText, onComplete);
    }
  }

  // Dual-Engine Text-to-Speech: Server Neural Voice or Browser Speech Synthesis
  async function speak(text, onComplete) {
    if (typeof window === 'undefined' || isMuted) {
      isSpeaking = false;
      if (onComplete) onComplete();
      return;
    }

    interruptPlayback();

    const cleanText = cleanSpeechText(text);
    if (!cleanText) {
      isSpeaking = false;
      if (onComplete) onComplete();
      return;
    }

    isSpeaking = true;
    aiSpokenText = cleanText;

    // Try high-fidelity server TTS first
    try {
      const res = await fetch('/api/ai/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText, engine: voiceEngine })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.audio) {
          playAudioStream(data.audio, data.mimeType, onComplete);
          return;
        }
      }
    } catch (err) {
      console.warn('Server TTS fetch exception, using browser speech:', err);
    }

    fallbackSpeak(cleanText, onComplete);
  }

  function fallbackSpeak(cleanText, onComplete) {
    if (typeof window === 'undefined' || !window.speechSynthesis || isMuted) {
      isSpeaking = false;
      if (onComplete) onComplete();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'en-US';
    utterance.rate = 1.0; // Natural 1.0 cadence (no pitch distortion)
    utterance.pitch = 1.0;

    if (!preferredVoice) loadVoices();
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    utterance.onstart = () => {
      isSpeaking = true;
    };

    utterance.onend = () => {
      isSpeaking = false;
      if (onComplete) onComplete();
    };

    utterance.onerror = () => {
      isSpeaking = false;
      if (onComplete) onComplete();
    };

    window.speechSynthesis.speak(utterance);
  }

  // Continuous Speech Recognition with Fast Endpointing (<250ms latency)
  function initSpeech() {
    if (typeof window === 'undefined') return;
    const SpeechRecognition =
      /** @type {any} */ (window).SpeechRecognition ||
      /** @type {any} */ (window).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      speechSupported = false;
      return;
    }

    speechSupported = true;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListening = true;
    };

    recognition.onresult = (event) => {
      if (isSpeaking) {
        interruptPlayback();
      }

      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      const text = final || interim;
      if (text) {
        if (isCallMode) {
          callTranscript = text;

          if (speechSilenceTimer) clearTimeout(speechSilenceTimer);

          // Fast endpointing: 200ms if final speech detected, 600ms if interim
          const delay = final.trim().length > 0 ? 200 : 600;
          speechSilenceTimer = setTimeout(() => {
            if (isCallMode && callTranscript.trim() && !isLoading && !isSpeaking) {
              const toSend = callTranscript.trim();
              callTranscript = '';
              sendMessage(toSend);
            }
          }, delay);
        } else {
          input = text;
        }
      }
    };

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech') {
        console.warn('Speech recognition status:', event.error);
      }
      isListening = false;
      if (isCallMode && !isSpeaking && !isLoading) {
        setTimeout(() => {
          if (isCallMode && !isSpeaking && !isLoading) {
            startListening();
          }
        }, 400);
      }
    };

    recognition.onend = () => {
      isListening = false;
      if (isCallMode) {
        if (callTranscript.trim() && !isLoading && !isSpeaking) {
          const toSend = callTranscript.trim();
          callTranscript = '';
          sendMessage(toSend);
        } else if (!isLoading && !isSpeaking) {
          setTimeout(() => {
            if (isCallMode && !isSpeaking && !isLoading) {
              startListening();
            }
          }, 300);
        }
      }
    };
  }

  function startListening() {
    if (!recognition) initSpeech();
    if (recognition && !isListening && !isMuted) {
      try {
        recognition.start();
      } catch {}
    }
  }

  function stopListening() {
    if (speechSilenceTimer) clearTimeout(speechSilenceTimer);
    if (recognition && isListening) {
      try {
        recognition.stop();
      } catch {}
    }
  }

  function toggleVoiceInput() {
    if (!speechSupported) {
      alert('Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.');
      return;
    }
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }

  // ChatGPT-Style Voice Call Mode Start & End
  async function startCallMode() {
    if (!speechSupported) {
      alert('Live voice calls require Web Speech API (available in Chrome, Edge, Safari).');
      return;
    }
    isCopilotOpen.set(true);
    isCallMode = true;
    callViewMode = 'voice';
    callTranscript = '';
    aiSpokenText = '';
    playAudioTone(440, 880);

    loadVoices();
    await startAudioAnalysis();

    // Friendly, brief spoken greeting
    const greeting = "Hey there! What can I do in LillyCRM for you?";
    speak(greeting, () => {
      if (isCallMode) {
        startListening();
      }
    });
  }

  function endCallMode() {
    isCallMode = false;
    callTranscript = '';
    aiSpokenText = '';
    stopListening();
    interruptPlayback();
    stopAudioAnalysis();
    playAudioTone(880, 440);
  }

  function toggleCallMode() {
    if (isCallMode) {
      endCallMode();
    } else {
      startCallMode();
    }
  }

  function toggleMute() {
    isMuted = !isMuted;
    if (isMuted) {
      stopListening();
      interruptPlayback();
    } else {
      startListening();
    }
  }

  // Keyboard shortcut listener (Cmd/Ctrl + J) and Voice Init
  onMount(() => {
    initSpeech();
    loadVoices();

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    function handleKeyDownGlobal(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggleOpen();
      }
    }
    window.addEventListener('keydown', handleKeyDownGlobal);
    return () => {
      window.removeEventListener('keydown', handleKeyDownGlobal);
      if (recognition) stopListening();
      interruptPlayback();
      stopAudioAnalysis();
    };
  });

  onDestroy(() => {
    if (recognition) stopListening();
    interruptPlayback();
    stopAudioAnalysis();
  });

  async function sendMessage(textToSend) {
    const text = (textToSend || input).trim();
    if (!text || isLoading) return;

    input = '';
    stopListening();

    messages = [
      ...messages,
      {
        role: 'user',
        content: text,
        tools_executed: [],
        navigated_to: null,
        navigated_label: null,
        records_created: [],
        records_found: []
      }
    ];
    isLoading = true;
    scrollToBottom();

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          is_voice: isCallMode,
          voice_engine: voiceEngine
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to get AI response');
      }

      const data = await response.json();

      // Live page navigation
      if (data.navigated_to) {
        navigateTo(data.navigated_to);
        lastAction = {
          type: 'navigation',
          title: `Navigated to ${data.navigated_label || data.navigated_to}`,
          path: data.navigated_to
        };
      }

      // Live record update -> Invalidate all
      if (data.records_created && data.records_created.length > 0) {
        try {
          await invalidateAll();
        } catch {}
        const topRec = data.records_created[0];
        lastAction = {
          type: 'record',
          title: `Created ${topRec.type}: "${topRec.title}"`,
          path: topRec.path || '/tasks'
        };
      }

      messages = [
        ...messages,
        {
          role: 'assistant',
          content: data.message,
          tools_executed: data.tools_executed || [],
          navigated_to: data.navigated_to || null,
          navigated_label: data.navigated_label || null,
          records_created: data.records_created || [],
          records_found: data.records_found || []
        }
      ];

      // Instant spoken reply
      if (isCallMode) {
        if (data.audio) {
          isSpeaking = true;
          aiSpokenText = cleanSpeechText(data.message);
          playAudioStream(data.audio, data.mimeType, () => {
            if (isCallMode) startListening();
          });
        } else {
          speak(data.message, () => {
            if (isCallMode) startListening();
          });
        }
      }
    } catch (err) {
      const errContent = `⚠️ Sorry, I encountered an issue: ${err.message}. Please try again.`;
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: errContent,
          tools_executed: [],
          navigated_to: null,
          navigated_label: null,
          records_created: [],
          records_found: []
        }
      ];
      if (isCallMode) {
        speak('Sorry, there was an issue processing your request.', () => {
          if (isCallMode) startListening();
        });
      }
    } finally {
      isLoading = false;
      scrollToBottom();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // Typographic markdown parser for clean monochrome display
  function formatContent(text) {
    if (!text) return '';
    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold text-zinc-950 dark:text-zinc-50">$1</strong>');
    escaped = escaped.replace(
      /`([^`]+)`/g,
      '<code class="px-1.5 py-0.5 rounded bg-zinc-200/80 dark:bg-zinc-800 text-xs font-mono text-zinc-900 dark:text-zinc-100">$1</code>'
    );
    escaped = escaped.replace(
      /\[(.*?)\]\((.*?)\)/g,
      '<a href="$2" data-crm-link class="inline-flex items-center gap-1 font-medium text-zinc-950 dark:text-zinc-50 underline underline-offset-4 decoration-zinc-300 dark:decoration-zinc-700 hover:decoration-zinc-950 dark:hover:decoration-zinc-50 transition-colors">$1 <span class="text-[10px] opacity-70">↗</span></a>'
    );
    escaped = escaped.replace(/^[\*\-]\s+(.*)$/gm, '<li class="ml-4 list-disc text-zinc-800 dark:text-zinc-200">$1</li>');
    escaped = escaped.replace(/\n\n/g, '<div class="h-2"></div>');

    return escaped;
  }

  function handleMessageClick(e) {
    const target = e.target.closest('a[data-crm-link]');
    if (target) {
      const href = target.getAttribute('href');
      if (href && (href.startsWith('/') || href.startsWith('http'))) {
        e.preventDefault();
        navigateTo(href);
      }
    }
  }
</script>

<!-- ============================================== -->
<!-- FLOATING TRIGGER PILL (MINIMALIST MONOCHROME)  -->
<!-- ============================================== -->
{#if !isOpen}
  <div class="fixed bottom-6 right-6 z-40 flex items-center shadow-2xl rounded-full border border-zinc-800/80 bg-zinc-950 text-white dark:border-zinc-300 dark:bg-zinc-50 dark:text-zinc-950 p-1 gap-1">
    <!-- Live Voice Call Quick Start -->
    <button
      onclick={toggleCallMode}
      class="group flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 hover:bg-zinc-800 text-white transition-all active:scale-95 dark:bg-zinc-200 dark:hover:bg-zinc-300 dark:text-zinc-950"
      title="Start ChatGPT Voice Mode"
      aria-label="Start Voice Mode"
    >
      <Phone class="h-4 w-4" />
    </button>

    <div class="h-4 w-[1px] bg-zinc-800 dark:bg-zinc-300"></div>

    <!-- Open AI Chat Sidebar -->
    <button
      onclick={toggleOpen}
      class="flex items-center gap-2 px-3 py-1.5 rounded-full hover:bg-zinc-900 dark:hover:bg-zinc-200 transition-colors active:scale-95"
      aria-label="Open AI Copilot"
    >
      <Sparkles class="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-700" />
      <span class="text-xs font-medium tracking-tight">Copilot</span>
      <span class="rounded bg-zinc-800 dark:bg-zinc-300 px-1 py-0.2 font-mono text-[9px] text-zinc-400 dark:text-zinc-600">Ctrl+J</span>
    </button>
  </div>
{/if}

<!-- Backdrop for screens where Copilot acts as an overlay drawer (<1280px) -->
{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 xl:hidden"
    onclick={toggleOpen}
  ></div>
{/if}

<!-- ============================================== -->
<!-- RIGHT-DOCKED SIDEBAR (STRICTLY BLACK & WHITE) -->
<!-- ============================================== -->
<aside
  class="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-zinc-200 bg-white text-zinc-950 shadow-2xl transition-all duration-200 ease-in-out dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50 {isOpen
    ? 'translate-x-0'
    : 'translate-x-full pointer-events-none'} {isExpanded
    ? 'w-full sm:w-[720px]'
    : 'w-full sm:w-[460px]'}"
  aria-label="LillyCRM AI Copilot Sidebar"
>
  <!-- TOP UNIFIED HEADER -->
  <div class="flex items-center justify-between border-b border-zinc-200/80 bg-zinc-50/70 px-4 py-3 backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-900/60">
    <!-- Brand Info -->
    <div class="flex items-center gap-2.5">
      <div class="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-white shadow-xs dark:border-zinc-700 dark:bg-zinc-100 dark:text-zinc-950">
        <Bot class="h-4 w-4" />
      </div>
      <div>
        <div class="flex items-center gap-2">
          <span class="font-semibold text-sm tracking-tight text-zinc-950 dark:text-zinc-50">Lilly Copilot</span>
          {#if isCallMode}
            <span class="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] font-semibold text-white dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950">
              <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              Live Voice
            </span>
          {:else}
            <span class="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300">
              <span class="h-1.5 w-1.5 rounded-full bg-zinc-950 dark:bg-zinc-50"></span>
              Live Sync
            </span>
          {/if}
        </div>
        <p class="text-[11px] text-zinc-500 dark:text-zinc-400">Controls CRM & executes actions in real-time</p>
      </div>
    </div>

    <!-- Header Actions -->
    <div class="flex items-center gap-1">
      <!-- Mode Switcher: Voice Mode <-> Chat Mode -->
      {#if isCallMode}
        <button
          onclick={() => (callViewMode = callViewMode === 'voice' ? 'transcript' : 'voice')}
          class="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 shadow-2xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          title="Toggle view"
        >
          {#if callViewMode === 'voice'}
            <MessageSquare class="h-3.5 w-3.5" />
            <span class="text-[11px]">Chat View</span>
          {:else}
            <Radio class="h-3.5 w-3.5" />
            <span class="text-[11px]">Voice Orb</span>
          {/if}
        </button>

        <button
          onclick={endCallMode}
          class="flex items-center gap-1 rounded-lg border border-red-600 bg-red-600 px-2.5 py-1 text-xs font-semibold text-white shadow-2xs hover:bg-red-700 active:scale-95"
          title="End Live Voice Call"
        >
          <PhoneOff class="h-3.5 w-3.5" />
          <span class="text-[11px]">End Call</span>
        </button>
      {:else}
        <button
          onclick={toggleCallMode}
          class="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-xs font-medium text-white shadow-2xs hover:bg-zinc-800 active:scale-95 dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
          title="Start ChatGPT Voice Mode"
        >
          <Phone class="h-3.5 w-3.5" />
          <span class="text-[11px]">Voice Call</span>
        </button>
      {/if}

      <!-- Expand / Minimize Width -->
      <button
        onclick={toggleExpanded}
        class="hidden sm:inline-flex rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors"
        title={isExpanded ? 'Normal width' : 'Expand width'}
      >
        {#if isExpanded}
          <Minimize2 class="h-4 w-4" />
        {:else}
          <Maximize2 class="h-4 w-4" />
        {/if}
      </button>

      <!-- Clear Chat -->
      <button
        onclick={clearHistory}
        class="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors"
        title="Clear conversation"
      >
        <Trash2 class="h-4 w-4" />
      </button>

      <!-- Close Sidebar -->
      <button
        onclick={toggleOpen}
        class="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors"
        title="Close sidebar"
      >
        <PanelRightClose class="h-4 w-4" />
      </button>
    </div>
  </div>

  <!-- ============================================== -->
  <!-- 1. CHATGPT-STYLE IMMERSIVE VOICE CALL SCREEN   -->
  <!-- ============================================== -->
  {#if isCallMode && callViewMode === 'voice'}
    <div class="relative flex flex-1 flex-col items-center justify-between p-6 overflow-hidden bg-gradient-to-b from-white via-zinc-50 to-zinc-100 dark:from-zinc-950 dark:via-zinc-900 dark:to-zinc-950">
      
      <!-- Top Engine & Quality Bar -->
      <div class="flex w-full items-center justify-between z-10">
        <!-- Voice Quality Selector -->
        <div class="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <button
            onclick={() => (voiceEngine = 'neural')}
            class="rounded-md px-2.5 py-1 transition-all {voiceEngine === 'neural'
              ? 'bg-white font-semibold text-zinc-950 shadow-xs dark:bg-zinc-800 dark:text-zinc-50'
              : 'hover:text-zinc-900 dark:hover:text-zinc-200'}"
            title="Warm, high-fidelity neural voice (streamed instantly)"
          >
            ✨ Neural Voice
          </button>
          <button
            onclick={() => (voiceEngine = 'gemini')}
            class="rounded-md px-2.5 py-1 transition-all {voiceEngine === 'gemini'
              ? 'bg-white font-semibold text-zinc-950 shadow-xs dark:bg-zinc-800 dark:text-zinc-50'
              : 'hover:text-zinc-900 dark:hover:text-zinc-200'}"
            title="Google AI Studio WAV voice (Puck)"
          >
            🎙️ Studio Puck
          </button>
        </div>

        <!-- Call Status Chip -->
        <div class="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/80 px-2.5 py-1 text-xs text-zinc-600 shadow-2xs backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-400">
          <span class="h-2 w-2 rounded-full {isListening ? 'bg-emerald-500 animate-pulse' : isSpeaking ? 'bg-zinc-950 dark:bg-white animate-ping' : 'bg-zinc-400'}"></span>
          <span class="font-mono text-[11px]">
            {#if isSpeaking}Speaking{:else if isListening}Listening{:else if isLoading}Thinking{:else}Connected{/if}
          </span>
        </div>
      </div>

      <!-- CENTER: THE CHATGPT FLUID VOICE ORB -->
      <div class="flex flex-col items-center justify-center my-auto w-full z-10 select-none">
        <!-- Interactive Animated Voice Orb -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          onclick={() => {
            if (isSpeaking) interruptPlayback();
            else if (!isListening) startListening();
          }}
          class="relative flex h-56 w-56 sm:h-64 sm:w-64 cursor-pointer items-center justify-center rounded-full transition-transform duration-300 group"
          title={isSpeaking ? 'Click to interrupt' : 'Click to speak'}
        >
          <!-- Layer 1: Ambient Ethereal Glow -->
          <div
            class="absolute inset-0 rounded-full blur-3xl opacity-40 transition-transform duration-200 ease-out {isSpeaking
              ? 'bg-zinc-400 dark:bg-zinc-600 scale-125'
              : 'bg-zinc-300 dark:bg-zinc-800'}"
            style="transform: scale({1 + volumeLevel * 0.5});"
          ></div>

          <!-- Layer 2: Harmonic Outer Wave Ring -->
          <div
            class="absolute inset-2 rounded-full border border-zinc-300/60 bg-zinc-200/30 backdrop-blur-xs transition-transform duration-100 ease-out dark:border-zinc-700/60 dark:bg-zinc-800/30"
            style="transform: scale({1 + volumeLevel * 0.35});"
          ></div>

          <!-- Layer 3: Secondary Fluid Ripple -->
          <div
            class="absolute inset-6 rounded-full border border-zinc-400/70 bg-zinc-300/30 transition-transform duration-150 ease-out dark:border-zinc-600/70 dark:bg-zinc-700/30"
            style="transform: scale({1 + volumeLevel * 0.2});"
          ></div>

          <!-- Layer 4: The Solid Core Sphere -->
          <div
            class="relative flex h-32 w-32 sm:h-36 sm:w-36 items-center justify-center rounded-full shadow-2xl transition-all duration-300 border border-zinc-800/20 dark:border-zinc-200/20 {isSpeaking
              ? 'bg-zinc-950 text-white dark:bg-zinc-50 dark:text-zinc-950 scale-105 shadow-zinc-950/20'
              : isLoading
              ? 'bg-zinc-900 text-white dark:bg-zinc-200 dark:text-zinc-900 animate-pulse'
              : isListening
              ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
              : 'bg-zinc-900 text-zinc-300 dark:bg-zinc-200 dark:text-zinc-700'}"
          >
            {#if isLoading}
              <div class="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent dark:border-zinc-950 dark:border-t-transparent"></div>
            {:else if isSpeaking}
              <!-- 5-bar live audio equalizer inside the core -->
              <div class="flex items-center gap-1.5 h-8">
                <span class="w-1 rounded-full bg-white dark:bg-zinc-950 animate-bounce h-7" style="animation-delay: 0ms"></span>
                <span class="w-1 rounded-full bg-white dark:bg-zinc-950 animate-bounce h-4" style="animation-delay: 150ms"></span>
                <span class="w-1 rounded-full bg-white dark:bg-zinc-950 animate-bounce h-8" style="animation-delay: 300ms"></span>
                <span class="w-1 rounded-full bg-white dark:bg-zinc-950 animate-bounce h-5" style="animation-delay: 100ms"></span>
                <span class="w-1 rounded-full bg-white dark:bg-zinc-950 animate-bounce h-6" style="animation-delay: 250ms"></span>
              </div>
            {:else if isListening}
              <div class="flex flex-col items-center gap-1">
                <Mic class="h-8 w-8 transition-transform duration-150" style="transform: scale({1 + volumeLevel * 0.25})" />
              </div>
            {:else}
              <MicOff class="h-8 w-8 text-zinc-400" />
            {/if}
          </div>
        </div>

        <!-- Dynamic Status Label -->
        <div class="mt-5 flex flex-col items-center gap-1 text-center">
          <span class="font-semibold text-base tracking-tight text-zinc-950 dark:text-zinc-50">
            {#if isSpeaking}
              Lilly is speaking...
            {:else if isLoading}
              Thinking & executing CRM actions...
            {:else if isListening}
              Listening to you...
            {:else if isMuted}
              Microphone Muted
            {:else}
              Connected & Ready
            {/if}
          </span>
          <p class="text-xs text-zinc-500 dark:text-zinc-400">
            {#if isSpeaking}
              Tap orb or start speaking to interrupt
            {:else if isListening}
              Speak naturally, e.g. "Take me to leads"
            {:else}
              Tap the microphone to unmute
            {/if}
          </p>
        </div>

        <!-- Dynamic Live Subtitles Stream -->
        <div class="mt-6 w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white/70 p-4 shadow-sm backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-900/70 text-center min-h-[80px] flex items-center justify-center">
          {#if callTranscript}
            <div class="space-y-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">You said:</span>
              <p class="text-sm font-medium text-zinc-950 dark:text-zinc-50 italic leading-relaxed">
                "{callTranscript}"
              </p>
            </div>
          {:else if aiSpokenText && isSpeaking}
            <div class="space-y-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Copilot:</span>
              <p class="text-xs text-zinc-800 dark:text-zinc-200 leading-relaxed">
                "{aiSpokenText}"
              </p>
            </div>
          {:else}
            <p class="text-xs text-zinc-400 dark:text-zinc-500 italic">
              Say "Open tasks", "Create lead", or "Show open deals"...
            </p>
          {/if}
        </div>

        <!-- Confirmed Live Action Toast -->
        {#if lastAction}
          <div class="mt-3.5 flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3.5 py-1.5 text-xs text-zinc-900 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <CheckCircle2 class="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span class="font-medium truncate max-w-[220px]">{lastAction.title}</span>
            <button
              onclick={() => navigateTo(lastAction.path)}
              class="rounded-md bg-zinc-950 px-2 py-0.5 text-[10px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950 hover:opacity-90 shrink-0"
            >
              View ↗
            </button>
          </div>
        {/if}
      </div>

      <!-- BOTTOM CHATGPT DOCK CONTROLS -->
      <div class="w-full flex flex-col items-center gap-2 pt-4 border-t border-zinc-200/60 dark:border-zinc-800/60 z-10">
        <div class="flex items-center gap-4">
          <!-- Mute Button -->
          <button
            onclick={toggleMute}
            class="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-800 shadow-md transition-all hover:bg-zinc-100 active:scale-95 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {#if isMuted}
              <MicOff class="h-5 w-5 text-red-500" />
            {:else}
              <Mic class="h-5 w-5" />
            {/if}
          </button>

          <!-- Center Interrupt / Tap to Speak Button -->
          <button
            onclick={() => {
              if (isSpeaking) interruptPlayback();
              else if (!isListening) startListening();
            }}
            class="flex h-14 w-14 items-center justify-center rounded-full border border-zinc-800 bg-zinc-950 text-white shadow-xl transition-all hover:scale-105 active:scale-95 dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950"
            title={isSpeaking ? 'Interrupt AI speech' : 'Start speaking'}
          >
            {#if isSpeaking}
              <RotateCcw class="h-6 w-6" />
            {:else}
              <Radio class="h-6 w-6" />
            {/if}
          </button>

          <!-- Hang Up Button (ChatGPT Iconic Red) -->
          <button
            onclick={endCallMode}
            class="flex h-12 w-12 items-center justify-center rounded-full border border-red-600 bg-red-600 text-white shadow-md transition-all hover:bg-red-700 active:scale-95"
            title="End Live Voice Call"
          >
            <PhoneOff class="h-5 w-5" />
          </button>
        </div>

        <span class="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">Tap orb or speak to interrupt anytime</span>
      </div>

    </div>
  {:else}
    <!-- ============================================== -->
    <!-- 2. HIGH-POLISH MODERN CHAT UI                  -->
    <!-- ============================================== -->

    <!-- Call Mode Top Banner (if viewing transcript while call is live) -->
    {#if isCallMode}
      <div class="flex items-center justify-between border-b border-zinc-200 bg-zinc-100/90 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900/90">
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span class="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Live Voice Call Active</span>
        </div>
        <div class="flex items-center gap-2">
          <button
            onclick={() => (callViewMode = 'voice')}
            class="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
          >
            Return to Orb
          </button>
          <button
            onclick={endCallMode}
            class="rounded-md bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700"
          >
            End Call
          </button>
        </div>
      </div>
    {/if}

    <!-- Quick Jump Bar (Clean Minimalist Ribbon) -->
    <div class="flex items-center gap-1.5 overflow-x-auto border-b border-zinc-200/80 bg-zinc-50/40 px-3.5 py-2 text-xs scrollbar-none dark:border-zinc-800/80 dark:bg-zinc-900/20">
      <span class="pr-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">Jump:</span>
      {#each QUICK_NAV as nav}
        <button
          onclick={() => navigateTo(nav.path)}
          class="flex shrink-0 items-center gap-1 rounded-md border border-zinc-200/90 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 shadow-2xs transition-all hover:border-zinc-900 hover:text-zinc-950 active:scale-95 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-100 dark:hover:text-zinc-50"
        >
          <nav.icon class="h-3 w-3 opacity-70" />
          <span>{nav.label}</span>
        </button>
      {/each}
    </div>

    <!-- Messages Container -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={chatContainer}
      onclick={handleMessageClick}
      class="flex-1 space-y-5 overflow-y-auto p-4 sm:p-5 text-sm"
    >
      {#each messages as msg, i (i)}
        <div class="flex gap-3 {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
          {#if msg.role === 'assistant'}
            <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-900 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 mt-0.5">
              <Bot class="h-3.5 w-3.5" />
            </div>
          {/if}

          <!-- Message Body -->
          <div class="space-y-2.5 max-w-[88%] {msg.role === 'user' ? 'items-end' : 'items-start'}">
            <!-- Tool Activity Badges -->
            {#if msg.tools_executed && msg.tools_executed.length > 0}
              <div class="flex flex-wrap gap-1">
                {#each msg.tools_executed as tool}
                  <span class="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 font-mono text-[10px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                    <CheckCircle2 class="h-2.5 w-2.5 text-emerald-500" />
                    {tool.replace('_', ' ')}
                  </span>
                {/each}
              </div>
            {/if}

            <!-- Live Navigation Card -->
            {#if msg.navigated_to}
              <div class="flex items-center justify-between gap-3 rounded-xl border border-zinc-300/80 bg-zinc-100/90 px-3.5 py-2 text-xs text-zinc-900 dark:border-zinc-700/80 dark:bg-zinc-800/80 dark:text-zinc-100 shadow-2xs">
                <div class="flex items-center gap-1.5 font-medium truncate">
                  <Compass class="h-4 w-4 text-zinc-700 dark:text-zinc-300 shrink-0" />
                  <span class="truncate">Navigated page to <code class="font-mono">{msg.navigated_to}</code></span>
                </div>
                <button
                  onclick={() => navigateTo(msg.navigated_to)}
                  class="shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold text-white shadow-xs hover:bg-zinc-800 dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200 active:scale-95"
                >
                  View ↗
                </button>
              </div>
            {/if}

            <!-- Records Created Cards -->
            {#if msg.records_created && msg.records_created.length > 0}
              <div class="space-y-1.5">
                {#each msg.records_created as rec}
                  <div class="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-3 text-xs text-zinc-900 shadow-2xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
                    <div>
                      <span class="font-semibold uppercase tracking-wider text-[10px] text-zinc-400">Created {rec.type}</span>
                      <p class="font-medium text-sm text-zinc-950 dark:text-zinc-50">{rec.title}</p>
                    </div>
                    <button
                      onclick={() => navigateTo(rec.path)}
                      class="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-zinc-800 active:scale-95 dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
                    >
                      <span>Open</span>
                      <ArrowRight class="h-3 w-3" />
                    </button>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Text Content Bubble -->
            <div
              class="rounded-2xl px-4 py-3 leading-relaxed {msg.role === 'user'
                ? 'rounded-tr-xs bg-zinc-950 text-white shadow-xs dark:bg-zinc-100 dark:text-zinc-950'
                : 'rounded-tl-xs border border-zinc-200/80 bg-zinc-50/80 text-zinc-900 shadow-2xs dark:border-zinc-800/80 dark:bg-zinc-900/60 dark:text-zinc-100'}"
            >
              <div class="whitespace-pre-wrap break-words leading-relaxed text-sm">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html formatContent(msg.content)}
              </div>
            </div>
          </div>

          {#if msg.role === 'user'}
            <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-white dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950 mt-0.5">
              <User class="h-3.5 w-3.5" />
            </div>
          {/if}
        </div>
      {/each}

      {#if isLoading}
        <div class="flex items-center gap-2.5 pl-10 text-xs text-zinc-500 dark:text-zinc-400">
          <div class="flex gap-1">
            <span class="h-2 w-2 animate-bounce rounded-full bg-zinc-900 dark:bg-zinc-100" style="animation-delay: 0ms"></span>
            <span class="h-2 w-2 animate-bounce rounded-full bg-zinc-900 dark:bg-zinc-100" style="animation-delay: 150ms"></span>
            <span class="h-2 w-2 animate-bounce rounded-full bg-zinc-900 dark:bg-zinc-100" style="animation-delay: 300ms"></span>
          </div>
          <span>Executing live CRM actions...</span>
        </div>
      {/if}
    </div>

    <!-- Suggested Quick Prompts (When Chat is Fresh) -->
    {#if messages.length === 1 && !isLoading}
      <div class="border-t border-zinc-200/80 bg-zinc-50/40 p-4 dark:border-zinc-800/80 dark:bg-zinc-900/20">
        <p class="mb-2 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Suggested commands:</p>
        <div class="grid grid-cols-2 gap-2">
          {#each SUGGESTIONS.slice(0, 4) as s}
            <button
              onclick={() => sendMessage(s.text)}
              class="flex items-start gap-2 rounded-xl border border-zinc-200/80 bg-white p-2.5 text-left text-xs text-zinc-800 shadow-2xs hover:border-zinc-900 hover:text-zinc-950 active:scale-95 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-100 dark:hover:text-zinc-50 transition-all"
            >
              <span class="font-mono text-zinc-400 dark:text-zinc-600">{s.icon}</span>
              <span class="font-medium leading-snug line-clamp-2">{s.text}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- BOTTOM INPUT BAR -->
    <div class="border-t border-zinc-200/80 bg-white p-4 dark:border-zinc-800/80 dark:bg-zinc-950">
      <form
        onsubmit={(e) => {
          e.preventDefault();
          sendMessage();
        }}
        class="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-1.5 focus-within:border-zinc-950 focus-within:bg-white dark:border-zinc-800 dark:bg-zinc-900/60 dark:focus-within:border-zinc-100 dark:focus-within:bg-zinc-900 transition-all shadow-xs"
      >
        <input
          type="text"
          bind:this={inputElement}
          bind:value={input}
          onkeydown={handleKeyDown}
          placeholder={isListening ? 'Listening to speech...' : 'Ask or instruct Lilly Copilot...'}
          disabled={isLoading}
          class="flex-1 bg-transparent px-3 py-2 text-sm text-zinc-950 placeholder-zinc-400 outline-none disabled:opacity-60 dark:text-zinc-50 dark:placeholder-zinc-500"
        />

        <!-- Dictation Mic Button -->
        <button
          type="button"
          onclick={toggleVoiceInput}
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all {isListening
            ? 'bg-red-500 text-white animate-pulse'
            : 'text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800'}"
          title={isListening ? 'Stop listening' : 'Dictate with mic'}
        >
          {#if isListening}
            <MicOff class="h-4 w-4" />
          {:else}
            <Mic class="h-4 w-4" />
          {/if}
        </button>

        <!-- Send Arrow Button -->
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 text-white shadow-xs transition-all hover:bg-zinc-800 disabled:opacity-20 active:scale-95 dark:border-zinc-200 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
          title="Send command"
        >
          <Send class="h-4 w-4" />
        </button>
      </form>
      <div class="mt-2 flex items-center justify-between px-1 text-[11px] text-zinc-400 dark:text-zinc-500">
        <span>Click <strong>📞 Voice Call</strong> for ChatGPT voice mode</span>
        <span>Shortcut: <strong>Ctrl+J</strong></span>
      </div>
    </div>
  {/if}
</aside>
